import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { CouncilRound } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";

const tracked: Array<{ db: BuildWardenDatabase; directory: string }> = [];

const makeDb = async () => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-council-db-"));
  const db = new BuildWardenDatabase(join(directory, "state.sqlite"));
  await db.init();
  tracked.push({ db, directory });
  return db;
};

afterEach(async () => {
  for (const entry of tracked.splice(0)) {
    await entry.db.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

const makeRun = (db: BuildWardenDatabase, overrides: Partial<Parameters<BuildWardenDatabase["createRun"]>[0]> = {}) => {
  const project = db.listProjects()[0] ?? db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
  const provider = db.listProviderAccounts()[0] ?? db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.listModels()[0] ?? db.addModel({ providerAccountId: provider.id, modelId: "m", displayName: "M", enabled: true });
  return db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "codex-app-server",
    mode: "code",
    workspaceType: "worktree",
    workspaceVcs: "git",
    prompt: "Do it",
    branchName: "branch",
    worktreePath: "C:\\worktree",
    ...overrides,
  });
};

const makeRound = (run: { id: string; projectId: string }, overrides: Partial<CouncilRound> = {}): CouncilRound => ({
  id: "round", runId: run.id, projectId: run.projectId, status: "ready", kind: "code", trigger: "manual",
  createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:05:00.000Z", deadlineAt: "2026-11-04T10:15:00.000Z",
  minReviews: 1, autoApply: false, authorModelId: "author", authorModelLabel: "Author", subjectFingerprint: "code:a",
  reviews: [], assessment: null, assessmentError: null, summary: null, findings: [], groups: [], appliedGroupIds: [], error: null, stepId: null,
  ...overrides,
});

describe("council persistence", () => {
  it("starts on a database that already has an unrelated council_rounds table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-council-upgrade-"));
    const path = join(directory, "state.sqlite");
    const existing = new DatabaseSync(path);
    existing.exec(`
      create table council_rounds (id text primary key, run_id text not null, request_id text not null, record_json text not null, unique(run_id, request_id));
      insert into council_rounds values ('old', 'old-run', 'request', '{}');
    `);
    existing.close();

    const db = new BuildWardenDatabase(path);
    await db.init();
    tracked.push({ db, directory });
    const run = makeRun(db);
    db.saveCouncilRound(makeRound(run));
    expect(db.listCouncilRounds(run.id)).toHaveLength(1);
    await db.close();
    tracked.pop();

    const reopened = new DatabaseSync(path);
    expect(reopened.prepare("select count(*) as total from council_rounds").get()).toMatchObject({ total: 1 });
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("stores, updates, and finds rounds by status", async () => {
    const db = await makeDb();
    const run = makeRun(db);
    db.saveCouncilRound(makeRound(run, { status: "reviewing" }));
    expect(db.listCouncilRoundsWithStatuses(["reviewing"])).toHaveLength(1);

    db.saveCouncilRound(makeRound(run, { status: "ready", summary: "Done" }));
    expect(db.listCouncilRoundsWithStatuses(["reviewing"])).toEqual([]);
    expect(db.getCouncilRound("round")).toMatchObject({ status: "ready", summary: "Done" });
    expect(db.listCouncilRounds(run.id)).toHaveLength(1);
  });

  it("includes rounds in run detail and removes them with the run", async () => {
    const db = await makeDb();
    const run = makeRun(db);
    db.saveCouncilRound(makeRound(run));
    db.deleteRun(run.id);
    expect(db.listCouncilRounds(run.id)).toEqual([]);
  });

  it("removes rounds with the project", async () => {
    const db = await makeDb();
    const run = makeRun(db);
    db.saveCouncilRound(makeRound(run));
    db.deleteProject(run.projectId);
    expect(db.listCouncilRounds(run.id)).toEqual([]);
  });

  it("finds only a run's review children", async () => {
    const db = await makeDb();
    const parent = makeRun(db);
    const child = makeRun(db, { kind: "council-review", parentRunId: parent.id, rootRunId: parent.id });
    makeRun(db, { kind: "orchestration-task", parentRunId: parent.id, rootRunId: parent.id });
    expect(db.listCouncilChildRunIds(parent.id)).toEqual([child.id]);
  });

  it("keeps reviewer runs out of project lists and the attention inbox", async () => {
    const db = await makeDb();
    const parent = makeRun(db);
    const child = makeRun(db, { kind: "council-review", parentRunId: parent.id, rootRunId: parent.id });
    db.updateRunStatus(child.id, "failed", { errorMessage: "Usage limit" });

    expect(db.listAttentionInbox().map((item) => item.runId)).not.toContain(child.id);
    const project = db.getSnapshot().projects[0]!;
    expect([...project.runs, ...project.orchestratedRuns].map((run) => run.id)).not.toContain(child.id);
  });

  it("announces automatic results, but not ones the user asked for", async () => {
    const db = await makeDb();
    const run = makeRun(db);
    db.saveCouncilRound(makeRound(run, { id: "manual", status: "ready", trigger: "manual" }));
    expect(db.listAttentionInbox().filter((item) => item.id.startsWith("council:"))).toEqual([]);

    db.saveCouncilRound(makeRound(run, { id: "auto", status: "ready", trigger: "auto" }));
    expect(db.listAttentionInbox().find((item) => item.id.startsWith("council:"))).toMatchObject({
      kind: "review",
      detail: "Validation results are ready.",
    });
  });
});
