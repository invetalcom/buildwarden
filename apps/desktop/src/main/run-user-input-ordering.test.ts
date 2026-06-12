import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-run-ordering-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const createRunFixture = (db: BuildWardenDatabase) => {
  const project = db.addProject({
    repoPath: "C:\\repo",
    defaultBranch: "main",
    resolvedName: "Repo",
  });
  const provider = db.addProviderAccount({
    providerType: "codex-cli",
    label: "Codex",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const model = db.addModel({
    providerAccountId: provider.id,
    modelId: "gpt-5.3-codex",
    displayName: "Codex",
    config: {},
    capabilities: {},
    enabled: true,
  });

  return db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "codex-app-server",
    mode: "code",
    workspaceType: "worktree",
    prompt: "Initial prompt",
    branchName: "main",
    worktreePath: "C:\\repo",
  });
};

const waitForDistinctTimestamp = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("run user-input ordering metadata", () => {
  it("derives lastUserInputAt from user prompt steps instead of later run activity", async () => {
    const db = await makeDb();
    const run = createRunFixture(db);

    const initialPrompt = db.appendRunStep(run.id, "log", "Initial command", "Initial prompt", JSON.stringify({ source: "user" }));
    await waitForDistinctTimestamp();
    db.appendRunStep(run.id, "status", "Run update", "The agent is working.");
    const followUpPrompt = db.appendRunStep(run.id, "log", "Follow-up command", "Follow-up prompt", JSON.stringify({ source: "user" }));
    db.appendRunStep(run.id, "output", "Agent output", "Output after the follow-up.");
    await waitForDistinctTimestamp();
    db.updateRunStatus(run.id, "running");

    const loaded = db.getRun(run.id);

    expect(loaded.lastUserInputAt).toBe(followUpPrompt.createdAt);
    expect(loaded.lastUserInputAt).not.toBe(loaded.updatedAt);
    expect(loaded.lastUserInputAt).not.toBe(initialPrompt.createdAt);
  });

  it("preserves derived run metadata when loading project run lists in batch", async () => {
    const db = await makeDb();
    const firstRun = createRunFixture(db);
    const secondRun = db.createRun({
      projectId: firstRun.projectId,
      providerAccountId: firstRun.providerAccountId,
      modelId: firstRun.modelId,
      harnessType: firstRun.harnessType,
      mode: "code",
      workspaceType: "worktree",
      prompt: "Second initial prompt",
      branchName: "main",
      worktreePath: "C:\\repo",
    });

    const followUpPrompt = db.appendRunStep(
      firstRun.id,
      "log",
      "Follow-up command",
      "Follow-up prompt",
      JSON.stringify({ source: "user" }),
    );
    db.appendRunStep(
      firstRun.id,
      "user-input-requested",
      "Needs input",
      "Pick an option",
      JSON.stringify({ requestKind: "user-input", requestStatus: "opened" }),
    );
    const submittedInput = db.appendRunStep(
      secondRun.id,
      "user-input-requested",
      "Answered input",
      "Resolved answer",
      JSON.stringify({ requestKind: "user-input", requestStatus: "resolved" }),
    );

    const runsById = new Map(db.listRunsForProject(firstRun.projectId).map((run) => [run.id, run]));
    const loadedFirstRun = runsById.get(firstRun.id);
    const loadedSecondRun = runsById.get(secondRun.id);

    expect(loadedFirstRun?.lastUserInputAt).toBe(followUpPrompt.createdAt);
    expect(loadedFirstRun?.pendingUserInputRequest).toBe(true);
    expect(loadedFirstRun?.userInputSearchText).toContain("Follow-up prompt");
    expect(loadedSecondRun?.lastUserInputAt).toBe(submittedInput.createdAt);
    expect(loadedSecondRun?.pendingUserInputRequest).toBe(false);
    expect(loadedSecondRun?.userInputSearchText).toContain("Resolved answer");
  });

  it("loads project lab thread details with events and implementation runs", async () => {
    const db = await makeDb();
    const run = createRunFixture(db);
    const thread = db.createProjectLabThread({
      projectId: run.projectId,
      kind: "implementation",
      mode: "refactoring",
      status: "completed",
      origin: "manual",
      title: "Speed up project reads",
      summary: "Batch the expensive reads.",
      implementationRunId: run.id,
      implementationModelId: run.modelId,
      baseBranch: "main",
    });
    const event = db.appendProjectLabEvent({
      threadId: thread.id,
      role: "implementation",
      label: "Result",
      content: "Implemented batching.",
    });

    const details = db.listProjectLabThreadDetails(run.projectId);

    expect(details).toHaveLength(1);
    expect(details[0]?.thread.id).toBe(thread.id);
    expect(details[0]?.events[0]?.id).toBe(event.id);
    expect(details[0]?.implementationRun?.id).toBe(run.id);
  });
});
