import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  type AppWarning,
  type AssistProjectForgeIssueInput,
  type ChatAttachmentPayload,
  type ChatEvent,
  type ChatInput,
  commandToExactShellPatternSource,
  type CommentProjectForgeIssueInput,
  type ContinueRunInput,
  type CreateProjectBranchInput,
  type CreateProjectForgeIssueInput,
  type CreateProjectLoopInput,
  type DeleteProjectBranchInput,
  type DesktopApi,
  type FetchProjectPrMrDiffInput,
  type FollowUpChatOptions,
  type FollowUpDelivery,
  type FollowUpQueueAction,
  type GenerateProjectInsightInput,
  getHarnessCapabilities,
  type GetProjectForgeIssueDetailsInput,
  type GetProjectForgeIssueImageInput,
  type GetProjectForgeRequestDetailsInput,
  isSkillSelection,
  isThemeToolName,
  type ListAvailableProviderModelsInput,
  type ListComposerCommandsInput,
  type ListProjectForgeIssuesInput,
  type ListProjectForgeRequestsInput,
  type ManageOwnedProcessesInput,
  type MergeProjectBranchInput,
  type MergeProjectForgeRequestInput,
  type MergeRunForgeRequestInput,
  type ModelInput,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  type NetworkProxySettingsInput,
  type OrchestrationAdoptionDecisionInput,
  type OrchestrationChangedPayload,
  type OrchestrationTaskMessageInput,
  type OwnedProcessOwner,
  parseHarnessSessionCapabilities,
  parseProjectRunDefaultsSetting,
  parseShellAllowlistExtraSetting,
  parseToolApprovalAllowlistSetting,
  type PostProjectPrMrReviewInput,
  type ProjectActivityQueryInput,
  type ProjectAutomationInput,
  type ProjectForgePrMonitorConfig,
  type ProjectForgePrMonitorSettingsInput,
  type ProjectInput,
  type ProjectLoopChangedPayload,
  type ProjectLoopUiReviewDecisionInput,
  type ProjectRecord,
  type ProjectTaskInput,
  type ProjectTaskRecord,
  type ProviderAccountInput,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  type ProviderType,
  type PullProjectBranchInput,
  type PushProjectBranchInput,
  type RebaseProjectBranchInput,
  type RenameProjectBranchInput,
  type RendererLogPayload,
  type ReplyProjectPrMrReviewThreadInput,
  type ResolveProjectPrMrReviewThreadInput,
  RUN_VERIFICATION_FAILURE_PREFIX,
  type RunChatInput,
  type RunDiffReviewOptions,
  type RunEvent,
  type RunFollowUpOptions,
  type RunInput,
  type RunListVisibility,
  type RunProjectLabInput,
  type RunRecord,
  type RunResumeCheckpoint,
  type RunRewindInput,
  type RunStepRecord,
  type RunTokenUsage,
  type RunToolResult,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
  type RunWorkspaceFileInput,
  type RunWorkspaceVcs,
  type SecretStore,
  type ShellApprovalDecision,
  type ShellApprovalRespondOptions,
  type SkillImportInput,
  type StartPrWatchInput,
  type SubmitProjectPrMrCommentsInput,
  type SubscriptionLimitsInput,
  type SubscriptionResetInput,
  type SupportedIdeKind,
  type UpdateProjectAutomationInput,
  type UpdateProjectForgeIssueInput,
  type UpdateProjectForgeRequestInput,
  type UpdateProjectTaskInput,
  type UpdateRunForgeRequestInput,
  type UpdateRunNoteInput,
  type UpdateRunOrganizationInput,
  type UsageCostReportInput,
  type UserAnchoredHistoryPageRequest,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { getCompileCacheWorkerData } from "./compile-cache";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { createFolderSnapshot } from "./folder-diff";
import { createFolderWorkspaceCopy, planFolderWorkspaceCopy } from "./folder-workspace";
import { HostEventBus } from "./host-events";
import type { HostTerminal } from "./host-terminal-service";
import { logWarn } from "./logger";
import { resolveMcpServerRuntimeConfigs } from "./mcp-server-registry";
import { isOrchestrationToolName, ORCHESTRATION_TOOL_DEFINITIONS, orchestrationToolFailure } from "./orchestration-tools";
import type { ProjectVerificationResult } from "./project-verification";
import {
  buildContextHandoffBlock,
  findLatestAccountStepMetadata,
  modelHandoffContextFor,
  planContextHandoff,
  selectHandoffAttachments,
  withContextHandoff,
} from "./provider-context-handoff";
import { createResponseImageEmbedder } from "./response-images";
import { type RunBudgetExhaustion, timeBudgetExhaustion, tokenBudgetExhaustion } from "./run-autonomy-budget";
import { type AppControllerLifecycle, AppServiceContext } from "./services/app-service";
import { ACTIVE_RUN_STATUSES, AZURE_LEGACY_AUTO_RECOVERY_KIND, SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./services/app-service-constants";
import type { AppServices } from "./services/app-services";
import { createAppServices } from "./services/create-app-services";
import { ORCHESTRATION_CANCELLABLE_STATUSES } from "./services/orchestration-policy";
import { assertModelBelongsToProvider, providerAllowsMissingApiKey } from "./services/provider-model-support";
import { resolveProviderExecutionOptions } from "./services/run-execution-settings";
import {
  buildPromptWithRunGoal,
  mergeProjectTaskRunAttachments,
  normalizeAssistantOutputText,
  normalizeRunGoalText,
  parseMetadataRecord,
  runChunkEventType,
} from "./services/run-step-content";
import { resetUsageBaselineForFreshSession, type RunWorkerPayload } from "./services/worker-payloads";
import { advanceUsageTracker, EMPTY_REPORTED_TOKEN_USAGE, readReportedTokenUsage, type UsageReportTracker } from "./token-usage-accounting";
import { canonicalWorkspacePath } from "./workspace-restore-safety";

const SHELL_APPROVAL_DECISION_MESSAGES: Record<string, { title: string; content: string }> = {
  deny: { title: "Shell command denied", content: "The requested shell command was denied." },
  "allow-for-run": {
    title: "Shell command allowed for run",
    content: "The requested shell command was allowed and will stay allowed for this run.",
  },
  "allow-always": {
    title: "Shell command allowed and saved to settings",
    content:
      "The requested shell command was allowed. An exact-match pattern was added to Settings > Projects & Workspace > Shell allowlist.",
  },
  "allow-once": { title: "Shell command allowed once", content: "The requested shell command was allowed once." },
};

const AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE = "The run exceeded the maximum number of tool rounds (Azure Legacy).";

const AZURE_LEGACY_AUTO_RECOVERY_PROMPT =
  "Go ahead. The last session was interrupted. Trigger a full build or test first to see if you are done or not. If it fails, go ahead and fix the issues.";

type RunTerminalOutcome = {
  title: string;
  content: string;
  status: "cancelled" | "failed" | "completed";
  errorMessage: string | null;
};

const buildRunTerminalOutcome = (input: {
  wasCancelled: boolean;
  budgetExhaustion: RunBudgetExhaustion | undefined;
  failedVerificationResult: ProjectVerificationResult | undefined;
  waitingForSubagents: boolean;
  inputTokens: number;
  outputTokens: number;
}): RunTerminalOutcome => {
  const usage = `Input tokens: ${input.inputTokens}\nOutput tokens: ${input.outputTokens}`;
  if (input.wasCancelled) {
    return {
      title: "Run cancelled",
      content: `Run cancellation finished cleanup.\n${usage}`,
      status: "cancelled",
      errorMessage: "Run cancelled by user.",
    };
  }
  if (input.budgetExhaustion) {
    return {
      title: "Autonomy budget exhausted",
      content: `${input.budgetExhaustion.reason}\n${usage}`,
      status: "failed",
      errorMessage: input.budgetExhaustion.reason,
    };
  }
  if (input.failedVerificationResult) {
    return {
      title: "Verification gate failed",
      content: `The agent turn finished, but the verification gate failed at: ${input.failedVerificationResult.command}.\n${usage}`,
      status: "failed",
      errorMessage: `${RUN_VERIFICATION_FAILURE_PREFIX}${input.failedVerificationResult.command}`,
    };
  }
  if (input.waitingForSubagents) {
    return {
      title: "Waiting for subagents to complete",
      content: `The coordinator turn completed and is waiting for delegated subagents.\n${usage}`,
      status: "completed",
      errorMessage: null,
    };
  }
  return {
    title: "Run completed",
    content: `Run completed successfully.\n${usage}`,
    status: "completed",
    errorMessage: null,
  };
};

/** The app's API. Every method is implemented by one of the services in `services/`. */
export class AppController
  implements
    Omit<
      DesktopApi,
      | "getRemoteAccessStatus"
      | "getDesignBackgroundImage"
      | "setDesignBackgroundImage"
      | "listHostDirectories"
      | "createRemoteAccessPairing"
      | "listRemoteAccessSessions"
      | "revokeRemoteAccessSession"
      | "onRunEvent"
      | "ensureRunBrowser"
      | "getRunBrowserPreview"
      | "navigateRunBrowser"
      | "runBrowserAction"
      | "setRunBrowserViewport"
      | "setRunBrowserDesktopSurface"
      | "getRunBrowserElementCapture"
      | "sendRunBrowserInput"
      | "onRunBrowserEvent"
      | "runTerminalList"
      | "runTerminalStart"
      | "runTerminalWrite"
      | "runTerminalResize"
      | "runTerminalKill"
      | "onRunTerminalData"
      | "onRunTerminalExit"
      | "onAppMenuCommand"
      | "consumePendingDeepLink"
      | "onDeepLinkReceived"
      | "onAppSettingsChanged"
      | "onProviderCliUpdatesChanged"
      | "onOwnedProcessesChanged"
      | "onProjectForgeRequestOpen"
      | "onProjectForgeRequestNotification"
      | "onRunForgeRequestChanged"
      | "onProjectTaskChanged"
      | "onRunOrganizationChanged"
      | "onOrchestrationChanged"
      | "showAppMenu"
      | "openSystemTerminalAtPath"
      | "openExternalUrl"
      | "exportDataBackup"
      | "selectDataBackupForImport"
      | "importDataBackup"
    >
{
  private readonly context: AppServiceContext;
  private readonly services: AppServices;

  constructor(
    db: BuildWardenDatabase,
    secrets: SecretStore,
    logDirPath: string,
    desktop: AppControllerDesktopServices,
    terminal: Pick<HostTerminal, "killForRunId">,
    events: HostEventBus,
    lifecycle?: AppControllerLifecycle,
  ) {
    const context = new AppServiceContext(db, secrets, logDirPath, desktop, terminal, events, lifecycle);
    this.context = context;
    this.services = createAppServices(context, this);
  }

  private readonly runShellApprovalStepIds = new Map<string, string>();
  private readonly runUserInputStepIds = new Map<string, string>();
  /** What each provider account's latest session reported about the installed agent. */
  /** Tool identity of open non-shell approval requests, keyed like {@link runShellApprovalStepIds}. */
  private readonly runToolApprovalKeys = new Map<string, string>();
  /** Open approval requests (by step key) that may only be allowed once. */
  private readonly runOnceOnlyApprovals = new Set<string>();
  /**
   * The model each live run's provider last said served it. The reports are silent chunks, which
   * are not saved as steps, so publication copies the value into its durable effect.
   */
  readonly runExecutedModels = new Map<string, string>();

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
      this.context.db.updateRunStatus(run.id, "failed", { errorMessage: message });
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
          workspaceType: this.context.db.getProject(input.projectId).kind === "git" ? "worktree" as const : "copy" as const,
        }
      : input;
    if (normalizedInput.workspaceType === "local") {
      return this.services.workspaceGuard.serializeProjectLocalRunStart(normalizedInput.projectId, () => this.createRunInternal(normalizedInput));
    }
    return this.createRunInternal(normalizedInput);
  }

  private async createRunInternal(input: RunInput): Promise<RunRecord> {
    const project = this.context.db.getProject(input.projectId);
    let projectTask: ProjectTaskRecord | null = null;
    if (input.projectTaskId) {
      projectTask = this.context.db.getProjectTask(input.projectTaskId);
      if (projectTask.projectId !== project.id) {
        throw new Error("The selected task does not belong to this project.");
      }
    }
    const provider = this.context.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.context.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

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
        const activeLocalRun = this.context.db.listRunsForProject(project.id).find(
          (candidate) => candidate.workspaceType === "local" && ACTIVE_RUN_STATUSES.has(candidate.status),
        );
        if (activeLocalRun) {
          throw new Error("The checked-out project workspace is already used by an active run. Wait for it to finish or use an isolated worktree.");
        }
        branchName = await this.context.gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
      } else {
        const startPoint = await this.resolveWorktreeStartPoint(project, input.baseBranch?.trim() || project.baseBranch);
        const gitWorkspace = await this.context.gitService.createWorktreeForRun(
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
      run = this.context.db.createRun({
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
      this.context.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }
    // A run started from a Task Board entry works on the issue that entry tracks, also when the client did not say so.
    this.services.forgeIssueActions.recordForgeIssueLink(input.forgeIssue ?? this.services.forgeIssueActions.findForgeIssueReferenceForTask(project.id, run.projectTaskId), project.id, "run", run.id);

    if (workspaceType === "worktree" || workspaceType === "copy") {
      this.context.db.upsertWorktree({
        id: run.id,
        projectId: run.projectId,
        runId: run.id,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        status: "ready",
      });
    }

    this.context.db.touchProject(project.id);
    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.context.db.setSetting(SELECTED_RUN_KEY, run.id);
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
    run = this.context.db.updateRunStatus(run.id, "preparing");
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
    const worker = await this.startWorker(
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

    return this.context.db.getRun(run.id);
  }

  async continueRun(input: ContinueRunInput): Promise<RunRecord> {
    const sourceRun = this.context.db.getRun(input.sourceRunId);
    if (ACTIVE_RUN_STATUSES.has(sourceRun.status)) {
      throw new Error("Wait for this run to finish before starting a continuation.");
    }
    if (!existsSync(sourceRun.worktreePath) || !statSync(sourceRun.worktreePath).isDirectory()) {
      throw new Error("The source run workspace is no longer available.");
    }
    const initialAttachments = this.services.turnState.getInitialRunAttachments(sourceRun.id);
    validateChatAttachmentPayloads(initialAttachments);

    const project = this.context.db.getProject(sourceRun.projectId);
    const provider = this.context.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.context.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const userText = input.prompt.trim();
    if (!userText) {
      throw new Error("Enter a continuation prompt.");
    }

    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.context.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
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
      run = this.context.db.createRun({
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
      this.context.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }

    this.context.db.upsertWorktree({
      id: run.id,
      projectId: run.projectId,
      runId: run.id,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      status: "ready",
    });

    this.context.db.touchProject(project.id);
    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.context.db.setSetting(SELECTED_RUN_KEY, run.id);

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
    run = this.context.db.updateRunStatus(run.id, "preparing");
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
    const worker = await this.startWorker(
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

    return this.context.db.getRun(run.id);
  }

  resolveWorktreeStartPoint(project: ProjectRecord, baseBranch: string): Promise<string> | string {
    return this.context.db.getSettings()[APP_SETTING_KEYS.worktreeStartFromRemoteBase] === "true"
      ? this.context.gitService.resolveFreshBaseStartPoint(project.repoPath, baseBranch)
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
      ...this.context.gitService.planRunWorktree(project.repoPath, project.name, workspaceId, configuredWorkspaceRoot),
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
      const currentBranch = await this.context.gitService.getCurrentBranch(project.repoPath);
      if (currentBranch !== sourceRun.branchName) {
        throw new Error(
          `The project repository is currently on "${currentBranch}", but this run is tied to "${sourceRun.branchName}". Check out the run branch or turn off workspace changes before continuing.`,
        );
      }
    }

    const workspace = await this.context.gitService.createWorktreeForContinuation(
      project.repoPath,
      project.name,
      workspaceId,
      sourceRun.branchName,
      configuredWorkspaceRoot,
      shareDependencies,
    );
    if (includeWorkspaceChanges) {
      try {
        await this.context.gitService.cloneWorkspaceChanges(sourceRun.worktreePath, workspace.worktreePath);
      } catch (error) {
        await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, { workspaceType: "worktree", ...workspace });
        throw error;
      }
    }
    return { workspaceType: "worktree", workspaceVcs: "git", ...workspace };
  }

  async followUpRun(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (this.services.workspaceGuard.manualVerifications.has(runId)) throw new Error("Wait for verification to finish or cancel it first.");
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(runId);
    const hasUserTurn = Boolean(prompt.trim() || options?.attachments?.length);
    if (!orchestration || !hasUserTurn || !["waiting", "attention"].includes(orchestration.status)) {
      return this.followUpRunInternal(runId, prompt, options, extraLogMetadata);
    }
    if (this.services.orchestrationCoordinator.orchestrationWakeLocks.has(orchestration.id)) {
      throw new Error("A coordinator continuation is already starting. Retry after it becomes active.");
    }
    this.services.orchestrationCoordinator.orchestrationWakeLocks.add(orchestration.id);
    try {
      const durableContext = this.services.orchestrationCoordinator.buildOrchestrationResumePrompt(orchestration);
      const combinedPrompt = [
        durableContext,
        prompt.trim() ? `<user_request>\n${prompt.trim()}\n</user_request>` : "",
      ].filter(Boolean).join("\n\n");
      return await this.services.orchestrationCoordinator.deliverOrchestrationUpdate(orchestration, (deliveryMetadata) => {
        this.context.db.appendOrchestrationEvent({
          orchestrationId: orchestration.id,
          type: "user-wake",
          title: "Coordinator resumed by user",
          content: "A user follow-up superseded the persisted automatic wake condition.",
        });
        return this.followUpRunInternal(runId, combinedPrompt, options, {
          ...extraLogMetadata,
          ...deliveryMetadata,
          source: "user",
          orchestrationResume: true,
          userWake: true,
          displayPrompt: prompt.trim(),
        });
      }, { userWake: true });
    } finally {
      this.services.orchestrationCoordinator.orchestrationWakeLocks.delete(orchestration.id);
    }
  }

  async followUpRunInternal(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    return this.services.workspaceGuard.serializeRunStart(runId, () => this.followUpRunUnlocked(runId, prompt, options, extraLogMetadata));
  }

  private async followUpRunUnlocked(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    let run = this.context.db.getRun(runId);
    const project = this.context.db.getProject(run.projectId);
    const model = this.context.db.getModel(options?.modelId ?? run.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, options) ?? this.services.turnState.getLatestRunExecutionOptions(runId, provider);

    if (this.services.activeWorkers.runWorkers.has(runId)) {
      throw new Error("This run is already active. Wait for it to finish before sending a follow-up.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    const hasGoalUpdate = options ? Object.prototype.hasOwnProperty.call(options, "goalText") : false;
    const nextGoalText = hasGoalUpdate ? normalizeRunGoalText(options?.goalText) : run.goalText;
    if (!userText && attachmentNames.length === 0 && !hasGoalUpdate) {
      throw new Error("Enter a follow-up command or attach at least one file.");
    }
    if (userText || attachmentNames.length > 0) {
      this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    }

    // Internal turns send a generated prompt but record a readable version of it in the run.
    const { displayPrompt, ...followUpLogMetadata } = extraLogMetadata ?? {};
    const isOrchestrationUpdate = followUpLogMetadata.orchestrationResume === true;
    const followUpLogContent = (typeof displayPrompt === "string" ? displayPrompt : userText) || "(no text)";

    this.context.db.touchProject(project.id);
    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.context.db.setSetting(SELECTED_RUN_KEY, run.id);
    run = this.context.db.updateRunConfiguration(run.id, {
      providerAccountId: provider.id,
      modelId: model.id,
      mode: options?.mode ?? run.mode,
      ...(hasGoalUpdate ? { goalText: nextGoalText } : {}),
      ...(options?.delegationEnabled !== undefined ? { delegationEnabled: options.delegationEnabled } : {}),
    });
    const resumableSession = this.services.turnState.resolveRunNativeSession(run, provider).session;
    // Hand over the conversation the target provider has not seen: everything for a fresh
    // session, or only the turns it missed since its last delivered turn.
    const historySteps = this.context.db.getRunSteps(run.id);
    const contextHandoff = planContextHandoff({
      steps: historySteps,
      targetProviderType: provider.providerType,
      targetProviderAccountId: provider.id,
      resumesNativeSession: resumableSession !== null,
      sessionSeenAt: resumableSession?.lastSeenAt ?? null,
      resolveTurnAccount: this.services.turnState.createTurnAccountResolver(),
    });
    // The delta above assumes the saved session reloads. ACP agents may fail to reload it and
    // start fresh, so they also get the full handoff to send in that case.
    const resumeFallbackContext = resumableSession !== null ? this.services.turnState.buildResumeFallbackContext(historySteps, provider) : undefined;
    // Files attached in the handed-over turns travel along, within the attachment limits.
    const handoffAttachments = selectHandoffAttachments(historySteps, contextHandoff, options?.attachments, this.context.db.resolveAttachmentBlob);
    const workerAttachments = mergeProjectTaskRunAttachments(handoffAttachments.attachments, options?.attachments);
    validateChatAttachmentPayloads(workerAttachments);
    if (hasGoalUpdate && !userText && attachmentNames.length === 0) {
      await this.services.runEvents.appendRunEvent(run.id, "log", "Run goal updated", run.goalText ?? "No run goal set.", {
        source: "user",
        commandType: "goal",
        mode: run.mode,
        modelId: run.modelId,
        goalText: run.goalText,
      });
      return this.context.db.getRun(run.id);
    }

    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const followUpPromptForHarness =
      [
        withContextHandoff(
          buildContextHandoffBlock(historySteps, contextHandoff, { attachments: handoffAttachments.note }),
          buildPromptWithRunGoal(
            userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : ""),
            run.goalText,
            isOrchestrationUpdate ? "Update:" : undefined,
          ),
        ),
        this.services.turnState.buildRunFollowUpMemo(run.id),
      ]
        .filter(Boolean)
        .join("\n\n");
    const turnMarker = this.services.turnState.buildTurnSettingsMarker(
      historySteps,
      model,
      provider,
      modelHandoffContextFor(provider.providerType, contextHandoff, resumableSession !== null),
      { reasoningEffort: options?.reasoningEffort, anthropicEffort: options?.anthropicEffort, executionOptions },
      followUpLogMetadata.queuedFollowUpId,
    );
    if (turnMarker) {
      await this.services.runEvents.appendRunEvent(run.id, "status", turnMarker.title, turnMarker.content, turnMarker.metadata);
    }
    await this.services.runEvents.appendRunEvent(run.id, "log", "Follow-up command", followUpLogContent, {
      source: "user",
      commandType: "follow-up",
      mode: run.mode,
      modelId: run.modelId,
      providerAccountId: provider.id,
      ...(contextHandoff.strategy !== "none"
        ? { contextHandoff: { strategy: contextHandoff.strategy, turnCount: contextHandoff.turnCount } }
        : {}),
      goalText: run.goalText,
      yoloMode: options?.yoloMode === true,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      executionOptions,
      ...followUpLogMetadata,
      ...this.services.runEvents.buildStoredAttachmentMetadata(options?.attachments),
    });
    // Published task results retain prior reports; the live summary belongs to this turn.
    this.context.db.updateRunStatus(run.id, "preparing", { errorMessage: null,
      ...(run.kind === "orchestration-task" ? { summary: "" } : {}),
    });
    await this.context.db.flushDurable();
    this.services.turnState.clearRunCheckpoint(run.id);
    let worker: Worker;
    try {
      await this.services.turnState.capturePromptRestorePoint(run.id, "follow-up");
      worker = await this.startWorker(
        run,
        provider,
        model,
        apiKey ?? "",
        await this.services.settings.resolveNetworkProxyRuntimeConfig(),
        {
          promptOverride: followUpPromptForHarness,
          attachments: workerAttachments,
          skillPrompt: userText,
          providerOptions: executionOptions,
          yoloMode: options?.yoloMode === true,
          isOrchestrationUpdate,
          ...(resumeFallbackContext ? { resumeFallbackContext } : {}),
        },
      );
    } catch (error) {
      // A turn that never started must not leave the run looking active.
      if (!this.services.activeWorkers.runWorkers.has(run.id)) {
        this.context.db.updateRunStatus(run.id, "failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
    this.services.followUps.acceptQueuedFollowUp(extraLogMetadata);

    return this.context.db.getRun(run.id);
  }

  async cancelRun(runId: string): Promise<void> {
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(runId);
    if (orchestration && ORCHESTRATION_CANCELLABLE_STATUSES.has(orchestration.status)) {
      await this.services.orchestration.cancelOrchestration(runId);
      return;
    }

    await this.services.activeWorkers.cancelRunWorker(runId);
  }

  async cancelRunShell(runId: string, toolCallId: string): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      return;
    }

    active.worker.postMessage({ type: "cancel-shell", callId: toolCallId });
  }

  async respondToShellApproval(
    runId: string,
    requestId: string,
    requestedDecision: ShellApprovalDecision,
    options?: ShellApprovalRespondOptions,
  ): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    // An action with nothing specific to remember can only be allowed this once.
    const onceOnly = this.runOnceOnlyApprovals.delete(this.shellApprovalStepKey(runId, requestId));
    const decision: ShellApprovalDecision = onceOnly && requestedDecision !== "deny" ? "allow-once" : requestedDecision;
    const approvalKey = this.runToolApprovalKeys.get(this.shellApprovalStepKey(runId, requestId));
    if (decision === "allow-always" && approvalKey) {
      // A tool approval is stored by tool identity, apart from shell patterns, so it can never
      // be matched against a shell command.
      const projectId = this.context.db.getRun(runId).projectId;
      const lists = parseToolApprovalAllowlistSetting(this.context.db.getSettings()[APP_SETTING_KEYS.toolApprovalAllowlist]);
      const keys = lists[projectId] ?? [];
      if (!keys.includes(approvalKey)) {
        lists[projectId] = [...keys, approvalKey];
        this.context.db.setSetting(APP_SETTING_KEYS.toolApprovalAllowlist, JSON.stringify(lists));
      }
    } else if (decision === "allow-always") {
      const cmd = options?.command?.trim();
      if (!cmd) {
        throw new Error('A command is required when choosing "always allow" (save to settings).');
      }
      const pattern = commandToExactShellPatternSource(cmd);
      const list = parseShellAllowlistExtraSetting(this.context.db.getSettings()[APP_SETTING_KEYS.shellAllowlistExtra]);
      if (!list.includes(pattern)) {
        list.push(pattern);
        this.context.db.setSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(list));
      }
    }
    this.runToolApprovalKeys.delete(this.shellApprovalStepKey(runId, requestId));

    active.worker.postMessage({
      type: "shell-approval-response",
      requestId,
      decision,
    });

    const { title, content } = SHELL_APPROVAL_DECISION_MESSAGES[decision] ?? SHELL_APPROVAL_DECISION_MESSAGES["allow-once"];

    const metadata = {
      requestKind: "approval",
      requestStatus: "resolved",
      shellApprovalDecision: decision,
      approvalRequestId: requestId,
      approvalResolutionMessage: content,
    };
    const approvalStepId = this.runShellApprovalStepIds.get(this.shellApprovalStepKey(runId, requestId));
    if (approvalStepId) {
      this.context.db.updateRunStep(approvalStepId, {
        title,
        metadataJson: JSON.stringify(metadata),
      });
      this.runShellApprovalStepIds.delete(this.shellApprovalStepKey(runId, requestId));
    } else {
      await this.services.runEvents.appendRunEvent(runId, "approval-resolved", title, content, metadata);
    }
    this.services.runEvents.emitEvent({
      runId,
      type: "approval-resolved",
      title,
      content,
      metadata: {
        requestKind: "approval",
        requestStatus: "resolved",
        shellApprovalDecision: decision,
        approvalRequestId: requestId,
        approvalResolutionMessage: content,
      },
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.context.db.getOrchestrationTaskByChildRunId(runId);
    if (orchestrationTask?.status === "waiting-input") {
      this.context.db.updateOrchestrationTask(orchestrationTask.id, { status: "running", attentionReason: null });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestrationTask.orchestrationId,
        taskId: orchestrationTask.id,
        type: "attention-resolved",
        title: "Approval resolved",
        content,
      });
      this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
    }
  }

  async respondToRunUserInput(
    runId: string,
    requestId: string,
    answers: RunUserInputAnswers,
    answeredBy: "user" | "coordinator" = "user",
  ): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    active.worker.postMessage({
      type: "user-input-response",
      requestId,
      answers,
    });

    const content = this.formatRunUserInputAnswers(answers);
    const title = answeredBy === "coordinator" ? "Coordinator answered" : "User input submitted";
    const metadata = {
      requestKind: "user-input",
      requestStatus: "resolved",
      userInputRequestId: requestId,
      userInputAnswers: answers,
      ...(answeredBy === "coordinator" ? { answeredBy } : {}),
    };
    const stepKey = this.userInputStepKey(runId, requestId);
    const stepId = this.runUserInputStepIds.get(stepKey);
    if (stepId) {
      let existingMetadata: Record<string, unknown> = {};
      try {
        existingMetadata = JSON.parse(this.context.db.getRunSteps(runId).find((step) => step.id === stepId)?.metadataJson || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        /* keep response metadata even if the stored request metadata is malformed */
      }
      this.context.db.updateRunStep(stepId, {
        title,
        metadataJson: JSON.stringify({
          ...existingMetadata,
          ...metadata,
        }),
      });
      this.runUserInputStepIds.delete(stepKey);
    } else {
      await this.services.runEvents.appendRunEvent(runId, "user-input-requested", title, content, metadata);
    }
    this.services.runEvents.emitEvent({
      runId,
      type: "user-input-requested",
      title,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.context.db.getOrchestrationTaskByChildRunId(runId);
    if (orchestrationTask?.status === "waiting-input") {
      this.context.db.updateOrchestrationTask(orchestrationTask.id, { status: "running", attentionReason: null });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestrationTask.orchestrationId,
        taskId: orchestrationTask.id,
        type: "attention-resolved",
        title,
        content,
      });
      this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
    }
  }

  private async handleRunWorkerHostToolRequest(
    runId: string,
    worker: Worker,
    payload: Extract<RunWorkerPayload, { type: "host-tool-request" }>,
  ): Promise<void> {
    try {
      if (this.services.activeWorkers.runWorkers.get(runId)?.worker !== worker || this.services.activeWorkers.runWorkers.get(runId)?.cancelled) {
        throw new Error("This run is no longer active.");
      }
      const result = payload.toolName === "buildwarden_browser"
        ? await this.context.lifecycle.executeBrowserTool?.(runId, payload.callId, payload.arguments)
        : isThemeToolName(payload.toolName)
        ? this.context.lifecycle.executeThemeTool?.(payload.callId, payload.toolName, payload.arguments)
        : await this.services.orchestrationTools.executeOrchestrationTool(
        runId,
        payload.callId,
        payload.toolName,
        payload.arguments,
      );
      worker.postMessage({ type: "host-tool-response", callId: payload.callId, result });
    } catch (error) {
      // A rejected call is an answer the model can act on, not a transport failure.
      const result: RunToolResult = isOrchestrationToolName(payload.toolName)
        ? orchestrationToolFailure(payload.callId, payload.toolName, error)
        : {
          toolCallId: payload.callId,
          name: payload.toolName,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        };
      worker.postMessage({ type: "host-tool-response", callId: payload.callId, result });
    }
  }

  private async handleRunWorkerShellApprovalRequest(
    run: RunRecord,
    payload: Extract<RunWorkerPayload, { type: "shell-approval-request" }>,
  ): Promise<void> {
    if (run.kind === "council-review") {
      // Nobody is watching a reviewer, and reading files needs no approval.
      this.services.activeWorkers.runWorkers.get(run.id)?.worker.postMessage({ type: "shell-approval-response", requestId: payload.requestId, decision: "deny" });
      return;
    }
    const approvalKey = typeof payload.approvalKey === "string" && /^(mcp|acp):/.test(payload.approvalKey) ? payload.approvalKey : undefined;
    const metadata = {
      requestKind: "approval",
      requestStatus: "opened",
      approvalRequestId: payload.requestId,
      shellApprovalRequest: true,
      command: payload.command,
      ...(approvalKey ? { toolApprovalKey: approvalKey } : {}),
      ...(payload.onceOnly === true ? { approvalOnceOnly: true } : {}),
    };
    const title = approvalKey ? "Tool approval requested" : "Shell approval requested";
    const step = await this.services.runEvents.appendRunEvent(
      run.id,
      "approval-requested",
      title,
      payload.command,
      metadata,
    );
    this.runShellApprovalStepIds.set(this.shellApprovalStepKey(run.id, payload.requestId), step.id);
    if (approvalKey) this.runToolApprovalKeys.set(this.shellApprovalStepKey(run.id, payload.requestId), approvalKey);
    if (payload.onceOnly === true) this.runOnceOnlyApprovals.add(this.shellApprovalStepKey(run.id, payload.requestId));
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "approval-requested",
      title,
      content: payload.command,
      metadata,
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.context.db.getOrchestrationTaskByChildRunId(run.id);
    if (!orchestrationTask) {
      return;
    }
    this.context.db.updateOrchestrationTask(orchestrationTask.id, {
      status: "waiting-input",
      attentionReason: `Shell approval required: ${payload.command}`,
    });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestrationTask.orchestrationId,
      taskId: orchestrationTask.id,
      type: "attention",
      title: "Child needs shell approval",
      content: payload.command,
    });
    await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
  }

  private async handleRunWorkerUserInputRequest(
    run: RunRecord,
    payload: Extract<RunWorkerPayload, { type: "user-input-request" }>,
  ): Promise<void> {
    if (run.kind === "council-review") {
      // A reviewer that waits for an answer would only hold up the round until its deadline.
      await this.services.activeWorkers.cancelRunWorker(run.id);
      return;
    }
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const content =
      payload.content?.trim() ||
      this.formatRunUserInputQuestions(questions) ||
      "The provider requested more input before it can continue.";
    const title = payload.title?.trim() || "User input requested";
    const metadata = {
      ...(payload.metadata ?? {}),
      requestKind: "user-input",
      requestStatus: "opened",
      userInputRequest: true,
      userInputRequestId: payload.requestId,
      requestId: payload.requestId,
      userInputQuestions: questions,
    };
    const step = await this.services.runEvents.appendRunEvent(run.id, "user-input-requested", title, content, metadata);
    this.runUserInputStepIds.set(this.userInputStepKey(run.id, payload.requestId), step.id);
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "user-input-requested",
      title,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.context.db.getOrchestrationTaskByChildRunId(run.id);
    if (!orchestrationTask) {
      return;
    }
    this.context.db.updateOrchestrationTask(orchestrationTask.id, {
      status: "waiting-input",
      attentionReason: title === "User input requested" ? "The child requested user input." : title,
    });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestrationTask.orchestrationId,
      taskId: orchestrationTask.id,
      type: "attention",
      title: "Child needs user input",
      content,
      metadata: { kind: "user-input", inputRequestId: payload.requestId },
    });
    await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
  }

  /**
   * Codex reports cumulative usage per thread, so a resumed thread continues from the last
   * totals that thread reported. Only this account's turns count: totals reported by another
   * provider in between belong to a different session.
   */
  initialUsageReportTracker(
    provider: ProviderAccountRecord,
    steps: ReadonlyArray<{ eventType: string; metadataJson: string }>,
    resumesNativeSession: boolean,
    model?: Pick<ModelRecord, "modelId">,
  ): UsageReportTracker {
    const attribution = model ? { providerType: provider.providerType, modelId: model.modelId } : undefined;
    const fresh = (): UsageReportTracker => ({ reportedUsage: { ...EMPTY_REPORTED_TOKEN_USAGE }, ...(attribution ? { attribution } : {}) });
    if (provider.providerType !== "codex-cli" || !resumesNativeSession) {
      return fresh();
    }
    const metadata = findLatestAccountStepMetadata(
      steps,
      provider.id,
      this.services.turnState.createTurnAccountResolver(),
      (candidate) => Boolean(candidate.usageTotals) && typeof candidate.usageTotals === "object" && !Array.isArray(candidate.usageTotals),
    );
    return metadata
      ? { ...fresh(), reportedUsage: readReportedTokenUsage(metadata.usageTotals as Partial<RunTokenUsage>) }
      : fresh();
  }

  private applyRunWorkerUsageUpdate(
    run: RunRecord,
    usageTotals: Partial<RunTokenUsage> | null,
    maxRunTokens: number,
    exhaustBudget: (exhaustion: RunBudgetExhaustion) => void,
    tracker: UsageReportTracker,
  ): RunRecord {
    if (!usageTotals) {
      return this.context.db.getRun(run.id);
    }
    let updatedRun = this.context.db.getRun(run.id);
    for (const delta of advanceUsageTracker(tracker, usageTotals)) {
      updatedRun = this.context.db.recordRunTokenUsage(run.id, delta.inputTokensDelta, delta.outputTokensDelta, delta.attribution);
    }
    const orchestrationTask = run.kind === "orchestration-task" ? this.context.db.getOrchestrationTaskByChildRunId(run.id) : null;
    const exhaustion = tokenBudgetExhaustion(maxRunTokens, usageTotals) ??
      (orchestrationTask ? this.services.orchestration.orchestrationBudgetExhaustion(this.context.db.getOrchestration(orchestrationTask.orchestrationId)) : null);
    if (exhaustion) {
      exhaustBudget(exhaustion);
    }
    return updatedRun;
  }

  private async handleRunWorkerChunk(
    run: RunRecord,
    _provider: ProviderAccountRecord,
    _modelId: string,
    payload: Extract<RunWorkerPayload, { type: "chunk" }>,
    maxRunTokens: number,
    exhaustBudget: (exhaustion: RunBudgetExhaustion) => void,
    streamingStepIds: Map<string, string>,
    streamingStepKinds: Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">,
    resetNarrationStreams: () => void,
    usageTracker: UsageReportTracker,
  ): Promise<void> {
    if (payload.chunk.metadata?.skillEvent === true) this.services.skills.skillService.recordEvent("run", run.id, payload.chunk.metadata);
    const sessionCapabilities = parseHarnessSessionCapabilities(payload.chunk.metadata?.sessionCapabilities);
    if (sessionCapabilities) {
      this.services.providerRuntime.runSessionCapabilities.set(run.id, sessionCapabilities);
      this.services.providerRuntime.rememberSessionCapabilities(_provider, sessionCapabilities);
    }
    const executedModel = payload.chunk.metadata?.executedModel;
    if (typeof executedModel === "string" && executedModel) this.runExecutedModels.set(run.id, executedModel);
    const setupStatus = payload.chunk.metadata?.setupStatus;
    if (payload.chunk.metadata?.workspaceSetup === true && (setupStatus === "running" || setupStatus === "completed" || setupStatus === "failed")) {
      const setup = this.context.db.getRunWorkspaceSetup(run.id);
      if (setup) this.context.db.saveRunWorkspaceSetup(run.id, { ...setup, status: setupStatus });
    }
    const eventType = runChunkEventType(payload.chunk.type);
    const usageTotals =
      typeof payload.chunk.metadata?.usageTotals === "object" && payload.chunk.metadata.usageTotals
        ? (payload.chunk.metadata.usageTotals as Partial<RunTokenUsage>)
        : null;
    resetUsageBaselineForFreshSession(usageTracker, payload.chunk.metadata);
    if (usageTotals) this.applyRunWorkerUsageUpdate(run, usageTotals, maxRunTokens, exhaustBudget, usageTracker);

    // Session-start chunks precede prompt acceptance; only terminal failure accounting is durable here.
    await this.services.turnState.persistFailedTurnAccounting("run", run.id, _provider, _modelId, payload.chunk.metadata);

    const streamId = typeof payload.chunk.metadata?.streamId === "string" ? payload.chunk.metadata.streamId : null;
    const shouldReplace =
      payload.chunk.metadata?.replace === true &&
      streamId &&
      (payload.chunk.type === "message" ||
        payload.chunk.type === "tool-result" ||
        payload.chunk.type === "tool-progress" ||
        payload.chunk.type === "plan-updated" ||
        payload.chunk.type === "plan-progress");
    const checkpoint =
      payload.chunk.metadata?.checkpoint === true &&
      typeof payload.chunk.metadata.resumeCheckpoint === "object" &&
      payload.chunk.metadata.resumeCheckpoint
        ? {
            ...(payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint),
            round: Number((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).round ?? 0),
            memo:
              typeof (payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo === "string"
                ? ((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo ?? "")
                : "",
          }
        : null;
    if (checkpoint) {
      this.services.turnState.setRunCheckpoint(run.id, checkpoint);
    }

    if (payload.chunk.metadata?.silent === true) {
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: eventType,
        title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
        content: payload.chunk.value,
        metadata: payload.chunk.metadata,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    if (payload.chunk.type === "tool-call" || payload.chunk.type === "tool-result") {
      resetNarrationStreams();
    }

    let persistedStep: RunStepRecord;
    if (shouldReplace) {
      const existingStepId = streamingStepIds.get(streamId);
      if (existingStepId) {
        // Persist the latest type so a progress step finishing as "tool-result" stops reading as live progress.
        persistedStep = this.context.db.updateRunStep(existingStepId, {
          eventType,
          title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
          content: payload.chunk.value,
          metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
        });
      } else {
        persistedStep = await this.services.runEvents.appendRunEvent(
          run.id,
          eventType,
          payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
          payload.chunk.value,
          payload.chunk.metadata,
        );
        streamingStepIds.set(streamId, persistedStep.id);
        let streamingStepKind: "tool-result" | "tool-progress" | "assistant" | "reasoning" =
          payload.chunk.metadata?.assistantKind === "reasoning" ? "reasoning" : "assistant";
        if (payload.chunk.type === "tool-result" || payload.chunk.type === "tool-progress") {
          streamingStepKind = payload.chunk.type;
        }
        streamingStepKinds.set(streamId, streamingStepKind);
      }
    } else {
      persistedStep = await this.services.runEvents.appendRunEvent(
        run.id,
        eventType,
        payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
        payload.chunk.value,
        payload.chunk.metadata,
      );
    }
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: eventType,
      title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
      content: payload.chunk.value,
      metadata: payload.chunk.metadata,
      createdAt: new Date().toISOString(),
      step: persistedStep,
    });
  }

  async startWorker(
    run: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    options?: {
      promptOverride?: string;
      skillPrompt?: string;
      attachments?: ChatAttachmentPayload[];
      recoverSkills?: boolean;
      providerOptions?: ProviderExecutionOptions;
      yoloMode?: boolean;
      isOrchestrationUpdate?: boolean;
      /** Full conversation for a fresh session when the expected session resume fails. */
      resumeFallbackContext?: string;
    },
  ): Promise<Worker> {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    this.services.workspaceGuard.requireWorkspaceNotRestoring(run.worktreePath);
    const settings = this.context.db.getSettings();
    try {
      // Recheck after asynchronous workspace preparation, using the worker's settings snapshot.
      this.services.providerRuntime.requireProjectMcpSupported(run.projectId, provider, settings[APP_SETTING_KEYS.projectRunDefaults]);
    } catch (error) {
      this.context.db.updateRunStatus(run.id, "failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (run.kind === "orchestration-task" && this.context.db.getOrchestrationTaskByChildRunId(run.id)?.permissionMode === "supervised") {
      options = { ...options, yoloMode: false };
    }
    const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
    const savedSkills = checkpoint?.skills ?? (checkpoint || options?.recoverSkills ? this.context.db.getSessionSkills("run", run.id) ?? undefined : undefined);
    const skills = {
      snapshot: await this.services.skills.prepareSessionSkills("run", run.id, options?.skillPrompt ?? run.prompt, run.projectId, savedSkills),
      storePath: this.services.skills.skillService.storePath,
      recovering: Boolean(checkpoint || options?.recoverSkills),
    };
    const workspaceSetup = this.context.db.getRunWorkspaceSetup(run.id, true);
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
    const streamingStepIds = new Map<string, string>();
    const streamingStepKinds = new Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">();
    const nativeSession = this.services.turnState.resolveRunNativeSession(run, provider);
    // Every resume needs it, including recovery and orchestration wakes, not only follow-ups.
    const resumeFallbackContext = nativeSession.session
      ? options?.resumeFallbackContext ?? this.services.turnState.buildResumeFallbackContext(this.context.db.getRunSteps(run.id), provider)
      : undefined;
    const usageTracker = this.initialUsageReportTracker(provider, this.context.db.getRunSteps(run.id), nativeSession.session !== null, model);
    if (this.services.workspaceGuard.manualVerifications.has(run.id)) throw new Error("Wait for verification to finish or cancel it first.");
    const resetNarrationStreams = () => {
      for (const [streamId, kind] of streamingStepKinds.entries()) {
        if (kind === "assistant" || kind === "reasoning") {
          streamingStepKinds.delete(streamId);
          streamingStepIds.delete(streamId);
        }
      }
    };
    const shellAllowlistExtra = parseShellAllowlistExtraSetting(settings[APP_SETTING_KEYS.shellAllowlistExtra]);
    const toolApprovalAllowlist = parseToolApprovalAllowlistSetting(settings[APP_SETTING_KEYS.toolApprovalAllowlist])[run.projectId] ?? [];
    const runDefaults = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults])[run.projectId];
    const maxRunMinutes = runDefaults?.maxRunMinutes ?? 0;
    const maxRunTokens = runDefaults?.maxRunTokens ?? 0;
    const projectMcpSupported = getHarnessCapabilities(provider.providerType).projectMcp !== "unsupported";
    const mcpServers = projectMcpSupported
      ? resolveMcpServerRuntimeConfigs(runDefaults?.mcpServers ?? [])
      : [];
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.context.logDirPath, { recursive: true });
    }

    // A report belongs to the worker that made it. A new turn that reports no model (an ACP agent
    // whose reloaded session omits it, a provider that never reports) must not inherit the last one.
    this.runExecutedModels.delete(run.id);
    const worker = new Worker(workerPath, {
      workerData: {
        ...getCompileCacheWorkerData(),
        acknowledgeChunks: true,
        request: {
          ...(workspaceSetup && workspaceSetup.status !== "completed" ? { workspaceSetup: {
            profile: workspaceSetup.profile, sourcePath: this.context.db.getProject(run.projectId).repoPath,
          } } : {}),
          runId: run.id,
          providerAccountId: provider.id,
          worktreePath: run.worktreePath,
          browserToolsEnabled: Boolean(this.context.lifecycle.executeBrowserTool),
          // Delegated children and council reviewers work on the repository, never on the app's look.
          themeToolsEnabled: Boolean(this.context.lifecycle.executeThemeTool) && run.kind !== "orchestration-task" && run.kind !== "council-review",
          workspaceVcs: run.workspaceVcs,
          mode: run.mode,
          yoloMode: options?.yoloMode === true,
          prompt: options?.promptOverride ?? run.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: nativeSession.previousResponseId,
          providerSessionRuntime: nativeSession.session,
          priorMessages: this.services.turnState.buildPriorRunMessagesFromSteps(run.id),
          skills,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          modelCapabilities: parseMetadataRecord(model.capabilitiesJson),
          providerOptions: options?.providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          shellAllowlistExtra,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...(toolApprovalAllowlist.length > 0 ? { toolApprovalAllowlist } : {}),
          ...(resumeFallbackContext ? { resumeFallbackContext } : {}),
          ...(run.kind === "orchestration-task" && run.mode !== "code" ? { requireReadOnly: true } : {}),
          resumeCheckpoint: this.services.turnState.getRunCheckpoint(run.id),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.context.logDirPath } } : {}),
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          ...(Boolean(run.delegationEnabled) && run.kind !== "orchestration-task"
            ? { orchestrationTools: ORCHESTRATION_TOOL_DEFINITIONS }
            : {}),
          ...(options?.isOrchestrationUpdate ? { isOrchestrationUpdate: true } : {}),
        },
      },
    });

    this.context.lifecycle.onRunBrowserActive?.(run.id, true);
    worker.once("exit", () => {
      if (!this.services.activeWorkers.runWorkers.has(run.id) || this.services.activeWorkers.runWorkers.get(run.id)?.worker === worker) {
        this.context.lifecycle.onRunBrowserActive?.(run.id, false);
      }
    });
    const exhaustBudget = (exhaustion: RunBudgetExhaustion) => {
      const active = this.services.activeWorkers.runWorkers.get(run.id);
      if (!active || active.worker !== worker || active.cancelled || active.budgetExhaustion) return;
      active.budgetExhaustion = exhaustion;
      this.context.lifecycle.onRunBrowserActive?.(run.id, false);
      worker.postMessage({ type: "cancel" });
      const metadata = {
        autonomyBudget: true,
        budgetKind: exhaustion.kind,
        limit: exhaustion.limit,
        observed: exhaustion.observed,
      };
      void this.services.runEvents.appendRunEvent(run.id, "status", "Autonomy budget exhausted", exhaustion.reason, metadata)
        .then((step) => {
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "status",
            title: "Autonomy budget exhausted",
            content: exhaustion.reason,
            metadata,
            createdAt: new Date().toISOString(),
            step,
          });
        })
        .catch((error) => {
          this.context.logControllerError("Could not persist the autonomy budget event.", error, { runId: run.id });
        });
    };
    const budgetTimer = maxRunMinutes > 0
      ? setTimeout(() => {
          exhaustBudget(timeBudgetExhaustion(maxRunMinutes));
        }, maxRunMinutes * 60_000)
      : null;
    const clearBudgetTimer = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
    };

    const runningRun = this.context.db.updateRunStatus(run.id, "running");
    this.services.workspaceGuard.updateWorktreeStatus(run, "busy");
    // Step events intentionally omit their full run row on the remote wire. Publish the status
    // transition separately so every client observes preparing -> running without bloating chunks.
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run started",
      content: "The agent is running.",
      createdAt: new Date().toISOString(),
      run: runningRun,
    });

    /** Settles a failed turn, whether the worker reported the error or its thread crashed. */
    const handleError = async (error: string): Promise<void> => {
      clearBudgetTimer();
      const active = this.services.activeWorkers.runWorkers.get(run.id);
      const status = active?.cancelled ? "cancelled" : "failed";
      const errorMessage = active?.budgetExhaustion?.reason ?? error;
      const shouldAutoRecover =
        !active?.budgetExhaustion && status === "failed" && this.shouldAutoRecoverAzureLegacyToolRoundLimit(run.id, provider.providerType, error);
      this.context.logControllerError("Run worker reported an error payload.", errorMessage, {
        runId: run.id,
        status,
      });
      this.context.db.updateRunStatus(run.id, status, { errorMessage });
      this.services.turnState.clearRunCheckpoint(run.id);
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      let eventTitle = "Run failed";
      if (status === "cancelled") eventTitle = "Run cancelled";
      else if (active?.budgetExhaustion) eventTitle = "Autonomy budget exhausted";
      await this.services.runEvents.appendRunEvent(run.id, "error", eventTitle, errorMessage, {
        autonomyBudgetExhausted: Boolean(active?.budgetExhaustion),
        budgetKind: active?.budgetExhaustion?.kind,
      });
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: "error",
        title: eventTitle,
        content: errorMessage,
        createdAt: new Date().toISOString(),
      });
      this.clearRunRequestStepIds(run.id);
      this.services.activeWorkers.runWorkers.delete(run.id);
      await worker.terminate();
      if (run.kind === "lab-implementation") {
        if (status === "cancelled") {
          this.services.projectLab.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        } else {
          await this.services.projectLab.failProjectLabImplementation(run, errorMessage);
        }
      }
      if (run.kind === "loop-iteration") {
        this.services.projectLoops.loopRunner.handleRunTerminal(run.id);
      }
      if (run.kind === "orchestration-task") {
        await this.services.orchestrationResults.handleOrchestrationChildTerminal(run.id).catch((error) => {
          this.context.logControllerError("Could not finalize a failed orchestration child.", error, { runId: run.id });
        });
      }
      if (run.kind === "council-review") this.services.council.handleCouncilChildTerminal(run.id);
      else this.services.council.handleCouncilRunTerminal(run.id, false);
      void this.services.prWatch.handlePrWatchRunTerminal(run.id);
      if (shouldAutoRecover) {
        await this.services.runEvents.appendRunEvent(
          run.id,
          "status",
          "Automatic follow-up queued",
          "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
          {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          },
        );
        this.services.runEvents.emitEvent({
          runId: run.id,
          type: "status",
          title: "Automatic follow-up queued",
          content:
            "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
          metadata: {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          },
          createdAt: new Date().toISOString(),
        });
        try {
          await this.followUpRunInternal(
            run.id,
            AZURE_LEGACY_AUTO_RECOVERY_PROMPT,
            {
              mode: run.mode,
              modelId: run.modelId,
            },
            {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
          );
        } catch (autoRecoveryError) {
          const message =
            autoRecoveryError instanceof Error ? autoRecoveryError.message : "Could not start the automatic follow-up.";
          this.context.logControllerError("Automatic Azure Legacy recovery follow-up failed to start.", autoRecoveryError, {
            runId: run.id,
          });
          await this.services.runEvents.appendRunEvent(run.id, "error", "Automatic follow-up failed", message, {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          });
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "error",
            title: "Automatic follow-up failed",
            content: message,
            metadata: {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
            createdAt: new Date().toISOString(),
          });
        }
      }
    };

    worker.on("message", async (message: unknown) => {
      const payload = message as RunWorkerPayload;
      if (payload.type === "steer-result") {
        this.services.followUps.settleFollowUpSteer(payload);
        return;
      }
      // Even a replaced turn's processes belong to this run, so record them before the stale check.
      if (payload.type === "process-spawned") {
        this.services.processes.registerRunWorkerProcess(run, payload);
        return;
      }

      // Worker identity is the turn generation. Ignore late messages from a
      // cancelled/replaced worker so stale turns cannot invoke host tools or
      // overwrite the state of a newer continuation.
      if (this.services.activeWorkers.runWorkers.get(run.id)?.worker !== worker) {
        if (payload.type === "chunk" && payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        return;
      }

      if (payload.type === "host-tool-request") {
        await this.handleRunWorkerHostToolRequest(run.id, worker, payload);
        return;
      }

      if (payload.type === "shell-approval-request") {
        await this.handleRunWorkerShellApprovalRequest(run, payload);
        return;
      }

      if (payload.type === "user-input-request") {
        await this.handleRunWorkerUserInputRequest(run, payload);
        return;
      }

      if (payload.type === "chunk") {
        try {
          await this.handleRunWorkerChunk(
            run,
            provider,
            model.modelId,
            payload,
            maxRunTokens,
            exhaustBudget,
            streamingStepIds,
            streamingStepKinds,
            resetNarrationStreams,
            usageTracker,
          );
        } finally {
          if (payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        }
        return;
      }

      const handleDone = async (donePayload: Extract<RunWorkerPayload, { type: "done" }>): Promise<void> => {
        const payload = donePayload;
        clearBudgetTimer();
        const active = this.services.activeWorkers.runWorkers.get(run.id);
        let wasCancelled = active?.cancelled === true;
        const currentRun = this.applyRunWorkerUsageUpdate(
          run,
          payload.result.usage,
          maxRunTokens,
          exhaustBudget,
          usageTracker,
        );
        const nextInputTokens = currentRun.inputTokens;
        const nextOutputTokens = currentRun.outputTokens;
        const finalTokenExhaustion = tokenBudgetExhaustion(maxRunTokens, payload.result.usage);
        if (active && !active.budgetExhaustion && finalTokenExhaustion) {
          active.budgetExhaustion = finalTokenExhaustion;
        }
        const budgetExhaustion = active?.budgetExhaustion;
        if (payload.result.providerSessionRuntime && !wasCancelled) {
          this.services.turnState.upsertProviderSessionRuntime("run", run.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        const trimmedSummary = payload.result.summary.trim();
        const latestAssistantOutput = [...this.context.db.getRunSteps(run.id)]
          .reverse()
          .find((step) => {
            if (step.eventType !== "output") {
              return false;
            }
            let metadata: Record<string, unknown> = {};
            try {
              metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
            } catch {
              /* ignore malformed legacy metadata */
            }
            return metadata.assistantKind !== "reasoning" && metadata.assistantKind !== "image";
          });
        const latestAssistantSource = latestAssistantOutput ? parseMetadataRecord(latestAssistantOutput.metadataJson).responseSourceText : undefined;
        const latestAssistantOutputText = latestAssistantOutput ? normalizeAssistantOutputText(typeof latestAssistantSource === "string" ? latestAssistantSource : latestAssistantOutput.content) : "";
        const shouldAppendFinalSummary =
          !wasCancelled &&
          provider.providerType !== "azure-legacy" &&
          trimmedSummary &&
          trimmedSummary !== "No output returned from the provider." &&
          normalizeAssistantOutputText(trimmedSummary) !== latestAssistantOutputText;
        if (shouldAppendFinalSummary) {
          const summaryContent = createResponseImageEmbedder(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run))(trimmedSummary);
          const summaryMetadata = {
            assistantKind: "final-summary",
            ...(summaryContent !== trimmedSummary ? { responseSourceText: trimmedSummary } : {}),
          };
          await this.services.runEvents.appendRunEvent(run.id, "output", "Final summary", summaryContent, summaryMetadata);
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "output",
            title: "Final summary",
            content: summaryContent,
            metadata: summaryMetadata,
            createdAt: new Date().toISOString(),
          });
        }

        const orchestration = run.delegationEnabled
          ? this.context.db.getOrchestrationByCoordinatorRunId(run.id)
          : null;
        const waitingForSubagents = !wasCancelled && orchestration?.status === "waiting";
        const configuredVerificationCommands = parseProjectRunDefaultsSetting(
          this.context.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults],
        )[run.projectId]?.verificationCommands ?? [];
        let verificationResults: ProjectVerificationResult[] = [];
        const runVerificationGate = async (): Promise<void> => {
          if (!wasCancelled && !budgetExhaustion && !waitingForSubagents && run.mode === "code" && configuredVerificationCommands.length > 0) {
          const verificationAbortController = new AbortController();
          if (active) active.verificationAbortController = verificationAbortController;
          const verificationStartedContent = configuredVerificationCommands.join("\n");
          await this.services.runEvents.appendRunEvent(
            run.id,
            "status",
            "Verification started",
            verificationStartedContent,
            { verificationGate: true, commandCount: configuredVerificationCommands.length },
          );
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "status",
            title: "Verification started",
            content: verificationStartedContent,
            metadata: { verificationGate: true, commandCount: configuredVerificationCommands.length },
            createdAt: new Date().toISOString(),
          });
          const evidence = await this.services.verification.executeRevisionCheck(run, configuredVerificationCommands, verificationAbortController.signal);
          verificationResults = [...evidence.results];
          if (evidence.status !== "passed" && !verificationResults.some((result) => !result.ok)) {
            verificationResults.push({ command: "Revision verification", ok: false, exitCode: null, durationMs: 0, timedOut: false, output: evidence.error ?? evidence.status });
          }
          if (active) active.verificationAbortController = undefined;
          wasCancelled = active?.cancelled === true;
          if (!wasCancelled) {
            for (const result of verificationResults) {
              const title = result.ok ? "Verification passed" : "Verification failed";
              const content = `$ ${result.command}\n${result.output}`;
              const metadata = {
                verificationGate: true,
                command: result.command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut,
                ok: result.ok,
              };
              await this.services.runEvents.appendRunEvent(run.id, result.ok ? "tool-result" : "error", title, content, metadata);
              this.services.runEvents.emitEvent({
                runId: run.id,
                type: result.ok ? "tool-result" : "error",
                title,
                content,
                metadata,
                createdAt: new Date().toISOString(),
              });
            }
          }
          }
        };
        await runVerificationGate();
        const failedVerification = !wasCancelled && verificationResults.some((result) => !result.ok);
        const failedVerificationResult = verificationResults.find((result) => !result.ok);
        const terminalOutcome = buildRunTerminalOutcome({
          wasCancelled,
          budgetExhaustion,
          failedVerificationResult,
          waitingForSubagents,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
        });
        this.context.db.updateRunStatus(run.id, terminalOutcome.status, {
          summary: wasCancelled ? currentRun.summary : payload.result.summary,
          errorMessage: terminalOutcome.errorMessage,
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
        });
        this.services.turnState.clearRunCheckpoint(run.id);
        this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
        await this.services.runEvents.appendRunEvent(
          run.id,
          "status",
          terminalOutcome.title,
          terminalOutcome.content,
          {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
            waitingForSubagents,
            verificationGate: configuredVerificationCommands.length > 0,
            verificationPassed: verificationResults.length > 0 && !failedVerification,
            autonomyBudgetExhausted: Boolean(budgetExhaustion),
            budgetKind: budgetExhaustion?.kind,
          },
        );
        this.services.runEvents.emitEvent({
          runId: run.id,
          type: "status",
          title: terminalOutcome.title,
          content: terminalOutcome.content,
          metadata: {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
            waitingForSubagents,
            verificationGate: configuredVerificationCommands.length > 0,
            verificationPassed: verificationResults.length > 0 && !failedVerification,
            autonomyBudgetExhausted: Boolean(budgetExhaustion),
            budgetKind: budgetExhaustion?.kind,
          },
          createdAt: new Date().toISOString(),
        });
        this.clearRunRequestStepIds(run.id);
        this.services.activeWorkers.runWorkers.delete(run.id);
        await worker.terminate();
        if (!wasCancelled && !budgetExhaustion && !failedVerification) this.services.runForge.syncRunForgeRequestInBackground(run.id, true);
        if (!wasCancelled && !budgetExhaustion && !failedVerification && run.kind === "lab-implementation") {
          try {
            await this.services.projectLab.reviewCompletedProjectLabImplementation(this.context.db.getRun(run.id));
          } catch (labReviewError) {
            this.context.logControllerError("Project Lab implementation review failed.", labReviewError, { runId: run.id });
          }
        } else if ((budgetExhaustion || failedVerification) && run.kind === "lab-implementation") {
          await this.services.projectLab.failProjectLabImplementation(
            run,
            budgetExhaustion?.reason ?? "The implementation did not pass its project verification gate.",
          );
        } else if (wasCancelled && run.kind === "lab-implementation") {
          this.services.projectLab.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        }
        if (run.kind === "loop-iteration") {
          this.services.projectLoops.loopRunner.handleRunTerminal(run.id);
        }
        if (run.kind === "orchestration-task") {
          await this.services.orchestrationResults.handleOrchestrationChildTerminal(run.id).catch((error) => {
            this.context.logControllerError("Could not finalize an orchestration child.", error, { runId: run.id });
          });
        } else if (run.delegationEnabled) {
          await this.services.orchestrationCoordinator.handleOrchestrationCoordinatorTurnTerminal(run.id).catch((error) => {
            this.context.logControllerError("Could not persist the coordinator wake state.", error, { runId: run.id });
          });
        }
        if (run.kind === "council-review") this.services.council.handleCouncilChildTerminal(run.id);
        else this.services.council.handleCouncilRunTerminal(run.id, terminalOutcome.status === "completed" && !waitingForSubagents);
        const prWatchTurn = this.services.prWatch.handlePrWatchRunTerminal(run.id);
        // Cancelled or failed turns hold the queue until the user resumes it or sends another follow-up.
        if (terminalOutcome.status === "completed") void prWatchTurn.then(() => this.services.followUps.dispatchQueuedFollowUpsInBackground("run", run.id));
      };

      if (payload.type === "done") {
        await handleDone(payload);
        return;
      }

      if (payload.type === "error") {
        await handleError(payload.error);
      }
    });

    worker.on("error", async (error) => {
      clearBudgetTimer();
      if (this.services.activeWorkers.runWorkers.get(run.id)?.worker !== worker) return;
      this.context.logControllerError("Run worker emitted a thread error.", error, { runId: run.id });
      await handleError(error.message);
    });

    return worker;
  }

  private shellApprovalStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  private userInputStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  private clearRunRequestStepIds(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.runShellApprovalStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runShellApprovalStepIds.delete(key);
      }
    }
    for (const key of [...this.runToolApprovalKeys.keys(), ...this.runOnceOnlyApprovals]) {
      if (key.startsWith(prefix)) {
        this.runToolApprovalKeys.delete(key);
        this.runOnceOnlyApprovals.delete(key);
      }
    }
    for (const key of this.runUserInputStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runUserInputStepIds.delete(key);
      }
    }
  }

  private formatRunUserInputQuestions(questions: RunUserInputQuestion[]): string {
    return questions
      .map((question, index) => {
        const heading = question.header || `Question ${String(index + 1)}`;
        const options = question.options.map((option) => {
          const descriptionSuffix = option.description ? `: ${option.description}` : "";
          return `- ${option.label}${descriptionSuffix}`;
        });
        return [heading, question.question, ...options].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private formatRunUserInputAnswers(answers: RunUserInputAnswers): string {
    return Object.entries(answers)
      .map(([questionId, answer]) => `${questionId}: ${Array.isArray(answer) ? answer.join(", ") : answer}`)
      .join("\n");
  }

  private shouldAutoRecoverAzureLegacyToolRoundLimit(runId: string, providerType: ProviderAccountRecord["providerType"], errorMessage: string): boolean {
    if (providerType !== "azure-legacy" || errorMessage.trim() !== AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE) {
      return false;
    }

    const latestUserCommand = [...this.context.db.getRunSteps(runId)]
      .reverse()
      .find((step) => {
        if (step.eventType !== "log") {
          return false;
        }
        try {
          const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
          return metadata.source === "user";
        } catch {
          return false;
        }
      });

    if (!latestUserCommand) {
      return true;
    }

    try {
      const metadata = JSON.parse(latestUserCommand.metadataJson || "{}") as Record<string, unknown>;
      return metadata.autoRecoveryKind !== AZURE_LEGACY_AUTO_RECOVERY_KIND;
    } catch {
      return true;
    }
  }

  // Persists run and chat timeline events and publishes them to connected clients.
  onChatEvent(listener: (event: ChatEvent) => void) { return this.services.runEvents.onChatEvent(listener); }
  onRunEvent(listener: (event: RunEvent) => void) { return this.services.runEvents.onRunEvent(listener); }
  onAppWarning(listener: (warning: AppWarning) => void) { return this.services.runEvents.onAppWarning(listener); }
  getAttachmentBlob(blobId: string) { return this.services.runEvents.getAttachmentBlob(blobId); }
  getStepContent(kind: "run" | "chat", stepId: string) { return this.services.runEvents.getStepContent(kind, stepId); }
  getStepPreviewContent(kind: "run" | "chat", stepId: string) { return this.services.runEvents.getStepPreviewContent(kind, stepId); }

  // Tracks the live run and chat worker threads and stops them.
  stopAgentWorkers() { return this.services.activeWorkers.stopAgentWorkers(); }

  // Builds the app snapshot and maintains the selected and ordered projects, runs and chats.
  getSnapshot() { return this.services.appState.getSnapshot(); }
  refreshSnapshot() { return this.services.appState.refreshSnapshot(); }
  selectProject(projectId: string) { return this.services.appState.selectProject(projectId); }
  reorderProjects(projectIds: string[]) { return this.services.appState.reorderProjects(projectIds); }

  // Reads and changes app settings.
  getNetworkProxySettings() { return this.services.settings.getNetworkProxySettings(); }
  saveNetworkProxySettings(input: NetworkProxySettingsInput) { return this.services.settings.saveNetworkProxySettings(input); }
  setAppSetting(key: string, value: string) { return this.services.settings.setAppSetting(key, value); }
  getTerminalSettings() { return this.services.settings.getTerminalSettings(); }

  // Lists, updates and reviews a project's pull and merge requests.
  fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput) { return this.services.forgeRequests.fetchProjectPrMrDiff(projectId, input); }
  getProjectForgeAuthStatus(projectId: string) { return this.services.forgeRequests.getProjectForgeAuthStatus(projectId); }
  saveProjectForgeAuthToken(projectId: string, token: string) { return this.services.forgeRequests.saveProjectForgeAuthToken(projectId, token); }
  deleteProjectForgeAuthToken(projectId: string) { return this.services.forgeRequests.deleteProjectForgeAuthToken(projectId); }
  getProjectForgePrMonitorSettings(projectId: string) { return this.services.forgeRequests.getProjectForgePrMonitorSettings(projectId); }
  saveProjectForgePrMonitorSettings(projectId: string, input: ProjectForgePrMonitorSettingsInput) {
    return this.services.forgeRequests.saveProjectForgePrMonitorSettings(projectId, input);
  }
  listProjectForgePrMonitorConfigs() { return this.services.forgeRequests.listProjectForgePrMonitorConfigs(); }
  listProjectForgeRequests(projectId: string, input?: ListProjectForgeRequestsInput) {
    return this.services.forgeRequests.listProjectForgeRequests(projectId, input);
  }
  getProjectForgeRequestDetails(projectId: string, input: GetProjectForgeRequestDetailsInput) {
    return this.services.forgeRequests.getProjectForgeRequestDetails(projectId, input);
  }
  getProjectForgeRequestStatus(projectId: string, input: GetProjectForgeRequestDetailsInput) {
    return this.services.forgeRequests.getProjectForgeRequestStatus(projectId, input);
  }
  updateProjectForgeRequest(projectId: string, input: UpdateProjectForgeRequestInput) {
    return this.services.forgeRequests.updateProjectForgeRequest(projectId, input);
  }
  mergeProjectForgeRequest(projectId: string, input: MergeProjectForgeRequestInput) {
    return this.services.forgeRequests.mergeProjectForgeRequest(projectId, input);
  }
  shouldRunProjectForgeBackgroundCheck(projectId: string, startup = false) {
    return this.services.forgeRequests.shouldRunProjectForgeBackgroundCheck(projectId, startup);
  }
  postProjectPrMrReview(projectId: string, input: PostProjectPrMrReviewInput) { return this.services.forgeRequests.postProjectPrMrReview(projectId, input); }
  submitProjectPrMrComments(projectId: string, input: SubmitProjectPrMrCommentsInput) {
    return this.services.forgeRequests.submitProjectPrMrComments(projectId, input);
  }
  replyProjectPrMrReviewThread(projectId: string, input: ReplyProjectPrMrReviewThreadInput) {
    return this.services.forgeRequests.replyProjectPrMrReviewThread(projectId, input);
  }
  resolveProjectPrMrReviewThread(projectId: string, input: ResolveProjectPrMrReviewThreadInput) {
    return this.services.forgeRequests.resolveProjectPrMrReviewThread(projectId, input);
  }

  // Finds and refreshes the pull or merge request that belongs to a run.
  startRunForgeDiscovery() { return this.services.runForge.startRunForgeDiscovery(); }
  stopRunForgeDiscovery() { return this.services.runForge.stopRunForgeDiscovery(); }
  getRunForgeRequestDetails(runId: string, options?: { refresh?: boolean }) { return this.services.runForge.getRunForgeRequestDetails(runId, options); }
  refreshRunForgeRequest(runId: string, options?: { automatic?: boolean; onOpen?: boolean }) {
    return this.services.runForge.refreshRunForgeRequest(runId, options);
  }
  getRunForgeRequestDiff(runId: string) { return this.services.runForge.getRunForgeRequestDiff(runId); }
  updateRunForgeRequest(runId: string, input: UpdateRunForgeRequestInput) { return this.services.runForge.updateRunForgeRequest(runId, input); }
  mergeRunForgeRequest(runId: string, input: MergeRunForgeRequestInput) { return this.services.runForge.mergeRunForgeRequest(runId, input); }
  onRunForgeRequestChanged(listener: (payload: import("@buildwarden/shared").RunForgeRequestChangedPayload) => void) {
    return this.services.runForge.onRunForgeRequestChanged(listener);
  }

  // Connects GitHub and GitLab issues with tasks, runs and automations.
  listProjectForgeIssues(projectId: string, input?: ListProjectForgeIssuesInput) {
    return this.services.forgeIssueActions.listProjectForgeIssues(projectId, input);
  }
  getProjectForgeIssueDetails(projectId: string, input: GetProjectForgeIssueDetailsInput) {
    return this.services.forgeIssueActions.getProjectForgeIssueDetails(projectId, input);
  }
  getProjectForgeIssueImage(projectId: string, input: GetProjectForgeIssueImageInput) {
    return this.services.forgeIssueActions.getProjectForgeIssueImage(projectId, input);
  }
  getProjectForgeIssueMetadata(projectId: string) { return this.services.forgeIssueActions.getProjectForgeIssueMetadata(projectId); }
  createProjectForgeIssue(projectId: string, input: CreateProjectForgeIssueInput) {
    return this.services.forgeIssueActions.createProjectForgeIssue(projectId, input);
  }
  updateProjectForgeIssue(projectId: string, input: UpdateProjectForgeIssueInput) {
    return this.services.forgeIssueActions.updateProjectForgeIssue(projectId, input);
  }
  commentProjectForgeIssue(projectId: string, input: CommentProjectForgeIssueInput) {
    return this.services.forgeIssueActions.commentProjectForgeIssue(projectId, input);
  }
  assistProjectForgeIssue(projectId: string, input: AssistProjectForgeIssueInput) {
    return this.services.forgeIssueActions.assistProjectForgeIssue(projectId, input);
  }
  collectProjectForgeIssueNotifications(config: ProjectForgePrMonitorConfig) {
    return this.services.forgeIssueActions.collectProjectForgeIssueNotifications(config);
  }

  // Reviews run diffs and pull or merge request diffs with a model.
  analyzeRunDiff(runId: string, options?: RunDiffReviewOptions) { return this.services.diffReview.analyzeRunDiff(runId, options); }
  analyzeProjectPrMrDiff(projectId: string, input: { prUrl: string; diff: string; modelId?: string }) {
    return this.services.diffReview.analyzeProjectPrMrDiff(projectId, input);
  }

  // Adds and removes projects and manages their Git branches.
  migrateProjectBaseBranches() { return this.services.projects.migrateProjectBaseBranches(); }
  getProjectBranches(projectId: string) { return this.services.projects.getProjectBranches(projectId); }
  getProjectCurrentBranch(projectId: string) { return this.services.projects.getProjectCurrentBranch(projectId); }
  getProjectBranchOverview(projectId: string) { return this.services.projects.getProjectBranchOverview(projectId); }
  checkProjectGitConversion(projectId: string) { return this.services.projects.checkProjectGitConversion(projectId); }
  convertProjectToGit(projectId: string) { return this.services.projects.convertProjectToGit(projectId); }
  updateProjectBaseBranch(projectId: string, branchName: string) { return this.services.projects.updateProjectBaseBranch(projectId, branchName); }
  checkProjectFolderGitStatus(repoPath: string) { return this.services.projects.checkProjectFolderGitStatus(repoPath); }
  getProjectBranchDeleteImpact(projectId: string, input: DeleteProjectBranchInput) {
    return this.services.projects.getProjectBranchDeleteImpact(projectId, input);
  }
  checkoutProjectBranch(projectId: string, branchName: string) { return this.services.projects.checkoutProjectBranch(projectId, branchName); }
  fetchProjectBranches(projectId: string) { return this.services.projects.fetchProjectBranches(projectId); }
  createProjectBranch(projectId: string, input: CreateProjectBranchInput) { return this.services.projects.createProjectBranch(projectId, input); }
  renameProjectBranch(projectId: string, input: RenameProjectBranchInput) { return this.services.projects.renameProjectBranch(projectId, input); }
  deleteProjectBranch(projectId: string, input: DeleteProjectBranchInput) { return this.services.projects.deleteProjectBranch(projectId, input); }
  pullProjectBranch(projectId: string, input?: PullProjectBranchInput) { return this.services.projects.pullProjectBranch(projectId, input); }
  pushProjectBranch(projectId: string, input: PushProjectBranchInput) { return this.services.projects.pushProjectBranch(projectId, input); }
  mergeProjectBranch(projectId: string, input: MergeProjectBranchInput) { return this.services.projects.mergeProjectBranch(projectId, input); }
  rebaseProjectBranch(projectId: string, input: RebaseProjectBranchInput) { return this.services.projects.rebaseProjectBranch(projectId, input); }
  abortProjectGitOperation(projectId: string) { return this.services.projects.abortProjectGitOperation(projectId); }
  deleteProjectRemoteBranch(projectId: string, input: DeleteProjectBranchInput) { return this.services.projects.deleteProjectRemoteBranch(projectId, input); }
  addProject(input: ProjectInput) { return this.services.projects.addProject(input); }
  deleteProject(projectId: string) { return this.services.projects.deleteProject(projectId); }
  pickProjectDirectory() { return this.services.projects.pickProjectDirectory(); }

  // Manages provider accounts, models and composer commands.
  addProviderAccount(input: ProviderAccountInput) { return this.services.providerAccounts.addProviderAccount(input); }
  addModel(input: ModelInput) { return this.services.providerAccounts.addModel(input); }
  listAvailableProviderModels(input: ListAvailableProviderModelsInput) { return this.services.providerAccounts.listAvailableProviderModels(input); }
  listComposerCommands(input: ListComposerCommandsInput) { return this.services.providerAccounts.listComposerCommands(input); }
  deleteProviderAccount(providerAccountId: string) { return this.services.providerAccounts.deleteProviderAccount(providerAccountId); }
  recheckProviderCapabilities(providerAccountId: string) { return this.services.providerAccounts.recheckProviderCapabilities(providerAccountId); }
  listAcpRegistryAgents() { return this.services.providerAccounts.listAcpRegistryAgents(); }
  deleteModel(modelId: string) { return this.services.providerAccounts.deleteModel(modelId); }
  getModelDeletionImpact(modelId: string) { return this.services.providerAccounts.getModelDeletionImpact(modelId); }

  // Knows the installed provider agents: adapters, versions, updates, limits and reported capabilities.
  startProviderCliUpdateChecks() { return this.services.providerRuntime.startProviderCliUpdateChecks(); }
  stopProviderCliUpdateChecks() { return this.services.providerRuntime.stopProviderCliUpdateChecks(); }
  getProviderCliUpdates() { return this.services.providerRuntime.getProviderCliUpdates(); }
  checkProviderCliUpdates() { return this.services.providerRuntime.checkProviderCliUpdates(); }
  runProviderCliUpdate(providerType: ProviderType) { return this.services.providerRuntime.runProviderCliUpdate(providerType); }
  getDetectedCodexInstallation() { return this.services.providerRuntime.getDetectedCodexInstallation(); }
  getDetectedClaudeInstallation() { return this.services.providerRuntime.getDetectedClaudeInstallation(); }
  getDetectedCursorInstallation() { return this.services.providerRuntime.getDetectedCursorInstallation(); }

  // Reports usage costs and subscription limits.
  getSubscriptionLimits(input: SubscriptionLimitsInput) { return this.services.usage.getSubscriptionLimits(input); }
  getSubscriptionLimitsAvailability() { return this.services.usage.getSubscriptionLimitsAvailability(); }
  useSubscriptionReset(input: SubscriptionResetInput) { return this.services.usage.useSubscriptionReset(input); }
  getUsageCostReport(input: UsageCostReportInput) { return this.services.usage.getUsageCostReport(input); }

  // Generates and renames run and chat titles.
  renameRunTitle(id: string, title: string) { return this.services.titles.renameRunTitle(id, title); }
  regenerateRunTitle(id: string) { return this.services.titles.regenerateRunTitle(id); }
  renameChatTitle(id: string, title: string) { return this.services.titles.renameChatTitle(id, title); }
  regenerateChatTitle(id: string) { return this.services.titles.regenerateChatTitle(id); }

  // Schedules and starts project automations.
  createProjectAutomation(projectId: string, input: ProjectAutomationInput) { return this.services.automations.createProjectAutomation(projectId, input); }
  getProjectAutomation(automationId: string) { return this.services.automations.getProjectAutomation(automationId); }
  updateProjectAutomation(automationId: string, input: UpdateProjectAutomationInput) {
    return this.services.automations.updateProjectAutomation(automationId, input);
  }
  deleteProjectAutomation(automationId: string) { return this.services.automations.deleteProjectAutomation(automationId); }
  runProjectAutomationNow(automationId: string) { return this.services.automations.runProjectAutomationNow(automationId); }
  getStartupAutomationCatchUp() { return this.services.automations.getStartupAutomationCatchUp(); }
  resolveStartupAutomationCatchUp(automationIds: string[]) { return this.services.automations.resolveStartupAutomationCatchUp(automationIds); }
  startAutomationScheduler() { return this.services.automations.startAutomationScheduler(); }
  onAutomationStarted(listener: (payload: import("@buildwarden/shared").AutomationStartedNotificationPayload) => void) {
    return this.services.automations.onAutomationStarted(listener);
  }

  // Manages the project task board.
  createProjectTask(projectId: string, input: ProjectTaskInput) { return this.services.tasks.createProjectTask(projectId, input); }
  getProjectTask(taskId: string) { return this.services.tasks.getProjectTask(taskId); }
  updateProjectTask(taskId: string, input: UpdateProjectTaskInput) { return this.services.tasks.updateProjectTask(taskId, input); }
  syncProjectTaskPullRequestStatuses(projectId: string, automatic = false) {
    return this.services.tasks.syncProjectTaskPullRequestStatuses(projectId, automatic);
  }
  deleteProjectTask(taskId: string) { return this.services.tasks.deleteProjectTask(taskId); }
  generateProjectTaskRunPrompt(input: { projectId: string; title: string; notes: string; modelId: string }) {
    return this.services.tasks.generateProjectTaskRunPrompt(input);
  }

  // Manages bookmarks, sections, notes, layouts and the attention inbox.
  addBookmark(runId: string) { return this.services.organization.addBookmark(runId); }
  removeBookmark(runId: string) { return this.services.organization.removeBookmark(runId); }
  removeBookmarkById(bookmarkId: string) { return this.services.organization.removeBookmarkById(bookmarkId); }
  getBookmarksWithSteps() { return this.services.organization.getBookmarksWithSteps(); }
  addChatBookmark(chatId: string) { return this.services.organization.addChatBookmark(chatId); }
  removeChatBookmark(chatId: string) { return this.services.organization.removeChatBookmark(chatId); }
  removeChatBookmarkById(bookmarkId: string) { return this.services.organization.removeChatBookmarkById(bookmarkId); }
  isChatBookmarked(chatId: string) { return this.services.organization.isChatBookmarked(chatId); }
  getChatBookmarksWithSteps() { return this.services.organization.getChatBookmarksWithSteps(); }
  isBookmarked(runId: string) { return this.services.organization.isBookmarked(runId); }
  getAttentionInbox() { return this.services.organization.getAttentionInbox(); }
  acknowledgeAttentionItem(itemId: string) { return this.services.organization.acknowledgeAttentionItem(itemId); }
  acknowledgeAttentionItems(itemIds: string[]) { return this.services.organization.acknowledgeAttentionItems(itemIds); }
  listRunWorkspaceLayouts() { return this.services.organization.listRunWorkspaceLayouts(); }
  setRunWorkspaceLayout(runId: unknown, layout: unknown) { return this.services.organization.setRunWorkspaceLayout(runId, layout); }
  searchRunUserInput(query: string) { return this.services.organization.searchRunUserInput(query); }
  addRunNote(runId: string, input: { content: string }) { return this.services.organization.addRunNote(runId, input); }
  updateRunNote(noteId: string, input: UpdateRunNoteInput) { return this.services.organization.updateRunNote(noteId, input); }
  deleteRunNote(noteId: string) { return this.services.organization.deleteRunNote(noteId); }
  startHistorySearchBackfill() { return this.services.organization.startHistorySearchBackfill(); }
  createRunSection(name: string, color?: string) { return this.services.organization.createRunSection(name, color); }
  setRunSectionColor(sectionId: string, color: string) { return this.services.organization.setRunSectionColor(sectionId, color); }
  renameRunSection(sectionId: string, name: string) { return this.services.organization.renameRunSection(sectionId, name); }
  deleteRunSection(sectionId: string) { return this.services.organization.deleteRunSection(sectionId); }
  reorderRunSections(sectionIds: string[]) { return this.services.organization.reorderRunSections(sectionIds); }
  updateRunOrganization(runId: string, input: UpdateRunOrganizationInput) { return this.services.organization.updateRunOrganization(runId, input); }
  setRunListVisibility(runId: string, visibility: RunListVisibility) { return this.services.organization.setRunListVisibility(runId, visibility); }

  // Verifies run revisions with the project's commands.
  setProjectRevisionVerificationPolicy(projectId: string, enabled: boolean) {
    return this.services.verification.setProjectRevisionVerificationPolicy(projectId, enabled);
  }
  getRunVerification(runId: string) { return this.services.verification.getRunVerification(runId); }
  verifyRunRevision(runId: string) { return this.services.verification.verifyRunRevision(runId); }
  cancelRunVerification(runId: string) { return this.services.verification.cancelRunVerification(runId); }
  stopRevisionVerifications() { return this.services.verification.stopRevisionVerifications(); }

  // Imports skills and selects them for runs and chats.
  importSkill(input: SkillImportInput) { return this.services.skills.importSkill(input); }
  removeImportedSkill(skillId: string) { return this.services.skills.removeImportedSkill(skillId); }
  getSessionSkills(kind: "run" | "chat", id: string) { return this.services.skills.getSessionSkills(kind, id); }
  setSessionSkills(kind: "run" | "chat", id: string, skillIds: string[] | null) { return this.services.skills.setSessionSkills(kind, id, skillIds); }
  listIntegratedSkills() { return this.services.skills.listIntegratedSkills(); }
  getIntegratedSkillContent(skillId: string) { return this.services.skills.getIntegratedSkillContent(skillId); }

  // Covers the app's data folder, database maintenance and opening folders outside the app.
  reportRendererLog(payload: RendererLogPayload) { return this.services.system.reportRendererLog(payload); }
  resetDatabase() { return this.services.system.resetDatabase(); }
  getDatabaseStorageInfo() { return this.services.system.getDatabaseStorageInfo(); }
  compactDatabase() { return this.services.system.compactDatabase(); }
  openPathInFileManager(dirPath: string) { return this.services.system.openPathInFileManager(dirPath); }
  getAppPaths() { return this.services.system.getAppPaths(); }
  pickIdeExecutable() { return this.services.system.pickIdeExecutable(); }
  openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind) { return this.services.system.openRunWorktreeInIde(runId, ideKind); }
  openFolderInIde(folderPath: string, ideKind: SupportedIdeKind) { return this.services.system.openFolderInIde(folderPath, ideKind); }

  // Lists and stops the processes that runs and chats started.
  getOwnedProcesses(owner: OwnedProcessOwner) { return this.services.processes.getOwnedProcesses(owner); }
  manageOwnedProcesses(input: ManageOwnedProcessesInput) { return this.services.processes.manageOwnedProcesses(input); }
  getOwnedProcessOutput(owner: OwnedProcessOwner, processId: string) { return this.services.processes.getOwnedProcessOutput(owner, processId); }

  // Reads run history, workspace files and diffs for the run page.
  getProjectCodeMap(projectId: string) { return this.services.runDetails.getProjectCodeMap(projectId); }
  getRunDetail(runId: string) { return this.services.runDetails.getRunDetail(runId); }
  getEarlierRunHistory(runId: string, request: UserAnchoredHistoryPageRequest) { return this.services.runDetails.getEarlierRunHistory(runId, request); }
  getRunWorkspaceFile(input: RunWorkspaceFileInput) { return this.services.runDetails.getRunWorkspaceFile(input); }
  getRunWorktreeDiff(runId: string) { return this.services.runDetails.getRunWorktreeDiff(runId); }
  getRunWorktreeDiffSummary(runId: string) { return this.services.runDetails.getRunWorktreeDiffSummary(runId); }

  // Creates, continues and deletes chats, including the chats that belong to a run.
  createChat(input: ChatInput) { return this.services.chats.createChat(input); }
  getChatDetail(chatId: string) { return this.services.chats.getChatDetail(chatId); }
  getEarlierChatHistory(chatId: string, request: UserAnchoredHistoryPageRequest) { return this.services.chats.getEarlierChatHistory(chatId, request); }
  getRunChat(runId: string) { return this.services.chats.getRunChat(runId); }
  createRunChat(runId: string, input: RunChatInput) { return this.services.chats.createRunChat(runId, input); }
  followUpChat(chatId: string, prompt: string, options?: FollowUpChatOptions, extraLogMetadata?: Record<string, unknown>) {
    return this.services.chats.followUpChat(chatId, prompt, options, extraLogMetadata);
  }
  listChats() { return this.services.chats.listChats(); }
  listChatsWithSteps() { return this.services.chats.listChatsWithSteps(); }
  deleteChat(chatId: string) { return this.services.chats.deleteChat(chatId); }
  cancelChat(chatId: string) { return this.services.chats.cancelChat(chatId); }

  // Runs a chat turn in a worker thread and records its output.
  respondToChatUserInput(chatId: string, requestId: string, answers: RunUserInputAnswers) {
    return this.services.chatWorkerHost.respondToChatUserInput(chatId, requestId, answers);
  }

  // Queues, steers and delivers follow-up messages.
  queueRunFollowUp(runId: string, prompt: string, options?: RunFollowUpOptions, delivery: FollowUpDelivery = "queue") {
    return this.services.followUps.queueRunFollowUp(runId, prompt, options, delivery);
  }
  updateRunFollowUpQueue(runId: string, action: FollowUpQueueAction) { return this.services.followUps.updateRunFollowUpQueue(runId, action); }
  queueChatFollowUp(chatId: string, prompt: string, options?: FollowUpChatOptions, delivery: FollowUpDelivery = "queue") {
    return this.services.followUps.queueChatFollowUp(chatId, prompt, options, delivery);
  }
  updateChatFollowUpQueue(chatId: string, action: FollowUpQueueAction) { return this.services.followUps.updateChatFollowUpQueue(chatId, action); }

  // Connects council validation rounds with runs, workspaces and workers.
  startCouncil(runId: string) { return this.services.council.startCouncil(runId); }
  getCouncilRounds(runId: string) { return this.services.council.getCouncilRounds(runId); }
  cancelCouncil(roundId: string) { return this.services.council.cancelCouncil(roundId); }
  applyCouncilFindings(roundId: string, groupIds: string[]) { return this.services.council.applyCouncilFindings(roundId, groupIds); }
  reconcileCouncilAfterRestart() { return this.services.council.reconcileCouncilAfterRestart(); }

  // Connects pull request watching with runs and their workspaces.
  getRunPrWatchCandidates(runId: string) { return this.services.prWatch.getRunPrWatchCandidates(runId); }
  setRunForgeLink(runId: string, prUrl: string | null) { return this.services.prWatch.setRunForgeLink(runId, prUrl); }
  startPrWatch(runId: string, input: StartPrWatchInput) { return this.services.prWatch.startPrWatch(runId, input); }
  stopPrWatch(runId: string) { return this.services.prWatch.stopPrWatch(runId); }
  resumePrWatch(runId: string) { return this.services.prWatch.resumePrWatch(runId); }
  getProjectPrWatchInstructions(projectId: string) { return this.services.prWatch.getProjectPrWatchInstructions(projectId); }
  saveProjectPrWatchInstructions(projectId: string, instructions: string) {
    return this.services.prWatch.saveProjectPrWatchInstructions(projectId, instructions);
  }

  // Runs Project Lab proposals and implementations.
  runProjectLab(input: RunProjectLabInput) { return this.services.projectLab.runProjectLab(input); }
  deleteProjectLabThread(threadId: string) { return this.services.projectLab.deleteProjectLabThread(threadId); }
  getProjectLabThreadDetail(threadId: string) { return this.services.projectLab.getProjectLabThreadDetail(threadId); }

  // Starts and controls project loops.
  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void) { return this.services.projectLoops.onProjectLoopChanged(listener); }
  resumeActiveProjectLoops() { return this.services.projectLoops.resumeActiveProjectLoops(); }
  createProjectLoop(input: CreateProjectLoopInput) { return this.services.projectLoops.createProjectLoop(input); }
  getProjectLoopDetail(loopId: string) { return this.services.projectLoops.getProjectLoopDetail(loopId); }
  cancelProjectLoop(loopId: string) { return this.services.projectLoops.cancelProjectLoop(loopId); }
  resumeProjectLoop(loopId: string) { return this.services.projectLoops.resumeProjectLoop(loopId); }
  deleteProjectLoop(loopId: string) { return this.services.projectLoops.deleteProjectLoop(loopId); }
  respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput) {
    return this.services.projectLoops.respondToProjectLoopUiReview(reviewId, input);
  }
  getProjectLoopUiReviewImage(reviewId: string) { return this.services.projectLoops.getProjectLoopUiReviewImage(reviewId); }
  getProjectLoopAvailability(projectId: string) { return this.services.projectLoops.getProjectLoopAvailability(projectId); }

  // Generates project insights and activity reports.
  getProjectInsights(projectId: string) { return this.services.projectInsights.getProjectInsights(projectId); }
  queryProjectActivity(input: ProjectActivityQueryInput) { return this.services.projectInsights.queryProjectActivity(input); }
  generateProjectInsight(input: GenerateProjectInsightInput) { return this.services.projectInsights.generateProjectInsight(input); }

  // Drafts and opens pull and merge requests for runs.
  getRunPublishOptions(runId: string) { return this.services.runPullRequests.getRunPublishOptions(runId); }
  createRunPullRequest(runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string, commitMessage?: string) {
    return this.services.runPullRequests.createRunPullRequest(runId, targetBranch, title, sourceBranchName, description, commitMessage);
  }
  suggestRunPullRequestDraft(runId: string, targetBranch: string) { return this.services.runPullRequests.suggestRunPullRequestDraft(runId, targetBranch); }
  suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string) {
    return this.services.runPullRequests.suggestRunPullRequestDescription(runId, targetBranch, title);
  }

  // Commits, publishes, checks out and releases run branches.
  activateRun(runId: string) { return this.services.runBranches.activateRun(runId); }
  commitRun(runId: string, message: string) { return this.services.runBranches.commitRun(runId, message); }
  suggestCommitMessage(runId: string) { return this.services.runBranches.suggestCommitMessage(runId); }
  publishRunBranch(runId: string, branchName?: string) { return this.services.runBranches.publishRunBranch(runId, branchName); }
  createRunLocalBranch(runId: string, branchName: string) { return this.services.runBranches.createRunLocalBranch(runId, branchName); }
  suggestRunBranchName(runId: string) { return this.services.runBranches.suggestRunBranchName(runId); }
  releaseRun(runId: string) { return this.services.runBranches.releaseRun(runId); }

  // Deletes runs, their workspaces and data that is past its retention.
  getRunDeletionImpact(runId: string) { return this.services.runDeletion.getRunDeletionImpact(runId); }
  getDataRetentionCleanupImpact(dayCount: number) { return this.services.runDeletion.getDataRetentionCleanupImpact(dayCount); }
  deleteDataRetentionCandidates(dayCount: number, cutoffAt: string) { return this.services.runDeletion.deleteDataRetentionCandidates(dayCount, cutoffAt); }
  deleteRun(runId: string, options: { preserveBranch?: boolean } = {}) { return this.services.runDeletion.deleteRun(runId, options); }

  // Resumes interrupted runs and rewinds runs to earlier prompts.
  reconcileOrphanedActiveSessions() { return this.services.runRecovery.reconcileOrphanedActiveSessions(); }
  resumeRunFromCheckpoint(runId: string) { return this.services.runRecovery.resumeRunFromCheckpoint(runId); }
  recoverInterruptedRun(runId: string) { return this.services.runRecovery.recoverInterruptedRun(runId); }
  getRunRewindHistory(runId: string) { return this.services.runRecovery.getRunRewindHistory(runId); }
  rewindRun(input: RunRewindInput) { return this.services.runRecovery.rewindRun(input); }
  undoRunToLastPrompt(runId: string) { return this.services.runRecovery.undoRunToLastPrompt(runId); }

  // Owns orchestration records, their settings and their overall status.
  onOrchestrationChanged(listener: (payload: OrchestrationChangedPayload) => void) { return this.services.orchestration.onOrchestrationChanged(listener); }
  getOrchestrationDetail(coordinatorRunId: string) { return this.services.orchestration.getOrchestrationDetail(coordinatorRunId); }
  getOrchestrationTaskDetail(taskId: string) { return this.services.orchestration.getOrchestrationTaskDetail(taskId); }
  pauseOrchestration(coordinatorRunId: string) { return this.services.orchestration.pauseOrchestration(coordinatorRunId); }
  resumeOrchestration(coordinatorRunId: string) { return this.services.orchestration.resumeOrchestration(coordinatorRunId); }
  cancelOrchestration(coordinatorRunId: string) { return this.services.orchestration.cancelOrchestration(coordinatorRunId); }
  finishOrchestration(coordinatorRunId: string) { return this.services.orchestration.finishOrchestration(coordinatorRunId); }
  refreshOrchestrationTeam(coordinatorRunId: string) { return this.services.orchestration.refreshOrchestrationTeam(coordinatorRunId); }

  // Accepts delegated tasks and starts, defers and retries their child runs.
  retryOrchestrationTask(taskId: string) { return this.services.orchestrationDispatch.retryOrchestrationTask(taskId); }

  // Delivers messages from coordinators and users to child runs.
  sendOrchestrationTaskMessage(input: OrchestrationTaskMessageInput) { return this.services.orchestrationMessages.sendOrchestrationTaskMessage(input); }

  // Previews and applies the changes of isolated child workspaces.
  getOrchestrationAdoptionPreview(taskId: string) { return this.services.orchestrationAdoption.getOrchestrationAdoptionPreview(taskId); }
  decideOrchestrationAdoption(input: OrchestrationAdoptionDecisionInput) { return this.services.orchestrationAdoption.decideOrchestrationAdoption(input); }

  // Reconciles orchestrations after a restart and deletes them completely.
  reconcileOrchestrationsAfterRestart() { return this.services.orchestrationRecovery.reconcileOrchestrationsAfterRestart(); }
}
