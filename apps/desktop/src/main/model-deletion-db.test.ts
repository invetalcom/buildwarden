import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

const makeDatabase = async (): Promise<BuildWardenDatabase> => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-model-deletion-"));
  tempDirs.push(directory);
  const database = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await database.init();
  databases.push(database);
  return database;
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model deletion targets", () => {
  it("expands related runs through Lab threads and project loops", async () => {
    const db = await makeDatabase();
    const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
    const provider = db.addProviderAccount({
      providerType: "ai-sdk",
      label: "AI SDK",
      apiBaseUrl: null,
      apiKeyRef: "",
      configJson: "{}",
    });
    const targetModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "target-model",
      displayName: "Target model",
      config: {},
      capabilities: {},
    });
    const otherModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "other-model",
      displayName: "Other model",
      config: {},
      capabilities: {},
    });
    const createRun = (modelId: string, branchName: string) => db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId,
      harnessType: "ai-sdk",
      mode: "code",
      workspaceType: "local",
      prompt: branchName,
      branchName,
      worktreePath: project.repoPath,
    });
    const directRun = createRun(targetModel.id, "direct");
    const labRun = createRun(otherModel.id, "lab");
    const loopRun = createRun(otherModel.id, "loop");
    const standaloneChat = db.createChat(provider.id, targetModel.id, "Standalone");
    const runChat = db.createChat(provider.id, otherModel.id, "Run chat", directRun.id);
    const insight = db.upsertProjectInsight({
      projectId: project.id,
      kind: "curiosity-mode",
      title: "Insight",
      summary: "Summary",
      dataJson: "{}",
      modelId: targetModel.id,
    });
    const labThread = db.createProjectLabThread({
      projectId: project.id,
      kind: "implementation",
      mode: "new-feature",
      status: "completed",
      origin: "manual",
      title: "Lab",
      summary: "Summary",
      implementationRunId: labRun.id,
      implementationModelId: otherModel.id,
      reviewModelId: targetModel.id,
    });
    const loop = db.createProjectLoop({
      projectId: project.id,
      name: "Loop",
      prompt: "Prompt",
      runnerModelId: targetModel.id,
      mergePolicy: "wait-for-approval",
      uiChangePolicy: "auto",
      baseBranch: "main",
      status: "completed",
    });
    const iteration = db.createProjectLoopIteration({
      loopId: loop.id,
      iterationIndex: 0,
      title: "Iteration",
      objective: "Objective",
    });
    db.updateProjectLoopIteration(iteration.id, { runId: loopRun.id });

    expect(db.getModelDeletionTargets(targetModel.id)).toEqual({
      runIds: [directRun.id, labRun.id, loopRun.id].sort(),
      chatIds: [standaloneChat.id, runChat.id].sort(),
      projectInsightIds: [insight.id],
      projectLabThreadIds: [labThread.id],
      projectLoopIds: [loop.id],
      orchestrationIds: [],
    });
  });

  it("does not delete an orchestration merely because its frozen team lists an unused model", async () => {
    const db = await makeDatabase();
    const project = db.addProject({ repoPath: "C:\\repo", baseBranch: "main", resolvedName: "Repo" });
    const provider = db.addProviderAccount({
      providerType: "ai-sdk",
      label: "AI SDK",
      apiBaseUrl: null,
      apiKeyRef: "",
      configJson: "{}",
    });
    const targetModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "unused-model",
      displayName: "Unused model",
      config: {},
      capabilities: {},
    });
    const activeModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "active-model",
      displayName: "Active model",
      config: {},
      capabilities: {},
    });
    const coordinator = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: activeModel.id,
      harnessType: "ai-sdk",
      mode: "code",
      workspaceType: "local",
      prompt: "Coordinate",
      branchName: "main",
      worktreePath: project.repoPath,
      delegationEnabled: true,
    });
    db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: {
        version: 1,
        maxConcurrentTasks: 2,
        maxTasksPerOrchestration: 4,
        models: [
          { modelId: targetModel.id, enabled: false, maxConcurrent: 1 },
          { modelId: activeModel.id, enabled: true, maxConcurrent: 1 },
        ],
        roles: [{
          id: "implementer",
          name: "Implementer",
          description: `Does not use ${targetModel.id}`,
          eligibleModelIds: [activeModel.id],
          preferredModelId: activeModel.id,
          maxConcurrent: 1,
        }],
      },
    });

    expect(db.getModelDeletionTargets(targetModel.id)).toEqual({
      runIds: [],
      chatIds: [],
      projectInsightIds: [],
      projectLabThreadIds: [],
      projectLoopIds: [],
      orchestrationIds: [],
    });
  });
});
