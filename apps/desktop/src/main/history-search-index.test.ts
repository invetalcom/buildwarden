import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { readOrchestrationHistory } from "./orchestration-history";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-history-index-"));
  dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  databases.push(db);
  await db.init();
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "One" });
  const other = db.addProject({ repoPath: join(dir, "other"), baseBranch: "main", resolvedName: "Two" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "test", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "test", config: {}, capabilities: {}, enabled: true });
  const runInput = { providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const, mode: "ask" as const, workspaceType: "local" as const, branchName: "main", worktreePath: dir };
  const search = (query: string, projectId = project.id) =>
    readOrchestrationHistory(db, projectId, "search", { query }) as { items: Array<{ id: string; kind: string; matchedIn?: string; snippet?: string }>; searchedTranscripts: boolean };
  return { dir, db, project, other, provider, model, runInput, search };
};

describe("transcript search", () => {
  it("finds a decision inside a run's agent output, with a snippet, only in its own project", async () => {
    const { db, project, other, runInput, search } = await fixture();
    const run = db.createRun({ ...runInput, projectId: project.id, prompt: "Refactor storage" });
    const outside = db.createRun({ ...runInput, projectId: other.id, prompt: "Elsewhere" });
    db.appendRunStep(run.id, "output", "Agent output", "We decided to keep SQLite WAL mode because backups copy the sidecars.");
    db.appendRunStep(outside.id, "output", "Agent output", "We decided to keep SQLite WAL mode here too.");
    db.appendRunStep(run.id, "tool-result", "Shell", "WAL mode appears in tool output, which is not indexed.");

    const result = search("wal mode because");

    expect(result.searchedTranscripts).toBe(true);
    expect(result.items).toEqual([expect.objectContaining({ id: run.id, kind: "run", matchedIn: "transcript", snippet: expect.stringContaining("[WAL mode because]") })]);
  });

  it("indexes chat answers and follows edits and deletions", async () => {
    const { db, project, provider, model, runInput, search } = await fixture();
    const run = db.createRun({ ...runInput, projectId: project.id, prompt: "Plan" });
    const chat = db.createChat(provider.id, model.id, "Question", run.id);
    db.appendChatEvent(chat.id, "output", "Answer", "Use the outbox pattern for crash safety.");
    expect(search("outbox pattern").items).toEqual([expect.objectContaining({ id: chat.id, kind: "chat" })]);

    const runStep = db.appendRunStep(run.id, "output", "Agent output", "first draft");
    db.updateRunStep(runStep.id, { content: "final answer mentions idempotency keys" });
    expect(search("first draft").items).toEqual([]);
    expect(search("idempotency keys").items).toEqual([expect.objectContaining({ id: run.id })]);

    // A deleted step stops matching while its run, and the run's other steps, remain.
    db.appendRunStep(run.id, "log", "Follow-up command", "withdrawn follow-up about vacuum", JSON.stringify({ source: "user", queuedFollowUpId: "q-1" }));
    expect(search("about vacuum").items).toEqual([expect.objectContaining({ id: run.id })]);
    expect(db.deleteStepsForQueuedFollowUp("run", run.id, "q-1")).toBe(1);
    expect(search("about vacuum").items).toEqual([]);
    expect(search("idempotency keys").items).toEqual([expect.objectContaining({ id: run.id })]);
  });

  it("falls back to prompts and summaries for queries shorter than a trigram", async () => {
    const { db, project, runInput, search } = await fixture();
    const run = db.createRun({ ...runInput, projectId: project.id, prompt: "Fix CI" });
    db.appendRunStep(run.id, "output", "Agent output", "ci is green");
    const result = search("ci");
    expect(result.searchedTranscripts).toBe(false);
    expect(result.items).toEqual([expect.objectContaining({ id: run.id })]);
    expect(result.items[0]).not.toHaveProperty("matchedIn");
  });

  it("indexes steps written before the index existed, in slices", async () => {
    const { db, project, runInput, search } = await fixture();
    const run = db.createRun({ ...runInput, projectId: project.id, prompt: "Old run" });
    for (let index = 0; index < 5; index += 1) db.appendRunStep(run.id, "output", "Agent output", `legacy decision ${String(index)} about retries`);
    // Simulate a database from before the index: nothing indexed, nothing queued, backfill not started.
    const raw = new DatabaseSync(db.getFilePath());
    raw.exec("delete from history_fts; delete from history_index_map; delete from history_index_queue; update history_index_backfill set cursor = '', done = 0;");
    raw.close();
    expect(search("about retries").items).toEqual([]);

    expect(db.backfillHistorySearchIndex(2)).toBe(true);
    while (db.backfillHistorySearchIndex(2)) { /* keep slicing */ }

    expect(search("about retries").items).toEqual([expect.objectContaining({ id: run.id, matchedIn: "transcript" })]);
  });
});
