import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { readOrchestrationHistory } from "./orchestration-history";

describe("project history tools", () => {
  it("paginates history and rejects another project's run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bw-history-"));
    const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
    try {
      await db.init();
      const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "One" });
      const other = db.addProject({ repoPath: join(dir, "other"), baseBranch: "main", resolvedName: "Two" });
      const provider = db.addProviderAccount({ providerType: "codex-cli", label: "test", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
      const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "test", config: {}, capabilities: {}, enabled: true });
      const runInput = { providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const, mode: "ask" as const, workspaceType: "local" as const, branchName: "main", worktreePath: dir };
      const run = db.createRun({ ...runInput, projectId: project.id, prompt: "a".repeat(12_000) + "tail" });
      const outside = db.createRun({ ...runInput, projectId: other.id, prompt: "Other project's context" });
      const projectChat = db.createChat(provider.id, model.id, "Chat scope: project", run.id);
      const outsideChat = db.createChat(provider.id, model.id, "Chat scope: other project", outside.id);
      const standaloneChat = db.createChat(provider.id, model.id, "Chat scope: standalone");
      expect(readOrchestrationHistory(db, project.id, "read", { kind: "run", id: run.id })).toMatchObject({ nextOffset: 12_000 });
      expect(readOrchestrationHistory(db, project.id, "read", { kind: "run", id: run.id, offset: 12_000 })).toMatchObject({ text: "tail", nextOffset: null });
      expect(() => readOrchestrationHistory(db, project.id, "read", { kind: "run", id: outside.id })).toThrow("does not belong");
      expect(readOrchestrationHistory(db, project.id, "search", { query: "Other project's" })).toMatchObject({ items: [] });
      expect(() => readOrchestrationHistory(db, project.id, "read", { kind: "run", id: run.id, offset: -1 })).toThrow("offset");
      expect(readOrchestrationHistory(db, project.id, "read", { kind: "chat", id: projectChat.id })).toMatchObject({ text: "Chat scope: project" });
      for (const chat of [outsideChat, standaloneChat]) {
        expect(() => readOrchestrationHistory(db, project.id, "read", { kind: "chat", id: chat.id })).toThrow("does not belong");
      }
      expect(readOrchestrationHistory(db, project.id, "search", { query: "Chat scope:" })).toMatchObject({
        items: [{ kind: "chat", id: projectChat.id }], nextOffset: null,
      });
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
