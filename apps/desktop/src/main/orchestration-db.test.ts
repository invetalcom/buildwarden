import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { OrchestrationTeamSettings } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";

const tracked: Array<{ db: BuildWardenDatabase; directory: string }> = [];

const makeDb = async () => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-orchestration-db-"));
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

const makeFixture = async (db: BuildWardenDatabase) => {
  const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
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
  const coordinator = db.createRun({
    projectId: project.id,
    providerAccountId: provider.id,
    modelId: model.id,
    harnessType: "codex-app-server",
    mode: "code",
    workspaceType: "local",
    prompt: "Coordinate the implementation",
    branchName: "main",
    worktreePath: project.repoPath,
    delegationEnabled: true,
  });
  const team: OrchestrationTeamSettings = {
    version: 1,
    maxConcurrentTasks: 3,
    maxTasksPerOrchestration: 12,
    models: [{ modelId: model.id, enabled: true, defaultEffort: "high", maxConcurrent: 2 }],
    roles: [{
      id: "implementer",
      name: "Implementer",
      description: "Implements isolated work.",
      eligibleModelIds: [model.id],
      preferredModelId: model.id,
      maxConcurrent: 2,
    }],
  };
  return { project, provider, model, coordinator, team };
};

describe("durable orchestration database", () => {
  it("round-trips the frozen team, graph, messages, adoption, operations, and monotonic events", async () => {
    const db = await makeDb();
    const { project, model, coordinator, team } = await makeFixture(db);
    const orchestration = db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: team,
    });
    const wave = db.createOrchestrationWave(orchestration.id, "C:\\artifacts\\baseline");
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      clientTaskId: "client-task-1",
      title: "Implement persistence",
      prompt: "Add durable storage",
      roleId: "implementer",
      modelId: model.id,
      intent: "implement",
    });
    db.updateOrchestrationTask(task.id, { status: "running", inputTokens: 25, outputTokens: 10 });
    const firstEvent = db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: "task-started",
      title: "Started",
      content: "Child launched.",
    });
    const secondEvent = db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: "attention",
      title: "Input needed",
      content: "Choose an API.",
      metadata: { reason: "input" },
    });
    db.createOrchestrationTaskMessage({
      orchestrationId: orchestration.id,
      taskId: task.id,
      source: "user",
      content: "Use the typed API.",
    });
    db.upsertOrchestrationAdoption({
      orchestrationId: orchestration.id,
      taskId: task.id,
      status: "proposed",
      manifest: { changedFiles: ["src/index.ts"] },
      backupPath: "C:\\artifacts\\backup",
    });
    db.createOrchestrationOperation({
      orchestrationId: orchestration.id,
      requestId: "stable-request-1",
      toolName: "buildwarden_tasks_delegate",
      requestHash: "hash-1",
    });
    db.completeOrchestrationOperation(orchestration.id, "stable-request-1", "completed", { taskId: task.id });
    await db.flushDurable();

    const detail = db.getOrchestrationDetailByCoordinatorRunId(coordinator.id);
    expect(detail?.orchestration.teamSnapshot).toEqual(team);
    expect([firstEvent.sequence, secondEvent.sequence]).toEqual([1, 2]);
    expect(detail?.messages[0]?.content).toBe("Use the typed API.");
    expect(detail?.totalInputTokens).toBe(25);
    expect(detail?.totalOutputTokens).toBe(10);
    expect(db.getOrchestrationAdoption(task.id)?.manifest).toEqual({ changedFiles: ["src/index.ts"] });
    expect(db.getOrchestrationOperation(orchestration.id, "stable-request-1")).toMatchObject({
      requestHash: "hash-1",
      status: "completed",
    });
  });

  it("hides child runs from normal project history and deletes the orchestration graph independently", async () => {
    const db = await makeDb();
    const { project, provider, model, coordinator, team } = await makeFixture(db);
    const orchestration = db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: team,
    });
    const wave = db.createOrchestrationWave(orchestration.id, "C:\\artifacts\\baseline");
    const child = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: "Child work",
      branchName: "feat/child",
      worktreePath: "C:\\owned\\child",
      kind: "orchestration-task",
      parentRunId: coordinator.id,
      rootRunId: coordinator.id,
      delegationEnabled: false,
    });
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      clientTaskId: "child-1",
      title: "Child",
      prompt: "Child work",
      roleId: "implementer",
      modelId: model.id,
      intent: "implement",
      childRunId: child.id,
    });
    db.createOrchestrationTaskMessage({ orchestrationId: orchestration.id, taskId: task.id, source: "coordinator", content: "Continue." });
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "queued", title: "Queued", content: "" });
    db.updateRunStatus(coordinator.id, "completed");
    db.updateOrchestration(orchestration.id, { status: "waiting", wakeMode: "all-terminal", wakeTaskIds: [task.id] });

    const projectSnapshot = db.getSnapshot().projects[0]!;
    expect(projectSnapshot.runs.map((run) => run.id)).toContain(coordinator.id);
    expect(projectSnapshot.runs.map((run) => run.id)).not.toContain(child.id);
    expect(projectSnapshot.orchestratedRuns.map((run) => run.id)).toEqual([child.id]);
    expect(projectSnapshot.runs.find((run) => run.id === coordinator.id)).toMatchObject({
      status: "completed",
      orchestrationStatus: "waiting",
    });
    expect(projectSnapshot.activeRuns.map((run) => run.id)).toContain(coordinator.id);

    db.deleteOrchestrationData(orchestration.id);
    expect(db.getOrchestrationDetailByCoordinatorRunId(coordinator.id)).toBeNull();
    expect(() => db.getOrchestrationTask(task.id)).toThrow("not found");
    expect(db.getRun(child.id).id).toBe(child.id);
  });

  it("persists retryable cleanup jobs until explicitly completed", async () => {
    const db = await makeDb();
    const { coordinator, project, team } = await makeFixture(db);
    const orchestration = db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: team,
    });
    const jobId = db.createOrchestrationCleanupJob({
      coordinatorRunId: coordinator.id,
      orchestrationId: orchestration.id,
      manifest: { runIds: [coordinator.id], ownedDirectories: ["C:\\owned\\coordinator"] },
    });
    db.updateOrchestrationCleanupJob(jobId, "failed", "directory locked");
    await db.flushDurable();
    expect(db.listPendingOrchestrationCleanupJobs()).toEqual([
      expect.objectContaining({ id: jobId, status: "failed", errorMessage: "directory locked" }),
    ]);
    db.completeOrchestrationCleanupJob(jobId);
    expect(db.listPendingOrchestrationCleanupJobs()).toEqual([]);
  });
});
