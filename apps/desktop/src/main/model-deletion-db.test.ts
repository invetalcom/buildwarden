import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { ProjectAutomationInput } from "@buildwarden/shared";
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
  it("links automation definitions and all of their hidden run history to the configured model", async () => {
    const db = await makeDatabase();
    const project = db.addProject({ repoPath: "C:\\automation-repo", baseBranch: "main", resolvedName: "Automation Repo" });
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
    const oldModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "old-model",
      displayName: "Old model",
      config: {},
      capabilities: {},
    });
    const attachment = { fileName: "instructions.md", mimeType: "text/markdown", dataBase64: "IyBUYXNr" };
    const automation = db.createProjectAutomation(project.id, {
      name: "Daily review",
      prompt: "Review dependencies",
      attachments: [attachment],
      cronExpression: "0 9 * * *",
      timeZone: "UTC",
      modelId: targetModel.id,
      effort: "high",
      executionOptions: { reasoningEffort: "high", serviceTier: "priority" },
      workspaceType: "worktree",
      baseBranch: "develop",
    }, "2026-08-20T09:00:00.000Z", "UTC");
    const historicalRun = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: oldModel.id,
      harnessType: "ai-sdk",
      mode: "code",
      workspaceType: "worktree",
      prompt: automation.prompt,
      branchName: "automation/history",
      worktreePath: "C:\\automation-worktree",
      kind: "automation",
      automationId: automation.id,
    });

    expect(db.getSnapshot().projects[0]?.automations?.[0]).toMatchObject({
      automation: {
        id: automation.id,
        attachmentCount: 1,
        effort: "high",
        baseBranch: "develop",
        executionOptions: { reasoningEffort: "high", serviceTier: "priority" },
      },
      runs: [{ id: historicalRun.id, automationId: automation.id }],
    });
    expect(db.getModelDeletionTargets(targetModel.id)).toEqual({
      runIds: [historicalRun.id],
      chatIds: [],
      projectInsightIds: [],
      projectLabThreadIds: [],
      projectLoopIds: [],
      orchestrationIds: [],
      automationIds: [automation.id],
    });
  });

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
      runIds: [directRun.id, labRun.id, loopRun.id].sort((left, right) => left.localeCompare(right)),
      chatIds: [standaloneChat.id, runChat.id].sort((left, right) => left.localeCompare(right)),
      projectInsightIds: [insight.id],
      projectLabThreadIds: [labThread.id],
      projectLoopIds: [loop.id],
      orchestrationIds: [],
      automationIds: [],
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
      automationIds: [],
    });
  });

  it("expands a task model through its orchestration coordinator and child runs", async () => {
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
    const coordinatorModel = db.addModel({
      providerAccountId: provider.id,
      modelId: "coordinator-model",
      displayName: "Coordinator model",
      config: {},
      capabilities: {},
    });
    const createRun = (branchName: string, parentRunId?: string) => db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: coordinatorModel.id,
      harnessType: "ai-sdk",
      mode: "code",
      workspaceType: "local",
      prompt: branchName,
      branchName,
      worktreePath: project.repoPath,
      kind: parentRunId ? "orchestration-task" : "standard",
      parentRunId,
      rootRunId: parentRunId,
      delegationEnabled: !parentRunId,
    });
    const coordinator = createRun("coordinator");
    const child = createRun("child", coordinator.id);
    const orchestration = db.createOrchestration({
      projectId: project.id,
      coordinatorRunId: coordinator.id,
      teamSnapshot: {
        version: 1,
        maxConcurrentTasks: 2,
        maxTasksPerOrchestration: 4,
        models: [{ modelId: targetModel.id, enabled: true, maxConcurrent: 1 }],
        roles: [{
          id: "implementer",
          name: "Implementer",
          description: "Implements tasks",
          eligibleModelIds: [targetModel.id],
          preferredModelId: targetModel.id,
          maxConcurrent: 1,
        }],
      },
    });
    const wave = db.createOrchestrationWave(orchestration.id);
    db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      clientTaskId: "task-1",
      title: "Implement",
      prompt: "Implement the change",
      roleId: "implementer",
      modelId: targetModel.id,
      intent: "implement",
      childRunId: child.id,
    });

    expect(db.getModelDeletionTargets(targetModel.id)).toEqual({
      runIds: [child.id, coordinator.id].sort((left, right) => left.localeCompare(right)),
      chatIds: [],
      projectInsightIds: [],
      projectLabThreadIds: [],
      projectLoopIds: [],
      orchestrationIds: [orchestration.id],
      automationIds: [],
    });
  });
});

describe("automation workspace migration", () => {
  it("moves a legacy local Git automation to an isolated worktree", async () => {
    const db = await makeDatabase();
    const project = db.addProject({ repoPath: "C:\\automation-repo", baseBranch: "main", resolvedName: "Automation Repo" });
    const provider = db.addProviderAccount({
      providerType: "ai-sdk",
      label: "AI SDK",
      apiBaseUrl: null,
      apiKeyRef: "",
      configJson: "{}",
    });
    const model = db.addModel({
      providerAccountId: provider.id,
      modelId: "automation-model",
      displayName: "Automation model",
      config: {},
      capabilities: {},
    });
    const legacyInput = {
      name: "Legacy local automation",
      prompt: "Review the project",
      cronExpression: "0 9 * * *",
      timeZone: "UTC",
      modelId: model.id,
      workspaceType: "local",
      baseBranch: "main",
    } as unknown as ProjectAutomationInput;
    const automation = db.createProjectAutomation(
      project.id,
      legacyInput,
      "2026-08-20T09:00:00.000Z",
      "UTC",
    );
    const databasePath = db.getFilePath();
    await db.close();

    const reopened = new BuildWardenDatabase(databasePath);
    await reopened.init();
    databases.push(reopened);

    expect(reopened.getProjectAutomation(automation.id)).toMatchObject({
      workspaceType: "worktree",
      baseBranch: "main",
    });
  });
});
