import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { RunForgeRequestDetailsResult, RunForgeRequestSummary } from "@buildwarden/shared";

const directories: string[] = [];
const databases: BuildWardenDatabase[] = [];

const createDb = async (filePath?: string) => {
  let path = filePath;
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), "buildwarden-run-forge-"));
    directories.push(directory);
    path = join(directory, "db.sqlite");
  }
  const db = new BuildWardenDatabase(path);
  await db.init();
  databases.push(db);
  return db;
};

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\forge-repo", baseBranch: "main", resolvedName: "Forge repo" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt-5", displayName: "GPT-5", config: {}, capabilities: {}, enabled: true });
  const makeRun = (branchName: string) => db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "codex-app-server",
    mode: "code",
    workspaceType: "worktree",
    prompt: `Work on ${branchName}`,
    branchName,
    worktreePath: `C:\\forge-repo\\${branchName.replace(/\//g, "-")}`,
  });
  return { project, makeRun };
};

const summary: RunForgeRequestSummary = {
  provider: "github",
  number: 42,
  title: "Ship forge status",
  url: "https://github.com/acme/repo/pull/42",
  state: "open",
  readiness: "pending",
  draft: false,
  mergeability: "mergeable",
  reviewDecision: "review-required",
  author: "octocat",
  sourceBranch: "feat/forge",
  targetBranch: "main",
  headSha: "abc123",
  checks: { completed: 4, total: 7, successful: 4, failed: 0, running: 3 },
  unresolvedThreadCount: 0,
  supportedActions: ["refresh", "open", "merge", "close"],
  supportedMergeMethods: ["merge", "squash"],
  updatedAt: "2026-08-08T09:00:00.000Z",
  lastSyncedAt: "2026-08-08T09:01:00.000Z",
  stale: false,
  syncError: null,
};

const details: RunForgeRequestDetailsResult = {
  summary,
  request: {
    provider: summary.provider,
    number: summary.number,
    title: summary.title,
    url: summary.url,
    state: summary.state,
    draft: summary.draft,
    author: summary.author,
    sourceBranch: summary.sourceBranch,
    targetBranch: summary.targetBranch,
    description: "Forge request details",
    authorUser: null,
    labels: [],
    createdAt: "2026-08-08T08:00:00.000Z",
    updatedAt: summary.updatedAt,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    commentCount: 0,
    reviewCommentCount: 0,
  },
  activity: [],
  commits: [],
  files: [],
  reviewThreads: [],
  checks: [],
  warnings: [],
};

describe("run-linked forge persistence", () => {
  it("hydrates summaries in run reads and shares one cached request across runs", async () => {
    const db = await createDb();
    const { project, makeRun } = fixture(db);
    const first = makeRun("feat/forge");
    const second = makeRun("feat/forge-copy");

    db.saveRunForgeRequest(first.id, project.id, first.branchName, summary.headSha, summary, null);
    db.saveRunForgeRequest(second.id, project.id, second.branchName, summary.headSha, summary, null);
    const updatedSummary = { ...summary, title: "Updated forge status" };
    db.saveRunForgeRequest(first.id, project.id, first.branchName, summary.headSha, updatedSummary, null);

    expect(db.listRunsForProject(project.id).filter((run) => run.forgeRequest?.number === 42)).toHaveLength(2);
    expect(db.getRunForgeRequestCache(first.id)?.summary?.checks).toEqual(summary.checks);
    expect(db.getRunForgeRequestCache(second.id)?.summary?.title).toBe(updatedSummary.title);
    db.deleteRun(first.id);
    expect(db.getRunForgeRequestCache(second.id)?.summary?.url).toBe(summary.url);
  });

  it("retains negative probes and stale cached status across a restart", async () => {
    let db = await createDb();
    const { project, makeRun } = fixture(db);
    const linked = makeRun("feat/forge");
    const missing = makeRun("feat/no-request");
    db.saveRunForgeRequest(linked.id, project.id, linked.branchName, summary.headSha, summary, details);
    db.saveRunForgeNegativeProbe(missing.id, missing.branchName, "def456", "2026-08-08T09:20:00.000Z");
    db.saveRunForgeSyncError(linked.id, "GitHub API 401", "2026-08-08T09:05:00.000Z");
    const filePath = db.getFilePath();
    await db.close();
    databases.splice(databases.indexOf(db), 1);
    db = await createDb(filePath);

    expect(db.getRun(linked.id).forgeRequest).toMatchObject({ readiness: "unavailable", stale: true, syncError: "GitHub API 401" });
    expect(db.getRunForgeRequestCache(linked.id)?.details).toMatchObject({
      summary: { readiness: "unavailable", stale: true, syncError: "GitHub API 401" },
      request: { description: "Forge request details" },
    });
    expect(db.getRunForgeRequestCache(missing.id)).toMatchObject({ summary: null, headSha: "def456", negativeCacheUntil: "2026-08-08T09:20:00.000Z" });
  });
});
