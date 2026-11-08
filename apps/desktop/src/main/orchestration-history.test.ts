import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

      const runStep = db.appendRunStep(run.id, "output", "Result", "🎨".repeat(12_100));
      const chatStep = db.appendChatEvent(projectChat.id, "output", "Answer", "ä".repeat(12_100));
      const chatTail = db.appendChatEvent(projectChat.id, "output", "Follow-up", "end");
      // No read or search should hydrate unrelated sessions or a complete step history.
      for (const method of ["listRunsForProject", "listAllChats", "getRunSteps", "getChatSteps"] as const) {
        vi.spyOn(db, method).mockImplementation(() => { throw new Error("Unbounded history read"); });
      }
      for (const [kind, record, steps] of [["run", run, [runStep]], ["chat", projectChat, [chatStep, chatTail]]] as const) {
        const expected = [record.prompt, ...steps.map((step) => `${step.createdAt} ${step.eventType}: ${step.title}\n${step.content}`)].join("\n\n");
        const parts: string[] = [];
        let offset: number | null = 0;
        do {
          const page = db.readProjectHistoryPage(project.id, kind, record.id, offset);
          expect(Array.from(page.text).length).toBeLessThanOrEqual(12_000);
          expect(page.totalChars).toBe(Array.from(expected).length);
          parts.push(page.text);
          offset = page.nextOffset;
        } while (offset !== null);
        expect(parts.join("")).toBe(expected);
        expect(db.readProjectHistoryPage(project.id, kind, record.id, 1_000_000)).toMatchObject({ text: "", nextOffset: null });
      }
      for (let index = 0; index < 21; index++) db.createChat(provider.id, model.id, `Änderung ${index}`, run.id);
      const first = db.searchProjectHistory(project.id, "änderung", 0);
      const second = db.searchProjectHistory(project.id, "änderung", first.nextOffset!);
      expect(first.items).toHaveLength(20);
      expect(first.nextOffset).toBe(20);
      expect(second.items).toHaveLength(1);
      expect(second.nextOffset).toBeNull();
      expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(21);
      expect(() => readOrchestrationHistory(db, project.id, "read", { kind: "run", id: "missing" })).toThrow("does not belong");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
