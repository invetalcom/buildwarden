import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-step-update-"));
  dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  databases.push(db);
  await db.init();
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "One" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "test", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "test", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "ask", workspaceType: "local",
    branchName: "main", worktreePath: dir, projectId: project.id, prompt: "Build",
  });
  const chat = db.createChat(provider.id, model.id, "Question", run.id);
  return { db, run, chat };
};

describe("streamed step updates", () => {
  it("returns the stored run step whether or not the update carries its text", async () => {
    const { db, run } = await fixture();
    const step = db.appendRunStep(run.id, "tool-progress", "Shell", "building", JSON.stringify({ streamId: "s" }));

    const replaced = db.updateRunStep(step.id, { content: "building\ndone", metadataJson: JSON.stringify({ streamId: "s", ok: true }) });
    expect(replaced).toEqual({ ...step, content: "building\ndone", metadataJson: JSON.stringify({ streamId: "s", ok: true }) });

    // Fields that are left out keep their stored values, including the text.
    const retyped = db.updateRunStep(step.id, { eventType: "tool-result", title: "Shell finished" });
    expect(retyped).toEqual({ ...replaced, eventType: "tool-result", title: "Shell finished" });
    expect(db.getRunSteps(run.id).find((candidate) => candidate.id === step.id)).toEqual(retyped);
    expect(() => db.updateRunStep("missing", { content: "x" })).toThrow("Run step not found: missing");
  });

  it("returns the stored chat step whether or not the update carries its text", async () => {
    const { db, chat } = await fixture();
    const step = db.appendChatEvent(chat.id, "output", "Answer", "Draft");

    const replaced = db.updateChatStep(step.id, { content: "Final answer" });
    expect(replaced).toEqual({ ...step, content: "Final answer" });
    const retitled = db.updateChatStep(step.id, { title: "Reply" });
    expect(retitled).toEqual({ ...replaced, title: "Reply" });
    expect(db.updateChatStep(step.id, {})).toEqual(retitled);
    expect(() => db.updateChatStep("missing", { content: "x" })).toThrow("Chat step not found: missing");
  });
});
