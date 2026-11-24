import { existsSync, statSync } from "node:fs";
import {
  APP_SETTING_KEYS,
  type ContinueRunInput,
  isSkillSelection,
  type ProjectRecord,
  type ProjectTaskRecord,
  type RunInput,
  type RunRecord,
  type RunWorkspaceVcs,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { createFolderSnapshot } from "../folder-diff";
import { createFolderWorkspaceCopy, planFolderWorkspaceCopy } from "../folder-workspace";
import { logWarn } from "../logger";
import { canonicalWorkspacePath } from "../workspace-restore-safety";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES, SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";
import { assertModelBelongsToProvider, providerAllowsMissingApiKey } from "./provider-model-support";
import { resolveProviderExecutionOptions } from "./run-execution-settings";
import { buildPromptWithRunGoal, mergeProjectTaskRunAttachments, normalizeRunGoalText } from "./run-step-content";

/** Creates and continues runs and prepares their workspaces. */
export class RunLifecycleService extends AppService<
  | "activeWorkers"
  | "forgeIssueActions"
  | "providerRuntime"
  | "runDeletion"
  | "runEvents"
  | "runForge"
  | "runWorkerHost"
  | "settings"
  | "skills"
  | "turnState"
  | "workspaceGuard"
> {
  private async captureFolderBaselineSnapshot(run: RunRecord): Promise<void> {
    if (run.workspaceVcs !== "folder") {
      return;
    }
    await createFolderSnapshot({
      runId: run.id,
      workspacePath: run.worktreePath,
      snapshotsRoot: this.services.workspaceGuard.getFolderSnapshotRoot(),
    });
  }

  async captureFolderBaselineSnapshotOrFail(run: RunRecord, project: ProjectRecord): Promise<void> {
    try {
      await this.captureFolderBaselineSnapshot(run);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Could not prepare the folder baseline snapshot for this run. ${detail}`;
      this.db.updateRunStatus(run.id, "failed", { errorMessage: message });
      await this.services.runEvents.appendRunEvent(run.id, "error", "Folder snapshot failed", message);
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: "error",
        title: "Folder snapshot failed",
        content: message,
        createdAt: new Date().toISOString(),
      });
      try {
        await this.services.runDeletion.deleteRunResources(project.repoPath, run, "run");
      } catch (cleanupError) {
        logWarn("Failed to clean up folder run resources after snapshot creation failed.", {
          runId: run.id,
          worktreePath: run.worktreePath,
          error: cleanupError,
        });
      }
      throw error;
    }
  }

  async createRun(input: RunInput): Promise<RunRecord> {
    if (input.skillIds !== undefined && !isSkillSelection(input.skillIds)) throw new Error("Invalid run skill selection.");
    const normalizedInput = input.kind === "automation"
      ? {
          ...input,
          yoloMode: true,
          workspaceType: this.db.getProject(input.projectId).kind === "git" ? "worktree" as const : "copy" as const,
        }
      : input;
    if (normalizedInput.workspaceType === "local") {
      return this.services.workspaceGuard.serializeProjectLocalRunStart(normalizedInput.projectId, () => this.createRunInternal(normalizedInput));
    }
    return this.createRunInternal(normalizedInput);
  }

  private async createRunInternal(input: RunInput): Promise<RunRecord> {
    const project = this.db.getProject(input.projectId);
    let projectTask: ProjectTaskRecord | null = null;
    if (input.projectTaskId) {
      projectTask = this.db.getProjectTask(input.projectTaskId);
      if (projectTask.projectId !== project.id) {
        throw new Error("The selected task does not belong to this project.");
      }
    }
    const provider = this.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const initialAttachments = projectTask
      ? mergeProjectTaskRunAttachments(projectTask.attachments, input.attachments)
      : input.attachments;
    validateChatAttachmentPayloads(initialAttachments);
    const userText = input.prompt.trim();
    const attachmentNames = initialAttachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a task description or attach at least one file.");
    }
    const displayPrompt =
      userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : input.prompt);
    const goalText = normalizeRunGoalText(input.goalText);
    const initialPromptForHarness = buildPromptWithRunGoal(displayPrompt, goalText);

    const runInsertInput = input;

    const workspaceType = input.workspaceType ?? (project.kind === "folder" ? "copy" : "worktree");
    const workspaceVcs: RunWorkspaceVcs = project.kind === "folder" ? "folder" : "git";
    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.services.workspaceGuard.getConfiguredWorktreeRoot();
    let branchName: string;
    let worktreePath: string;

    if (project.kind === "folder") {
      if (workspaceType === "worktree") {
        throw new Error("Git worktrees are only available for Git projects.");
      }
      if (workspaceType === "copy") {
        const folderWorkspace = await createFolderWorkspaceCopy({
          sourcePath: project.repoPath,
          projectName: project.name,
          runId: crypto.randomUUID(),
          configuredWorkspaceRoot: configuredWorktreeRoot,
        });
        branchName = folderWorkspace.branchName;
        worktreePath = folderWorkspace.worktreePath;
      } else {
        branchName = "project-folder";
        worktreePath = project.repoPath;
      }
    } else {
      if (workspaceType === "copy") {
        throw new Error("Folder copy runs are only available for non-Git folder projects.");
      }
      if (workspaceType === "local") {
        const activeLocalRun = this.db.listRunsForProject(project.id).find(
          (candidate) => candidate.workspaceType === "local" && ACTIVE_RUN_STATUSES.has(candidate.status),
        );
        if (activeLocalRun) {
          throw new Error("The checked-out project workspace is already used by an active run. Wait for it to finish or use an isolated worktree.");
        }
        branchName = await this.gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
      } else {
        const startPoint = await this.resolveWorktreeStartPoint(project, input.baseBranch?.trim() || project.baseBranch);
        const gitWorkspace = await this.gitService.createWorktreeForRun(
          project.repoPath,
          project.name,
          crypto.randomUUID(),
          startPoint,
          configuredWorktreeRoot,
          workspaceSetupProfile?.dependencies !== "isolated",
        );
        branchName = gitWorkspace.branchName;
        worktreePath = gitWorkspace.worktreePath;
      }
    }

    let run: RunRecord;
    try {
      this.services.workspaceGuard.requireWorkspaceNotRestoring(worktreePath);
      run = this.db.createRun({
        ...runInsertInput,
        workspaceSetupProfile,
        prompt: displayPrompt,
        goalText,
        workspaceType,
        workspaceVcs,
        branchName,
        worktreePath,
      });
    } catch (error) {
      await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, { workspaceType, branchName, worktreePath });
      throw error;
    }

    if (run.projectTaskId) {
      this.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }
    // A run started from a Task Board entry works on the issue that entry tracks, also when the client did not say so.
    this.services.forgeIssueActions.recordForgeIssueLink(input.forgeIssue ?? this.services.forgeIssueActions.findForgeIssueReferenceForTask(project.id, run.projectTaskId), project.id, "run", run.id);

    if (workspaceType === "worktree" || workspaceType === "copy") {
      this.db.upsertWorktree({
        id: run.id,
        projectId: run.projectId,
        runId: run.id,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        status: "ready",
      });
    }

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
    this.services.runForge.syncRunForgeRequestInBackground(run.id, false);

    const initialLogContent = userText || "(no text)";

    await this.services.runEvents.appendRunEvent(run.id, "log", "Initial command", initialLogContent, {
      source: "user",
      commandType: "initial",
      mode: run.mode,
      modelId: run.modelId,
      providerAccountId: run.providerAccountId,
      goalText: run.goalText,
      yoloMode: input.yoloMode === true,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(initialAttachments),
    });
    if (run.goalText) {
      await this.services.runEvents.appendRunEvent(run.id, "status", "Goal set", run.goalText, { goalText: run.goalText });
    }
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      "Run queued",
      workspaceType === "local" ? `Using ${this.services.workspaceGuard.getRunWorkspaceLabel(run)}` : `Preparing workspace ${worktreePath}`,
    );
    run = this.db.updateRunStatus(run.id, "preparing");
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run preparing",
      content: workspaceType === "local" ? `Using workspace ${worktreePath}` : `Created workspace ${worktreePath}`,
      createdAt: new Date().toISOString(),
    });

    if (input.skillIds !== undefined) this.services.skills.skillService.setSelection("run", run.id, input.skillIds);
    await this.captureFolderBaselineSnapshotOrFail(run, project);
    await this.services.turnState.capturePromptRestorePoint(run.id, "initial");
    const worker = await this.services.runWorkerHost.startWorker(
      run,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: initialPromptForHarness || undefined,
        attachments: initialAttachments,
        providerOptions: executionOptions,
        yoloMode: input.yoloMode === true,
      },
    );
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });

    return this.db.getRun(run.id);
  }

  async continueRun(input: ContinueRunInput): Promise<RunRecord> {
    const sourceRun = this.db.getRun(input.sourceRunId);
    if (ACTIVE_RUN_STATUSES.has(sourceRun.status)) {
      throw new Error("Wait for this run to finish before starting a continuation.");
    }
    if (!existsSync(sourceRun.worktreePath) || !statSync(sourceRun.worktreePath).isDirectory()) {
      throw new Error("The source run workspace is no longer available.");
    }
    const initialAttachments = this.services.turnState.getInitialRunAttachments(sourceRun.id);
    validateChatAttachmentPayloads(initialAttachments);

    const project = this.db.getProject(sourceRun.projectId);
    const provider = this.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const userText = input.prompt.trim();
    if (!userText) {
      throw new Error("Enter a continuation prompt.");
    }

    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    const { workspaceType, workspaceVcs, branchName, worktreePath } = await this.services.workspaceGuard.serializeProjectBranchMutation(
      sourceRun.projectId,
      async () => {
        // Keep the source stable while copying changes; undo uses this same project lock.
        this.services.workspaceGuard.requireWorkspaceNotRestoring(canonicalWorkspacePath(sourceRun.worktreePath));
        return this.prepareContinuationWorkspace(
          sourceRun,
          project,
          input.includeWorkspaceChanges !== false,
          configuredWorktreeRoot,
          workspaceSetupProfile?.dependencies !== "isolated",
        );
      },
    );

    const goalText = input.goalText === undefined ? sourceRun.goalText : normalizeRunGoalText(input.goalText);
    const promptForHarness = buildPromptWithRunGoal(userText, goalText);

    let run: RunRecord;
    try {
      run = this.db.createRun({
        projectId: project.id,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: input.harnessType,
        mode: input.mode,
        workspaceType,
        workspaceVcs,
        prompt: userText,
        goalText,
        branchName,
        worktreePath,
        parentRunId: sourceRun.id,
        rootRunId: sourceRun.rootRunId ?? sourceRun.id,
        lineageTitle: sourceRun.prompt || sourceRun.branchName,
        workspaceSetupProfile,
        projectTaskId: sourceRun.projectTaskId,
        delegationEnabled: input.delegationEnabled ?? Boolean(sourceRun.delegationEnabled),
      });
    } catch (error) {
      await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, { workspaceType, branchName, worktreePath });
      throw error;
    }

    if (run.projectTaskId) {
      this.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }

    this.db.upsertWorktree({
      id: run.id,
      projectId: run.projectId,
      runId: run.id,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      status: "ready",
    });

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);

    await this.services.runEvents.appendRunEvent(run.id, "log", "Initial command", userText, {
      source: "user",
      commandType: "initial",
      mode: run.mode,
      modelId: run.modelId,
      providerAccountId: run.providerAccountId,
      goalText: run.goalText,
      yoloMode: input.yoloMode === true,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      executionOptions,
      continuedFromRunId: sourceRun.id,
      continuedFromBranch: sourceRun.branchName,
      includeWorkspaceChanges: input.includeWorkspaceChanges !== false,
      ...this.services.runEvents.buildStoredAttachmentMetadata(initialAttachments),
    });
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      "Continuation queued",
      `Preparing workspace ${worktreePath} from ${this.services.workspaceGuard.getRunWorkspaceLabel(sourceRun)}`,
      {
        continuedFromRunId: sourceRun.id,
        continuedFromBranch: sourceRun.branchName,
      },
    );
    run = this.db.updateRunStatus(run.id, "preparing");
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run preparing",
      content: `Created continuation workspace ${worktreePath}`,
      metadata: {
        continuedFromRunId: sourceRun.id,
        continuedFromBranch: sourceRun.branchName,
      },
      createdAt: new Date().toISOString(),
    });

    await this.captureFolderBaselineSnapshotOrFail(run, project);
    await this.services.turnState.capturePromptRestorePoint(run.id, "initial");
    const worker = await this.services.runWorkerHost.startWorker(
      run,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: promptForHarness,
        attachments: initialAttachments,
        providerOptions: executionOptions,
        yoloMode: input.yoloMode === true,
      },
    );
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });

    return this.db.getRun(run.id);
  }

  resolveWorktreeStartPoint(project: ProjectRecord, baseBranch: string): Promise<string> | string {
    return this.db.getSettings()[APP_SETTING_KEYS.worktreeStartFromRemoteBase] === "true"
      ? this.gitService.resolveFreshBaseStartPoint(project.repoPath, baseBranch)
      : baseBranch;
  }

  /**
   * Where {@link prepareContinuationWorkspace} puts the workspace with this id. Nothing is created,
   * so a caller can record that it owns the workspace before any of it exists.
   */
  planContinuationWorkspace(
    sourceRun: RunRecord,
    project: ProjectRecord,
    includeWorkspaceChanges: boolean,
    configuredWorkspaceRoot: string | undefined,
    workspaceId: string,
  ): Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath"> {
    if (sourceRun.workspaceVcs === "folder") {
      const sourcePath = includeWorkspaceChanges ? sourceRun.worktreePath : project.repoPath;
      return {
        workspaceType: "copy", workspaceVcs: "folder",
        ...planFolderWorkspaceCopy({ sourcePath, projectName: project.name, runId: workspaceId, configuredWorkspaceRoot }),
      };
    }
    return {
      workspaceType: "worktree", workspaceVcs: "git",
      ...this.gitService.planRunWorktree(project.repoPath, project.name, workspaceId, configuredWorkspaceRoot),
    };
  }

  async prepareContinuationWorkspace(
    sourceRun: RunRecord,
    project: ProjectRecord,
    includeWorkspaceChanges: boolean,
    configuredWorkspaceRoot: string | undefined,
    shareDependencies: boolean,
    workspaceId: string = crypto.randomUUID(),
  ): Promise<Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">> {
    if (sourceRun.workspaceVcs === "folder") {
      if (sourceRun.workspaceType === "local" && !includeWorkspaceChanges) {
        throw new Error("Folder continuations from the project folder cannot exclude workspace changes yet.");
      }
      const sourcePath = includeWorkspaceChanges ? sourceRun.worktreePath : project.repoPath;
      const workspace = await createFolderWorkspaceCopy({
        sourcePath,
        projectName: project.name,
        runId: workspaceId,
        configuredWorkspaceRoot,
      });
      return { workspaceType: "copy", workspaceVcs: "folder", ...workspace };
    }

    if (sourceRun.workspaceType === "local" && includeWorkspaceChanges) {
      const currentBranch = await this.gitService.getCurrentBranch(project.repoPath);
      if (currentBranch !== sourceRun.branchName) {
        throw new Error(
          `The project repository is currently on "${currentBranch}", but this run is tied to "${sourceRun.branchName}". Check out the run branch or turn off workspace changes before continuing.`,
        );
      }
    }

    const workspace = await this.gitService.createWorktreeForContinuation(
      project.repoPath,
      project.name,
      workspaceId,
      sourceRun.branchName,
      configuredWorkspaceRoot,
      shareDependencies,
    );
    if (includeWorkspaceChanges) {
      try {
        await this.gitService.cloneWorkspaceChanges(sourceRun.worktreePath, workspace.worktreePath);
      } catch (error) {
        await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, { workspaceType: "worktree", ...workspace });
        throw error;
      }
    }
    return { workspaceType: "worktree", workspaceVcs: "git", ...workspace };
  }
}
