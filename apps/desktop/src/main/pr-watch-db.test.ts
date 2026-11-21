import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { PrWatchRecord, RunForgeRequestSummary } from "@buildwarden/shared";

const directories: string[] = [];
const databases: BuildWardenDatabase[] = [];

const createDb = async () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-pr-watch-"));
  directories.push(directory);
  const db = new BuildWardenDatabase(join(directory, "db.sqlite"));
  await db.init();
  databases.push(db);
  return db;
};

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PR_URL = "https://github.com/acme/app/pull/12";

const fixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\watch-repo", baseBranch: "main", resolvedName: "Watch repo" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt-5", displayName: "GPT-5", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code",
    workspaceType: "worktree", prompt: "Redesign cards", branchName: "feat/cards", worktreePath: "C:\\watch-repo\\feat-cards",
  });
  return { project, run };
};

const summary: RunForgeRequestSummary = {
  provider: "github", number: 12, title: "Redesign cards", url: PR_URL, state: "open", readiness: "pending", draft: false,
  mergeability: "mergeable", reviewDecision: "none", author: "dev", sourceBranch: "feat/cards", sourceRepository: "acme/app",
  targetBranch: "main", headSha: "abc", checks: { completed: 0, total: 0, successful: 0, failed: 0, running: 0 },
  unresolvedThreadCount: 0, supportedActions: ["refresh"], supportedMergeMethods: ["merge"], updatedAt: null,
  lastSyncedAt: "2026-11-21T10:00:00.000Z", stale: false, syncError: null,
};

const watch = (runId: string, projectId: string, overrides: Partial<PrWatchRecord> = {}): PrWatchRecord => ({
  runId, projectId, prUrl: PR_URL, prNumber: 12, provider: "github", status: "watching",
  options: { checks: true, feedback: true, conflicts: true }, message: null, endReason: null, wakeCount: 0, attemptsOnHead: 0,
  attemptHeadSha: null, lastCheckedAt: null, lastWakeAt: null, pending: null, lastResult: null, attention: null,
  createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z", ...overrides,
});

it("hydrates a run's watch without the pending comment list", async () => {
  const db = await createDb();
  const { project, run } = fixture(db);
  expect(db.getRun(run.id).prWatch).toBeNull();
  db.savePrWatch(watch(run.id, project.id, {
    status: "working",
    pending: {
      id: "wake", triggers: ["feedback"], headSha: "abc", handledKeys: ["comment:1"], repairRequested: false, startedAt: "2026-11-21T10:01:00.000Z",
      feedback: [{ ref: "C1", kind: "conversation", threadId: null, replyToCommentId: null, path: null, line: null, commentIds: ["1"], author: "rev", excerpt: "Rename" }],
    },
  }));
  expect(db.getRun(run.id).prWatch).toMatchObject({ status: "working", pending: { triggers: ["feedback"], startedAt: "2026-11-21T10:01:00.000Z" } });
  expect(db.getRun(run.id).prWatch?.pending).not.toHaveProperty("feedback");
  expect(db.listRunsForProject(project.id)[0]?.prWatch?.status).toBe("working");
  expect(db.listPrWatchesWithStatuses(["working"]).map((record) => record.runId)).toEqual([run.id]);
  expect(db.getPrWatch(run.id)?.pending?.feedback).toHaveLength(1);
});

it("remembers handled events and the link source, and forgets both with the run", async () => {
  const db = await createDb();
  const { project, run } = fixture(db);
  db.saveRunForgeRequest(run.id, project.id, "feat/cards", "abc", summary, null);
  expect(db.getRunForgeRequestCache(run.id)?.linkSource).toBe("auto");
  db.setRunForgeLinkSource(run.id, "user");
  // A later sync keeps the user's choice.
  db.saveRunForgeRequest(run.id, project.id, "feat/cards", "abc", { ...summary, title: "Renamed" }, null);
  expect(db.getRunForgeRequestCache(run.id)?.linkSource).toBe("user");
  db.saveRunForgeUnlinked(run.id, "feat/cards");
  expect(db.getRunForgeRequestCache(run.id)).toMatchObject({ linkSource: "none", summary: null });

  db.addPrWatchKeys(run.id, ["checks:abc", "comment:1"]);
  db.addPrWatchKeys(run.id, ["comment:1", "comment:2"]);
  expect(db.listPrWatchKeys(run.id)).toEqual(new Set(["checks:abc", "comment:1", "comment:2"]));
  db.savePrWatch(watch(run.id, project.id));
  db.deleteRun(run.id);
  expect(db.getPrWatch(run.id)).toBeNull();
  expect(db.listPrWatchKeys(run.id).size).toBe(0);
});

it("saves a moved watch's two records together or not at all", async () => {
  const db = await createDb();
  const { project, run } = fixture(db);
  db.savePrWatch(watch(run.id, project.id));
  const ended = watch(run.id, project.id, { status: "ended", endReason: "moved" });
  expect(() => db.savePrWatches([ended, { ...watch("other-run", project.id), projectId: null as unknown as string }])).toThrow();
  expect(db.getPrWatch(run.id)?.status).toBe("watching");
  db.savePrWatches([ended, watch("other-run", project.id)]);
  expect(db.getPrWatch(run.id)?.status).toBe("ended");
  expect(db.getPrWatch("other-run")?.status).toBe("watching");
});

it("lists a paused watch as blocked in the inbox until acknowledged", async () => {
  const db = await createDb();
  const { project, run } = fixture(db);
  db.savePrWatch(watch(run.id, project.id, { status: "paused", attention: { id: "notice", message: "Push failed.", createdAt: "2026-11-21T10:05:00.000Z" } }));
  const item = db.listAttentionInbox().find((entry) => entry.id.startsWith("pr-watch:"));
  expect(item).toMatchObject({ id: `pr-watch:${run.id}:notice`, kind: "blocked", detail: "Push failed.", runId: run.id, dismissible: true });
  db.acknowledgeAttentionItems([item!.id]);
  expect(db.listAttentionInbox().some((entry) => entry.id.startsWith("pr-watch:"))).toBe(false);
  db.savePrWatch(watch(run.id, project.id, { attention: { id: "later", message: "1 comment needs your decision.", createdAt: "2026-11-21T10:09:00.000Z" } }));
  expect(db.listAttentionInbox().find((entry) => entry.id.startsWith("pr-watch:"))).toMatchObject({ kind: "review" });
});
