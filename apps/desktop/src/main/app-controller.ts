import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { BuildWardenDatabase, type QueuedFollowUpEntry } from "@buildwarden/db";
import {
  GitService,
  isSameWorktreePath,
  readProjectActivityLog,
  readProjectReleaseHistory,
  readRecentCommitLog,
  readTrackedProjectFiles,
} from "@buildwarden/git-service";
import {
  APP_SETTING_KEYS,
  type AppWarning,
  type AssistProjectForgeIssueInput,
  buildDefaultProjectLabSettings,
  buildPriorChatCompletionMessagesFromSteps,
  canReviewRunChanges,
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatEvent,
  type ChatHistoryPage,
  type ChatInput,
  type ChatRecord,
  type ChatSearchDetail,
  type ChatStepRecord,
  commandToExactShellPatternSource,
  type CommentProjectForgeIssueInput,
  type ContinueRunInput,
  COUNCIL_REVIEW_EVENT_TITLE,
  type CouncilApplyRecord,
  type CouncilRound,
  type CreateProjectBranchInput,
  type CreateProjectForgeIssueInput,
  type CreateProjectLoopInput,
  type DataRetentionCleanupImpact,
  type DeleteProjectBranchInput,
  type DesktopApi,
  effectiveHarnessCapabilities,
  extractAttachmentPayloadsFromMetadata,
  type FetchProjectPrMrDiffInput,
  type FollowUpChatOptions,
  type FollowUpDelivery,
  type FollowUpQueueAction,
  type FollowUpQueueOutcome,
  type FollowUpQueueOwnerKind,
  type FollowUpQueueResult,
  forgeIssueBranchName,
  type GenerateProjectInsightInput,
  getAiSdkProviderFamilyFromConfigJson,
  getHarnessCapabilities,
  type GetProjectForgeIssueDetailsInput,
  type GetProjectForgeIssueImageInput,
  type GetProjectForgeRequestDetailsInput,
  isLoopCapableProviderType,
  isPrWatchActive,
  isSkillSelection,
  isSteerOutcomeUnknownError,
  isThemeToolName,
  type ListAvailableProviderModelsInput,
  type ListComposerCommandsInput,
  type ListProjectForgeIssuesInput,
  type ListProjectForgeRequestsInput,
  type ManageOwnedProcessesInput,
  MAX_DATA_RETENTION_CLEANUP_DAYS,
  MAX_QUEUED_FOLLOW_UPS,
  type MergeProjectBranchInput,
  type MergeProjectForgeRequestInput,
  type MergeRunForgeRequestInput,
  MIN_DATA_RETENTION_CLEANUP_DAYS,
  type ModelExecutionControlId,
  type ModelInput,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  type NetworkProxySettingsInput,
  type OrchestrationAdoptionDecisionInput,
  type OrchestrationAdoptionPreview,
  type OrchestrationChangedPayload,
  type OrchestrationDetail,
  type OrchestrationEffectRecord,
  type OrchestrationMessageDelivery,
  type OrchestrationRecord,
  type OrchestrationTaskMessageInput,
  type OrchestrationTaskMessageRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTaskStatus,
  type OrchestrationTeamSettings,
  OrchestrationToolError,
  type OrchestrationToolName,
  type OrchestrationWakeMode,
  type OwnedProcessOwner,
  parseCouncilSettings,
  parseHarnessSessionCapabilities,
  parseOrchestrationTeamSettings,
  parseProjectLabSettingsSetting,
  parseProjectPrWatchInstructionsSetting,
  parseProjectRunDefaultsSetting,
  parseShellAllowlistExtraSetting,
  parseToolApprovalAllowlistSetting,
  type PostProjectPrMrReviewInput,
  PR_WATCH_INSTRUCTIONS_MAX_CHARS,
  previewLargeStepContents,
  PROJECT_INSIGHT_KINDS,
  type ProjectActivityInsightData,
  type ProjectActivityQueryInput,
  type ProjectActivityQueryResult,
  type ProjectAutomationInput,
  type ProjectForgePrMonitorConfig,
  type ProjectForgePrMonitorSettingsInput,
  type ProjectForgeRequestSummary,
  type ProjectInput,
  type ProjectInsightKind,
  type ProjectInsightRecord,
  type ProjectLabMode,
  type ProjectLabSettings,
  type ProjectLabThreadRecord,
  type ProjectLoopAvailability,
  type ProjectLoopChangedPayload,
  type ProjectLoopDetail,
  type ProjectLoopRecord,
  type ProjectLoopUiReviewDecisionInput,
  type ProjectRecord,
  type ProjectTaskInput,
  type ProjectTaskRecord,
  type ProviderAccountInput,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  providerSupportsFollowUpSteering,
  type ProviderType,
  prWatchRequestLabel,
  type PrWatchView,
  type PullProjectBranchInput,
  type PushProjectBranchInput,
  type RebaseProjectBranchInput,
  type RenameProjectBranchInput,
  type RendererLogPayload,
  type ReplyProjectPrMrReviewThreadInput,
  resolveCouncilReviewers,
  resolveModelExecutionProfile,
  type ResolveProjectPrMrReviewThreadInput,
  RUN_CHAT_CONTEXT_SOURCE,
  RUN_VERIFICATION_FAILURE_PREFIX,
  type RunChatInput,
  type RunDeletionImpact,
  type RunDiffReviewOptions,
  type RunEvent,
  type RunFollowUpOptions,
  type RunForgeRequestSummary,
  type RunInput,
  type RunListVisibility,
  type RunProjectLabInput,
  type RunPrWatchCandidate,
  type RunPrWatchCandidates,
  type RunPublishOptions,
  type RunPullRequestDraft,
  type RunRecord,
  type RunResumeCheckpoint,
  type RunRewindArchive,
  type RunRewindInput,
  type RunRewindResult,
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
  SteerOutcomeUnknownError,
  type SubmitProjectPrMrCommentsInput,
  type SubscriptionLimitsInput,
  type SubscriptionResetInput,
  type SupportedIdeKind,
  toPrWatchView,
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
  validateUserInputAnswers,
} from "@buildwarden/shared";
import { normalizeSuggestedBranchName } from "./branch-name-suggestion";
import { getChatWorkspacePath, removeChatWorkspace } from "./chat-workspace";
import { getCompileCacheWorkerData } from "./compile-cache";
import { classifyCouncilFailure } from "./council-output";
import { councilApplyStepContent, type CouncilSubject } from "./council-prompts";
import { CouncilService } from "./council-service";
import { buildDataRetentionCleanupPlan, type DataRetentionCleanupPlan, retentionRootRunId } from "./data-retention";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { createFolderSnapshot, deleteFolderSnapshot } from "./folder-diff";
import { createFolderWorkspaceCopy, planFolderWorkspaceCopy, removeFolderWorkspaceCopy } from "./folder-workspace";
import { getHarnessTypeForProvider } from "./harness-adapters";
import { HostEventBus } from "./host-events";
import type { HostTerminal } from "./host-terminal-service";
import { normalizeJsonResponse } from "./json-response";
import { logInfo, logWarn } from "./logger";
import { ProjectLoopRunner } from "./loop/loop-runner";
import { resolveMcpServerRuntimeConfigs } from "./mcp-server-registry";
import {
  AGENT_ACTIVITY_EVENT_TYPES,
  closeCoordinatorWaitDeliveries,
  recordCoordinatorWaitDelivery,
  settleCoordinatorWaitDeliveries,
} from "./orchestration-delivery";
import { readOrchestrationHistory } from "./orchestration-history";
import {
  abandonedSubagentNote,
  closeAbandonedChildSubagents,
  describeChildPendingWork,
  resultAbandonedSubagentCount,
} from "./orchestration-native-work";
import { publishedFollowUpSummary } from "./orchestration-result-summary";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES, OrchestrationRuntimeActions } from "./orchestration-runtime-actions";
import { buildOrchestrationTaskRead, ORCHESTRATION_TASK_READ_MAX_EVENTS, ORCHESTRATION_TASK_READ_MESSAGES_PAGE } from "./orchestration-task-read";
import {
  childTaskMessagesDisplayText,
  classifyOrchestrationToolError,
  compactOrchestrationTask,
  DEFERRED_CHILD_RESUME_PROMPT,
  fenceChildOutput,
  formatChildTaskMessages,
  formatOrchestrationResumeTasks,
  isOrchestrationToolName,
  ORCHESTRATION_TOOL_DEFINITIONS,
  ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS,
  ORCHESTRATION_WAIT_MAX_TIMEOUT_MS,
  orchestrationToolFailure,
  orchestrationUpdateDisplayText,
  parseChildQuestionAnswers,
  type PendingChildQuestion,
  truncateForCoordinator,
  wrapOrchestrationUpdate,
} from "./orchestration-tools";
import { orchestrationWakeSatisfied } from "./orchestration-wake-policy";
import {
  applyOrchestrationDelta,
  captureOrchestrationBaseline,
  getOrchestrationArtifactRoot,
  previewOrchestrationDelta,
  recoverOrchestrationAdoption,
  removeOwnedOrchestrationArtifact,
  restoreOrchestrationBaseline,
  undoOrchestrationDelta,
} from "./orchestration-workspace";
import { PrReviewHttpError } from "./pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "./pr-review/pr-review-types";
import { type PrWatchForgeState, PrWatchService, type PrWatchWorkspaceCheck } from "./pr-watch-service";
import {
  buildProjectActivityInsight,
  parseProjectActivityLog,
  type ProjectActivityCommit,
  queryProjectActivity as queryProjectActivityCommits,
} from "./project-activity";
import { buildDependencyGraphSnapshotForProjectGraph, listDependencySourceFilesForProjectGraph } from "./project-graph-utils";
import {
  buildNarrativeBranchingInsight,
  buildProjectInsightPrompt,
  type DependencyGraphSnapshot,
  parseProjectInsightAiResponse,
  parseRecentCommitLog,
  type RepoCommitInfo,
} from "./project-insights";
import type { ProjectVerificationResult } from "./project-verification";
import {
  buildContextHandoffBlock,
  findLatestAccountStepMetadata,
  modelHandoffContextFor,
  planContextHandoff,
  providerUsesNativeSession,
  selectHandoffAttachments,
  stepsBeforeLatestTurn,
  withContextHandoff,
} from "./provider-context-handoff";
import { createResponseImageEmbedder } from "./response-images";
import { type RunBudgetExhaustion, timeBudgetExhaustion, tokenBudgetExhaustion } from "./run-autonomy-budget";
import { buildRunChatContext, buildRunChatFirstTurnPrompt, buildRunChatUpdateTurnPrompt, providerReplaysChatHistory } from "./run-chat-context";
import { resolveRunForgeSourceRepository } from "./run-forge-source";
import { executeRunRewind } from "./run-rewind-service";
import { runWorktreeDiffInWorker } from "./run-worktree-diff-worker";
import { type AppControllerLifecycle, AppServiceContext } from "./services/app-service";
import {
  ACTIVE_RUN_STATUSES,
  AZURE_LEGACY_AUTO_RECOVERY_KIND,
  FOLDER_BASELINE_MISSING_REASON,
  MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST,
  MAX_DIFF_CHARS_FOR_REVIEW,
  SELECTED_CHAT_KEY,
  SELECTED_PROJECT_KEY,
  SELECTED_RUN_KEY,
  SESSION_INTERRUPTED_MESSAGE,
} from "./services/app-service-constants";
import type { AppServices } from "./services/app-services";
import { createAppServices } from "./services/create-app-services";
import { isOpenForgeRequestState, projectForgeTokenSecretKey } from "./services/forge-request-policy";
import {
  isSettledChildRun,
  ORCHESTRATION_ACTIVE_TASK_STATUSES,
  ORCHESTRATION_CANCELLABLE_STATUSES,
  ORCHESTRATION_PENDING_ADOPTION_STATUSES,
  ORCHESTRATION_WAKE_NEWS_EVENT_TYPES,
  orchestrationRequestHash,
  orchestrationTaskStatusForRun,
  readPublishResultPayload,
} from "./services/orchestration-policy";
import { PROJECT_LAB_MODE_LABELS } from "./services/project-lab-prompts";
import {
  assertModelBelongsToProvider,
  providerAllowsMissingApiKey,
  type ProviderLimitState,
  providerSupportsInterruptedRunRecovery,
} from "./services/provider-model-support";
import { normalizeSuggestedCommitMessage } from "./services/run-branch-service";
import {
  applyTaskExecutionOptions,
  latestRunExecutionSettings,
  latestUserTurnUsedFullAccess,
  mergeOrchestrationExecutionOptions,
  resolveOrchestrationChildFullAccess,
  resolveProviderExecutionOptions,
  steerKeepsExecutionSettings,
} from "./services/run-execution-settings";
import { resolveRecoveryKind } from "./services/run-recovery-service";
import {
  buildPromptWithRunGoal,
  latestRunAnswerText,
  mergeProjectTaskRunAttachments,
  normalizeAssistantOutputText,
  normalizeRunGoalText,
  parseMetadataRecord,
  readPrWatchTurnResult,
  runChunkEventType,
  runUserRequests,
} from "./services/run-step-content";
import {
  type ChatWorkerChunkPayload,
  type ChatWorkerPayload,
  resetUsageBaselineForFreshSession,
  type RunWorkerPayload,
  type WorkerSteerResultPayload,
} from "./services/worker-payloads";
import { advanceUsageTracker, EMPTY_REPORTED_TOKEN_USAGE, readReportedTokenUsage, type UsageReportTracker } from "./token-usage-accounting";
import { stopWorkerAfterCleanup } from "./worker-shutdown";
import { canonicalWorkspacePath, workspacePathsOverlap } from "./workspace-restore-safety";
import { captureWorkspaceRevision } from "./workspace-revision";

/** buildwarden_tasks_read output goes straight into the coordinator's context; keep it bounded. */
const ORCHESTRATION_TASK_READ_DEFAULT_STEPS = 8;

const ORCHESTRATION_TASK_READ_MAX_STEPS = 50;
const ORCHESTRATION_TASK_READ_MAX_STEP_CHARS = 2_000;
const ORCHESTRATION_TASK_READ_MAX_FILES = 100;
const ORCHESTRATION_TASK_READ_MAX_DIFF_CHARS = 60_000;
const ORCHESTRATION_TASK_READ_MAX_SUMMARY_CHARS = 32_000;
const ORCHESTRATION_TASK_READ_MAX_PROMPT_CHARS = 4_000;

/** How often a blocking coordinator wait rechecks state that publishes no event. */
const ORCHESTRATION_WAIT_POLL_MS = 1_000;

/** Longer waits and repeated limits go to the coordinator instead of holding the wave. */
const ORCHESTRATION_MAX_DEFER_MS = 8 * 24 * 60 * 60 * 1_000;

const ORCHESTRATION_MAX_DEFERRALS = 3;
const TRANSIENT_WORKTREE_CLEANUP_ERROR = /\b(?:EBUSY|EPERM|ENOTEMPTY)\b/i;
const WORKTREE_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

const PROJECT_INSIGHT_AI_KINDS = new Set<ProjectInsightKind>([
  "repo-historian",
  "codebase-mood",
  "curiosity-mode",
]);

const councilCodeFingerprint = (revision: { fingerprint: string }): string => `code:${revision.fingerprint}`;
const councilTextFingerprint = (answer: string): string => `text:${createHash("sha256").update(answer).digest("hex")}`;

/**
 * Where a run's committed work begins: the head recorded when it started. A worktree run from before
 * that record uses its base branch. A local run has no branch of its own, so it gets null and its
 * start has to be found in history.
 */
export const councilCommittedBaseRef = (
  run: Pick<RunRecord, "workspaceType">,
  baseBranch: string,
  reviewBaseline: string | null,
): string | null => reviewBaseline ?? (run.workspaceType === "worktree" ? baseBranch : null);

const PROJECT_LAB_MODES: ProjectLabMode[] = ["new-feature", "bugfix", "refactoring", "rfc-only"];
const CHILD_WORKSPACE_REMOVAL_RETRY = "The child workspace could not be removed; BuildWarden tries again at the next start.";

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

/** Human-readable lab kickoff message; `baseBranch` is null for plain folder projects. */
const describeLabStart = (modeLabel: string, baseBranch: string | null, topic: string | null): string => {
  const origin = baseBranch ? `Started ${modeLabel} mode from base branch \`${baseBranch}\`` : `Started ${modeLabel} mode for this project folder`;
  return topic ? `${origin} with user direction: ${topic}` : `${origin}.`;
};

const AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE = "The run exceeded the maximum number of tool rounds (Azure Legacy).";

const AZURE_LEGACY_AUTO_RECOVERY_PROMPT =
  "Go ahead. The last session was interrupted. Trigger a full build or test first to see if you are done or not. If it fails, go ahead and fix the issues.";

/** Host-side wait for a worker to deliver steered input into its running turn. */
const FOLLOW_UP_STEER_TIMEOUT_MS = 20_000;

const UNCERTAIN_FOLLOW_UP_MESSAGE =
  "It stays queued but will not send on its own, so it cannot reach the agent twice. Send it again or remove it.";

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
  readonly chatUserInputRequests = new Map<string, Set<string>>();
  /** In-flight run-chat creations by run id; serializes concurrent first sends for the same run. */
  private readonly runChatCreations = new Map<string, Promise<ChatRecord>>();
  private deferredOrchestrationTickActive = false;
  /** Serializes durable orchestration state transitions for each coordinator graph. */
  private readonly orchestrationMutations = new Map<string, Promise<unknown>>();
  /** Coalesces automatic and user-triggered coordinator continuations. */
  private readonly orchestrationWakeLocks = new Set<string>();

  /** Live steering this run's integration implements, narrowed by what its session reported. */
  private acceptsLiveSteering(runId: string | null, providerType: ProviderType | null | undefined): boolean {
    if (!providerType || !providerSupportsFollowUpSteering(providerType)) return false;
    return effectiveHarnessCapabilities(providerType, runId ? this.services.providerRuntime.runSessionCapabilities.get(runId) : null).liveSteering;
  }

  /** What each provider account's latest session reported about the installed agent. */
  /** Tool identity of open non-shell approval requests, keyed like {@link runShellApprovalStepIds}. */
  private readonly runToolApprovalKeys = new Map<string, string>();
  /** Open approval requests (by step key) that may only be allowed once. */
  private readonly runOnceOnlyApprovals = new Set<string>();
  /**
   * The model each live run's provider last said served it. The reports are silent chunks, which
   * are not saved as steps, so publication copies the value into its durable effect.
   */
  private readonly runExecutedModels = new Map<string, string>();
  /** Owners (`kind:id`) whose follow-up queue is currently starting its next entry. */
  private readonly followUpQueueDispatches = new Set<string>();
  private readonly pendingFollowUpSteers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly cancelledProjectLabThreadIds = new Set<string>();
  private loopRunnerInstance: ProjectLoopRunner | null = null;
  private readonly projectActivityCache = new Map<string, {
    expiresAt: number;
    commits: ProjectActivityCommit[];
    currentFiles: string[];
    releaseHistory: Awaited<ReturnType<typeof readProjectReleaseHistory>>;
  }>();

  notifyRunDeleted(runId: string): void {
    this.services.runForge.runForgeViewRefreshedAt.delete(runId);
    try {
      this.context.lifecycle.onRunDeleted?.(runId);
    } catch (error) {
      this.context.logControllerWarn("A run-deletion lifecycle callback failed.", { runId, error });
    }
  }

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

  private async captureFolderBaselineSnapshotOrFail(run: RunRecord, project: ProjectRecord): Promise<void> {
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
        await this.deleteRunResources(project.repoPath, run, "run");
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

  private getProjectLabSettings(projectId: string): ProjectLabSettings {
    const settingsByProjectId = parseProjectLabSettingsSetting(this.context.db.getSettings()[APP_SETTING_KEYS.projectLabSettings]);
    return settingsByProjectId[projectId] ?? buildDefaultProjectLabSettings();
  }

  private async buildProjectLabRepoBrief(project: ProjectRecord): Promise<string> {
    const tasks = this.context.db.listProjectTasks(project.id).slice(0, 5);
    const insights = this.context.db.listProjectInsights(project.id).slice(0, 4);
    const recentRuns = this.context.db
      .listRunsForProject(project.id)
      .filter((run) => run.kind === "standard")
      .slice(0, 6);
    const recentCommits = (await this.readRecentCommitInfo(project.repoPath, 18)).slice(0, 8);

    return [
      `Repository path: ${project.repoPath}`,
      `Base branch: ${project.baseBranch}`,
      "",
      "Recent tasks:",
      tasks.length ? tasks.map((task) => `- ${task.title}: ${task.prompt}`).join("\n") : "- none",
      "",
      "Recent project insights:",
      insights.length ? insights.map((insight) => `- ${insight.title}: ${insight.summary}`).join("\n") : "- none",
      "",
      "Recent standard runs:",
      recentRuns.length ? recentRuns.map((run) => `- [${run.status}] ${run.prompt}`).join("\n") : "- none",
      "",
      "Recent commits:",
      recentCommits.length ? recentCommits.map((commit) => `- ${commit.date} ${commit.title}`).join("\n") : "- none",
    ].join("\n");
  }

  private buildProjectLabAvoidanceBrief(projectId: string, excludedThreadId?: string): string {
    const priorThreads = this.context.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.status !== "failed")
      .slice(0, 20);

    if (priorThreads.length === 0) {
      return "No prior Project Lab topics yet.";
    }

    return [
      "Avoid repeating or lightly rephrasing these existing Project Lab topics unless the user explicitly asked to revisit one:",
      ...priorThreads.map((thread) => {
        const summary = thread.summary.trim() ? ` - ${thread.summary.trim()}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 280)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Implementation: ${thread.implementationPrompt.trim().slice(0, 280)}`
          : "";
        return `- [${thread.status}] ${thread.title}${summary}${outcome}${implementation}`;
      }),
      "",
      "Choose a substantially different code area, risk, feature, or refactoring angle. If no distinct idea is worth pursuing, say so instead of duplicating prior work.",
    ].join("\n");
  }

  private buildProjectLabSameModePriorWorkBrief(projectId: string, mode: ProjectLabMode, excludedThreadId?: string): string {
    const priorThreads = this.context.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.mode === mode)
      .slice(0, 12);

    if (priorThreads.length === 0) {
      return `No previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs yet.`;
    }

    return [
      `Previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs. Treat these as already explored or worked on:`,
      ...priorThreads.map((thread) => {
        const topic = thread.title.trim() || `${PROJECT_LAB_MODE_LABELS[thread.mode]} Project Lab run`;
        const summary = thread.summary.trim() ? ` Summary: ${thread.summary.trim().slice(0, 320)}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 320)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Worked-on implementation: ${thread.implementationPrompt.trim().slice(0, 520)}`
          : "";
        return `- [${thread.status}] Topic: ${topic}.${summary}${outcome}${implementation}`;
      }),
      "",
      "Do not implement, fix, refactor, or lightly rephrase any topic listed above. Pick a genuinely different area and value/risk, or explicitly conclude that there is no distinct same-mode opportunity worth starting.",
    ].join("\n");
  }

  private chooseProjectLabMode(): ProjectLabMode {
    return PROJECT_LAB_MODES[randomInt(PROJECT_LAB_MODES.length)] ?? "new-feature";
  }

  private normalizeProjectLabMode(value: ProjectLabMode | undefined): ProjectLabMode {
    return value && PROJECT_LAB_MODES.includes(value) ? value : this.chooseProjectLabMode();
  }

  private buildProjectLabOpportunityInstruction(input: RunProjectLabInput, mode: ProjectLabMode): string {
    const userDirection = input.topic?.trim() ? `User direction: ${input.topic.trim()}` : null;
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    if (input.topic?.trim()) {
      return [
        `Chosen Project Lab mode: ${modeLabel}.`,
        userDirection,
        "Honor the user direction, but frame the work through the chosen mode unless the user explicitly asked for a different kind of outcome.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (mode === "new-feature") {
      return [
        "Chosen Project Lab mode: New feature.",
        "Find one concrete new user-facing product feature or workflow capability, then implement the smallest useful slice.",
        "Do not default to internal cleanup unless it directly enables the feature.",
      ].join(" ");
    }
    if (mode === "bugfix") {
      return [
        "Chosen Project Lab mode: Bugfix.",
        "Look for one concrete bug or vulnerability supported by repository evidence, with priority on security issues, authorization/authentication mistakes, null/undefined/null-pointer failures, data-loss risks, race conditions, invalid state handling, and reliability failures.",
        "Do not make a change just to produce output. Do not implement cosmetic cleanup, broad refactoring, dependency upgrades, naming changes, or speculative improvements.",
        "If the inspected code looks sound and you cannot identify a defensible bug, make no code changes and explain what you inspected.",
      ].join(" ");
    }
    if (mode === "refactoring") {
      return [
        "Chosen Project Lab mode: Refactoring.",
        "Find one focused refactor that reduces complexity, coupling, duplication, or maintenance cost, then implement it with a clear safety check.",
      ].join(" ");
    }
    return [
      "Chosen Project Lab mode: RFC only.",
      "Find one larger opportunity and write an RFC only. Do not edit code.",
      "The RFC should include motivation, proposal, alternatives, risks, rollout, and open questions.",
    ].join(" ");
  }

  private buildProjectLabModeBrief(mode: ProjectLabMode): string {
    if (mode === "new-feature") {
      return [
        "Mode requirements:",
        "- Prioritize a new capability that a developer using BuildWarden would notice.",
        "- Keep the implementation small enough for one worktree.",
        "- Update relevant UI, wiring, tests, and docs when needed.",
      ].join("\n");
    }
    if (mode === "bugfix") {
      return [
        "Mode requirements:",
        "- Prioritize security defects, auth/permission mistakes, null/undefined/null-pointer risks, data corruption/loss, race conditions, invalid state transitions, broken error handling, or reliability failures.",
        "- Require concrete evidence from the code path before changing files.",
        "- State the suspected failure mode before implementing.",
        "- Prefer a regression test or targeted validation that would catch the bug.",
        "- If no defensible bug is found, leave the worktree unchanged and summarize the inspected areas.",
      ].join("\n");
    }
    if (mode === "refactoring") {
      return [
        "Mode requirements:",
        "- Prioritize code health, architecture, cohesion, or simplification.",
        "- Avoid sweeping rewrites; choose a bounded refactor with a clear safety net.",
        "- Preserve behavior unless the user direction says otherwise.",
      ].join("\n");
    }
    return [
      "Mode requirements:",
      "- Produce an RFC only.",
      "- Do not edit files.",
      "- Include concrete next implementation steps, but leave execution for a future run.",
    ].join("\n");
  }

  private async buildProjectLabImplementationPrompt(input: RunProjectLabInput, project: ProjectRecord, mode: ProjectLabMode, threadId: string): Promise<string> {
    const repoBrief = await this.buildProjectLabRepoBrief(project);
    const avoidanceBrief = this.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
    const opportunityInstruction = this.buildProjectLabOpportunityInstruction(input, mode);
    const modeBrief = this.buildProjectLabModeBrief(mode);
    const agentObjective =
      mode === "bugfix"
        ? "Your job is to inspect this project, identify exactly one concrete bug or vulnerability for the selected mode, and implement a narrowly scoped fix only when the evidence supports it."
        : "Your job is to inspect this project, identify exactly one worthwhile improvement for the selected mode, and implement it directly in this workspace.";

    return [
      "You are BuildWarden Project Lab's implementation agent.",
      agentObjective,
      "Do not ask for a discussion round or wait for approval. Make a small, reviewable change.",
      "If the project evidence shows there is no safe distinct change worth making, make no code changes and explain why in the final answer.",
      "",
      `Project: ${project.name}`,
      opportunityInstruction,
      "",
      "Repository brief:",
      repoBrief,
      "",
      modeBrief,
      "",
      "Existing Project Lab topics to avoid:",
      avoidanceBrief,
      "",
      "Previous same-mode Project Lab work to avoid:",
      sameModePriorWorkBrief,
      "",
      "Execution requirements:",
      "- Start by inspecting the relevant code before choosing the exact change.",
      "- State the opportunity you selected in the run output before or while implementing.",
      "- Keep changes tightly scoped to one feature, bugfix, or refactor.",
      "- Run appropriate validation when available, or inspect changed files carefully when validation is not practical.",
      "- Finish with a concise summary of what changed, why it was worth doing, and how it was checked.",
    ].join("\n");
  }

  private async createProjectLabImplementationRun(
    projectId: string,
    threadId: string,
    modelId: string,
    prompt: string,
    baseBranch?: string | null,
  ): Promise<RunRecord> {
    const project = this.context.db.getProject(projectId);
    const selectedBaseBranch = baseBranch?.trim() || project.baseBranch;
    if (project.kind === "git") {
      const availableBranches = await this.services.projects.getProjectBranches(projectId);
      if (!availableBranches.includes(selectedBaseBranch)) {
        throw new Error(`Base branch "${selectedBaseBranch}" is not available for this project. Choose an existing Project Lab base branch and start a new thread.`);
      }
    }
    const model = this.context.db.getModel(modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    const harnessType = getHarnessTypeForProvider(provider.providerType);
    const run = await this.createRun({
      projectId,
      providerAccountId: model.providerAccountId,
      modelId,
      harnessType,
      mode: "code",
      workspaceType: project.kind === "folder" ? "copy" : "worktree",
      baseBranch: project.kind === "git" ? selectedBaseBranch : undefined,
      prompt,
      kind: "lab-implementation",
      labThreadId: threadId,
    });
    this.context.db.deleteSetting(SELECTED_RUN_KEY);
    this.context.db.setSetting(SELECTED_PROJECT_KEY, projectId);
    return run;
  }

  private async reviewCompletedProjectLabImplementation(run: RunRecord): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    const thread = this.context.db.getProjectLabThread(run.labThreadId);
    const project = this.context.db.getProject(run.projectId);
    const reviewModelId = thread.reviewModelId?.trim();

    if (!reviewModelId) {
      this.context.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: "Implementation completed, but no review model was stored on this Project Lab thread.",
      });
      this.context.db.updateProjectLabThread(thread.id, {
        status: "completed",
        summary: run.summary?.trim() || thread.summary,
        outcome: run.summary?.trim() || thread.outcome,
      });
      return;
    }

    this.context.db.updateProjectLabThread(thread.id, { status: "reviewing" });
    const diff = (await this.services.runDetails.getRunWorktreeDiff(run.id)).diff.trim();
    const context = await this.services.modelText.resolveModelInvocationContext(reviewModelId);
    const content = await this.services.modelText.askModelForText(run.worktreePath, context, {
      prompt: [
        `Project: ${project.name}`,
        `Project Lab mode: ${PROJECT_LAB_MODE_LABELS[thread.mode]}`,
        `Implementation thread: ${thread.title}`,
        `Implementation run summary: ${run.summary ?? "(none)"}`,
        "",
        "Review the implementation as a second agent.",
        "Focus on correctness, scope control, regressions, missing validation, and whether the change matches the Project Lab mode.",
        "Do not rewrite the implementation. Return concise Markdown with sections: Verdict, Findings, Follow-up.",
        "",
        "Diff:",
        diff || "(No remaining diff found. Review the run summary and note that there was no diff to inspect.)",
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Be direct, concrete, and practical.",
      maxTokens: 900,
      temperature: 0.2,
      usageProjectId: project.id,
    });

    const review = content.trim() || "Review completed without comments.";
    this.context.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "review",
      label: "Review agent",
      content: review,
    });
    this.context.db.updateProjectLabThread(thread.id, {
      status: "completed",
      summary: run.summary?.trim() || thread.summary,
      outcome: review,
    });
  }

  private async failProjectLabImplementation(run: RunRecord, message: string): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    const thread = this.context.db.getProjectLabThread(run.labThreadId);
    if (thread.status === "cancelled") {
      return;
    }
    this.context.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "System",
      content: `Implementation ended without success: ${message}`,
    });
    this.context.db.updateProjectLabThread(thread.id, {
      status: "failed",
      outcome: message,
    });
  }

  cancelProjectLabImplementation(run: RunRecord, message: string): void {
    if (!run.labThreadId) {
      return;
    }
    try {
      const thread = this.context.db.getProjectLabThread(run.labThreadId);
      if (thread.status === "cancelled") {
        return;
      }
      this.context.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: message,
      });
      this.context.db.updateProjectLabThread(thread.id, {
        status: "cancelled",
        outcome: message,
      });
    } catch {
      /* The Project Lab thread may have been deleted while its run was still stopping. */
    }
  }

  private isProjectLabThreadCancelled(threadId: string): boolean {
    return this.cancelledProjectLabThreadIds.has(threadId);
  }

  private projectLabTitleFromMarkdown(markdown: string, fallback: string): string {
    const heading = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#{1,3}\s+/.test(line));
    return heading?.replace(/^#{1,3}\s+/, "").trim().slice(0, 140) || fallback;
  }

  private projectLabSummaryFromMarkdown(markdown: string, fallback: string): string {
    const paragraph = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))[0];
    return paragraph?.slice(0, 320) || fallback;
  }

  private async executeProjectLabRfcThread(
    threadId: string,
    input: RunProjectLabInput,
    project: ProjectRecord,
    mode: ProjectLabMode,
    implementationModelId: string,
    reviewModelId: string,
  ): Promise<void> {
    const repoBrief = await this.buildProjectLabRepoBrief(project);
    const avoidanceBrief = this.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
    const implementationContext = await this.services.modelText.resolveModelInvocationContext(implementationModelId);
    const rfc = await this.services.modelText.askModelForText(project.repoPath, implementationContext, {
      prompt: [
        "You are BuildWarden Project Lab's RFC agent.",
        "Inspect the repository context below and write one useful RFC. Do not modify files.",
        "",
        `Project: ${project.name}`,
        this.buildProjectLabOpportunityInstruction(input, mode),
        "",
        "Repository brief:",
        repoBrief,
        "",
        this.buildProjectLabModeBrief(mode),
        "",
        "Existing Project Lab topics to avoid:",
        avoidanceBrief,
        "",
        "Previous same-mode Project Lab work to avoid:",
        sameModePriorWorkBrief,
        "",
        "Return concise Markdown with sections: Title, Motivation, Proposal, Alternatives, Risks, Rollout, Open Questions.",
      ].join("\n"),
      systemPrompt: "You write practical engineering RFCs grounded in repository evidence.",
      maxTokens: 1400,
      temperature: 0.35,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    const rfcContent = rfc.trim() || "No RFC content returned.";
    this.context.db.appendProjectLabEvent({
      threadId,
      role: "rfc",
      label: "RFC agent",
      content: rfcContent,
    });
    this.context.db.updateProjectLabThread(threadId, {
      title: this.projectLabTitleFromMarkdown(rfcContent, "Project Lab RFC"),
      summary: this.projectLabSummaryFromMarkdown(rfcContent, "Project Lab drafted an RFC."),
      outcome: rfcContent,
      status: "reviewing",
    });

    const reviewContext = await this.services.modelText.resolveModelInvocationContext(reviewModelId);
    const review = await this.services.modelText.askModelForText(project.repoPath, reviewContext, {
      prompt: [
        `Project: ${project.name}`,
        "Review this Project Lab RFC as a second agent.",
        "Check whether the proposal is useful, scoped, risky, missing alternatives, or ready for a future implementation run.",
        "Return concise Markdown with sections: Verdict, Gaps, Suggested next step.",
        "",
        "RFC:",
        rfcContent,
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Review RFC quality and practicality.",
      maxTokens: 800,
      temperature: 0.25,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    this.context.db.appendProjectLabEvent({
      threadId,
      role: "review",
      label: "Review agent",
      content: review.trim() || "RFC review completed without comments.",
    });
    this.context.db.updateProjectLabThread(threadId, {
      status: "completed",
    });
  }

  /**
   * Workers live only in memory; after a cold start the DB may still list runs/chats as queued/running.
   * Mark those rows terminal, reset worktree bookkeeping, and append an explanatory step.
   */
  async reconcileOrphanedActiveSessions(): Promise<void> {
    this.context.db.clearPendingSessionTitles();
    const activeStatuses: RunRecord["status"][] = ["queued", "preparing", "running"];
    this.reconcileInterruptedFollowUpDeliveries();

    const staleRuns = this.context.db.listRunsWithStatuses(activeStatuses).filter((run) => !this.services.activeWorkers.runWorkers.has(run.id));
    for (const run of staleRuns) {
      const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
      const model = this.context.db.getModel(run.modelId);
      const provider = this.context.db.getProviderAccount(model.providerAccountId);
      const providerRuntime = this.services.turnState.resolveRunNativeSession(run, provider).session;
      const providerRecoverySupported = providerSupportsInterruptedRunRecovery(provider.providerType);
      this.context.db.updateRunStatus(run.id, "cancelled", { errorMessage: SESSION_INTERRUPTED_MESSAGE });
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      await this.services.runEvents.appendRunEvent(
        run.id,
        "status",
        "Session interrupted",
        SESSION_INTERRUPTED_MESSAGE,
        {
          sessionInterrupted: true,
          canRecoverInterruptedSession: providerRecoverySupported && Boolean(checkpoint || providerRuntime?.resumeCursor),
          recoveryKind: resolveRecoveryKind(providerRecoverySupported, Boolean(checkpoint), Boolean(providerRuntime?.resumeCursor)),
        },
      );
    }

    const staleChats = this.context.db.listChatsWithStatuses(activeStatuses).filter((chat) => !this.services.activeWorkers.chatWorkers.has(chat.id));
    for (const chat of staleChats) {
      this.context.db.closeChatUserInputRequests(chat.id);
      this.context.db.updateChatStatus(chat.id, "cancelled", { finishedAt: new Date().toISOString() });
      await this.services.runEvents.appendChatEvent(chat.id, "status", "Session interrupted", SESSION_INTERRUPTED_MESSAGE, {
        sessionInterrupted: true,
      });
    }
  }

  async createChat(input: ChatInput): Promise<ChatRecord> {
    if (input.skillIds !== undefined && !isSkillSelection(input.skillIds)) throw new Error("Invalid chat skill selection.");
    const provider = this.context.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.context.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const displayPrompt =
      userText ||
      (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    const chat = this.context.db.createChat(input.providerAccountId, input.modelId, displayPrompt);
    if (input.skillIds !== undefined) this.services.skills.skillService.setSelection("chat", chat.id, input.skillIds);
    this.context.db.setSetting(SELECTED_CHAT_KEY, chat.id);
    this.services.forgeIssueActions.recordForgeIssueLink(input.forgeIssue, input.forgeIssue?.projectId ?? "", "chat", chat.id);

    const logContent = userText || "(no text)";

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Initial message", logContent, {
      source: "user",
      commandType: "initial",
      modelId: chat.modelId,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(input.attachments),
    });
    this.context.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat starting",
      content: "Starting chat...",
      createdAt: new Date().toISOString(),
    });

    const worker = await this.startChatWorker(
      chat,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      userText,
      input.attachments,
      executionOptions,
      userText,
    );
    this.services.activeWorkers.chatWorkers.set(chat.id, { worker, cancelled: false, providerType: provider.providerType });

    return this.context.db.getChat(chat.id);
  }

  async getChatDetail(chatId: string): Promise<ChatDetail> {
    const history = this.context.db.getInitialChatHistory(chatId);
    return {
      chat: this.context.db.getChat(chatId),
      steps: previewLargeStepContents(history.steps),
      queuedFollowUps: this.context.db.listQueuedFollowUps("chat", chatId),
      historyPage: history.page,
    };
  }

  async getEarlierChatHistory(chatId: string, request: UserAnchoredHistoryPageRequest): Promise<ChatHistoryPage> {
    const history = this.context.db.getEarlierChatHistory(chatId, request);
    return { ...history, steps: previewLargeStepContents(history.steps) };
  }

  async getRunChat(runId: string): Promise<ChatDetail | null> {
    const chat = this.context.db.getLatestChatForRun(runId);
    if (!chat) return null;
    const detail = this.context.db.getChatDetail(chat.id);
    return { ...detail, steps: previewLargeStepContents(detail.steps) };
  }

  private async buildRunChatContextForRun(runId: string): Promise<string> {
    const run = this.context.db.getRun(runId);
    const project = this.context.db.getProject(run.projectId);
    const diffResult = await this.services.runDetails.getRunWorktreeDiff(runId);
    return buildRunChatContext({
      run,
      steps: this.context.db.getRunSteps(runId),
      projectName: project.name,
      diff: diffResult.diff,
      diffUnavailableReason: diffResult.diffUnavailableReason ?? null,
    });
  }

  /**
   * Syncs the hidden run-context step with the run's latest steps and diff before a
   * follow-up turn. History-replaying providers pick the new content up automatically
   * on the next turn; for session-based providers the caller re-sends the context in
   * the prompt when it changed. Returns null when the refresh failed (the chat then
   * continues with the previous context).
   */
  private async refreshRunChatContext(chat: ChatRecord): Promise<{ context: string; changed: boolean } | null> {
    if (!chat.runId) {
      return null;
    }
    try {
      const context = await this.buildRunChatContextForRun(chat.runId);
      const contextStep = this.context.db.getChatSteps(chat.id).find((step) => {
        try {
          return (JSON.parse(step.metadataJson || "{}") as Record<string, unknown>).source === RUN_CHAT_CONTEXT_SOURCE;
        } catch {
          return false;
        }
      });
      if (!contextStep) {
        await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", context, {
          source: RUN_CHAT_CONTEXT_SOURCE,
          hidden: true,
          runId: chat.runId,
        });
        return { context, changed: true };
      }
      if (contextStep.content === context) {
        return { context, changed: false };
      }
      this.context.db.updateChatStep(contextStep.id, { content: context });
      return { context, changed: true };
    } catch (error) {
      this.context.logControllerWarn("Could not refresh the run chat context; continuing with the previous context.", {
        chatId: chat.id,
        runId: chat.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Starts (or continues) the run-scoped Q&A chat for a run. The first turn seeds the
   * conversation with a hidden context step holding the run's prompts, output, and diff.
   */
  async createRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    // Creation awaits the worktree diff, which can take seconds; serialize with any
    // in-flight creation for the same run so a concurrent send cannot slip past the
    // existence check and create a duplicate chat.
    const pending = this.runChatCreations.get(runId);
    if (pending) {
      await pending.catch(() => undefined);
    }

    const existing = this.context.db.getLatestChatForRun(runId);
    if (existing) {
      return this.followUpChat(existing.id, input.prompt, {
        modelId: input.modelId !== existing.modelId ? input.modelId : undefined,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
        anthropicEffort: input.anthropicEffort,
        executionOptions: input.executionOptions,
      });
    }

    const creation = this.startNewRunChat(runId, input);
    this.runChatCreations.set(runId, creation);
    try {
      return await creation;
    } finally {
      this.runChatCreations.delete(runId);
    }
  }

  private async startNewRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    this.context.db.getRun(runId); // validate the run exists before creating the chat
    const model = this.context.db.getModel(input.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const contextBlock = await this.buildRunChatContextForRun(runId);

    const displayPrompt =
      userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    // Run chats intentionally skip SELECTED_CHAT_KEY: they live in the run detail
    // panel and must not hijack the Chats page selection.
    const chat = this.context.db.createChat(provider.id, model.id, displayPrompt, runId);

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", contextBlock, {
      source: RUN_CHAT_CONTEXT_SOURCE,
      hidden: true,
      runId,
    });

    const logContent = userText || "(no text)";

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Initial message", logContent, {
      source: "user",
      commandType: "initial",
      modelId: chat.modelId,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(input.attachments),
    });
    this.context.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat starting",
      content: "Starting chat...",
      createdAt: new Date().toISOString(),
    });

    // History-replaying providers receive the context through prior messages (the hidden
    // step maps to a user turn); session-based CLI providers only see what is in the
    // prompt, so the context must ride along on the first turn.
    const firstTurnPrompt = providerReplaysChatHistory(provider.providerType)
      ? userText
      : buildRunChatFirstTurnPrompt(contextBlock, userText);

    const worker = await this.startChatWorker(
      chat,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      firstTurnPrompt,
      input.attachments,
      executionOptions,
      userText,
    );
    this.services.activeWorkers.chatWorkers.set(chat.id, { worker, cancelled: false, providerType: provider.providerType });

    return this.context.db.getChat(chat.id);
  }

  async followUpChat(
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<ChatRecord> {
    let chat = this.context.db.getChat(chatId);
    const model = this.context.db.getModel(options?.modelId ?? chat.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, options) ?? this.services.turnState.getLatestChatExecutionOptions(chatId, provider);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    if (this.services.activeWorkers.chatWorkers.has(chatId)) {
      throw new Error("This chat is already active. Wait for it to finish before sending a follow-up.");
    }

    if (!chat.runId) {
      this.context.db.setSetting(SELECTED_CHAT_KEY, chatId);
    }
    if (options?.modelId) {
      this.context.db.updateChatConfiguration(chatId, options.modelId);
      chat = this.context.db.getChat(chatId);
    }

    // Run chats see the run's latest steps and diff on every turn: the hidden context
    // step is refreshed in place, and session-based providers get the updated context
    // re-sent with the prompt (their session still holds the stale version).
    let workerPrompt = userText;
    if (chat.runId) {
      const refreshed = await this.refreshRunChatContext(chat);
      if (refreshed?.changed && !providerReplaysChatHistory(provider.providerType)) {
        workerPrompt = buildRunChatUpdateTurnPrompt(refreshed.context, userText);
      }
    }

    const logContent = userText || "(no text)";

    const chatHistory = this.context.db.getChatSteps(chat.id);
    const freshNativeSession = providerUsesNativeSession(provider.providerType) &&
      !this.services.turnState.resolveChatNativeSession(chat, provider, chatHistory).session;
    // A fresh native session gets the prior conversation in its prompt (chat worker); send the
    // files attached in those turns along, within the attachment limits.
    const handoffAttachments = freshNativeSession
      ? selectHandoffAttachments(chatHistory, { strategy: "full", fromStepIndex: 0, turnCount: 0 }, options?.attachments, this.context.db.resolveAttachmentBlob).attachments
      : [];
    const workerAttachments = mergeProjectTaskRunAttachments(handoffAttachments, options?.attachments);
    validateChatAttachmentPayloads(workerAttachments);
    const chatTurnMarker = this.services.turnState.buildTurnSettingsMarker(
      chatHistory,
      model,
      provider,
      !providerUsesNativeSession(provider.providerType) ? "replay" : freshNativeSession ? "history" : "session",
      { reasoningEffort: options?.reasoningEffort, anthropicEffort: options?.anthropicEffort, executionOptions },
      extraLogMetadata?.queuedFollowUpId,
    );
    if (chatTurnMarker) {
      await this.services.runEvents.appendChatEvent(chat.id, "status", chatTurnMarker.title, chatTurnMarker.content, {
        ...chatTurnMarker.metadata,
        userFacing: true,
      });
    }
    await this.services.runEvents.appendChatEvent(chat.id, "log", "Follow-up", logContent, {
      ...extraLogMetadata,
      source: "user",
      commandType: "follow-up",
      modelId: model.id,
      providerAccountId: provider.id,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(options?.attachments),
    });
    this.context.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });

    let worker: Worker;
    try {
      worker = await this.startChatWorker(
        chat,
        provider,
        model,
        apiKey ?? "",
        await this.services.settings.resolveNetworkProxyRuntimeConfig(),
        workerPrompt,
        workerAttachments,
        executionOptions,
        userText,
      );
    } catch (error) {
      // A turn that never started must not leave the chat looking active.
      if (!this.services.activeWorkers.chatWorkers.has(chat.id)) {
        this.context.db.updateChatStatus(chat.id, "failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
    this.services.activeWorkers.chatWorkers.set(chat.id, { worker, cancelled: false, providerType: provider.providerType });
    this.acceptQueuedFollowUp(extraLogMetadata);

    return this.context.db.getChat(chat.id);
  }

  async queueRunFollowUp(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    delivery: FollowUpDelivery = "queue",
  ): Promise<FollowUpQueueResult> {
    this.context.db.getRun(runId);
    this.services.workspaceGuard.requireWorkspaceNotRestoring(this.context.db.getRun(runId).worktreePath);
    return this.queueFollowUp("run", runId, prompt, options ?? {}, delivery);
  }

  async updateRunFollowUpQueue(runId: string, action: FollowUpQueueAction): Promise<FollowUpQueueResult> {
    this.context.db.getRun(runId);
    return this.updateFollowUpQueue("run", runId, action);
  }

  async queueChatFollowUp(
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
    delivery: FollowUpDelivery = "queue",
  ): Promise<FollowUpQueueResult> {
    this.context.db.getChat(chatId);
    return this.queueFollowUp("chat", chatId, prompt, options ?? {}, delivery);
  }

  async updateChatFollowUpQueue(chatId: string, action: FollowUpQueueAction): Promise<FollowUpQueueResult> {
    this.context.db.getChat(chatId);
    return this.updateFollowUpQueue("chat", chatId, action);
  }

  private async queueFollowUp(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    prompt: string,
    options: RunFollowUpOptions | FollowUpChatOptions,
    delivery: FollowUpDelivery,
  ): Promise<FollowUpQueueResult> {
    const { attachments = [], ...executionOptions } = options;
    const text = prompt.trim();
    const updatesGoal = kind === "run" && Object.prototype.hasOwnProperty.call(executionOptions, "goalText");
    if (!text && attachments.length === 0 && !updatesGoal) {
      throw new Error(kind === "run" ? "Enter a follow-up command or attach at least one file." : "Enter a message or attach at least one file.");
    }
    validateChatAttachmentPayloads(attachments);
    if (executionOptions.modelId) this.context.db.getModel(executionOptions.modelId);
    if (this.context.db.listQueuedFollowUps(kind, ownerId).length >= MAX_QUEUED_FOLLOW_UPS) {
      throw new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can wait in the queue. Send or remove one first.`);
    }
    const entry = this.context.db.enqueueFollowUp({
      ownerKind: kind,
      ownerId,
      prompt: text,
      options: JSON.parse(JSON.stringify(executionOptions)) as Record<string, unknown>,
      attachments,
    });
    this.emitFollowUpQueueChanged(kind, ownerId);

    let steerError: string | undefined;
    let steerOutcomeUnknown = false;
    if (delivery === "steer" && this.isFollowUpOwnerActive(kind, ownerId)) {
      try {
        const notice = await this.steerQueuedFollowUp(entry);
        return { queue: this.context.db.listQueuedFollowUps(kind, ownerId), outcome: "steered", ...(notice ? { notice } : {}) };
      } catch (error) {
        steerError = error instanceof Error ? error.message : String(error);
        steerOutcomeUnknown = isSteerOutcomeUnknownError(error);
      }
    }
    // An idle owner starts its queue right away, oldest entry first, so ordering holds.
    const started = await this.dispatchQueuedFollowUps(kind, ownerId);
    return {
      queue: this.context.db.listQueuedFollowUps(kind, ownerId),
      outcome: started.includes(entry.record.id) ? "started" : "queued",
      ...(steerError ? { steerError } : {}),
      ...(steerOutcomeUnknown ? { steerOutcomeUnknown } : {}),
    };
  }

  private async updateFollowUpQueue(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    action: FollowUpQueueAction,
  ): Promise<FollowUpQueueResult> {
    let outcome: FollowUpQueueOutcome = "updated";
    let steerError: string | undefined;
    let steerOutcomeUnknown = false;
    let notice: string | undefined;
    switch (action.type) {
      case "edit": {
        const entry = this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        const text = action.prompt.trim();
        if (!text && entry.attachments.length === 0 && !entry.record.updatesGoal) {
          throw new Error("A queued follow-up needs text or at least one attachment.");
        }
        this.context.db.updateQueuedFollowUpPrompt(entry.record.id, text);
        break;
      }
      case "move":
        this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        this.context.db.moveQueuedFollowUp(action.queuedFollowUpId, action.direction === "up" ? "up" : "down");
        break;
      case "delete":
        this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        this.context.db.deleteQueuedFollowUp(action.queuedFollowUpId);
        break;
      case "send-now": {
        const entry = this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        // Sending an uncertain entry again is the user's explicit decision.
        if (entry.deliveryState === "uncertain") {
          this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
          entry.deliveryState = null;
        }
        if (this.isFollowUpOwnerActive(kind, ownerId)) {
          try {
            notice = await this.steerQueuedFollowUp(entry);
            outcome = "steered";
          } catch (error) {
            steerError = error instanceof Error ? error.message : String(error);
            steerOutcomeUnknown = isSteerOutcomeUnknownError(error);
            this.context.db.moveQueuedFollowUp(entry.record.id, "front");
            outcome = "moved-to-front";
          }
          break;
        }
        this.context.db.moveQueuedFollowUp(entry.record.id, "front");
        const started = await this.dispatchQueuedFollowUps(kind, ownerId, { rethrow: true });
        outcome = started.includes(entry.record.id) ? "started" : "moved-to-front";
        break;
      }
      case "resume": {
        const started = await this.dispatchQueuedFollowUps(kind, ownerId, { rethrow: true });
        if (started.length > 0) outcome = "started";
        break;
      }
      default:
        throw new Error("Unsupported follow-up queue action.");
    }
    this.emitFollowUpQueueChanged(kind, ownerId);
    return {
      queue: this.context.db.listQueuedFollowUps(kind, ownerId),
      outcome,
      ...(steerError ? { steerError } : {}),
      ...(steerOutcomeUnknown ? { steerOutcomeUnknown } : {}),
      ...(notice ? { notice } : {}),
    };
  }

  private requireQueuedFollowUp(kind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): QueuedFollowUpEntry {
    const entry = typeof queuedFollowUpId === "string" ? this.context.db.getQueuedFollowUpEntry(queuedFollowUpId) : null;
    const delivering = entry?.deliveryState === "starting" || entry?.deliveryState === "steering";
    if (!entry || delivering || entry.ownerKind !== kind || entry.ownerId !== ownerId) {
      throw new Error("This queued follow-up was already sent or removed.");
    }
    return entry;
  }

  private isFollowUpOwnerActive(kind: FollowUpQueueOwnerKind, ownerId: string): boolean {
    if (kind === "run") {
      if (this.services.activeWorkers.runWorkers.has(ownerId) || this.services.workspaceGuard.manualVerifications.has(ownerId)) return true;
      return ACTIVE_RUN_STATUSES.has(this.context.db.getRun(ownerId).status);
    }
    if (this.services.activeWorkers.chatWorkers.has(ownerId)) return true;
    return ACTIVE_RUN_STATUSES.has(this.context.db.getChat(ownerId).status);
  }

  private followUpOwnerExists(kind: FollowUpQueueOwnerKind, ownerId: string): boolean {
    try {
      if (kind === "run") this.context.db.getRun(ownerId);
      else this.context.db.getChat(ownerId);
      return true;
    } catch {
      return false;
    }
  }

  private dispatchQueuedFollowUpsInBackground(kind: FollowUpQueueOwnerKind, ownerId: string): void {
    void this.dispatchQueuedFollowUps(kind, ownerId).catch((error) => {
      this.context.logControllerError("Could not start a queued follow-up.", error, { ownerKind: kind, ownerId });
    });
  }

  /**
   * Starts queued follow-ups, oldest first, while the owner is idle. An entry is marked
   * `starting` (and hidden) while its turn starts and is deleted only once the turn runs; a
   * failed start returns it to the queue, which holds until the user resumes. An entry whose
   * steering could not be confirmed also holds the queue. Returns the ids that started.
   */
  private async dispatchQueuedFollowUps(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    options: { rethrow?: boolean } = {},
  ): Promise<string[]> {
    const key = `${kind}:${ownerId}`;
    if (this.followUpQueueDispatches.has(key)) return [];
    this.followUpQueueDispatches.add(key);
    const started: string[] = [];
    try {
      while (!this.services.activeWorkers.agentWorkersStopping && this.followUpOwnerExists(kind, ownerId) && !this.isFollowUpOwnerActive(kind, ownerId)) {
        const next = this.context.db.listQueuedFollowUpEntries(kind, ownerId)[0];
        if (!next) break;
        if (next.deliveryState === "uncertain") {
          if (options.rethrow) {
            throw new Error(`The next queued follow-up may already have reached the agent. ${UNCERTAIN_FOLLOW_UP_MESSAGE}`);
          }
          break;
        }
        this.context.db.setQueuedFollowUpDeliveryState(next.record.id, "starting");
        this.emitFollowUpQueueChanged(kind, ownerId);
        try {
          await this.startQueuedFollowUp(next);
          // Follow-ups that only update the goal finish without a worker to accept them.
          this.context.db.deleteQueuedFollowUp(next.record.id);
          this.emitFollowUpQueueChanged(kind, ownerId);
          started.push(next.record.id);
        } catch (error) {
          if (!this.followUpOwnerExists(kind, ownerId)) break;
          // Another caller may hold the owner's worker, so only this attempt's acceptance counts.
          if (!this.context.db.getQueuedFollowUpEntry(next.record.id)) {
            this.emitFollowUpQueueChanged(kind, ownerId);
            started.push(next.record.id);
            this.context.logControllerWarn("A queued follow-up started but reported an error.", { ownerKind: kind, ownerId, error });
            break;
          }
          // The turn did not start: withdraw the user step this attempt wrote so a retry does
          // not repeat it, and keep the entry queued for another attempt.
          this.withdrawQueuedFollowUpSteps(kind, ownerId, next.record.id);
          this.context.db.setQueuedFollowUpDeliveryState(next.record.id, null);
          this.emitFollowUpQueueChanged(kind, ownerId);
          await this.reportQueuedFollowUpFailure(kind, ownerId, error);
          if (options.rethrow) throw error;
          break;
        }
      }
    } finally {
      this.followUpQueueDispatches.delete(key);
    }
    return started;
  }

  /**
   * Called in the tick a worker registers for a follow-up. A queued entry is deleted here, so
   * its absence proves that this attempt, not another caller, delivered the message.
   */
  private acceptQueuedFollowUp(extraLogMetadata: Record<string, unknown> | undefined): void {
    const queuedFollowUpId = extraLogMetadata?.queuedFollowUpId;
    if (typeof queuedFollowUpId === "string") this.context.db.deleteQueuedFollowUp(queuedFollowUpId);
  }

  private async startQueuedFollowUp(entry: QueuedFollowUpEntry): Promise<void> {
    const options = {
      ...entry.options,
      ...(entry.attachments.length ? { attachments: entry.attachments } : {}),
    };
    const metadata = { queuedFollowUpId: entry.record.id };
    if (entry.ownerKind === "run") {
      await this.followUpRun(entry.ownerId, entry.record.prompt, options as RunFollowUpOptions, metadata);
    } else {
      await this.followUpChat(entry.ownerId, entry.record.prompt, options as FollowUpChatOptions, metadata);
    }
  }

  /**
   * Settles queue entries whose delivery was cut off by an app restart.
   *
   * - Starting: a worker deletes the entry when it accepts the turn, so a surviving entry
   *   never reached the agent. Its user step is withdrawn and it waits for another attempt.
   * - Steering: the step is written only after the provider confirmed the input, so it is
   *   proof; without it the agent may or may not have the message, so it waits for the user.
   */
  private reconcileInterruptedFollowUpDeliveries(): void {
    for (const entry of this.context.db.listQueuedFollowUpEntriesInDelivery()) {
      const { ownerKind: kind, ownerId } = entry;
      if (!this.followUpOwnerExists(kind, ownerId)) {
        this.context.db.deleteQueuedFollowUp(entry.record.id);
        continue;
      }
      if (entry.deliveryState === "steering") {
        if (this.context.db.hasStepForQueuedFollowUp(kind, ownerId, entry.record.id)) this.context.db.deleteQueuedFollowUp(entry.record.id);
        else this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, "uncertain");
        continue;
      }
      this.context.db.deleteStepsForQueuedFollowUp(kind, ownerId, entry.record.id);
      this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
    }
  }

  /** Drops the steps of an undelivered attempt and tells clients to reload the transcript. */
  private withdrawQueuedFollowUpSteps(kind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): void {
    if (this.context.db.deleteStepsForQueuedFollowUp(kind, ownerId, queuedFollowUpId) === 0) return;
    const event = {
      runId: ownerId,
      type: "status" as const,
      title: "Follow-up withdrawn",
      content: "",
      metadata: { silent: true, queuedFollowUpWithdrawn: queuedFollowUpId },
      createdAt: new Date().toISOString(),
    };
    if (kind === "run") this.services.runEvents.emitEvent(event);
    else this.services.runEvents.emitChatEvent(ownerId, event);
  }

  private async reportQueuedFollowUpFailure(kind: FollowUpQueueOwnerKind, ownerId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const content = `${message}\nThe follow-up stays queued. Edit it, remove it, or resume the queue.`;
    const metadata = { followUpQueue: true, userFacing: true };
    this.context.logControllerWarn("A queued follow-up could not start.", { ownerKind: kind, ownerId, error: message });
    try {
      if (kind === "run") {
        const step = await this.services.runEvents.appendRunEvent(ownerId, "error", "Queued follow-up held", content, metadata);
        this.services.runEvents.emitEvent({ runId: ownerId, type: "error", title: step.title, content, metadata, createdAt: step.createdAt, step });
      } else {
        const step = await this.services.runEvents.appendChatEvent(ownerId, "error", "Queued follow-up held", content, metadata);
        this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "error", title: step.title, content, metadata, createdAt: step.createdAt, step });
      }
    } catch (reportError) {
      this.context.logControllerError("Could not record the held follow-up.", reportError, { ownerKind: kind, ownerId });
    }
  }

  /**
   * Delivers a queued follow-up into the running turn. Refuses (leaving the entry queued)
   * when the turn cannot take it unchanged; an unconfirmed delivery marks it uncertain.
   * Returns a note when the turn keeps execution settings the follow-up asked to change.
   */
  private async steerQueuedFollowUp(entry: QueuedFollowUpEntry): Promise<string | undefined> {
    const { ownerKind: kind, ownerId } = entry;
    const active = (kind === "run" ? this.services.activeWorkers.runWorkers : this.services.activeWorkers.chatWorkers).get(ownerId);
    if (!active || active.cancelled) throw new OrchestrationToolError("delivery_unavailable", "The agent is not running a turn that can take this message.");
    if (!this.acceptsLiveSteering(kind === "run" ? ownerId : null, active.providerType)) {
      throw new OrchestrationToolError("delivery_unavailable", "This provider cannot take messages during a turn. The follow-up waits for the turn to finish.");
    }
    if (entry.record.updatesGoal) throw new Error("Goal updates wait for the current turn to finish.");
    const owner = kind === "run" ? this.context.db.getRun(ownerId) : this.context.db.getChat(ownerId);
    const requestedModelId = typeof entry.options.modelId === "string" ? entry.options.modelId : null;
    if (requestedModelId && requestedModelId !== owner.modelId) {
      throw new Error("A model change waits for the current turn to finish.");
    }
    const requestedMode = typeof entry.options.mode === "string" ? entry.options.mode : null;
    if (kind === "run" && requestedMode && requestedMode !== (owner as RunRecord).mode) {
      throw new Error("A mode change waits for the current turn to finish.");
    }
    // A steered message runs with the permissions of the running turn, so Full access changes wait.
    if (kind === "run" && typeof entry.options.yoloMode === "boolean" &&
      entry.options.yoloMode !== (latestRunExecutionSettings(this.context.db.getRunSteps(ownerId))?.yoloMode === true)) {
      throw new Error("A Full access change waits for the current turn to finish.");
    }
    const provider = this.context.db.getProviderAccount(owner.providerAccountId);
    const currentExecution = kind === "run"
      ? this.services.turnState.getLatestRunExecutionOptions(ownerId, provider)
      : this.services.turnState.getLatestChatExecutionOptions(ownerId, provider);
    const notice = steerKeepsExecutionSettings(resolveProviderExecutionOptions(provider, entry.options), currentExecution)
      ? "Sent into the running turn, which keeps its current reasoning and speed settings."
      : undefined;

    // Hidden while in flight so a turn ending meanwhile cannot also start it; the row stays
    // persisted so a restart can still recover the message.
    this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, "steering");
    this.emitFollowUpQueueChanged(kind, ownerId);
    try {
      await this.requestWorkerSteer(active.worker, entry.record.prompt, entry.attachments);
    } catch (error) {
      if (!this.followUpOwnerExists(kind, ownerId)) throw error;
      if (isSteerOutcomeUnknownError(error)) {
        this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, "uncertain");
        this.emitFollowUpQueueChanged(kind, ownerId);
        const message = error instanceof Error ? error.message : String(error);
        await this.reportUncertainFollowUp(kind, ownerId, entry, message);
        throw new SteerOutcomeUnknownError(`${message} ${UNCERTAIN_FOLLOW_UP_MESSAGE}`);
      }
      this.context.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
      this.emitFollowUpQueueChanged(kind, ownerId);
      throw error;
    }
    const content = entry.record.prompt || "(no text)";
    const metadata = {
      source: "user",
      commandType: "steer",
      steered: true,
      queuedFollowUpId: entry.record.id,
      modelId: owner.modelId,
      providerAccountId: owner.providerAccountId,
      ...this.services.runEvents.buildStoredAttachmentMetadata(entry.attachments),
    };
    if (kind === "run") {
      const step = await this.services.runEvents.appendRunEvent(ownerId, "log", "Follow-up command", content, metadata);
      this.services.runEvents.emitEvent({ runId: ownerId, type: "log", title: step.title, content, metadata, createdAt: step.createdAt, step });
    } else {
      const step = await this.services.runEvents.appendChatEvent(ownerId, "log", "Follow-up", content, metadata);
      this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "log", title: step.title, content, metadata, createdAt: step.createdAt, step });
    }
    this.context.db.deleteQueuedFollowUp(entry.record.id);
    this.emitFollowUpQueueChanged(kind, ownerId);
    return notice;
  }

  private async reportUncertainFollowUp(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    entry: QueuedFollowUpEntry,
    reason: string,
  ): Promise<void> {
    const title = "Steered message unconfirmed";
    const content = [
      `BuildWarden could not confirm that the running turn took this message: ${reason}`,
      entry.record.prompt ? `> ${entry.record.prompt.split("\n")[0]}` : "",
      UNCERTAIN_FOLLOW_UP_MESSAGE,
    ].filter(Boolean).join("\n");
    const metadata = { followUpQueue: true, userFacing: true, queuedFollowUpUncertain: entry.record.id };
    try {
      if (kind === "run") {
        const step = await this.services.runEvents.appendRunEvent(ownerId, "status", title, content, metadata);
        this.services.runEvents.emitEvent({ runId: ownerId, type: "status", title, content, metadata, createdAt: step.createdAt, step });
      } else {
        const step = await this.services.runEvents.appendChatEvent(ownerId, "status", title, content, metadata);
        this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "status", title, content, metadata, createdAt: step.createdAt, step });
      }
    } catch (reportError) {
      this.context.logControllerError("Could not record the unconfirmed steered message.", reportError, { ownerKind: kind, ownerId });
    }
  }

  private requestWorkerSteer(worker: Worker, prompt: string, attachments: ChatAttachmentPayload[]): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("exit", onExit);
        this.pendingFollowUpSteers.delete(requestId);
      };
      // Once posted, the worker may already have handed the message to the provider.
      const onExit = () => {
        cleanup();
        reject(new SteerOutcomeUnknownError("The turn ended before confirming the message."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SteerOutcomeUnknownError("The running turn did not confirm the message in time."));
      }, FOLLOW_UP_STEER_TIMEOUT_MS);
      worker.once("exit", onExit);
      this.pendingFollowUpSteers.set(requestId, {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      try {
        worker.postMessage({ type: "steer", requestId, prompt, attachments });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private settleFollowUpSteer(payload: WorkerSteerResultPayload): void {
    const pending = this.pendingFollowUpSteers.get(payload.requestId);
    if (!pending) return;
    if (payload.error) pending.reject(payload.outcomeUnknown ? new SteerOutcomeUnknownError(payload.error) : new Error(payload.error));
    else pending.resolve();
  }

  private emitFollowUpQueueChanged(kind: FollowUpQueueOwnerKind, ownerId: string): void {
    if (!this.followUpOwnerExists(kind, ownerId)) return;
    const event = {
      runId: ownerId,
      type: "status" as const,
      title: "Follow-up queue updated",
      content: "",
      metadata: { silent: true, followUpQueue: true, queuedFollowUps: this.context.db.listQueuedFollowUps(kind, ownerId) },
      createdAt: new Date().toISOString(),
    };
    if (kind === "run") this.services.runEvents.emitEvent(event);
    else this.services.runEvents.emitChatEvent(ownerId, event);
  }

  async listChats(): Promise<ChatRecord[]> {
    return this.context.db.listChats().map((s) => this.context.db.getChat(s.id));
  }

  async listChatsWithSteps(): Promise<ChatSearchDetail[]> {
    return this.context.db.listChatsWithSteps();
  }

  async deleteChat(chatId: string): Promise<void> {
    this.services.titles.sessionTitleServiceInstance?.cancel("chat", chatId);
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    if (active) {
      active.cancelled = true;
      const stopped = stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }));
      this.services.activeWorkers.chatWorkers.delete(chatId);
      this.chatUserInputRequests.delete(chatId);
      this.context.db.closeChatUserInputRequests(chatId);
      await stopped;
    }
    const isRunChat = Boolean(this.context.db.getChat(chatId).runId);
    await this.removeChatWorkspaceBestEffort(chatId);
    this.context.db.deleteProviderSessionRuntime(chatId, "chat");
    this.context.db.deleteChat(chatId);
    this.services.processes.ownedProcessRegistryInstance?.forgetOwner({ kind: "chat", id: chatId });
    if (!isRunChat) {
      this.context.db.deleteSetting(SELECTED_CHAT_KEY);
    }
  }

  private async removeChatWorkspaceBestEffort(chatId: string): Promise<void> {
    await this.services.processes.stopOwnedProcessesForRemoval({ kind: "chat", id: chatId });
    try {
      await removeChatWorkspace(this.context.db.getFilePath(), chatId);
    } catch (error) {
      this.context.logControllerWarn("Could not remove the chat workspace; continuing deletion.", { chatId, error });
    }
  }

  async cancelChat(chatId: string): Promise<void> {
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    if (!active) return;
    active.cancelled = true;
    const stopped = stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }));
    this.context.db.updateChatStatus(chatId, "cancelled", {
      errorMessage: "Chat cancelled by user.",
      finishedAt: new Date().toISOString(),
    });
    await this.services.runEvents.appendChatEvent(chatId, "status", "Chat cancelled", "Cancellation requested.", { userFacing: true });
    this.services.runEvents.emitChatEvent(chatId, {
      runId: chatId,
      type: "status",
      title: "Chat cancelled",
      content: "Cancellation requested.",
      metadata: { userFacing: true },
      createdAt: new Date().toISOString(),
    });
    this.chatUserInputRequests.delete(chatId);
    this.context.db.closeChatUserInputRequests(chatId);
    await stopped;
    if (this.services.activeWorkers.chatWorkers.get(chatId) === active) this.services.activeWorkers.chatWorkers.delete(chatId);
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
      await this.discardPreparedRunWorkspace(project.repoPath, { workspaceType, branchName, worktreePath });
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
      await this.discardPreparedRunWorkspace(project.repoPath, { workspaceType, branchName, worktreePath });
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

  private resolveWorktreeStartPoint(project: ProjectRecord, baseBranch: string): Promise<string> | string {
    return this.context.db.getSettings()[APP_SETTING_KEYS.worktreeStartFromRemoteBase] === "true"
      ? this.context.gitService.resolveFreshBaseStartPoint(project.repoPath, baseBranch)
      : baseBranch;
  }

  /**
   * Where {@link prepareContinuationWorkspace} puts the workspace with this id. Nothing is created,
   * so a caller can record that it owns the workspace before any of it exists.
   */
  private planContinuationWorkspace(
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

  private async prepareContinuationWorkspace(
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
        await this.discardPreparedRunWorkspace(project.repoPath, { workspaceType: "worktree", ...workspace });
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
    if (this.orchestrationWakeLocks.has(orchestration.id)) {
      throw new Error("A coordinator continuation is already starting. Retry after it becomes active.");
    }
    this.orchestrationWakeLocks.add(orchestration.id);
    try {
      const durableContext = this.buildOrchestrationResumePrompt(orchestration);
      const combinedPrompt = [
        durableContext,
        prompt.trim() ? `<user_request>\n${prompt.trim()}\n</user_request>` : "",
      ].filter(Boolean).join("\n\n");
      return await this.deliverOrchestrationUpdate(orchestration, (deliveryMetadata) => {
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
      this.orchestrationWakeLocks.delete(orchestration.id);
    }
  }

  private async followUpRunInternal(
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
    this.acceptQueuedFollowUp(extraLogMetadata);

    return this.context.db.getRun(run.id);
  }

  private shouldAutoCheckoutRunBranch(run: RunRecord): boolean {
    return run.workspaceVcs === "git" && run.workspaceType === "worktree" &&
      this.services.settings.isSettingEnabled(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, true);
  }

  private async canCheckoutRunWorktree(run: RunRecord): Promise<boolean> {
    return this.shouldAutoCheckoutRunBranch(run) && existsSync(run.worktreePath) &&
      await this.context.gitService.hasWorktreeGitMetadata(run.worktreePath);
  }

  async activateRun(runId: string): Promise<void> {
    let run = this.context.db.getRun(runId);
    const project = this.context.db.getProject(run.projectId);
    const branchPromotedToProject = this.services.workspaceGuard.wasRunPromotedToProject(run.id);
    const autoCheckoutWorktree = this.shouldAutoCheckoutRunBranch(run);

    if (await this.canCheckoutRunWorktree(run)) {
      try {
        await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
        this.services.workspaceGuard.updateWorktreeStatus(run, ACTIVE_RUN_STATUSES.has(run.status) ? "busy" : "ready");
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the run branch "${run.branchName}" in its worktree.`,
            "It may already be checked out in another IDE, repository, or worktree.",
            "Release it from the other source or open the run worktree folder directly instead.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    } else if (
      autoCheckoutWorktree &&
      branchPromotedToProject
    ) {
      try {
        await this.context.gitService.checkoutProjectBranch(project.repoPath, run.branchName);
        run = this.context.db.updateRunWorkspace(run.id, "local", project.repoPath);
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the promoted branch "${run.branchName}" in the project repository.`,
            "It may be blocked by local changes or another checkout state in the main repository.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    }

    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.context.db.setSetting(SELECTED_RUN_KEY, run.id);
  }

  async commitRun(runId: string, message: string): Promise<void> {
    const initialRun = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Committing");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.commitRunUnlocked(runId, message));
  }

  private async commitRunUnlocked(runId: string, message: string): Promise<void> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Committing");

    if (!canReviewRunChanges(run)) {
      throw new Error("The agent must finish its turn before its changes can be committed.");
    }

    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.context.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to commit for this run.");
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const commitMessage = message.trim() || this.buildRunCommitMessage(run.prompt);
    const result = await this.context.gitService.commitAllChanges(run.worktreePath, commitMessage);

    await this.services.runEvents.appendRunEvent(run.id, "status", "Commit created", `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`, {
      commitHash: result.commitHash,
      commitMessage: commitMessage,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Commit created",
      content: `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`,
      metadata: {
        commitHash: result.commitHash,
        commitMessage: commitMessage,
      },
      createdAt: new Date().toISOString(),
    });
    this.services.tasks.markLinkedRunTaskInReview(run);
    this.services.runForge.syncRunForgeRequestInBackground(run.id, true);
  }

  async suggestCommitMessage(runId: string): Promise<string> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Commit message suggestions");

    if (!canReviewRunChanges(run)) {
      throw new Error("The agent must finish its turn before requesting AI commit suggestions.");
    }

    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.context.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to describe for this run.");
    }

    const diffOutcome = await runWorktreeDiffInWorker(run.worktreePath);
    if (!diffOutcome.ok) {
      throw new Error("Could not read the worktree diff.");
    }
    let diff = diffOutcome.diff;
    if (diff.length > MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) {
      diff =
        diff.slice(0, MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) +
        "\n\n[Diff truncated for commit message generation - review before committing.]";
    }

    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const commitMessagePrompt = [
      "Task the agent was given:",
      run.prompt,
      "",
      "Git diff of current uncommitted changes in the run workspace (staged + unstaged + untracked as patches):",
      diff || "(empty diff)",
      "",
      "Write a concise git commit message for these changes.",
      "Use an imperative mood subject line, at most about 72 characters.",
      "Optionally add a blank line and a short body if needed.",
      "Output only the commit message text - no quotes, markdown fences, or commentary.",
    ].join("\n");

    try {
      const text = normalizeSuggestedCommitMessage(await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
        purpose: "commit-message",
        prompt: commitMessagePrompt,
        systemPrompt: "You write concise git commit messages from diffs. Output only the commit message.",
        maxTokens: 500,
        temperature: 0.3,
        usageProjectId: run.projectId,
      }));
      if (!text) throw new Error("The model returned an empty commit message.");
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a commit message via the configured provider. Detail: ${message}`);
    }
  }

  /** Apart from automations: their startup review must not hold up work that already started. */
  async runDeferredOrchestrationTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.deferredOrchestrationTickActive) return;
    this.deferredOrchestrationTickActive = true;
    try {
      await this.dispatchDueDeferredOrchestrationTasks();
    } catch (error) {
      this.context.logControllerError("Could not start deferred orchestration tasks.", error);
    } finally {
      this.deferredOrchestrationTickActive = false;
    }
  }

  async runProjectLab(input: RunProjectLabInput): Promise<ProjectLabThreadRecord[]> {
    const project = this.context.db.getProject(input.projectId);
    const settings = this.getProjectLabSettings(project.id);
    if (!settings.enabled) {
      throw new Error("Enable Project Lab on this project before starting it.");
    }

    const implementationModelId = input.implementationModelId?.trim() || settings.implementationModelId?.trim() || "";
    const reviewModelId = input.reviewModelId?.trim() || settings.reviewModelId?.trim() || "";
    if (!implementationModelId) {
      throw new Error("Choose an implementation model before running Project Lab.");
    }
    if (!reviewModelId) {
      throw new Error("Choose a review model before running Project Lab.");
    }
    this.context.db.getModel(implementationModelId);
    this.context.db.getModel(reviewModelId);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = this.context.db
      .listProjectLabThreads(project.id)
      .filter((thread) => new Date(thread.createdAt).getTime() >= todayStart.getTime()).length;
    if (todayCount >= settings.maxThreadsPerDay) {
      throw new Error(`Project Lab reached the daily cap of ${String(settings.maxThreadsPerDay)} thread(s) for this project.`);
    }

    const activeCount = this.context.db
      .listProjectLabThreads(project.id)
      .filter((thread) => thread.status === "queued" || thread.status === "running" || thread.status === "reviewing").length;
    if (activeCount >= settings.maxConcurrentThreads) {
      throw new Error(`Project Lab already has ${String(settings.maxConcurrentThreads)} active thread(s) on this project.`);
    }

    const mode = this.normalizeProjectLabMode(input.mode);
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    const baseBranch = project.kind === "git" ? input.baseBranch?.trim() || project.baseBranch : "project-folder";
    if (project.kind === "git") {
      const availableBranches = await this.services.projects.getProjectBranches(project.id);
      if (!availableBranches.includes(baseBranch)) {
        throw new Error(`Base branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
    }

    const thread = this.context.db.createProjectLabThread({
      projectId: project.id,
      kind: mode === "rfc-only" ? "rfc" : "implementation",
      mode,
      status: "queued",
      origin: input.origin ?? "manual",
      title: input.topic?.trim() || `${modeLabel} Project Lab run`,
      summary: mode === "rfc-only" ? "Project Lab is drafting an RFC." : `Project Lab is finding and implementing one ${modeLabel.toLowerCase()} opportunity.`,
      seedPrompt: input.topic?.trim() || null,
      implementationModelId,
      reviewModelId,
      baseBranch,
    });

    this.context.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "Project Lab",
      content: describeLabStart(modeLabel, project.kind === "git" ? baseBranch : null, input.topic?.trim() || null),
    });

    if (mode === "rfc-only") {
      this.context.db.updateProjectLabThread(thread.id, { status: "running" });
      void this.executeProjectLabRfcThread(thread.id, input, project, mode, implementationModelId, reviewModelId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.isProjectLabThreadCancelled(thread.id)) {
          try {
            this.context.db.appendProjectLabEvent({
              threadId: thread.id,
              role: "system",
              label: "Project Lab",
              content: `Project Lab RFC failed: ${message}`,
            });
            this.context.db.updateProjectLabThread(thread.id, {
              status: "failed",
              outcome: message,
            });
          } catch {
            /* thread may have been deleted */
          }
        }
        this.context.logControllerError("Project Lab RFC execution failed.", error, { projectId: project.id, threadId: thread.id });
      });
      return [this.context.db.getProjectLabThread(thread.id)];
    }

    const implementationPrompt = await this.buildProjectLabImplementationPrompt(input, project, mode, thread.id);
    const implementationRun = await this.createProjectLabImplementationRun(
      project.id,
      thread.id,
      implementationModelId,
      implementationPrompt,
      baseBranch,
    );
    this.context.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "implementation",
      label: "Implementation agent",
      content:
        implementationRun.workspaceVcs === "folder"
          ? `Implementation started in a copied folder workspace. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`
          : `Implementation started in worktree \`${implementationRun.branchName}\`. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`,
    });

    return [
      this.context.db.updateProjectLabThread(thread.id, {
        status: "running",
        implementationPrompt,
        implementationRunId: implementationRun.id,
      }),
    ];
  }

  async deleteProjectLabThread(threadId: string): Promise<void> {
    this.cancelledProjectLabThreadIds.add(threadId);
    const thread = this.context.db.getProjectLabThread(threadId);
    const implementationRun = thread.implementationRunId
      ? (() => {
          try {
            return this.context.db.getRun(thread.implementationRunId);
          } catch {
            return null;
          }
        })()
      : null;
    this.context.db.deleteProjectLabThread(threadId);
    if (implementationRun) {
      const ownedTask = this.context.db.getOrchestrationTaskByChildRunId(implementationRun.id);
      if (ownedTask) {
        let orchestration: OrchestrationRecord | null = null;
        try {
          orchestration = this.context.db.getOrchestration(ownedTask.orchestrationId);
        } catch {
          /* Fall through to the implementation run when orchestration metadata is stale. */
        }
        await this.deleteRun(orchestration?.coordinatorRunId ?? implementationRun.id);
      } else {
        await this.deleteRun(implementationRun.id);
      }
    }
  }

  get loopRunner(): ProjectLoopRunner {
    if (!this.loopRunnerInstance) {
      this.loopRunnerInstance = new ProjectLoopRunner({
        db: this.context.db,
        gitService: this.context.gitService,
        uiReviewImageRoot: join(dirname(this.context.db.getFilePath()), "loop-ui-reviews"),
        createIterationRun: (input) => this.services.appState.withPreservedRunSelection(() => this.createRun(input)),
        followUpRun: (runId, prompt, options) =>
          this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(runId, prompt, options, { loopFollowUp: true })),
        cancelRun: (runId) => this.cancelRun(runId),
        deleteRun: (runId) => this.deleteRun(runId),
        askModelForText: async (cwd, modelId, input) => {
          const context = await this.services.modelText.resolveModelInvocationContext(modelId);
          return this.services.modelText.askModelForText(cwd, context, input);
        },
        createForgeProvider: (projectId) => this.services.forgeRequests.createProjectPrReviewProvider(projectId),
        emitLoopChanged: (payload) => this.context.events.publish("loop", payload),
        logError: (message, error, metadata) => this.context.logControllerError(message, error, metadata),
        logWarn: (message, metadata) => this.context.logControllerWarn(message, metadata),
      });
    }
    return this.loopRunnerInstance;
  }

  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void): () => void {
    return this.context.events.subscribe("loop", listener);
  }

  /** Re-enters all active loops after an app restart (call after {@link reconcileOrphanedActiveSessions}). */
  resumeActiveProjectLoops(): void {
    try {
      this.loopRunner.resumeActiveLoops();
    } catch (error) {
      this.context.logControllerError("Could not resume active project loops on startup.", error);
    }
  }

  async createProjectLoop(input: CreateProjectLoopInput): Promise<ProjectLoopRecord> {
    const project = this.context.db.getProject(input.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Loops");
    return this.loopRunner.startLoop(input);
  }

  async getProjectLoopDetail(loopId: string): Promise<ProjectLoopDetail> {
    return this.context.db.getProjectLoopDetail(loopId);
  }

  async getProjectLabThreadDetail(threadId: string) {
    return this.context.db.getProjectLabThreadDetail(threadId);
  }

  async getProjectInsights(projectId: string): Promise<ProjectInsightRecord[]> {
    return this.context.db.listProjectInsights(projectId);
  }

  async cancelProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.cancelLoop(loopId);
  }

  async resumeProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.resumeLoop(loopId);
  }

  async deleteProjectLoop(loopId: string): Promise<{ deletedRunIds: string[] }> {
    return this.loopRunner.deleteLoop(loopId);
  }

  async respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput): Promise<void> {
    await this.loopRunner.respondToUiReview(reviewId, input);
  }

  async getProjectLoopUiReviewImage(reviewId: string): Promise<string | null> {
    return this.loopRunner.getUiReviewImageDataUrl(reviewId);
  }

  async getProjectLoopAvailability(projectId: string): Promise<ProjectLoopAvailability> {
    const project = this.context.db.getProject(projectId);
    const enabledModels = this.context.db.listModels().filter((model) => model.enabled);
    const providersById = new Map(this.context.db.listProviderAccounts().map((provider) => [provider.id, provider]));
    const hasLocalModels = enabledModels.some((model) => {
      const provider = providersById.get(model.providerAccountId);
      return provider ? isLoopCapableProviderType(provider.providerType) : false;
    });

    if (project.kind !== "git") {
      return { available: false, reason: "not-git", hasToken: false, hasLocalModels };
    }

    let context: ProjectPrReviewRemoteContext;
    try {
      context = await this.services.forgeRequests.resolveProjectPrReviewRemoteContext(projectId);
    } catch {
      return { available: false, reason: "no-remote", hasToken: false, hasLocalModels };
    }

    const hasToken = Boolean((await this.context.secrets.readSecret(projectForgeTokenSecretKey(projectId)))?.trim());
    if (!hasToken) {
      return {
        available: false,
        reason: "no-forge-token",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    if (!hasLocalModels) {
      return {
        available: false,
        reason: "no-local-models",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    return { available: true, provider: context.provider, repoLabel: context.repoLabel, hasToken, hasLocalModels };
  }

  async queryProjectActivity(input: ProjectActivityQueryInput): Promise<ProjectActivityQueryResult> {
    const project = this.context.db.getProject(input.projectId);
    const groupByValues = new Set(["day", "week", "month", "contributor", "module"]);
    if (!groupByValues.has(input.groupBy)) throw new Error("Unsupported Activity grouping.");
    if (input.contributorKey !== undefined && (typeof input.contributorKey !== "string" || input.contributorKey.length > 320)) {
      throw new Error("Invalid Activity contributor filter.");
    }
    if (input.modulePath !== undefined && (typeof input.modulePath !== "string" || input.modulePath.length > 1_024)) {
      throw new Error("Invalid Activity module filter.");
    }
    for (const date of [input.dateFrom, input.dateTo]) {
      if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00.000Z`)))) {
        throw new Error("Invalid Activity date filter.");
      }
    }
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new Error("Activity start date must not be after the end date.");
    if (input.weekday !== undefined && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) {
      throw new Error("Invalid Activity weekday filter.");
    }

    const cached = this.projectActivityCache.get(project.repoPath);
    let activityData: Omit<NonNullable<typeof cached>, "expiresAt">;
    if (cached && cached.expiresAt > Date.now()) {
      activityData = cached;
    } else {
      const [activityLog, currentFiles, releaseHistory] = await Promise.all([
        readProjectActivityLog(project.repoPath),
        readTrackedProjectFiles(project.repoPath),
        readProjectReleaseHistory(project.repoPath),
      ]);
      activityData = { commits: parseProjectActivityLog(activityLog), currentFiles, releaseHistory };
      this.projectActivityCache.set(project.repoPath, { expiresAt: Date.now() + 60_000, ...activityData });
    }
    return queryProjectActivityCommits(activityData.commits, input, {
      currentFiles: activityData.currentFiles,
      releases: activityData.releaseHistory.releases,
      totalReleaseCount: activityData.releaseHistory.totalReleases,
    });
  }

  async generateProjectInsight(input: GenerateProjectInsightInput): Promise<ProjectInsightRecord> {
    if (!PROJECT_INSIGHT_KINDS.includes(input.kind)) {
      throw new Error(`Unsupported project insight kind: ${String(input.kind)}`);
    }
    const project = this.context.db.getProject(input.projectId);
    const kind = input.kind;
    logInfo("Starting project insight generation.", {
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      kind,
      modelId: input.modelId ?? null,
    });

    try {
      if (kind === "activity") {
        const [activityLog, trackedFiles, releaseHistory] = await Promise.all([
          readProjectActivityLog(project.repoPath),
          readTrackedProjectFiles(project.repoPath),
          readProjectReleaseHistory(project.repoPath),
        ]);
        const commits = parseProjectActivityLog(activityLog);
        this.projectActivityCache.set(project.repoPath, {
          expiresAt: Date.now() + 60_000,
          commits,
          currentFiles: trackedFiles,
          releaseHistory,
        });
        const insight: ProjectActivityInsightData = buildProjectActivityInsight(commits, {
          currentFiles: trackedFiles,
          releases: releaseHistory.releases,
          totalReleaseCount: releaseHistory.totalReleases,
        });
        logInfo("Project activity insight built.", {
          projectId: project.id,
          commitCount: insight.summaryStats.totalCommits,
          contributorCount: insight.summaryStats.contributorCount,
          moduleCount: insight.modules.length,
          trackedFileCount: trackedFiles.length,
          releaseCount: releaseHistory.totalReleases,
          activityLogLength: activityLog.length,
        });
        return this.context.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Activity",
          summary: `Analyzed ${String(insight.summaryStats.totalCommits)} commits by ${String(insight.summaryStats.contributorCount)} contributors across ${String(insight.modules.length)} modules.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (kind === "narrative-branching") {
        const insight = buildNarrativeBranchingInsight(this.context.db.listRunsForProject(project.id));
        logInfo("Narrative branching insight built.", {
          projectId: project.id,
          branchCount: insight.branches.length,
          timelineCount: insight.timeline.length,
        });
        return this.context.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Narrative branching",
          summary: `Grouped ${String(insight.timeline.length)} runs into ${String(insight.branches.length)} active story branches.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (!PROJECT_INSIGHT_AI_KINDS.has(kind)) {
        throw new Error("Unsupported project insight kind.");
      }

      const modelId = input.modelId?.trim();
      if (!modelId) {
        throw new Error("Select a model before generating this project insight.");
      }

      const context = await this.services.modelText.resolveModelInvocationContext(modelId);
      const dependencyGraph = this.readDependencyGraphSnapshot(project.repoPath);
      const commits = await this.readRecentCommitInfo(project.repoPath, 120);
      const runs = this.context.db.listRunsForProject(project.id);
      const prompt = buildProjectInsightPrompt(project, kind, {
        dependencyGraph,
        commits,
        runs,
      });
      logInfo("Submitting AI-backed project insight request.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        moduleCount: dependencyGraph.modules.length,
        commitCount: commits.length,
        runCount: runs.length,
        promptLength: prompt.length,
      });
      const raw = await this.services.modelText.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You analyze software repositories and return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_600,
        temperature: 0.2,
        usageProjectId: project.id,
      });
      const parsed = parseProjectInsightAiResponse(kind, raw);
      logInfo("AI-backed project insight parsed successfully.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        title: parsed.title,
        summaryLength: parsed.summary.length,
        rawLength: raw.length,
      });
      return this.context.db.upsertProjectInsight({
        projectId: project.id,
        kind,
        title: parsed.title,
        summary: parsed.summary,
        dataJson: JSON.stringify(parsed.data),
        modelId: context.model.id,
      });
    } catch (error) {
      this.context.logControllerError("Project insight generation failed.", error, {
        projectId: project.id,
        kind,
        modelId: input.modelId ?? null,
        repoPath: project.repoPath,
      });
      throw error;
    }
  }

  private readDependencyGraphSnapshot(repoPath: string): DependencyGraphSnapshot {
    const sourceFiles = listDependencySourceFilesForProjectGraph(repoPath);
    logInfo("Collected dependency graph source files.", {
      repoPath,
      sourceFileCount: sourceFiles.length,
    });
    if (sourceFiles.length === 0) {
      this.context.logControllerWarn("No source files were found for dependency graph generation.", { repoPath });
    }
    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);
    logInfo("Built dependency graph snapshot.", {
      repoPath,
      moduleCount: snapshot.modules.length,
      dependencyEdgeCount: snapshot.modules.reduce((sum, module) => sum + module.dependencies.length, 0),
    });
    return snapshot;
  }

  private async readRecentCommitInfo(repoPath: string, limit: number): Promise<RepoCommitInfo[]> {
    let output: string;
    try {
      output = await readRecentCommitLog(repoPath, limit);
    } catch (error) {
      this.context.logControllerWarn("git log failed while collecting project insight commit history.", {
        repoPath,
        limit,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const commits = parseRecentCommitLog(output);
    logInfo("Collected recent commit info for project insight generation.", {
      repoPath,
      limit,
      commitCount: commits.length,
    });
    return commits;
  }

  async getRunPublishOptions(runId: string): Promise<RunPublishOptions> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Publishing");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Publishing");

    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const targetBranches = await this.context.gitService.listTargetBranches(run.worktreePath);
    const defaultTargetBranch =
      targetBranches.includes(project.baseBranch) ? project.baseBranch : (targetBranches[0] ?? project.baseBranch);
    const publishContext = await this.context.gitService
      .getPullRequestContext(run.worktreePath, defaultTargetBranch)
      .catch((error: unknown) => {
        this.context.logControllerWarn("Could not resolve target-relative Git context for the publish dialog.", {
          runId: run.id,
          targetBranch: defaultTargetBranch,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    const defaultCommitMessage = this.buildRunCommitMessage(run.prompt);
    const suggestedTitle = publishContext?.commits[0]?.subject || defaultCommitMessage;

    return {
      defaultTargetBranch,
      defaultSourceBranch: run.branchName,
      defaultDescription: this.buildRunPullRequestBody(project.name, run.prompt, defaultTargetBranch),
      defaultCommitMessage,
      hasOpenChanges: publishContext?.hasOpenChanges ?? (await this.context.gitService.hasChanges(run.worktreePath)),
      suggestedTitle,
      targetBranches,
    };
  }

  async createRunPullRequest(
    runId: string,
    targetBranch: string,
    title: string,
    sourceBranchName?: string,
    description?: string,
    commitMessage?: string,
  ): Promise<string> {
    const initialRun = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Pull and merge request creation");
    const initialProject = this.context.db.getProject(initialRun.projectId);
    this.services.workspaceGuard.requireGitProject(initialProject, "Pull and merge request creation");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialProject.id, () =>
      this.createRunPullRequestUnlocked(runId, targetBranch, title, sourceBranchName, description, commitMessage));
  }

  private async createRunPullRequestUnlocked(
    runId: string,
    targetBranch: string,
    title: string,
    sourceBranchName?: string,
    description?: string,
    commitMessage?: string,
  ): Promise<string> {
    let run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Pull and merge request creation");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request creation");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "creating a pull or merge request");
    const trimmedTitle = title.trim();
    const trimmedTargetBranch = targetBranch.trim();
    const trimmedSourceBranch = sourceBranchName?.trim() || run.branchName;
    const createdCustomSourceBranch = trimmedSourceBranch !== run.branchName;
    const trimmedDescription = this.services.forgeIssueActions.withForgeIssueClosingReference(
      run,
      description?.trim() || this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch),
    );
    if (createdCustomSourceBranch) {
      this.services.workspaceGuard.requireIdleProjectCheckout(run, "creating a pull or merge request from a new branch");
    }

    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title.");
    }

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch.");
    }

    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const prospectiveContext = await this.context.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
    if (!prospectiveContext.diff.trim()) {
      throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
    }

    if (createdCustomSourceBranch) {
      await this.context.gitService.assertPublishBranchAvailable(run.worktreePath, trimmedSourceBranch);
    }

    // Commit on the run branch before branching off, so rolling back a failed custom branch keeps the commit.
    if (await this.context.gitService.hasChanges(run.worktreePath)) {
      await this.commitRunUnlocked(run.id, commitMessage?.trim() || trimmedTitle);
      run = this.context.db.getRun(run.id);
    }

    const originalRunBranch = run.branchName;
    const previousCheckout = createdCustomSourceBranch ? await this.context.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createdCustomSourceBranch) {
      await this.context.gitService.createPublishBranchFromHead(run.worktreePath, trimmedSourceBranch);
      run = this.context.db.updateRunBranchName(run.id, trimmedSourceBranch);
    }

    let result: Awaited<ReturnType<GitService["createPullRequest"]>>;
    try {
      const publishContext = await this.context.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
      if (!publishContext.diff.trim()) {
        throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
      }

      await this.services.verification.requireVerifiedRevision(runId);
      result = await this.context.gitService.createPullRequest(
        run.worktreePath,
        trimmedSourceBranch,
        trimmedTargetBranch,
        trimmedTitle,
        trimmedDescription,
      );
    } catch (error) {
      if (createdCustomSourceBranch) {
        await this.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch,
          created: trimmedSourceBranch,
        });
      }
      throw error;
    }
    const url = result.url;
    const requestLabel = result.requestKind === "merge-request" ? "Merge request" : "Pull request";
    const eventTitle =
      result.mode === "created"
        ? `${requestLabel} created`
        : result.mode === "existing"
          ? `${requestLabel} already open`
          : `${requestLabel} draft opened`;

    await this.services.runEvents.appendRunEvent(run.id, "status", eventTitle, url, {
      targetBranch: trimmedTargetBranch,
      sourceBranch: trimmedSourceBranch,
      title: trimmedTitle,
      descriptionLength: trimmedDescription.length,
      url,
      mode: result.mode,
      promotedToProject: createdCustomSourceBranch,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: eventTitle,
      content: url,
      metadata: {
        targetBranch: trimmedTargetBranch,
        sourceBranch: trimmedSourceBranch,
        title: trimmedTitle,
        descriptionLength: trimmedDescription.length,
        url,
        mode: result.mode,
        promotedToProject: createdCustomSourceBranch,
      },
      createdAt: new Date().toISOString(),
    });
    if (result.descriptionOmitted === true) {
      // The draft link left the description out to stay short enough to open; keep it for pasting.
      await this.services.runEvents.appendRunEvent(run.id, "status", `${requestLabel} description to paste`, trimmedDescription, {
        url,
        descriptionOmittedFromDraftUrl: true,
      });
    }
    this.services.tasks.markLinkedRunTaskInReview(run, url);
    await this.services.runForge.syncRunForgeRequest(run.id, true, true, url);

    if (createdCustomSourceBranch) {
      await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedSourceBranch);
    }

    const openResult = await this.context.desktop.openExternalUrl(url);
    if (!openResult.ok) {
      throw new Error(openResult.error ?? "Could not open the pull request URL.");
    }

    return url;
  }

  async suggestRunPullRequestDraft(runId: string, targetBranch: string): Promise<RunPullRequestDraft> {
    return this.generateRunPullRequestDraft(runId, targetBranch);
  }

  async suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string): Promise<string> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title before generating a description.");
    }
    return (await this.generateRunPullRequestDraft(runId, targetBranch, trimmedTitle)).description;
  }

  private async generateRunPullRequestDraft(
    runId: string,
    targetBranch: string,
    preferredTitle?: string,
  ): Promise<RunPullRequestDraft> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Pull and merge request draft generation");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request draft generation");
    const trimmedTargetBranch = targetBranch.trim();

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch before generating a pull request draft.");
    }

    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const publishContext = await this.context.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
    let diff = publishContext.diff;
    if (!diff.trim()) {
      throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for MR/PR description generation.]`;
    }
    const commitContext = publishContext.commits.length > 0
      ? publishContext.commits.map((commit) => `- ${commit.hash.slice(0, 12)} ${commit.subject}`).join("\n")
      : "(no committed source-branch changes yet; open changes will be committed before publishing)";

    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const defaultTitle = preferredTitle?.trim() || publishContext.commits[0]?.subject || this.buildRunCommitMessage(run.prompt);
    const defaultCommitMessage = this.buildRunCommitMessage(run.prompt);
    const defaultDescription = this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch);
    const prompt = [
      "Create a complete merge request / pull request draft for these code changes.",
      "Return exactly one JSON object with this shape:",
      '{"title":"Concise PR title","commitMessage":"Concise git commit message or null","description":"Markdown PR body"}',
      "The title should be specific, concise, and should not use a conventional-commit prefix unless it improves clarity.",
      publishContext.hasOpenChanges
        ? "The commitMessage must describe the open changes that BuildWarden will commit before publishing."
        : "Set commitMessage to null because the workspace is clean.",
      "Keep the description practical and scannable, using ## Summary, ## What Changed, and ## Validation when useful.",
      "If validation is unknown, say so briefly instead of inventing it.",
      "Encode the markdown description as a JSON string. Do not output markdown fences or commentary outside the JSON object.",
      "",
      `Project: ${project.name}`,
      `Source branch: ${run.branchName}`,
      `Target branch: ${trimmedTargetBranch}`,
      "",
      "Original run prompt:",
      run.prompt || "(no prompt available)",
      "",
      "Current defaults:",
      `Title: ${defaultTitle}`,
      `Commit message: ${publishContext.hasOpenChanges ? defaultCommitMessage : "(not needed)"}`,
      "Description:",
      defaultDescription,
      "",
      "Source-branch commits since the target merge base:",
      commitContext,
      "",
      publishContext.hasOpenChanges
        ? "Prospective PR diff, including open changes that BuildWarden will commit before publishing:"
        : "Committed PR diff against the target branch merge base:",
      diff,
    ].join("\n");

    try {
      const text = await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
        purpose: "pull-request-draft",
        prompt,
        systemPrompt: "You write strong engineering pull request drafts. Output only the requested JSON object.",
        maxTokens: 1_300,
        temperature: 0.2,
        usageProjectId: run.projectId,
      });
      const parsed = JSON.parse(normalizeJsonResponse(text)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The model did not return a JSON object.");
      }
      const record = parsed as Record<string, unknown>;
      const generatedTitle = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "";
      const generatedDescription = typeof record.description === "string" ? record.description.trim() : "";
      const generatedCommitMessage = typeof record.commitMessage === "string"
        ? normalizeSuggestedCommitMessage(record.commitMessage)
        : "";
      if (!generatedTitle || !generatedDescription) {
        throw new Error("The model returned an incomplete pull request draft.");
      }
      return {
        title: generatedTitle,
        description: generatedDescription,
        commitMessage: publishContext.hasOpenChanges ? generatedCommitMessage || generatedTitle : null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a merge request or pull request draft. Detail: ${msg}`);
    }
  }

  async publishRunBranch(runId: string, branchName?: string): Promise<string> {
    const initialRun = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Publishing");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.publishRunBranchUnlocked(runId, branchName));
  }

  private async publishRunBranchUnlocked(runId: string, branchName?: string): Promise<string> {
    let run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Publishing");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Publishing");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "publishing its branch");
    const trimmedBranchName = branchName?.trim() || run.branchName;
    const createdCustomBranch = trimmedBranchName !== run.branchName;

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }
    if (createdCustomBranch) {
      this.services.workspaceGuard.requireIdleProjectCheckout(run, "publishing a new branch");
    }

    if (await this.context.gitService.hasChanges(run.worktreePath)) {
      throw new Error("Commit or discard open changes before publishing the branch.");
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const originalRunBranch = run.branchName;
    const previousCheckout = createdCustomBranch ? await this.context.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createdCustomBranch) {
      await this.context.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
      run = this.context.db.updateRunBranchName(run.id, trimmedBranchName);
    }

    let result: Awaited<ReturnType<GitService["publishBranch"]>>;
    try {
      result = await this.context.gitService.publishBranch(run.worktreePath, trimmedBranchName);
      if (createdCustomBranch) {
        await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName);
      }
    } catch (error) {
      if (createdCustomBranch) {
        await this.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch,
          created: trimmedBranchName,
        });
      }
      throw error;
    }

    const content = createdCustomBranch
      ? `Published branch ${result.branchName} to ${result.remoteName}, checked it out in the project repository, and removed the run worktree.`
      : `Published branch ${result.branchName} to ${result.remoteName}.`;

    await this.services.runEvents.appendRunEvent(run.id, "status", "Branch published", content, {
      branchName: result.branchName,
      remoteName: result.remoteName,
      promotedToProject: createdCustomBranch,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Branch published",
      content,
      metadata: {
        branchName: result.branchName,
        remoteName: result.remoteName,
        promotedToProject: createdCustomBranch,
      },
      createdAt: new Date().toISOString(),
    });
    this.services.tasks.markLinkedRunTaskInReview(run);
    this.services.runForge.syncRunForgeRequestInBackground(run.id, true);

    return content;
  }

  async createRunLocalBranch(runId: string, branchName: string): Promise<string> {
    const initialRun = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Local branch creation");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.createRunLocalBranchUnlocked(runId, branchName));
  }

  private async createRunLocalBranchUnlocked(runId: string, branchName: string): Promise<string> {
    let run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Local branch creation");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Local branch creation");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "moving its changes to a local branch");
    const originalRunBranchName = run.branchName;
    const trimmedBranchName = branchName.trim();

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }

    const createsNewBranch = trimmedBranchName !== run.branchName;
    if (!createsNewBranch && run.workspaceType !== "worktree") {
      throw new Error("The new local branch must differ from the current worktree branch.");
    }
    this.services.workspaceGuard.requireIdleProjectCheckout(run, "moving changes to a local branch");

    const hasOpenChanges = await this.context.gitService.hasChanges(run.worktreePath);

    const previousCheckout = createsNewBranch ? await this.context.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createsNewBranch) {
      await this.context.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
      run = this.context.db.updateRunBranchName(run.id, trimmedBranchName);
    }
    try {
      await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName, {
        transferOpenChanges: hasOpenChanges,
        deleteReleasedBranchName: createsNewBranch ? originalRunBranchName : undefined,
      });
    } catch (error) {
      if (createsNewBranch) {
        await this.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch: originalRunBranchName,
          created: trimmedBranchName,
        });
      }
      throw error;
    }

    const content = hasOpenChanges
      ? `Created local branch ${trimmedBranchName}, moved the open changes to it in the project repository, and removed the run worktree.`
      : `Created local branch ${trimmedBranchName}, checked it out in the project repository, and removed the run worktree.`;
    await this.services.runEvents.appendRunEvent(run.id, "status", "Local branch created", content, {
      branchName: trimmedBranchName,
      promotedToProject: true,
      transferredOpenChanges: hasOpenChanges,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Local branch created",
      content,
      metadata: {
        branchName: trimmedBranchName,
        promotedToProject: true,
        transferredOpenChanges: hasOpenChanges,
      },
      createdAt: new Date().toISOString(),
    });

    return content;
  }

  async suggestRunBranchName(runId: string): Promise<string> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Branch name suggestions");
    const project = this.context.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch name suggestions");
    // A run started from an issue gets a name that leads back to it; no model call needed.
    const issueLink = this.services.forgeIssueActions.findForgeIssueLinkForRun(run);
    if (issueLink) return forgeIssueBranchName(issueLink.issueNumber, issueLink.issueTitle);
    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const prompt = [
      `Project: ${project.name}`,
      `Task: ${run.prompt}`,
      `Current branch: ${run.branchName}`,
      "",
      "Suggest a new branch name for this task.",
      "Use lowercase ASCII letters, numbers, hyphens, and optional forward slashes only.",
      "Use a short conventional prefix such as feat/, fix/, refactor/, docs/, test/, or chore/ when appropriate.",
      "Output only the branch name, with no quotes, markdown, or commentary.",
    ].join("\n");
    const raw = await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
      purpose: "branch-name",
      prompt,
      systemPrompt: "You generate concise, valid Git branch names. Output only the branch name.",
      maxTokens: 80,
      temperature: 0.2,
      usageProjectId: run.projectId,
    });
    const branchName = normalizeSuggestedBranchName(raw);
    if (!branchName) {
      throw new Error("The model returned an empty branch name.");
    }
    return branchName;
  }

  async releaseRun(runId: string): Promise<void> {
    const run = this.context.db.getRun(runId);
    const project = this.context.db.getProject(run.projectId);

    // A watched run keeps its branch checked out: the next wake commits on it.
    const watched = Boolean(this.context.db.getPrWatch(runId)) && this.context.db.getPrWatch(runId)!.status !== "ended";
    if (
      run.workspaceType === "worktree" &&
      this.services.settings.isSettingEnabled(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, true) &&
      !ACTIVE_RUN_STATUSES.has(run.status) &&
      !watched
    ) {
      if (existsSync(run.worktreePath) && (await this.context.gitService.hasWorktreeGitMetadata(run.worktreePath))) {
        try {
          await this.context.gitService.releaseWorktreeBranch(run.worktreePath, run.branchName);
          this.services.workspaceGuard.updateWorktreeStatus(run, "released");
        } catch (error) {
          throw new Error(
            [
              `BuildWarden could not release the run branch "${run.branchName}" from its worktree.`,
              "Close file locks in other tools or open the run worktree folder directly instead.",
              "",
              `Original error: ${error instanceof Error ? error.message : String(error)}`,
            ].join("\n"),
          );
        }
      } else {
        this.services.workspaceGuard.updateWorktreeStatus(run, "released");
      }
    }

    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.context.db.deleteSetting(SELECTED_RUN_KEY);
  }

  async cancelRun(runId: string): Promise<void> {
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(runId);
    if (orchestration && ORCHESTRATION_CANCELLABLE_STATUSES.has(orchestration.status)) {
      await this.cancelOrchestration(runId);
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

  private getOrchestrationArtifactRoot(): string {
    return getOrchestrationArtifactRoot(this.context.db.getFilePath());
  }

  private async withOrchestrationMutation<T>(orchestrationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.orchestrationMutations.get(orchestrationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.orchestrationMutations.set(orchestrationId, current);
    try {
      return await current;
    } finally {
      if (this.orchestrationMutations.get(orchestrationId) === current) {
        this.orchestrationMutations.delete(orchestrationId);
      }
    }
  }

  private resolveOrchestrationTeamSettings() {
    const configured = parseOrchestrationTeamSettings(
      this.context.db.getSettings()[APP_SETTING_KEYS.orchestrationTeam],
    );
    const availableModels = new Set(
      this.context.db.listModels().filter((model) => Boolean(model.enabled)).map((model) => model.id),
    );
    const models = configured.models.filter((model) => model.enabled && availableModels.has(model.modelId));
    const modelIds = new Set(models.map((model) => model.modelId));
    const roles = configured.roles.flatMap((role) => {
      const eligibleModelIds = role.eligibleModelIds.filter((modelId) => modelIds.has(modelId));
      if (eligibleModelIds.length === 0 || !eligibleModelIds.includes(role.preferredModelId)) return [];
      return [{ ...role, eligibleModelIds }];
    });
    return { ...configured, models, roles };
  }

  private getOrCreateOrchestration(coordinatorRun: RunRecord): OrchestrationRecord {
    const existing = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRun.id);
    if (existing) return existing;
    if (!coordinatorRun.delegationEnabled) {
      throw new Error("Delegation is not enabled for this run.");
    }
    if (coordinatorRun.kind === "orchestration-task") {
      throw new Error("Durable orchestration tools are available only to the top-level coordinator.");
    }
    const teamSnapshot = this.resolveOrchestrationTeamSettings();
    if (teamSnapshot.roles.length === 0) {
      throw new Error("Configure at least one valid orchestration role before delegating.");
    }
    const orchestration = this.context.db.createOrchestration({
      projectId: coordinatorRun.projectId,
      coordinatorRunId: coordinatorRun.id,
      teamSnapshot,
    });
    const budgetWarning = this.coordinatorBudgetWarning(coordinatorRun, teamSnapshot);
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "created",
      title: "Orchestration started",
      content: [
        `Frozen team configuration with ${teamSnapshot.roles.length} role${teamSnapshot.roles.length === 1 ? "" : "s"}.`,
        budgetWarning,
      ].filter(Boolean).join(" "),
    });
    return this.context.db.getOrchestration(orchestration.id);
  }

  private getMutableOrchestrationByCoordinatorRunId(coordinatorRunId: string): OrchestrationRecord {
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration) throw new Error("This run has not started an orchestration.");
    if (orchestration.status === "deleting" || orchestration.status === "deletion-failed") {
      throw new Error("The orchestration is being deleted; retry or complete cleanup before changing it.");
    }
    return orchestration;
  }

  private emitOrchestrationChanged(orchestrationId: string, taskId?: string | null, deletedRunIds?: string[]): void {
    const orchestration = this.context.db.getOrchestration(orchestrationId);
    const payload: OrchestrationChangedPayload = {
      projectId: orchestration.projectId,
      coordinatorRunId: orchestration.coordinatorRunId,
      orchestrationId: orchestration.id,
      taskId: taskId ?? null,
      status: orchestration.status,
      sequence: orchestration.lastEventSequence,
      ...(deletedRunIds ? { deletedRunIds } : {}),
    };
    this.context.events.publish("orchestration", payload);
  }

  onOrchestrationChanged(listener: (payload: OrchestrationChangedPayload) => void): () => void {
    return this.context.events.subscribe("orchestration", listener);
  }

  async getOrchestrationDetail(coordinatorRunId: string): Promise<OrchestrationDetail | null> {
    return this.context.db.getOrchestrationDetailByCoordinatorRunId(coordinatorRunId);
  }

  async getOrchestrationTaskDetail(taskId: string): Promise<OrchestrationTaskRecord> {
    return this.context.db.getOrchestrationTask(taskId);
  }

  private orchestrationTaskChangedFiles(diff: string): string[] {
    const paths = new Set<string>();
    for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
      paths.add((match[2] || match[1] || "").trim());
    }
    for (const match of diff.matchAll(/^# (?:Created|Changed|Deleted) (?:text|binary|large) file: (.+)$/gm)) {
      paths.add((match[1] || "").trim());
    }
    return [...paths].filter(Boolean);
  }

  async getOrchestrationAdoptionPreview(taskId: string): Promise<OrchestrationAdoptionPreview> {
    const task = this.context.db.getOrchestrationTask(taskId);
    const orchestration = this.context.db.getOrchestration(task.orchestrationId);
    const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
    const wave = this.context.db.getOrchestrationWave(task.waveId);
    const adoption = this.context.db.getOrchestrationAdoption(task.id);
    if (adoption?.status !== "rejected" && adoption?.manifest.recoveryNeedsReview === true) {
      return { taskId, status: task.adoptionStatus, diff: "", changedFiles: [], autoMerged: [], unsupportedPaths: [],
        conflicts: [adoption.errorMessage ?? "Interrupted adoption needs manual review. Reject it after inspecting the coordinator workspace."] };
    }
    if (!task.childRunId) {
      return { taskId, status: task.adoptionStatus, diff: "", changedFiles: [], conflicts: [], autoMerged: [], unsupportedPaths: [] };
    }
    const child = this.context.db.getRun(task.childRunId);
    const result = this.context.db.listOrchestrationTaskResults(task.id).at(-1);
    const diffResult = await this.services.runDetails.getRunWorktreeDiff(child.id);
    const assertCurrentResult = () => {
      if (this.context.db.listOrchestrationTaskResults(task.id).at(-1)?.id !== result?.id) {
        throw new Error("The published result changed while loading the preview. Refresh it before approving.");
      }
    };
    assertCurrentResult();
    if (!wave.baselinePath || wave.baselineState !== "ready") {
      return {
        taskId,
        status: task.adoptionStatus,
        diff: diffResult.diff,
        changedFiles: this.orchestrationTaskChangedFiles(diffResult.diff),
        conflicts: ["The immutable wave baseline is unavailable."],
        autoMerged: [],
        unsupportedPaths: [],
      };
    }
    const preview = await previewOrchestrationDelta({
      baselinePath: wave.baselinePath,
      childPath: child.worktreePath,
      targetPath: coordinator.worktreePath,
      childSnapshotPath: result?.workspaceSnapshotPath,
    });
    if (result?.workspaceSnapshotPath) {
      const sincePublication = await previewOrchestrationDelta({ baselinePath: result.workspaceSnapshotPath, childPath: child.worktreePath, targetPath: child.worktreePath });
      if (sincePublication.changedFiles.length || sincePublication.unsupportedPaths.length) {
        preview.conflicts.push("The child workspace changed after publication. Finish a follow-up turn to publish and review a new result.");
      }
    }
    assertCurrentResult();
    const abandonedSubagents = result ? resultAbandonedSubagentCount(this.context.db, task.id, result.id) : 0;
    return {
      taskId,
      resultId: result?.id,
      status: task.adoptionStatus,
      diff: diffResult.diff,
      ...preview,
      ...(abandonedSubagents > 0
        ? { warnings: [`${String(abandonedSubagents)} provider subagent${abandonedSubagents === 1 ? " was" : "s were"} still running when the child stopped. ${abandonedSubagents === 1 ? "Its" : "Their"} work is not part of this result and may be incomplete.`] }
        : {}),
    };
  }

  /** Closes native subagents a stopped child left open; a running child keeps its own (see orchestration-native-work). */
  private closeAbandonedChildSubagents(runId: string): number {
    return this.services.activeWorkers.runWorkers.has(runId) ? 0 : closeAbandonedChildSubagents(this.context.db, runId);
  }

  private async createOrchestrationChildRun(
    coordinator: RunRecord,
    task: OrchestrationTaskRecord,
    effort?: string,
  ): Promise<RunRecord> {
    const project = this.context.db.getProject(coordinator.projectId);
    const model = this.context.db.getModel(task.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new OrchestrationToolError("model_unavailable", `Credentials are unavailable for ${provider.label}.`);
    }
    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.context.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    // Until the child run exists, nothing else owns this workspace. The effect is recorded before
    // anything is created, so if the app stops at any point before the run exists, startup finds
    // it and removes whatever part of the workspace was made before requeueing the task.
    const workspaceId = crypto.randomUUID();
    const plannedWorkspace = this.planContinuationWorkspace(coordinator, project, true, configuredWorktreeRoot, workspaceId);
    let launch = this.context.db.createOrchestrationEffect({
      orchestrationId: task.orchestrationId, taskId: task.id, kind: "launch-child",
      payload: { workspace: plannedWorkspace, phase: "preparing" },
    });
    await this.context.db.flushDurable();
    let workspace: Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">;
    try {
      workspace = await this.prepareContinuationWorkspace(
        coordinator,
        project,
        true,
        configuredWorktreeRoot,
        workspaceSetupProfile?.dependencies !== "isolated",
        workspaceId,
      );
      launch = this.context.db.updateOrchestrationEffect(launch.id, { payload: { workspace, phase: "prepared" } });
      await this.context.db.flushDurable();
    } catch (error) {
      await this.closeFailedChildLaunch(launch, project.repoPath, plannedWorkspace, error);
      throw error;
    }
    const wave = this.context.db.getOrchestrationWave(task.waveId);
    let child: RunRecord;
    try {
      if (wave.baselinePath && wave.baselineState === "ready") {
        await restoreOrchestrationBaseline({ baselinePath: wave.baselinePath, workspacePath: workspace.worktreePath });
      }
      child = this.context.db.createRun({
        projectId: coordinator.projectId,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: getHarnessTypeForProvider(provider.providerType),
        mode: task.intent === "inspect" ? "ask" : "code",
        workspaceType: workspace.workspaceType,
        workspaceVcs: workspace.workspaceVcs,
        prompt: task.prompt,
        goalText: coordinator.goalText,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        kind: "orchestration-task",
        parentRunId: coordinator.id,
        rootRunId: coordinator.id,
        lineageTitle: task.title,
        orchestrationTaskId: task.id,
        workspaceSetupProfile,
        delegationEnabled: false,
      });
      // The run now owns the workspace; task reconciliation handles anything that follows.
      this.context.db.updateOrchestrationEffect(launch.id, { status: "completed", payload: { workspace, childRunId: child.id }, incrementAttempts: true });
    } catch (error) {
      await this.closeFailedChildLaunch(launch, project.repoPath, workspace, error);
      throw error;
    }
    this.context.db.upsertWorktree({
      id: child.id,
      projectId: child.projectId,
      runId: child.id,
      branchName: child.branchName,
      worktreePath: child.worktreePath,
      status: "ready",
    });
    const coordinatorSteps = this.context.db.getRunSteps(coordinator.id);
    const inheritedFullAccess = task.permissionMode !== "supervised" && latestUserTurnUsedFullAccess(coordinatorSteps);
    const inheritedExecutionOptions = this.services.turnState.getLatestRunExecutionOptions(coordinator.id, provider);
    const childExecutionOptions = resolveProviderExecutionOptions(provider, {
      executionOptions: applyTaskExecutionOptions(
        mergeOrchestrationExecutionOptions(inheritedExecutionOptions, effort),
        this.context.db.getOrchestrationTaskExecutionOptions(task.id),
      ),
    });
    await this.services.runEvents.appendRunEvent(child.id, "log", "Delegated task", task.prompt, {
      source: "orchestration",
      commandType: "initial",
      orchestrationId: task.orchestrationId,
      orchestrationTaskId: task.id,
      coordinatorRunId: coordinator.id,
      roleId: task.roleId,
      intent: task.intent,
      modelId: task.modelId,
      effort,
      yoloMode: inheritedFullAccess,
      reasoningEffort: childExecutionOptions?.reasoningEffort,
      anthropicEffort: childExecutionOptions?.anthropicEffort,
      executionOptions: childExecutionOptions,
    });
    child = this.context.db.updateRunStatus(child.id, "preparing");
    await this.captureFolderBaselineSnapshotOrFail(child, project);
    await this.services.turnState.capturePromptRestorePoint(child.id, "initial");

    const role = this.context.db.getOrchestration(task.orchestrationId).teamSnapshot.roles.find(
      (entry) => entry.id === task.roleId,
    );
    const prompt = [
      `You are the ${role?.name ?? task.roleId} child in a durable BuildWarden orchestration.`,
      role?.description?.trim() || "",
      "Work only in this isolated child workspace. Do not attempt to control the parent run or delegate durable tasks.",
      task.intent === "inspect"
        ? "This is an inspect-only task. Do not modify files or execute mutating commands."
        : "Implement the requested work and leave all changes uncommitted for explicit adoption by the coordinator.",
      "",
      task.prompt,
    ].filter(Boolean).join("\n");
    this.services.skills.skillService.inheritSelection("run", child.id, coordinator.id);
    const worker = await this.startWorker(
      child,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: buildPromptWithRunGoal(prompt, coordinator.goalText),
        providerOptions: childExecutionOptions,
        yoloMode: inheritedFullAccess,
      },
    );
    this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
    this.context.db.updateOrchestrationTask(task.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      attentionReason: null,
      errorMessage: null,
    });
    return this.context.db.getRun(child.id);
  }

  /** No await between counting and reserving: all coordinators share this admission point. */
  private reserveOrchestrationTask(task: OrchestrationTaskRecord): boolean {
    const orchestration = this.context.db.getOrchestration(task.orchestrationId);
    if (!["active", "waiting", "attention"].includes(orchestration.status)) return false;
    const current = this.context.db.getOrchestrationTask(task.id);
    if (current.status !== task.status || ORCHESTRATION_ACTIVE_TASK_STATUSES.has(current.status)) return false;
    const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
    const model = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId && entry.enabled);
    if (!role || !model || this.orchestrationBudgetExhaustion(orchestration)) return false;
    const active = this.context.db.listOrchestrationsWithStatuses(["active", "waiting", "attention", "paused"])
      .flatMap((entry) => this.context.db.listOrchestrationTasks(entry.id))
      .filter((entry) => ORCHESTRATION_ACTIVE_TASK_STATUSES.has(entry.status));
    if (active.length >= orchestration.teamSnapshot.maxConcurrentTasks
      || active.filter((entry) => entry.roleId === task.roleId).length >= role.maxConcurrent
      || active.filter((entry) => entry.modelId === task.modelId).length >= model.maxConcurrent) return false;
    this.context.db.updateOrchestrationTask(task.id, { status: "provisioning", deferredUntil: null });
    return true;
  }

  private async dispatchOrchestrationTasks(orchestrationId: string): Promise<void> {
    const orchestration = this.context.db.getOrchestration(orchestrationId);
    if (orchestration.status !== "active" && orchestration.status !== "waiting") return;
    const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
    const limits = new Map<string, Promise<ProviderLimitState | null>>();
    const limitFor = (modelId: string): Promise<ProviderLimitState | null> => {
      const known = limits.get(modelId);
      if (known) return known;
      const pending = this.services.providerRuntime.getProviderLimitState(modelId);
      limits.set(modelId, pending);
      return pending;
    };
    for (const task of this.context.db.listOrchestrationTasks(orchestrationId).filter((entry) => entry.status === "pending")) {
      if (task.deferredUntil && Date.parse(task.deferredUntil) > Date.now()) continue;
      const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
      const modelProfile = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId && entry.enabled);
      if (!role || !modelProfile) {
        this.context.db.updateOrchestrationTask(task.id, {
          status: "blocked",
          attentionReason: "The frozen role or model configuration is unavailable.",
          finishedAt: new Date().toISOString(),
        });
        this.context.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "attention",
          title: "Task blocked",
          content: "The frozen role or model configuration is unavailable. BuildWarden will not substitute another provider.",
        });
        continue;
      }
      // Running children keep using tokens while this pass waits on each launch.
      const budget = this.orchestrationBudgetExhaustion(orchestration);
      if (budget) {
        this.blockOrchestrationTask(task, "Task blocked by the token budget", budget.reason);
        continue;
      }
      const limit = await limitFor(task.modelId);
      if (limit) {
        if (!this.deferOrchestrationTask(task, limit)) this.blockOrchestrationTask(task, "Task blocked by a usage limit", limit.reason);
        continue;
      }

      if (!this.reserveOrchestrationTask(task)) continue;
      try {
        await this.context.db.flushDurable();
        this.context.db.getModel(task.modelId);
        const effort = role.effortOverride ?? modelProfile.defaultEffort;
        if (task.childRunId && this.context.db.listOrchestrationTaskMessages(orchestrationId).some((message) => message.taskId === task.id && message.status === "queued")) {
          if (!(await this.deliverQueuedOrchestrationMessages(task, true))) {
            if (this.context.db.getOrchestrationTask(task.id).status === "provisioning") {
              // A live child still occupies capacity even though no new turn started.
              this.context.db.updateOrchestrationTask(task.id, { status: this.services.activeWorkers.runWorkers.has(task.childRunId) ? "running" : "pending" });
            }
            continue;
          }
        } else if (task.childRunId) await this.continueDeferredOrchestrationChild(task);
        else await this.createOrchestrationChildRun(coordinator, task, effort);
        this.context.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "task-started",
          title: task.title,
          content: `Started ${role.name} with model ${this.context.db.getModel(task.modelId).displayName}.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.db.updateOrchestrationTask(task.id, {
          status: "blocked",
          errorMessage: message,
          attentionReason: message,
          finishedAt: new Date().toISOString(),
        });
        this.context.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "attention",
          title: "Task could not start",
          content: message,
        });
      }
    }
    this.emitOrchestrationChanged(orchestrationId);
  }

  private blockOrchestrationTask(task: OrchestrationTaskRecord, title: string, reason: string): void {
    this.context.db.updateOrchestrationTask(task.id, {
      status: "blocked",
      deferredUntil: null,
      attentionReason: reason,
      finishedAt: new Date().toISOString(),
    });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "attention",
      title,
      content: reason,
    });
  }

  /**
   * Holds a task until its provider's usage window resets. Returns false when that cannot help,
   * so the caller reports the limit and the coordinator can choose another model.
   */
  private deferOrchestrationTask(task: OrchestrationTaskRecord, limit: ProviderLimitState): boolean {
    const waitMs = limit.resetsAt ? Date.parse(limit.resetsAt) - Date.now() : Number.NaN;
    const deferrals = this.context.db.listOrchestrationEvents(task.orchestrationId)
      .filter((event) => event.taskId === task.id && event.metadata.kind === "deferred").length;
    if (!(waitMs > 0) || waitMs > ORCHESTRATION_MAX_DEFER_MS || deferrals >= ORCHESTRATION_MAX_DEFERRALS) return false;
    const reason = `${limit.reason}. BuildWarden continues this task after the reset.`;
    this.context.db.updateOrchestrationTask(task.id, {
      status: "pending",
      deferredUntil: limit.resetsAt,
      attentionReason: reason,
      errorMessage: null,
      finishedAt: null,
    });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "attention",
      title: "Task deferred by a usage limit",
      content: reason,
      metadata: { kind: "deferred", deferredUntil: limit.resetsAt },
    });
    return true;
  }

  /** A child stopped by its provider's usage limit keeps its workspace and conversation. */
  private async deferChildAfterUsageLimit(task: OrchestrationTaskRecord, run: RunRecord): Promise<boolean> {
    if (!run.errorMessage || classifyCouncilFailure(run.errorMessage) !== "limit") return false;
    const limit = await this.services.providerRuntime.getProviderLimitState(task.modelId, true);
    if (!limit) return false;
    this.context.db.updateOrchestrationTask(task.id, { inputTokens: run.inputTokens, outputTokens: run.outputTokens });
    return this.deferOrchestrationTask(task, limit);
  }

  private async continueDeferredOrchestrationChild(task: OrchestrationTaskRecord): Promise<void> {
    const child = this.context.db.getRun(task.childRunId ?? "");
    const settings = latestRunExecutionSettings(this.context.db.getRunSteps(child.id));
    await this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(
      child.id,
      DEFERRED_CHILD_RESUME_PROMPT,
      { mode: child.mode, modelId: child.modelId, yoloMode: task.permissionMode !== "supervised" && settings?.yoloMode === true },
      { orchestrationTaskId: task.id, orchestrationResume: true },
    ));
    this.context.db.updateOrchestrationTask(task.id, {
      status: "running",
      attentionReason: null,
      errorMessage: null,
      finishedAt: null,
      startedAt: task.startedAt ?? new Date().toISOString(),
    });
  }

  /** Starts deferred tasks whose usage window has reset. */
  private async dispatchDueDeferredOrchestrationTasks(): Promise<void> {
    for (const orchestration of this.context.db.listOrchestrationsWithStatuses(["active", "waiting"])) {
      const due = this.context.db.listOrchestrationTasks(orchestration.id).some((task) =>
        task.status === "pending" && task.deferredUntil !== null && Date.parse(task.deferredUntil) <= Date.now());
      if (!due) continue;
      await this.withOrchestrationMutation(orchestration.id, async () => {
        await this.dispatchOrchestrationTasks(orchestration.id);
        await this.maybeWakeOrchestrationCoordinator(orchestration.id);
      });
    }
  }

  private orchestrationBudgetExhaustion(orchestration: OrchestrationRecord): RunBudgetExhaustion | null {
    const limit = orchestration.teamSnapshot.maxTotalTokens ?? 0;
    if (limit <= 0) return null;
    const observed = this.context.db.getOrchestrationTotalTokens(orchestration.id);
    if (observed < limit) return null;
    return { kind: "tokens", limit, observed, reason: `The orchestration used ${String(observed)} of its ${String(limit)} token budget.` };
  }

  private async dispatchOtherOrchestrationTasks(excludingOrchestrationId: string): Promise<void> {
    for (const orchestration of this.context.db.listOrchestrationsWithStatuses(["active", "waiting"])) {
      if (orchestration.id === excludingOrchestrationId) continue;
      await this.withOrchestrationMutation(orchestration.id, () => this.dispatchOrchestrationTasks(orchestration.id));
    }
  }

  private async delegateOrchestrationTasks(
    coordinator: RunRecord,
    rawTasks: unknown,
  ): Promise<OrchestrationTaskRecord[]> {
    const orchestration = this.getOrCreateOrchestration(coordinator);
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new OrchestrationToolError("invalid_arguments", "Delegate at least one task.");
    }
    if (orchestration.status === "paused") throw new OrchestrationToolError("orchestration_not_active", "Resume the orchestration before delegating more work.");
    if (!["active", "waiting", "attention"].includes(orchestration.status)) {
      throw new OrchestrationToolError("orchestration_not_active", `Tasks cannot be delegated while the orchestration is ${orchestration.status}.`);
    }
    const exhausted = this.orchestrationBudgetExhaustion(orchestration);
    if (exhausted) throw new OrchestrationToolError("budget_exhausted", exhausted.reason);
    const existing = this.context.db.listOrchestrationTasks(orchestration.id);
    if (existing.length + rawTasks.length > orchestration.teamSnapshot.maxTasksPerOrchestration) {
      throw new OrchestrationToolError("task_limit_reached", `This orchestration is limited to ${orchestration.teamSnapshot.maxTasksPerOrchestration} tasks.`);
    }
    const parsed = rawTasks.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} must be an object.`);
      }
      const entry = value as Record<string, unknown>;
      const clientTaskId = String(entry.clientTaskId ?? "").trim();
      const title = String(entry.title ?? "").trim();
      const prompt = String(entry.prompt ?? "").trim();
      const roleId = String(entry.roleId ?? "").trim();
      let intent: OrchestrationTaskRecord["intent"] | null = null;
      if (entry.intent === "implement" || entry.intent === "inspect") intent = entry.intent;
      if (!clientTaskId || !title || !prompt || !roleId || !intent) {
        throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} is missing clientTaskId, title, prompt, roleId, or intent.`);
      }
      // The tool schema states these limits, but transports do not all enforce schemas.
      for (const [field, value, limit] of [
        ["clientTaskId", clientTaskId, 80], ["title", title, 160], ["roleId", roleId, 80], ["prompt", prompt, 65_536],
      ] as const) {
        if (value.length > limit) {
          throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} ${field} is longer than ${String(limit)} characters.`);
        }
      }
      if (this.context.db.getOrchestrationTaskByClientTaskId(orchestration.id, clientTaskId)) {
        throw new OrchestrationToolError("invalid_arguments", `clientTaskId "${clientTaskId}" already exists in this orchestration.`);
      }
      const role = orchestration.teamSnapshot.roles.find((entryRole) => entryRole.id === roleId);
      if (!role) throw new OrchestrationToolError("role_unknown", `Unknown orchestration role: ${roleId}`);
      const requestedModelId = typeof entry.modelId === "string" && entry.modelId.trim()
        ? entry.modelId.trim()
        : role.preferredModelId;
      if (!role.eligibleModelIds.includes(requestedModelId)) {
        throw new OrchestrationToolError("model_not_eligible", `Model "${requestedModelId}" is not eligible for role "${role.name}".`);
      }
      if (orchestration.teamSnapshot.maxTotalTokens && this.modelReportsNoUsage(requestedModelId)) {
        throw new OrchestrationToolError(
          "model_unavailable",
          `Model "${requestedModelId}" reports no token usage, so this orchestration's token budget cannot limit it. Choose another model.`,
        );
      }
      if (intent === "implement" && coordinator.mode !== "code") {
        throw new OrchestrationToolError("not_authorized", "Only a coordinator running in code mode may delegate implementation tasks.");
      }
      const permissionMode = entry.permissionMode ?? "inherit";
      if (permissionMode !== "inherit" && permissionMode !== "supervised") {
        throw new OrchestrationToolError("invalid_arguments", "Invalid child permission mode.");
      }
      const executionOptions = this.validateTaskExecutionOptions(requestedModelId, entry.executionOptions, index);
      return {
        clientTaskId, title, prompt, roleId, modelId: requestedModelId, intent,
        permissionMode: permissionMode as "inherit" | "supervised", executionOptions,
      };
    });
    const clientIds = new Set<string>();
    for (const task of parsed) {
      if (clientIds.has(task.clientTaskId)) throw new OrchestrationToolError("invalid_arguments", `Duplicate clientTaskId: ${task.clientTaskId}`);
      clientIds.add(task.clientTaskId);
    }

    const wave = this.context.db.createOrchestrationWave(orchestration.id);
    await this.context.db.flushDurable();
    try {
      const baselinePath = await captureOrchestrationBaseline({
        workspacePath: coordinator.worktreePath,
        workspaceVcs: coordinator.workspaceVcs,
        artifactRoot: this.getOrchestrationArtifactRoot(),
        orchestrationId: orchestration.id,
        waveId: wave.id,
      });
      this.context.db.updateOrchestrationWave(wave.id, { baselinePath, baselineState: "ready" });
    } catch (error) {
      this.context.db.updateOrchestrationWave(wave.id, { baselineState: "failed" });
      throw error;
    }
    const tasks = parsed.map((task) => this.context.db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      ...task,
    }));
    this.context.db.updateOrchestration(orchestration.id, { status: "active", errorMessage: null });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "wave-created",
      title: `Wave ${wave.waveIndex + 1}`,
      content: `Delegated ${tasks.length} durable task${tasks.length === 1 ? "" : "s"}.`,
      metadata: { taskIds: tasks.map((task) => task.id) },
    });
    await this.context.db.flushDurable();
    await this.dispatchOrchestrationTasks(orchestration.id);
    return tasks.map((task) => this.context.db.getOrchestrationTask(task.id));
  }

  private async deliverQueuedOrchestrationMessages(task: OrchestrationTaskRecord, reserved = false): Promise<boolean> {
    if (!task.childRunId) return false;
    const messages = this.context.db.listOrchestrationTaskMessages(task.orchestrationId)
      .filter((message) => message.taskId === task.id && message.status === "queued");
    if (messages.length === 0) return false;
    // Recovery still targets this child. Starting another turn would let that cancellation stop it.
    if (this.context.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "cancel-child" }).length > 0) return false;
    const child = this.context.db.getRun(task.childRunId);
    if (this.services.activeWorkers.runWorkers.has(child.id)) return false;
    // Keep older terminal results addressable, including tasks created before versioned results.
    if (ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) && this.context.db.listOrchestrationTaskResults(task.id).length === 0) {
      await this.publishOrchestrationResult(task);
    }
    if (!reserved && !this.reserveOrchestrationTask(task)) {
      this.context.db.updateOrchestrationTask(task.id, { status: "pending" });
      return false;
    }
    const childExecutionSettings = latestRunExecutionSettings(this.context.db.getRunSteps(child.id));
    this.context.db.updateOrchestrationTask(task.id, {
      status: "queued",
      adoptionStatus: "none",
      errorMessage: null,
      attentionReason: null,
      finishedAt: null,
    });
    try {
      for (const message of messages) this.context.db.updateOrchestrationTaskMessage(message.id, "delivering");
      await this.context.db.flushDurable();
      await this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(
        child.id,
        formatChildTaskMessages(messages),
        { mode: child.mode, modelId: child.modelId, yoloMode: task.permissionMode !== "supervised" && childExecutionSettings?.yoloMode === true },
        {
          orchestrationTaskId: task.id,
          orchestrationMessageIds: messages.map((message) => message.id),
          orchestrationMessageSources: messages.map((message) => message.source),
          // The blocks name their authors, so the turn must not be labelled a user request.
          orchestrationResume: true,
          displayPrompt: childTaskMessagesDisplayText(messages),
        },
      ));
    } catch (error) {
      // The child never saw these messages, so it keeps the state it stopped in. Reporting the
      // failure lets the wave finish and tells the coordinator to send them again.
      const reason = `A message could not be delivered: ${error instanceof Error ? error.message : String(error)}`;
      for (const message of messages) this.context.db.updateOrchestrationTaskMessage(message.id, "failed");
      this.context.db.updateOrchestrationTask(task.id, {
        status: ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) ? task.status : "blocked",
        summary: task.summary,
        adoptionStatus: task.adoptionStatus,
        errorMessage: task.errorMessage,
        attentionReason: reason,
        finishedAt: task.finishedAt,
      });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: task.orchestrationId,
        taskId: task.id,
        type: "attention",
        title: "Message not delivered",
        content: reason,
      });
      return false;
    }
    for (const message of messages) this.context.db.updateOrchestrationTaskMessage(message.id, "delivered");
    this.context.db.updateOrchestrationTask(task.id, { status: "running", startedAt: new Date().toISOString() });
    return true;
  }

  /** Snapshots a completed implementation child, so adoption reviews exactly what was published. */
  private async captureOrchestrationResultSnapshot(
    task: OrchestrationTaskRecord,
    status: OrchestrationTaskStatus,
  ): Promise<string | undefined> {
    if (status !== "completed" || task.intent !== "implement" || !task.childRunId) return undefined;
    const child = this.context.db.getRun(task.childRunId);
    return captureOrchestrationBaseline({
      workspacePath: child.worktreePath, workspaceVcs: child.workspaceVcs,
      artifactRoot: this.getOrchestrationArtifactRoot(), orchestrationId: task.orchestrationId,
      waveId: `result-${randomUUID()}`,
    });
  }

  /** Publishes a task that is already terminal, such as a record from before versioned results. */
  private async publishOrchestrationResult(task: OrchestrationTaskRecord): Promise<void> {
    const workspaceSnapshotPath = await this.captureOrchestrationResultSnapshot(task, task.status);
    this.context.db.publishOrchestrationTaskResult(task.id, workspaceSnapshotPath, this.orchestrationResultModels(
      task, task.childRunId, task.childRunId ? this.runExecutedModels.get(task.childRunId) : undefined,
    ));
  }

  /**
   * Which model a result came from: the configured one the child ran with, and the one its
   * provider said served it. Routing, CLI fallbacks and agent defaults can make them differ.
   */
  private orchestrationResultModels(
    task: OrchestrationTaskRecord,
    childRunId: string | null,
    executedModel: string | undefined,
  ): { requestedModel?: string; executedModel?: string } {
    let requestedModel: string | undefined;
    try {
      requestedModel = this.context.db.getModel(childRunId ? this.context.db.getRun(childRunId).modelId : task.modelId).modelId;
    } catch {
      requestedModel = undefined;
    }
    return { ...(requestedModel ? { requestedModel } : {}), ...(executedModel ? { executedModel } : {}) };
  }

  /**
   * Publishes a finished child's result in phases that survive a crash. Its outcome is saved
   * first as a pending `publish-result` effect while the task keeps its active status, so
   * nothing reports completion yet. Then the workspace is snapshotted, and one transaction marks
   * the task terminal, publishes the result, records the completion event, and completes the
   * effect. Startup finishes an effect a crash left pending, reusing a snapshot already taken.
   */
  private async finalizeOrchestrationChildResult(task: OrchestrationTaskRecord, run: RunRecord): Promise<"published" | "blocked"> {
    const pending = this.context.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "publish-result" }).at(-1);
    const reportedModel = this.runExecutedModels.get(run.id);
    const previousResult = this.context.db.listOrchestrationTaskResults(task.id).at(-1);
    const previousWarning = previousResult
      ? abandonedSubagentNote(resultAbandonedSubagentCount(this.context.db, task.id, previousResult.id)) : "";
    const previousSummary = previousResult?.summary ?? null;
    const previousReport = previousWarning && previousSummary?.endsWith(previousWarning)
      ? previousSummary.slice(0, -previousWarning.length).trimEnd() || null : previousSummary;
    let effect = pending ?? this.context.db.createOrchestrationEffect({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      kind: "publish-result",
      payload: {
        childRunId: run.id,
        status: orchestrationTaskStatusForRun(run),
        summary: publishedFollowUpSummary(run.summary, previousReport),
        errorMessage: run.errorMessage,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        // Saved with the outcome, so a publication resumed after a crash still knows it.
        ...(reportedModel ? { executedModel: reportedModel } : {}),
      },
    });
    if (!pending) await this.context.db.flushDurable();
    // The effect now holds the report, also for a publication resumed after a crash.
    this.runExecutedModels.delete(run.id);
    const outcome = readPublishResultPayload(effect.payload, run);
    // Recorded once, so a publication resumed after a crash reports the same count. Closing the
    // subagents and recording how many were open is one transaction: otherwise a failure between
    // them leaves them closed, and the resumed publication counts none and drops the warning.
    if (typeof effect.payload.abandonedSubagents !== "number") {
      const pendingEffect = effect;
      effect = this.context.db.transaction(() => this.context.db.updateOrchestrationEffect(pendingEffect.id, {
        payload: { ...pendingEffect.payload, abandonedSubagents: this.closeAbandonedChildSubagents(run.id) },
      }));
      await this.context.db.flushDurable();
    }
    const abandonedSubagents = Number(effect.payload.abandonedSubagents);
    let snapshotPath = typeof effect.payload.workspaceSnapshotPath === "string" && existsSync(effect.payload.workspaceSnapshotPath)
      ? effect.payload.workspaceSnapshotPath
      : undefined;
    try {
      if (!snapshotPath) {
        snapshotPath = await this.captureOrchestrationResultSnapshot(task, outcome.status);
        if (snapshotPath) {
          effect = this.context.db.updateOrchestrationEffect(effect.id, { payload: { ...effect.payload, workspaceSnapshotPath: snapshotPath } });
          await this.context.db.flushDurable();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.db.transaction(() => {
        const updated = this.context.db.updateOrchestrationTask(task.id, {
          summary: outcome.summary, errorMessage: outcome.errorMessage,
          inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
        });
        this.blockOrchestrationTask(updated, "Result snapshot failed", message);
        this.context.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
      });
      await this.context.db.flushDurable();
      return "blocked";
    }
    const effectId = effect.id;
    // The caveat belongs to the published result itself, so every reader of it (wakes, waits,
    // task reads, the user) sees that part of the work never finished.
    const abandonedNote = abandonedSubagentNote(abandonedSubagents);
    const publishedSummary = abandonedNote ? [outcome.summary, abandonedNote].filter(Boolean).join("\n\n") : outcome.summary;
    this.context.db.transaction(() => {
      const updated = this.context.db.updateOrchestrationTask(task.id, {
        status: outcome.status,
        summary: publishedSummary,
        errorMessage: outcome.errorMessage,
        attentionReason: outcome.status === "failed" ? outcome.errorMessage : null,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        finishedAt: new Date().toISOString(),
      });
      const result = this.context.db.publishOrchestrationTaskResult(task.id, snapshotPath, this.orchestrationResultModels(
        task, run.id, typeof effect.payload.executedModel === "string" ? effect.payload.executedModel : undefined,
      ));
      this.context.db.appendOrchestrationEvent({
        orchestrationId: task.orchestrationId,
        taskId: task.id,
        type: outcome.status === "completed" ? "task-completed" : "attention",
        title: updated.title,
        content: outcome.status !== "completed" && outcome.errorMessage
          ? [outcome.errorMessage, publishedSummary].filter(Boolean).join("\n\n")
          : publishedSummary || `Task ${outcome.status}.`,
        metadata: {
          childRunId: run.id, resultId: result.id, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
          ...(abandonedSubagents > 0 ? { abandonedSubagents } : {}),
        },
      });
      this.context.db.updateOrchestrationEffect(effectId, { status: "completed", incrementAttempts: true });
    });
    await this.context.db.flushDurable();
    return "published";
  }

  /**
   * Settles a task whose child run stopped: defers it on a usage limit, otherwise publishes its
   * result and starts any queued follow-up. Returns "continued" when a follow-up turn started.
   */
  private async settleOrchestrationChildTerminal(
    task: OrchestrationTaskRecord,
    run: RunRecord,
    options: { deliverQueued: boolean } = { deliverQueued: true },
  ): Promise<"deferred" | "blocked" | "settled" | "continued"> {
    // Once an outcome is recorded for publication, it is published. Deferring then would leave the
    // effect pending and let a later, different outcome be published from its stale payload.
    const publicationPending = this.context.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "publish-result" }).length > 0;
    if (!publicationPending && orchestrationTaskStatusForRun(run) === "failed" && await this.deferChildAfterUsageLimit(task, run)) return "deferred";
    if (await this.finalizeOrchestrationChildResult(task, run) === "blocked") return "blocked";
    if (!options.deliverQueued) return "settled";
    return await this.deliverQueuedOrchestrationMessages(this.context.db.getOrchestrationTask(task.id)) ? "continued" : "settled";
  }

  private async handleOrchestrationChildTerminal(childRunId: string): Promise<void> {
    const task = this.context.db.getOrchestrationTaskByChildRunId(childRunId);
    if (!task) return;
    await this.withOrchestrationMutation(task.orchestrationId, async () => {
      const outcome = await this.settleOrchestrationChildTerminal(this.context.db.getOrchestrationTask(task.id), this.context.db.getRun(childRunId));
      if (outcome === "continued") {
        this.emitOrchestrationChanged(task.orchestrationId, task.id);
        return;
      }
      await this.dispatchOrchestrationTasks(task.orchestrationId);
      await this.maybeWakeOrchestrationCoordinator(task.orchestrationId);
      this.emitOrchestrationChanged(task.orchestrationId, task.id);
    });
    // Capacity is global across orchestrations. A terminal child may unblock a
    // different coordinator, so do not leave its persisted queue stranded.
    await this.dispatchOtherOrchestrationTasks(task.orchestrationId);
  }

  /**
   * Finishes or rolls back side effects a crash interrupted. Runs at startup, before tasks are
   * reconciled, so their state reflects every effect that already happened.
   */
  private async resumePendingOrchestrationEffects(orchestrationId: string): Promise<void> {
    for (const effect of this.context.db.listPendingOrchestrationEffects({ orchestrationId })) {
      try {
        if (effect.kind === "publish-result") await this.resumeResultPublication(effect);
        else if (effect.kind === "launch-child") await this.resumeChildLaunch(effect);
        else if (effect.kind === "deliver-update") this.resumeCoordinatorDelivery(effect);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
        this.context.db.appendOrchestrationEvent({
          orchestrationId, taskId: effect.taskId, type: "attention",
          title: "Interrupted operation needs review", content: message, metadata: { effectId: effect.id, effectKind: effect.kind },
        });
      }
    }
    await this.context.db.flushDurable();
  }

  private async resumeResultPublication(effect: OrchestrationEffectRecord): Promise<void> {
    const task = this.context.db.getOrchestrationTask(effect.taskId ?? "");
    const childRunId = typeof effect.payload.childRunId === "string" ? effect.payload.childRunId : task.childRunId;
    if (!childRunId) throw new Error("The interrupted result publication has no child run.");
    // Queued follow-ups stay queued: startup does not start child turns before recovery checks run.
    const outcome = await this.settleOrchestrationChildTerminal(task, this.context.db.getRun(childRunId), { deliverQueued: false });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId, taskId: task.id, type: "recovered", title: "Result publication finished",
      content: outcome === "blocked"
        ? "The app stopped while publishing this result; the snapshot could not be completed."
        : "The app stopped while publishing this result; BuildWarden finished publishing it.",
      metadata: { effectId: effect.id },
    });
  }

  /**
   * A child whose run was never created leaves a workspace nobody owns, possibly half made; remove
   * whatever exists and requeue the task. The effect names the workspace before it is created.
   */
  private async resumeChildLaunch(effect: OrchestrationEffectRecord): Promise<void> {
    const task = this.context.db.getOrchestrationTask(effect.taskId ?? "");
    const workspace = effect.payload.workspace as Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath"> | undefined;
    // A later attempt may have launched the task in another workspace, so a child run owns this
    // one only when it uses this exact path.
    const ownerPath = task.childRunId ? this.context.db.getRun(task.childRunId).worktreePath : null;
    if (workspace?.worktreePath && !(ownerPath && isSameWorktreePath(ownerPath, workspace.worktreePath))) {
      const project = this.context.db.getProject(this.context.db.getOrchestration(task.orchestrationId).projectId);
      if (!(await this.discardPreparedRunWorkspace(project.repoPath, workspace))) {
        this.context.db.updateOrchestrationEffect(effect.id, {
          payload: { ...effect.payload, phase: "cleanup" }, incrementAttempts: true,
          errorMessage: CHILD_WORKSPACE_REMOVAL_RETRY,
        });
        return;
      }
      this.context.db.updateOrchestrationEffect(effect.id, {
        status: "failed", incrementAttempts: true,
        errorMessage: effect.payload.phase === "cleanup"
          ? "The workspace left by a failed child launch was removed."
          : effect.payload.phase === "preparing"
            ? "The app stopped while preparing the child workspace; whatever part of it existed was removed."
            : "The app stopped before the child run existed; its prepared workspace was removed.",
      });
      return;
    }
    // The run exists, so task reconciliation resumes or restarts it.
    this.context.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
  }

  /**
   * Ends a child launch that failed before its run existed. The launch effect is the only record
   * of the workspace, so it stays pending until the workspace is gone, and startup retries the
   * removal if it fails now.
   */
  private async closeFailedChildLaunch(
    launch: OrchestrationEffectRecord,
    repoPath: string,
    workspace: Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (await this.discardPreparedRunWorkspace(repoPath, workspace)) {
      this.context.db.updateOrchestrationEffect(launch.id, { status: "failed", incrementAttempts: true, errorMessage: message });
    } else {
      this.context.db.updateOrchestrationEffect(launch.id, {
        payload: { workspace, phase: "cleanup" }, incrementAttempts: true,
        errorMessage: `${message} ${CHILD_WORKSPACE_REMOVAL_RETRY}`,
      });
    }
    await this.context.db.flushDurable();
  }

  /**
   * Advances the delivery cursor only when the agent demonstrably received the update: the run
   * shows agent activity after the tagged follow-up step. That step is written before the worker
   * starts, so on its own it proves nothing. Without the evidence the update counts as not
   * delivered. An automatic wake gets its exact wait back and is repeated, since a repeated update
   * is safer than a lost one. A user's follow-up is held for the user to send again, because
   * resuming the provider session would not carry its text.
   */
  private resumeCoordinatorDelivery(effect: OrchestrationEffectRecord): void {
    if (effect.payload.viaWait === true) {
      this.settleCoordinatorWaitDeliveries(effect.orchestrationId, { turnEnded: true });
      return;
    }
    const orchestration = this.context.db.getOrchestration(effect.orchestrationId);
    const steps = this.context.db.getRunSteps(orchestration.coordinatorRunId);
    const deliveryIndex = steps.findIndex((step) => parseMetadataRecord(step.metadataJson).orchestrationDeliveryId === effect.id);
    const started = deliveryIndex >= 0 && steps.slice(deliveryIndex + 1).some((step) => AGENT_ACTIVITY_EVENT_TYPES.has(step.eventType));
    const targetSequence = typeof effect.payload.targetSequence === "number" ? effect.payload.targetSequence : 0;
    if (started) {
      this.context.db.transaction(() => {
        this.context.db.updateOrchestration(orchestration.id, { lastDeliveredSequence: Math.max(orchestration.lastDeliveredSequence, targetSequence) });
        this.context.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
      return;
    }
    const previousWakeMode = effect.payload.previousWakeMode as OrchestrationWakeMode | null | undefined;
    const previousWakeTaskIds = Array.isArray(effect.payload.previousWakeTaskIds) ? effect.payload.previousWakeTaskIds.map(String) : [];
    const userWake = effect.payload.userWake === true;
    const unchangedSince = orchestration.status === "active" && !orchestration.wakeMode;
    this.context.db.transaction(() => {
      if (unchangedSince && userWake) {
        const reason = "The app stopped before your follow-up reached the coordinator. Send it again to continue.";
        this.context.db.updateOrchestration(orchestration.id, {
          status: "attention", wakeMode: previousWakeMode ?? null, wakeTaskIds: previousWakeTaskIds, errorMessage: reason,
        });
        this.context.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "attention", title: "Follow-up not delivered", content: reason });
      } else if (unchangedSince && previousWakeMode) {
        this.context.db.updateOrchestration(orchestration.id, { status: "waiting", wakeMode: previousWakeMode, wakeTaskIds: previousWakeTaskIds });
      }
      this.context.db.updateOrchestrationEffect(effect.id, {
        status: "failed", incrementAttempts: true,
        errorMessage: "The app stopped before the coordinator turn showed activity; the update counts as not delivered.",
      });
    });
  }

  private async handleOrchestrationCoordinatorTurnTerminal(coordinatorRunId: string): Promise<void> {
    const ended = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (ended) {
      this.settleCoordinatorWaitDeliveries(ended.id, { turnEnded: true });
      await this.context.db.flushDurable();
    }
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration || ["completed", "cancelled", "deleting", "deletion-failed"].includes(orchestration.status)) return;
    const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
    if (tasks.length === 0) return;
    const allTasksTerminal = tasks.every((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status));
    const adoptionApplying = tasks.some((task) => task.adoptionStatus === "applying");
    if (
      orchestration.status === "active" &&
      !orchestration.wakeMode &&
      orchestration.lastDeliveredSequence > 0 &&
      allTasksTerminal &&
      !adoptionApplying
    ) {
      await this.finishOrchestration(coordinatorRunId);
      return;
    }
    if (!orchestration.wakeMode && orchestration.status === "active") {
      const latestWave = this.context.db.listOrchestrationWaves(orchestration.id).at(-1);
      const waveTaskIds = latestWave ? tasks.filter((task) => task.waveId === latestWave.id).map((task) => task.id) : [];
      this.context.db.updateOrchestration(orchestration.id, {
        status: "waiting",
        wakeMode: "all-terminal",
        wakeTaskIds: waveTaskIds,
      });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "yield",
        title: "Default wake condition",
        content: "The coordinator ended its turn without yielding; BuildWarden will resume it when the current wave is terminal or needs attention.",
        metadata: { mode: "all-terminal", taskIds: waveTaskIds, implicit: true },
      });
    }
    await this.maybeWakeOrchestrationCoordinator(orchestration.id);
    this.emitOrchestrationChanged(orchestration.id);
  }

  /** Tasks whose child reported a state the coordinator has not been told about yet. */
  private undeliveredOrchestrationTaskIds(orchestration: OrchestrationRecord): Set<string> {
    return new Set(this.context.db.listOrchestrationEvents(orchestration.id).flatMap((event) =>
      event.taskId && ORCHESTRATION_WAKE_NEWS_EVENT_TYPES.has(event.type) && event.sequence > orchestration.lastDeliveredSequence
        ? [event.taskId]
        : []));
  }

  /** Tasks whose question the coordinator has not been told about yet. */
  private undeliveredQuestionTaskIds(orchestration: OrchestrationRecord): Set<string> {
    return new Set(this.context.db.listOrchestrationEvents(orchestration.id).flatMap((event) =>
      event.taskId && event.metadata.kind === "user-input" && event.sequence > orchestration.lastDeliveredSequence
        ? [event.taskId]
        : []));
  }

  /** Questions a child is blocked on. Approvals are absent: only the user can decide those. */
  private pendingChildQuestions(childRunId: string): PendingChildQuestion[] {
    const opened = new Map<string, PendingChildQuestion>();
    for (const step of this.context.db.getRunSteps(childRunId)) {
      if (step.eventType !== "user-input-requested") continue;
      const metadata = parseMetadataRecord(step.metadataJson);
      const inputRequestId = metadata.userInputRequestId;
      if (typeof inputRequestId !== "string") continue;
      if (metadata.requestStatus === "opened") {
        const questions = Array.isArray(metadata.userInputQuestions) ? metadata.userInputQuestions as RunUserInputQuestion[] : [];
        opened.set(inputRequestId, { inputRequestId, questions });
      } else {
        opened.delete(inputRequestId);
      }
    }
    return [...opened.values()];
  }

  /**
   * `any-terminal` and `attention` fire on news, not on standing state: a task that already
   * finished or failed, or a child still waiting on a human, was reported by an earlier wake
   * and must not resume the coordinator again. A new question wakes it in every mode, because
   * otherwise the child waits on someone who is asleep and may be able to answer.
   */
  private orchestrationWakeSatisfied(
    orchestration: OrchestrationRecord,
    tasks: OrchestrationTaskRecord[],
    undeliveredTaskIds: ReadonlySet<string> = new Set(),
    undeliveredQuestionTaskIds: ReadonlySet<string> = new Set(),
  ): boolean {
    return orchestrationWakeSatisfied(orchestration, tasks, undeliveredTaskIds, undeliveredQuestionTaskIds);
  }

  private async buildOrchestrationChildRunSummary(childRunId: string, args: Record<string, unknown>) {
    const run = this.context.db.getRun(childRunId);
    const requestedSteps = Number(args.recentSteps ?? ORCHESTRATION_TASK_READ_DEFAULT_STEPS);
    const stepLimit = Number.isInteger(requestedSteps)
      ? Math.min(Math.max(requestedSteps, 0), ORCHESTRATION_TASK_READ_MAX_STEPS)
      : ORCHESTRATION_TASK_READ_DEFAULT_STEPS;
    const recentSteps = this.context.db.listRecentRunStepPreviews(childRunId, stepLimit, ORCHESTRATION_TASK_READ_MAX_STEP_CHARS)
      // SQLite length()/substr() count code points, not UTF-16 units.
      .map((step) => step.contentChars > Array.from(step.content).length
        ? { ...step, content: `${step.content}\n... truncated (${String(step.contentChars)} chars total) ...` }
        : step);
    const { summary, worktreeUnavailable } = await this.services.runDetails.getRunWorktreeDiffSummary(childRunId);
    const diff = args.includeDiff === true && !worktreeUnavailable
      ? truncateForCoordinator((await this.services.runDetails.getRunWorktreeDiff(childRunId)).diff, ORCHESTRATION_TASK_READ_MAX_DIFF_CHARS)
      : undefined;
    return {
      id: run.id,
      status: run.status,
      mode: run.mode,
      workspaceType: run.workspaceType,
      branchName: run.branchName,
      errorMessage: run.errorMessage,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      changedFiles: {
        ...summary,
        files: summary.files.slice(0, ORCHESTRATION_TASK_READ_MAX_FILES),
        worktreeUnavailable,
      },
      recentSteps,
      ...(diff !== undefined ? { diff } : {}),
    };
  }

  /**
   * Everything the coordinator has not been told since the delivery cursor: each task's compact
   * state, the user's adoption decisions, and the new events. Wakes and the blocking wait both
   * report through this, so neither can leave part of the news out.
   */
  private buildOrchestrationNews(orchestration: OrchestrationRecord): string[] {
    const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
    const events = this.context.db.listOrchestrationEvents(orchestration.id)
      .filter((event) => event.sequence > orchestration.lastDeliveredSequence);
    const undelivered = this.undeliveredOrchestrationTaskIds(orchestration);
    const lines = formatOrchestrationResumeTasks(tasks.map((task) => ({
      task,
      modelName: this.orchestrationModelName(task.modelId),
      hasNews: undelivered.has(task.id),
      questions: task.status === "waiting-input" && task.childRunId ? this.pendingChildQuestions(task.childRunId) : [],
    })));
    const adoptionDecisions = events.filter((event) => event.type.startsWith("adoption-") && event.type !== "adoption-proposed")
      .map((event) => `- ${event.content}`);
    return [
      ...lines,
      ...(adoptionDecisions.length > 0 ? ["", "Adoption decisions:", ...adoptionDecisions] : []),
      "",
      `New durable events: ${events.map((event) => `${event.sequence}:${event.type}`).join(", ") || "none"}`,
    ];
  }

  private buildOrchestrationResumePrompt(orchestration: OrchestrationRecord): string {
    return wrapOrchestrationUpdate([
      "BuildWarden durable orchestration resumed you because the persisted wake condition was met.",
      "Review these compact results and inspect individual tasks with buildwarden_tasks_read when needed. Delegate another wave if useful; otherwise provide the final summary. BuildWarden completes the orchestration automatically when this turn ends without new work.",
      "",
      ...this.buildOrchestrationNews(orchestration),
    ]);
  }

  /** Moves the cursor for blocking waits the coordinator received (see orchestration-delivery). */
  private settleCoordinatorWaitDeliveries(orchestrationId: string, options: { turnEnded: boolean }): void {
    settleCoordinatorWaitDeliveries(this.context.db, orchestrationId, options);
  }

  private orchestrationModelName(modelId: string): string {
    try {
      return this.context.db.getModel(modelId).displayName;
    } catch {
      return modelId;
    }
  }

  /**
   * Starts a coordinator turn carrying undelivered news. The delivery cursor moves only once the
   * turn has started, so a failed start keeps the news and the wake condition for a retry. A
   * `deliver-update` effect records the attempt first, and the turn's log step carries its id:
   * after a crash, startup advances the cursor if that step exists and otherwise restores the
   * exact wake condition, instead of guessing.
   */
  private async deliverOrchestrationUpdate<T>(
    orchestration: OrchestrationRecord,
    startTurn: (deliveryMetadata: { orchestrationDeliveryId: string }) => Promise<T>,
    options: { userWake?: boolean } = {},
  ): Promise<T> {
    const effect = this.context.db.transaction(() => {
      const created = this.context.db.createOrchestrationEffect({
        orchestrationId: orchestration.id,
        kind: "deliver-update",
        payload: {
          targetSequence: orchestration.lastEventSequence,
          previousStatus: orchestration.status,
          previousWakeMode: orchestration.wakeMode,
          previousWakeTaskIds: orchestration.wakeTaskIds,
          userWake: options.userWake === true,
        },
      });
      this.context.db.updateOrchestration(orchestration.id, { status: "active", wakeMode: null, wakeTaskIds: [], errorMessage: null });
      return created;
    });
    await this.context.db.flushDurable();
    try {
      const result = await startTurn({ orchestrationDeliveryId: effect.id });
      this.context.db.transaction(() => {
        this.context.db.updateOrchestration(orchestration.id, { lastDeliveredSequence: orchestration.lastEventSequence });
        this.context.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
      await this.context.db.flushDurable();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.db.transaction(() => {
        this.context.db.updateOrchestration(orchestration.id, {
          status: "attention",
          wakeMode: orchestration.wakeMode,
          wakeTaskIds: orchestration.wakeTaskIds,
          errorMessage: message,
        });
        this.context.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
      });
      throw error;
    }
  }

  /** What a coordinator needs to choose models: identity, availability, and current limits. */
  private async describeOrchestrationModels(team: OrchestrationTeamSettings, projectId: string) {
    const projectDefaults = parseProjectRunDefaultsSetting(this.context.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults])[projectId];
    const requiresProjectMcp = projectDefaults?.mcpServers.some((server) => server.enabled && server.required === true) === true;
    return Promise.all(team.models.filter((profile) => profile.enabled).map(async (profile) => {
      const base = { modelId: profile.modelId, maxConcurrent: profile.maxConcurrent, ...(profile.defaultEffort ? { defaultEffort: profile.defaultEffort } : {}) };
      try {
        const model = this.context.db.getModel(profile.modelId);
        const provider = this.context.db.getProviderAccount(model.providerAccountId);
        const hasCredentials = providerAllowsMissingApiKey(provider) || await this.context.secrets.readSecret(provider.apiKeyRef) !== null;
        const limit = hasCredentials ? await this.services.providerRuntime.getProviderLimitState(model.id) : null;
        const reported = this.services.providerRuntime.sessionCapabilityReport(provider) ?? null;
        const unmetered = Boolean(team.maxTotalTokens) && getHarnessCapabilities(provider.providerType).usageReporting === "unavailable";
        const capabilities = effectiveHarnessCapabilities(provider.providerType, reported);
        const unavailableReason = !hasCredentials ? `Credentials are unavailable for ${provider.label}.`
          : requiresProjectMcp && capabilities.projectMcp === "unsupported"
            ? "This integration cannot use the project's required MCP servers."
            : unmetered
              ? "This integration reports no token usage, so the orchestration's token budget cannot limit it. Remove the token budget from the team to use it."
              : limit?.reason;
        const executionOptions = this.taskExecutionOptionChoices(model, provider);
        return {
          ...base,
          name: model.displayName,
          provider: provider.label,
          providerType: provider.providerType,
          steering: capabilities.liveSteering,
          capabilities,
          ...(reported ? { sessionCapabilities: reported } : {}),
          ...(Object.keys(executionOptions).length > 0 ? { executionOptions } : {}),
          available: !unavailableReason,
          ...(unavailableReason ? { unavailableReason } : {}),
          ...(limit?.resetsAt ? { availableAfter: limit.resetsAt } : {}),
        };
      } catch {
        return { ...base, available: false, unavailableReason: "This model is no longer configured." };
      }
    }));
  }

  /**
   * Settings a delegated task may set for this model: the model's own controls, limited to
   * those the integration can apply per task. Values exclude "auto", which means "omit".
   */
  private taskExecutionOptionChoices(model: ModelRecord, provider: ProviderAccountRecord): Partial<Record<ModelExecutionControlId, string[]>> {
    const allowed = new Set(getHarnessCapabilities(provider.providerType).taskExecutionOptions);
    const family = provider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : null;
    const profile = resolveModelExecutionProfile(provider.providerType, family, model.modelId, model.configJson);
    const choices: Partial<Record<ModelExecutionControlId, string[]>> = {};
    for (const control of profile.controls) {
      if (!allowed.has(control.id)) continue;
      const values = control.options.map((option) => option.value).filter((value) => value !== "auto");
      if (values.length > 0) choices[control.id] = values;
    }
    return choices;
  }

  private validateTaskExecutionOptions(modelId: string, raw: unknown, index: number): ProviderExecutionOptions | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} executionOptions must be an object.`);
    }
    const model = this.context.db.getModel(modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    const choices = this.taskExecutionOptionChoices(model, provider);
    const describe = () => Object.entries(choices).map(([key, values]) => `${key} (${values.join(", ")})`).join("; ") || "none";
    const options: ProviderExecutionOptions = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "auto") continue;
      // Own keys only: "constructor" or "__proto__" would otherwise find inherited values and throw.
      const allowedValues = Object.hasOwn(choices, key) ? choices[key as ModelExecutionControlId] : undefined;
      if (!allowedValues) {
        throw new OrchestrationToolError("execution_option_unsupported",
          `Task ${index + 1}: ${model.displayName} does not accept ${key} per task. It accepts: ${describe()}.`);
      }
      if (typeof value !== "string" || !allowedValues.includes(value)) {
        throw new OrchestrationToolError("execution_option_unsupported",
          `Task ${index + 1}: ${key} for ${model.displayName} must be one of ${allowedValues.join(", ")}.`);
      }
      (options as Record<string, string>)[key] = value;
    }
    return Object.keys(options).length > 0 ? options : null;
  }

  private async buildOrchestrationCoordinatorView(coordinatorRunId: string) {
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    const team = orchestration?.teamSnapshot ?? this.resolveOrchestrationTeamSettings();
    const totalTokens = orchestration ? this.context.db.getOrchestrationTotalTokens(orchestration.id) : 0;
    const coordinator = this.context.db.getRun(coordinatorRunId);
    const budgetWarning = this.coordinatorBudgetWarning(coordinator, team);
    return {
      delegationEnabled: true,
      orchestration: orchestration
        ? {
            id: orchestration.id,
            status: orchestration.status,
            wakeMode: orchestration.wakeMode,
            wakeTaskIds: orchestration.wakeTaskIds,
            errorMessage: orchestration.errorMessage,
          }
        : null,
      limits: {
        maxConcurrentTasks: team.maxConcurrentTasks,
        maxTasksPerOrchestration: team.maxTasksPerOrchestration,
        ...(team.maxTotalTokens ? { maxTotalTokens: team.maxTotalTokens } : {}),
        ...(budgetWarning ? { budgetCoverage: "children-only", budgetWarning } : {}),
      },
      totalTokens,
      models: await this.describeOrchestrationModels(team, coordinator.projectId),
      roles: team.roles,
      tasks: orchestration ? this.listCompactOrchestrationTasks(orchestration.id) : [],
    };
  }

  /**
   * Children on integrations without usage reports are refused under a token budget, but the
   * coordinator itself is already running. Its own tokens then go uncounted, so say so.
   */
  private coordinatorBudgetWarning(coordinator: RunRecord, team: OrchestrationTeamSettings): string | null {
    if (!team.maxTotalTokens || !this.modelReportsNoUsage(coordinator.modelId)) return null;
    return "The coordinator runs on an integration that reports no token usage, so the token budget counts only the delegated tasks, not the coordinator's own turns.";
  }

  /** Whether the model's integration reports no token usage, so budgets cannot measure it. */
  private modelReportsNoUsage(modelId: string): boolean {
    try {
      const provider = this.context.db.getProviderAccount(this.context.db.getModel(modelId).providerAccountId);
      return getHarnessCapabilities(provider.providerType).usageReporting === "unavailable";
    } catch {
      return false;
    }
  }

  /** A task of this coordinator's orchestration, or a coded rejection. */
  private requireCoordinatorTask(coordinatorRunId: string, rawTaskId: unknown): OrchestrationTaskRecord {
    const taskId = typeof rawTaskId === "string" ? rawTaskId.trim() : "";
    if (!taskId) throw new OrchestrationToolError("invalid_arguments", "taskId is required.");
    const task = this.context.db.findOrchestrationTask(taskId);
    if (!task) throw new OrchestrationToolError("task_not_found", `Task ${taskId} does not exist.`);
    if (this.context.db.getOrchestration(task.orchestrationId).coordinatorRunId !== coordinatorRunId) {
      throw new OrchestrationToolError("task_not_in_orchestration", "Task does not belong to this coordinator.");
    }
    return task;
  }

  /** Where a task stands beyond its status (see orchestration-native-work). */
  private describeChildPendingWork(task: OrchestrationTaskRecord) {
    return describeChildPendingWork(this.context.db, task, {
      childRunning: Boolean(task.childRunId && this.services.activeWorkers.runWorkers.has(task.childRunId)),
      taskActive: ORCHESTRATION_ACTIVE_TASK_STATUSES.has(task.status),
    });
  }

  /**
   * Blocks a coordinator tool call until the selected tasks meet `mode`, a child asks a
   * question, or the timeout passes. It then reports like a wake. The delivery cursor moves once
   * the coordinator shows it received the result, so the next wake neither repeats it nor, after
   * a crash, loses it. Children keep running on timeout.
   */
  private async waitForOrchestrationTasks(coordinatorRunId: string, args: Record<string, unknown>, toolCallId: string) {
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration) throw new OrchestrationToolError("orchestration_not_active", "Nothing has been delegated yet.");
    const mode = args.mode;
    if (mode !== "all-terminal" && mode !== "any-terminal" && mode !== "attention") {
      throw new OrchestrationToolError("invalid_arguments", "mode must be all-terminal, any-terminal, or attention.");
    }
    const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
    const known = new Set(this.context.db.listOrchestrationTasks(orchestration.id).map((task) => task.id));
    const unknownTaskId = taskIds.find((taskId) => !known.has(taskId));
    if (unknownTaskId) throw new OrchestrationToolError("task_not_in_orchestration", `Task ${unknownTaskId} does not belong to this orchestration.`);
    const requested = Number.isSafeInteger(args.timeoutMs) ? Number(args.timeoutMs) : ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1_000), ORCHESTRATION_WAIT_MAX_TIMEOUT_MS);
    const satisfied = (): boolean => {
      const current = this.context.db.getOrchestration(orchestration.id);
      return this.orchestrationWakeSatisfied(
        { ...current, wakeMode: mode, wakeTaskIds: taskIds },
        this.context.db.listOrchestrationTasks(orchestration.id),
        this.undeliveredOrchestrationTaskIds(current),
        this.undeliveredQuestionTaskIds(current),
      );
    };
    const coordinatorActive = () => {
      const active = this.services.activeWorkers.runWorkers.get(coordinatorRunId);
      return Boolean(active && !active.cancelled);
    };
    const startedAt = Date.now();
    const outcome = await new Promise<"satisfied" | "timeout" | "ended">((resolve) => {
      if (satisfied()) {
        resolve("satisfied");
        return;
      }
      let settled = false;
      const finish = (value: "satisfied" | "timeout" | "ended") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        resolve(value);
      };
      const check = () => {
        if (!coordinatorActive()) finish("ended");
        else if (satisfied()) finish("satisfied");
      };
      const unsubscribe = this.context.events.subscribe("orchestration", (payload: OrchestrationChangedPayload) => {
        if (payload.orchestrationId === orchestration.id) check();
      });
      // Not every state change publishes an event; a slow poll covers the rest and a stopped turn.
      const poll = setInterval(check, ORCHESTRATION_WAIT_POLL_MS);
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
    if (outcome === "ended") throw new OrchestrationToolError("coordinator_inactive", "This coordinator turn is no longer active.");
    return this.withOrchestrationMutation(orchestration.id, async () => {
      const current = this.context.db.getOrchestration(orchestration.id);
      const lines = this.buildOrchestrationNews(current);
      this.context.db.transaction(() => {
        this.context.db.appendOrchestrationEvent({
          orchestrationId: current.id, type: "coordinator-waited", title: "Coordinator waited",
          content: outcome === "satisfied" ? `The ${mode} condition was met.` : `Stopped waiting after ${String(timeoutMs)} ms.`,
          metadata: { mode, taskIds, timedOut: outcome === "timeout" },
        });
        // The waited event is the coordinator's own action, not news, so it is covered too.
        recordCoordinatorWaitDelivery(this.context.db, current.id, coordinatorRunId, toolCallId);
      });
      await this.context.db.flushDurable();
      return {
        satisfied: outcome === "satisfied",
        timedOut: outcome === "timeout",
        waitedMs: Date.now() - startedAt,
        mode,
        taskIds,
        ...(outcome === "timeout" ? { next: "Children keep running. Yield with buildwarden_orchestration_yield and end the turn, or continue other work." } : {}),
        update: wrapOrchestrationUpdate(lines),
      };
    });
  }

  private listCompactOrchestrationTasks(orchestrationId: string) {
    return this.context.db.listOrchestrationTasks(orchestrationId)
      .map((task) => compactOrchestrationTask(task, this.orchestrationModelName(task.modelId)));
  }

  private async maybeWakeOrchestrationCoordinator(
    orchestrationId: string,
    options?: { afterRestart?: boolean },
  ): Promise<void> {
    const orchestration = this.context.db.getOrchestration(orchestrationId);
    if (["active", "waiting"].includes(orchestration.status) && this.services.activeWorkers.runWorkers.has(orchestration.coordinatorRunId)) {
      await this.notifyRunningOrchestrationCoordinator(orchestration);
      return;
    }
    if (orchestration.status !== "waiting" || this.orchestrationWakeLocks.has(orchestrationId)) return;
    const tasks = this.context.db.listOrchestrationTasks(orchestrationId);
    const undelivered = this.undeliveredOrchestrationTaskIds(orchestration);
    if (!this.orchestrationWakeSatisfied(orchestration, tasks, undelivered, this.undeliveredQuestionTaskIds(orchestration))) return;
    if (this.services.activeWorkers.runWorkers.has(orchestration.coordinatorRunId)) return;
    // A wake continues the user's turn, so it keeps the access that turn granted, as children do.
    const fullAccess = latestUserTurnUsedFullAccess(this.context.db.getRunSteps(orchestration.coordinatorRunId));
    if (fullAccess && options?.afterRestart) {
      const message = "The coordinator used elevated permissions and requires explicit recovery.";
      this.context.db.updateOrchestration(orchestrationId, { status: "attention", errorMessage: message });
      this.context.db.appendOrchestrationEvent({
        orchestrationId,
        type: "attention",
        title: "Coordinator recovery needs attention",
        content: message,
      });
      this.emitOrchestrationChanged(orchestrationId);
      return;
    }
    this.orchestrationWakeLocks.add(orchestrationId);
    try {
      const prompt = this.buildOrchestrationResumePrompt(orchestration);
      const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
      await this.deliverOrchestrationUpdate(orchestration, (deliveryMetadata) => this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(
        coordinator.id,
        prompt,
        { mode: coordinator.mode, modelId: coordinator.modelId, delegationEnabled: true, yoloMode: fullAccess },
        { source: "orchestration", orchestrationResume: true, displayPrompt: orchestrationUpdateDisplayText(prompt), ...deliveryMetadata },
      )));
      this.context.db.appendOrchestrationEvent({
        orchestrationId,
        type: "coordinator-resumed",
        title: "Coordinator resumed",
        content: "Delivered new durable task results.",
      });
      this.emitOrchestrationChanged(orchestrationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.db.appendOrchestrationEvent({
        orchestrationId,
        type: "attention",
        title: "Coordinator could not resume",
        content: message,
      });
      this.emitOrchestrationChanged(orchestrationId);
    } finally {
      this.orchestrationWakeLocks.delete(orchestrationId);
    }
  }

  /** Urgent notices do not consume the result cursor or replace the persisted wake condition. */
  private async notifyRunningOrchestrationCoordinator(orchestration: OrchestrationRecord): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(orchestration.coordinatorRunId);
    if (!active || active.cancelled || !this.acceptsLiveSteering(orchestration.coordinatorRunId, active.providerType)
      || this.orchestrationWakeLocks.has(orchestration.id)) return;
    const events = this.context.db.listOrchestrationEvents(orchestration.id);
    const attempted = new Set(events.filter((event) => event.type === "coordinator-notice")
      .flatMap((event) => Array.isArray(event.metadata.sequences) ? event.metadata.sequences : []));
    const urgent = events.filter((event) => event.sequence > orchestration.lastDeliveredSequence
      && event.type === "attention" && event.taskId && !attempted.has(event.sequence)).slice(0, 8);
    if (!urgent.length) return;
    this.orchestrationWakeLocks.add(orchestration.id);
    try {
      this.context.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "coordinator-notice",
        title: "Urgent child update", content: "Delivery attempted to the running coordinator.",
        metadata: { sequences: urgent.map((event) => event.sequence), phase: "attempted" } });
      await this.context.db.flushDurable();
      const prompt = wrapOrchestrationUpdate([
        "A child needs attention. Read the task for its current question or failure. Use buildwarden_tasks_respond to answer questions; shell approvals remain with the user.",
        ...urgent.map((event) => `Task ${event.taskId}: ${fenceChildOutput(truncateForCoordinator(event.content, 1_000))}`),
      ]);
      await this.requestWorkerSteer(active.worker, prompt, []);
      await this.services.runEvents.appendRunEvent(orchestration.coordinatorRunId, "log", "Child attention notice", prompt, { source: "orchestration", steered: true });
    } catch (error) {
      this.context.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "coordinator-notice-outcome",
        title: "Child update retained", content: "The coordinator will receive this update after its turn ends.",
        metadata: { error: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.orchestrationWakeLocks.delete(orchestration.id);
    }
  }

  private async executeIdempotentOrchestrationMutation<T>(
    orchestration: OrchestrationRecord,
    toolName: OrchestrationToolName,
    args: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
    if (requestId.length < 8) throw new OrchestrationToolError("invalid_arguments", "A stable requestId of at least 8 characters is required.");
    const requestHash = orchestrationRequestHash({ toolName, args });
    return this.withOrchestrationMutation(orchestration.id, async () => {
      const existing = this.context.db.getOrchestrationOperation(orchestration.id, requestId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new OrchestrationToolError("request_id_conflict", "This requestId was already used with a different payload.");
        }
        if (existing.status === "completed") {
          return JSON.parse(existing.responseJson || "null") as T;
        }
        if (existing.status === "failed") {
          throw new OrchestrationToolError(
            existing.errorCode === "operation_interrupted" ? "operation_interrupted" : "operation_failed_previously",
            existing.errorMessage || "The previous identical operation failed.",
          );
        }
        throw new OrchestrationToolError("operation_in_progress", "The identical operation is already running.");
      }
      this.context.db.createOrchestrationOperation({
        orchestrationId: orchestration.id,
        requestId,
        toolName,
        requestHash,
      });
      await this.context.db.flushDurable();
      try {
        const response = await operation();
        this.context.db.completeOrchestrationOperation(orchestration.id, requestId, "completed", response);
        await this.context.db.flushDurable();
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.db.completeOrchestrationOperation(orchestration.id, requestId, "failed", null, message, classifyOrchestrationToolError(error).code);
        await this.context.db.flushDurable();
        throw error;
      }
    });
  }

  private async executeOrchestrationTool(
    coordinatorRunId: string,
    toolCallId: string,
    toolName: OrchestrationToolName,
    args: Record<string, unknown>,
  ): Promise<RunToolResult> {
    if (!isOrchestrationToolName(toolName)) throw new OrchestrationToolError("invalid_arguments", `Unsupported orchestration tool: ${toolName}`);
    const coordinator = this.context.db.getRun(coordinatorRunId);
    if (!coordinator.delegationEnabled || coordinator.kind === "orchestration-task") {
      throw new OrchestrationToolError("not_authorized", "This worker is not authorized to use durable orchestration tools.");
    }
    if (!this.services.activeWorkers.runWorkers.has(coordinatorRunId)) {
      throw new OrchestrationToolError("coordinator_inactive", "This coordinator turn is no longer active.");
    }
    const existingOrchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (existingOrchestration) this.settleCoordinatorWaitDeliveries(existingOrchestration.id, { turnEnded: false });
    let response: unknown;
    if (toolName === "buildwarden_history_search" || toolName === "buildwarden_history_read") {
      response = readOrchestrationHistory(this.context.db, coordinator.projectId, toolName === "buildwarden_history_search" ? "search" : "read", args);
    } else if (toolName === "buildwarden_orchestration_get") {
      response = await this.buildOrchestrationCoordinatorView(coordinatorRunId);
    } else if (toolName === "buildwarden_tasks_list") {
      const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
      response = orchestration ? this.listCompactOrchestrationTasks(orchestration.id) : [];
    } else if (toolName === "buildwarden_tasks_read") {
      const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
      const results = this.context.db.listOrchestrationTaskResults(task.id).reverse();
      if (args.resultId !== undefined && !results.some((result) => result.id === args.resultId)) {
        throw new OrchestrationToolError("invalid_arguments", "Published result does not belong to this task.");
      }
      const messagesOffset = Number.isSafeInteger(args.messagesOffset) && Number(args.messagesOffset) >= 0 ? Number(args.messagesOffset) : 0;
      response = buildOrchestrationTaskRead({
        task,
        args,
        results,
        pendingQuestions: task.status === "waiting-input" && task.childRunId ? this.pendingChildQuestions(task.childRunId) : [],
        events: this.context.db.listOrchestrationTaskEvents(task.id, ORCHESTRATION_TASK_READ_MAX_EVENTS),
        messages: this.context.db.listOrchestrationTaskMessagesPage(task.id, messagesOffset, ORCHESTRATION_TASK_READ_MESSAGES_PAGE),
        childRun: task.childRunId ? await this.buildOrchestrationChildRunSummary(task.childRunId, args) : null,
        pendingWork: task.childRunId ? this.describeChildPendingWork(task) : null,
        maxSummaryChars: ORCHESTRATION_TASK_READ_MAX_SUMMARY_CHARS,
        maxPromptChars: ORCHESTRATION_TASK_READ_MAX_PROMPT_CHARS,
      }).response;
    } else if (toolName === "buildwarden_orchestration_wait") {
      response = await this.waitForOrchestrationTasks(coordinatorRunId, args, toolCallId);
    } else {
      const orchestration = this.getOrCreateOrchestration(coordinator);
      response = await this.executeIdempotentOrchestrationMutation(orchestration, toolName, args, async () => {
        switch (toolName) {
          case "buildwarden_tasks_delegate":
            return this.delegateOrchestrationTasks(coordinator, args.tasks);
          case "buildwarden_tasks_send_message": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            const delivery = (args.delivery ?? "auto") as OrchestrationMessageDelivery;
            if (!["auto", "queue", "steer", "restart"].includes(delivery)) throw new OrchestrationToolError("invalid_arguments", "Invalid message delivery.");
            return this.queueOrchestrationTaskMessage({
              taskId: task.id,
              content: String(args.content ?? ""),
            }, "coordinator", delivery);
          }
          case "buildwarden_tasks_respond": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            const inputRequestId = String(args.inputRequestId ?? "");
            const request = task.childRunId && this.services.activeWorkers.runWorkers.has(task.childRunId)
              ? this.pendingChildQuestions(task.childRunId).find((entry) => entry.inputRequestId === inputRequestId)
              : undefined;
            if (!task.childRunId || !request) {
              throw new OrchestrationToolError("question_not_pending", "That question is no longer pending. The user may have answered it.");
            }
            let answers: RunUserInputAnswers;
            try {
              answers = parseChildQuestionAnswers(args.answers, request.questions);
              validateUserInputAnswers(request.questions, answers);
            } catch (error) {
              throw new OrchestrationToolError("answer_invalid", error instanceof Error ? error.message : String(error));
            }
            await this.respondToRunUserInput(task.childRunId, inputRequestId, answers, "coordinator");
            return { taskId: task.id, answered: true };
          }
          case "buildwarden_tasks_cancel": {
            const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
            await this.cancelOrchestrationTasks(orchestration, taskIds);
            return { taskIds, cancelled: true };
          }
          case "buildwarden_orchestration_yield": {
            const mode = args.mode as OrchestrationWakeMode;
            if (!["all-terminal", "any-terminal", "attention", "adoption-decided"].includes(mode)) throw new OrchestrationToolError("invalid_arguments", "Invalid wake mode.");
            const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
            const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
            const unknownTaskId = taskIds.find((taskId) => !tasks.some((task) => task.id === taskId));
            if (unknownTaskId) throw new OrchestrationToolError("task_not_in_orchestration", `Task ${unknownTaskId} does not belong to this orchestration.`);
            const selected = taskIds.length > 0 ? tasks.filter((task) => taskIds.includes(task.id)) : tasks;
            if (mode === "adoption-decided" && !selected.some((task) => ORCHESTRATION_PENDING_ADOPTION_STATUSES.has(task.adoptionStatus))) {
              return { waiting: false, mode, taskIds, reason: "No selected task has changes waiting for a decision." };
            }
            const undelivered = this.undeliveredOrchestrationTaskIds(this.context.db.getOrchestration(orchestration.id));
            if (mode !== "adoption-decided" && selected.every((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) && !undelivered.has(task.id))) {
              // Parking here would wake at once, and a coordinator that yields again would loop.
              return {
                waiting: false,
                mode,
                taskIds,
                reason: "Every selected task already finished and you have its result. Continue instead of waiting.",
              };
            }
            this.context.db.updateOrchestration(orchestration.id, {
              status: "waiting",
              wakeMode: mode,
              wakeTaskIds: taskIds,
            });
            this.context.db.appendOrchestrationEvent({
              orchestrationId: orchestration.id,
              type: "yield",
              title: "Coordinator yielded",
              content: `Waiting for ${mode}.`,
              metadata: { mode, taskIds },
            });
            await this.context.db.flushDurable();
            this.emitOrchestrationChanged(orchestration.id);
            return { waiting: true, mode, taskIds };
          }
          case "buildwarden_adoption_propose": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            if (task.intent !== "implement" || task.status !== "completed") {
              throw new OrchestrationToolError("adoption_not_allowed", "Only a completed implementation task can be proposed for adoption.");
            }
            const preview = await this.getOrchestrationAdoptionPreview(task.id);
            this.context.db.updateOrchestrationTask(task.id, {
              adoptionStatus: preview.conflicts.length || preview.unsupportedPaths.length ? "conflict" : "proposed",
            });
            this.context.db.upsertOrchestrationAdoption({
              orchestrationId: orchestration.id,
              taskId: task.id,
              status: preview.conflicts.length || preview.unsupportedPaths.length ? "conflict" : "proposed",
              manifest: { ...this.context.db.getOrchestrationAdoption(task.id)?.manifest,
                changedFiles: preview.changedFiles, conflicts: preview.conflicts, unsupportedPaths: preview.unsupportedPaths },
            });
            this.context.db.appendOrchestrationEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              type: "adoption-proposed",
              title: "Changes proposed for adoption",
              content: `${preview.changedFiles.length} changed file${preview.changedFiles.length === 1 ? "" : "s"}.`,
            });
            this.emitOrchestrationChanged(orchestration.id, task.id);
            return preview;
          }
          case "buildwarden_orchestration_finish":
            await this.finishOrchestration(coordinatorRunId);
            return { finished: true };
          default:
            throw new OrchestrationToolError("invalid_arguments", `Unsupported mutating orchestration tool: ${toolName}`);
        }
      });
    }
    return {
      toolCallId,
      name: toolName,
      ok: true,
      content: JSON.stringify(response),
      metadata: { orchestration: true },
    };
  }

  private get orchestrationRuntimeActions(): OrchestrationRuntimeActions {
    return new OrchestrationRuntimeActions(this.context.db, (runId) => this.cancelRun(runId));
  }

  private async cancelOrchestrationTasks(orchestration: OrchestrationRecord, taskIds: string[], cancelCoordinator = false): Promise<void> {
    const tasks = [...new Set(taskIds)].map((taskId) => {
      const task = this.context.db.findOrchestrationTask(taskId);
      if (!task) throw new OrchestrationToolError("task_not_found", `Task ${taskId} does not exist.`);
      if (task.orchestrationId !== orchestration.id) {
        throw new OrchestrationToolError("task_not_in_orchestration", `Task ${taskId} does not belong to this orchestration.`);
      }
      return task;
    });
    await this.orchestrationRuntimeActions.cancel(tasks, cancelCoordinator ? orchestration.id : undefined);
    await this.maybeWakeOrchestrationCoordinator(orchestration.id);
    this.emitOrchestrationChanged(orchestration.id);
  }

  async pauseOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      this.context.db.updateOrchestration(orchestration.id, { status: "paused" });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "paused",
        title: "Scheduling paused",
        content: "Running child tasks may finish; queued tasks will not launch.",
      });
      await this.context.db.flushDurable();
      this.emitOrchestrationChanged(orchestration.id);
    });
  }

  async resumeOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      const current = this.context.db.getOrchestration(orchestration.id);
      const tasks = this.context.db.listOrchestrationTasks(current.id);
      // A coordinator stopped without a wake condition still has to hear how its tasks ended.
      const needsWakeCondition = current.status === "attention" && !current.wakeMode && tasks.length > 0 &&
        !this.services.activeWorkers.runWorkers.has(coordinatorRunId);
      const latestWave = needsWakeCondition ? this.context.db.listOrchestrationWaves(current.id).at(-1) : undefined;
      const wakeMode = needsWakeCondition ? "all-terminal" : current.wakeMode;
      this.context.db.updateOrchestration(current.id, {
        status: wakeMode ? "waiting" : "active",
        wakeMode,
        wakeTaskIds: needsWakeCondition ? tasks.filter((task) => task.waveId === latestWave?.id).map((task) => task.id) : current.wakeTaskIds,
        errorMessage: null,
      });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "resumed",
        title: "Scheduling resumed",
        content: "Eligible queued tasks can launch.",
      });
      await this.dispatchOrchestrationTasks(orchestration.id);
      await this.maybeWakeOrchestrationCoordinator(orchestration.id);
      this.emitOrchestrationChanged(orchestration.id);
    });
  }

  async cancelOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      closeCoordinatorWaitDeliveries(this.context.db, orchestration.id);
      const errors: unknown[] = [];
      try { await this.cancelOrchestrationTasks(
        orchestration,
        this.context.db.listOrchestrationTasks(orchestration.id)
          .filter((task) => !ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status))
          .map((task) => task.id),
        true,
      ); } catch (error) { errors.push(error); }
      try {
        if (this.services.activeWorkers.runWorkers.has(coordinatorRunId)) await this.services.activeWorkers.cancelRunWorker(coordinatorRunId);
      } catch (error) { errors.push(error); }
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "cancelled",
        title: "Orchestration cancelled",
        content: errors.length ? "Cancellation requested; some workers could not be cancelled." : "All pending and running tasks were cancelled.",
      });
      await this.context.db.flushDurable();
      this.emitOrchestrationChanged(orchestration.id);
      if (errors.length) throw new AggregateError(errors, `Orchestration cancellation failed: ${errors.map(String).join("; ")}`);
    });
  }

  async finishOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
    if (tasks.some((task) => !ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status))) {
      throw new Error("The orchestration cannot finish while tasks are still pending or running.");
    }
    if (tasks.some((task) => task.adoptionStatus === "applying")) {
      throw new Error("The orchestration cannot finish while adoption is applying.");
    }
    // A finished orchestration must not show native work as still running.
    for (const task of tasks) if (task.childRunId) this.closeAbandonedChildSubagents(task.childRunId);
    // Its own turn may have just received a wait's result; nothing reads that news afterwards.
    this.settleCoordinatorWaitDeliveries(orchestration.id, { turnEnded: false });
    closeCoordinatorWaitDeliveries(this.context.db, orchestration.id);
    this.context.db.updateOrchestration(orchestration.id, {
      status: "completed",
      wakeMode: null,
      wakeTaskIds: [],
      finishedAt: new Date().toISOString(),
    });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "completed",
      title: "Orchestration completed",
      content: `Completed with ${tasks.length} durable task${tasks.length === 1 ? "" : "s"}.`,
    });
    this.emitOrchestrationChanged(orchestration.id);
  }

  async sendOrchestrationTaskMessage(input: OrchestrationTaskMessageInput): Promise<void> {
    const { orchestrationId } = this.context.db.getOrchestrationTask(input.taskId);
    await this.withOrchestrationMutation(orchestrationId, async () => {
      try {
        await this.queueOrchestrationTaskMessage(input, "user");
      } finally {
        await this.maybeWakeOrchestrationCoordinator(orchestrationId);
      }
    });
  }

  /** Runs inside the orchestration's mutation lock, so two senders cannot deliver one message twice. */
  private async queueOrchestrationTaskMessage(
    input: OrchestrationTaskMessageInput,
    source: OrchestrationTaskMessageRecord["source"],
    delivery: OrchestrationMessageDelivery = "auto",
  ) {
    const task = this.context.db.getOrchestrationTask(input.taskId);
    const content = input.content.trim();
    if (!content) throw new Error("Enter a message for the child task.");
    if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
      throw new Error("Create a new task for follow-up work after adoption, or undo adoption first.");
    }
    const orchestration = this.context.db.getOrchestration(task.orchestrationId);
    if (["deleting", "deletion-failed", "completed", "cancelled"].includes(orchestration.status)) {
      throw new Error(`Messages cannot be sent while the orchestration is ${orchestration.status}.`);
    }
    const active = task.childRunId ? this.services.activeWorkers.runWorkers.get(task.childRunId) : undefined;
    const runningWorker = active && !active.cancelled ? active : undefined;
    const steerable = Boolean(runningWorker) && task.status === "running" && this.acceptsLiveSteering(task.childRunId, runningWorker?.providerType);
    if (delivery === "steer" && !steerable) {
      throw new OrchestrationToolError("delivery_unavailable", "This child cannot take a message mid-turn. Use queue, or restart to interrupt it.");
    }
    if (delivery === "restart" && !runningWorker) {
      throw new OrchestrationToolError("delivery_unavailable", "This child has no running turn to restart.");
    }
    // Integrations without live steering but with a resumable session reach a running turn by
    // interrupting it and continuing the session with the message, instead of waiting it out.
    const runningProviderType = runningWorker?.providerType;
    const restartsOnAuto = delivery === "auto" && !steerable && runningProviderType !== undefined && task.status === "running" &&
      effectiveHarnessCapabilities(runningProviderType, this.services.providerRuntime.runSessionCapabilities.get(task.childRunId ?? "")).steeringFallback === "restart";
    const effectiveDelivery: OrchestrationMessageDelivery = restartsOnAuto ? "restart" : delivery;
    const message = this.context.db.createOrchestrationTaskMessage({
      orchestrationId: orchestration.id,
      taskId: task.id,
      source,
      content,
    });
    await this.context.db.flushDurable();
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: "message",
      title: "Message queued",
      content,
    });
    const outcome = await this.deliverOrchestrationTaskMessage(task, message, effectiveDelivery, steerable);
    this.emitOrchestrationChanged(orchestration.id, task.id);
    return { taskId: task.id, ...outcome };
  }

  private async deliverOrchestrationTaskMessage(
    task: OrchestrationTaskRecord,
    message: OrchestrationTaskMessageRecord,
    delivery: OrchestrationMessageDelivery,
    steerable: boolean,
  ) {
    if (ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status)) {
      if (await this.deliverQueuedOrchestrationMessages(task)) return { queued: false, delivery: "started" };
      if (this.context.db.listOrchestrationTaskMessages(task.orchestrationId).some((entry) => entry.id === message.id && entry.status === "failed")) {
        throw new Error(this.context.db.getOrchestrationTask(task.id).attentionReason ?? "The message could not be delivered.");
      }
      return { queued: true, delivery: "queued" };
    }
    if (delivery === "restart") {
      // The child's terminal handler picks up the queued message and continues it.
      await this.services.activeWorkers.cancelRunWorker(task.childRunId ?? "");
      return { queued: true, delivery: "restarting" };
    }
    if (delivery !== "queue" && steerable) {
      try {
        await this.steerOrchestrationChild(task, message);
        return { queued: false, delivery: "steered" };
      } catch (error) {
        if (isSteerOutcomeUnknownError(error)) {
          // Resending could reach the child twice, so this one is settled either way.
          this.context.db.updateOrchestrationTaskMessage(message.id, "unconfirmed");
          await this.context.db.flushDurable();
          return {
            queued: false,
            delivery: "unconfirmed",
            note: "The running turn did not confirm this message. It may have arrived, so check the child before resending.",
          };
        }
        if (delivery === "steer") {
          this.context.db.updateOrchestrationTaskMessage(message.id, "failed");
          throw error;
        }
        this.context.db.updateOrchestrationTaskMessage(message.id, "queued");
      }
    }
    if (task.status === "waiting-input") {
      const blockedOnQuestion = task.childRunId ? this.pendingChildQuestions(task.childRunId).length > 0 : false;
      return {
        queued: true,
        delivery: "queued",
        note: blockedOnQuestion
          ? "The child is blocked on a question and gets this message only after it stops. Use buildwarden_tasks_respond to answer it."
          : "The child is waiting for the user to approve a command and gets this message only after it stops.",
      };
    }
    return { queued: true, delivery: "queued" };
  }

  private async steerOrchestrationChild(task: OrchestrationTaskRecord, message: OrchestrationTaskMessageRecord): Promise<void> {
    const childRunId = task.childRunId ?? "";
    const active = this.services.activeWorkers.runWorkers.get(childRunId);
    if (!active) throw new Error("The child's turn has ended.");
    await this.orchestrationRuntimeActions.steer(task, message, () => this.requestWorkerSteer(active.worker, formatChildTaskMessages([message]), []));
    const content = childTaskMessagesDisplayText([message]);
    const metadata = {
      source: "user",
      commandType: "steer",
      steered: true,
      orchestrationTaskId: task.id,
      orchestrationMessageIds: [message.id],
      orchestrationMessageSources: [message.source],
    };
    try {
      const step = await this.services.runEvents.appendRunEvent(childRunId, "log", "Follow-up command", content, metadata);
      this.services.runEvents.emitEvent({ runId: childRunId, type: "log", title: step.title, content, metadata, createdAt: step.createdAt, step });
    } catch (error) {
      // Delivery is already durable. A missing display log must never cause a duplicate send.
      this.context.logControllerWarn("Could not append the delivered steering message to the timeline.", { childRunId, messageId: message.id, error });
    }
  }

  async retryOrchestrationTask(taskId: string): Promise<OrchestrationTaskRecord> {
    const { orchestrationId } = this.context.db.getOrchestrationTask(taskId);
    // Another dispatch could otherwise read the same pending task and start it a second time.
    return this.withOrchestrationMutation(orchestrationId, async () => {
      const source = this.context.db.getOrchestrationTask(taskId);
      if (!ORCHESTRATION_TERMINAL_TASK_STATUSES.has(source.status)) {
        throw new Error("Only a terminal task can be retried.");
      }
      const orchestration = this.context.db.getOrchestration(source.orchestrationId);
      if (!ORCHESTRATION_CANCELLABLE_STATUSES.has(orchestration.status)) {
        throw new Error(`Tasks cannot be retried while the orchestration is ${orchestration.status}.`);
      }
      const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
      if (tasks.length >= orchestration.teamSnapshot.maxTasksPerOrchestration) {
        throw new Error("The orchestration task cap has been reached.");
      }
      const replacement = this.context.db.createOrchestrationTask({
        orchestrationId: orchestration.id,
        waveId: source.waveId,
        clientTaskId: `${source.clientTaskId}-retry-${tasks.filter((task) => task.retryOfTaskId === source.id).length + 1}`,
        title: `${source.title} (retry)`,
        prompt: source.prompt,
        roleId: source.roleId,
        modelId: source.modelId,
        intent: source.intent,
        permissionMode: source.permissionMode,
        retryOfTaskId: source.id,
      });
      this.context.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        taskId: replacement.id,
        type: "task-retried",
        title: replacement.title,
        content: `Retry of ${source.id}.`,
      });
      await this.dispatchOrchestrationTasks(orchestration.id);
      return this.context.db.getOrchestrationTask(replacement.id);
    });
  }

  private recordOrchestrationAdoptionConflict(task: OrchestrationTaskRecord, reason: string): void {
    this.context.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "adoption-conflict",
      title: "Adoption blocked",
      content: `Task "${task.title}" could not be adopted: ${reason}`,
    });
  }

  async decideOrchestrationAdoption(input: OrchestrationAdoptionDecisionInput): Promise<void> {
    const source = this.context.db.getOrchestrationTask(input.taskId);
    await this.withOrchestrationMutation(source.orchestrationId, async () => {
      try {
        await this.applyOrchestrationAdoptionDecision(input, source.orchestrationId);
      } finally {
        // A coordinator waiting on this decision hears about it, whichever way it went.
        await this.maybeWakeOrchestrationCoordinator(source.orchestrationId);
      }
    });
  }

  private async applyOrchestrationAdoptionDecision(input: OrchestrationAdoptionDecisionInput, orchestrationId: string): Promise<void> {
    const task = this.context.db.getOrchestrationTask(input.taskId);
    if (task.orchestrationId !== orchestrationId) {
      throw new Error("The task no longer belongs to the expected orchestration.");
    }
    const orchestration = this.context.db.getOrchestration(task.orchestrationId);
    const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
    const wave = this.context.db.getOrchestrationWave(task.waveId);
    const adoption = this.context.db.getOrchestrationAdoption(task.id);
    const result = this.context.db.listOrchestrationTaskResults(task.id).at(-1);
    if (input.decision === "approve" && input.resultId !== result?.id) {
      throw new Error("The published result changed. Refresh the adoption preview before approving.");
    }
    if (input.decision === "reject") {
      if (task.adoptionStatus === "rejected") return;
      if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
        throw new Error(`Changes cannot be rejected while adoption is ${task.adoptionStatus}.`);
      }
      this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "rejected" });
      this.context.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "rejected",
        // Only an explicit rejection abandons an unresolved interrupted adoption.
        manifest: { ...adoption?.manifest, recoveryNeedsReview: false } });
    } else if (input.decision === "undo") {
      if (!adoption?.backupPath || task.adoptionStatus !== "adopted") throw new Error("No adopted change is available to undo.");
      await undoOrchestrationDelta({ backupPath: adoption.backupPath, targetPath: coordinator.worktreePath });
      this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "undone" });
      this.context.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "undone" });
    } else {
      if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
        throw new Error(`Changes cannot be adopted while adoption is ${task.adoptionStatus}.`);
      }
      if (!task.childRunId || !wave.baselinePath || task.status !== "completed" || task.intent !== "implement") {
        throw new Error("Only completed implementation tasks with a valid baseline can be adopted.");
      }
      const preview = await this.getOrchestrationAdoptionPreview(task.id);
      if (preview.conflicts.length || preview.unsupportedPaths.length) {
        this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
        this.context.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "conflict",
          manifest: { ...adoption?.manifest, conflicts: preview.conflicts, unsupportedPaths: preview.unsupportedPaths },
        });
        const blocked = [...preview.conflicts, ...preview.unsupportedPaths].join(", ");
        this.recordOrchestrationAdoptionConflict(task, blocked);
        throw new Error(`Adoption is blocked: ${blocked}`);
      }
      const child = this.context.db.getRun(task.childRunId);
      const backupPath = join(this.getOrchestrationArtifactRoot(), orchestration.id, "adoptions", task.id, "backup");
      this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "applying" });
      this.context.db.upsertOrchestrationAdoption({
        orchestrationId: orchestration.id,
        taskId: task.id,
        status: "applying",
        backupPath,
        manifest: { changedFiles: preview.changedFiles, resultId: result?.id ?? null },
      });
      await this.context.db.flushDurable();
      try {
        await applyOrchestrationDelta({
          baselinePath: wave.baselinePath,
          childPath: child.worktreePath,
          targetPath: coordinator.worktreePath,
          backupPath,
          childSnapshotPath: result?.workspaceSnapshotPath,
        });
        this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "adopted" });
        this.context.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "adopted",
          backupPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
        this.context.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "conflict",
          backupPath,
          errorMessage: message,
        });
        this.recordOrchestrationAdoptionConflict(task, message);
        throw error;
      }
    }
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: `adoption-${input.decision}`,
      title: `Adoption ${input.decision}`,
      content: `Task "${task.title}" adoption decision: ${input.decision}.`,
    });
    await this.context.db.flushDurable();
    this.emitOrchestrationChanged(orchestration.id, task.id);
  }

  async refreshOrchestrationTeam(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
    if (tasks.some((task) => ORCHESTRATION_ACTIVE_TASK_STATUSES.has(task.status) || task.status === "pending")) {
      throw new Error("The frozen team can be refreshed only when no tasks are pending or running.");
    }
    const team = this.resolveOrchestrationTeamSettings();
    if (team.roles.length === 0) throw new Error("Configure at least one valid orchestration role.");
    this.context.db.updateOrchestration(orchestration.id, { teamSnapshot: team });
    this.context.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "team-refreshed",
      title: "Team configuration refreshed",
      content: `The frozen team now contains ${team.roles.length} role${team.roles.length === 1 ? "" : "s"}.`,
    });
    this.emitOrchestrationChanged(orchestration.id);
  }

  async getRunDeletionImpact(runId: string): Promise<RunDeletionImpact> {
    this.context.db.getRun(runId);
    const childTask = this.context.db.getOrchestrationTaskByChildRunId(runId);
    const orchestration = childTask
      ? this.context.db.getOrchestration(childTask.orchestrationId)
      : this.context.db.getOrchestrationByCoordinatorRunId(runId);
    const coordinatorRunId = orchestration?.coordinatorRunId ?? runId;
    const childRunIds = orchestration
      ? this.context.db.listOrchestrationTasks(orchestration.id).flatMap((task) => task.childRunId ? [task.childRunId] : [])
      : [];
    const runIds = [...new Set([coordinatorRunId, ...childRunIds])];
    const runs = runIds.flatMap((id) => {
      try { return [this.context.db.getRun(id)]; } catch { return []; }
    });
    const ownedDirectories = runs
      .filter((entry) => entry.workspaceType === "worktree" || entry.workspaceType === "copy")
      .map((entry) => entry.worktreePath);
    const artifactPaths = orchestration
      ? [
          join(this.getOrchestrationArtifactRoot(), orchestration.id),
          ...this.context.db.listOrchestrationWaves(orchestration.id).flatMap((wave) => wave.baselinePath ? [wave.baselinePath] : []),
          ...this.context.db.listOrchestrationTasks(orchestration.id).flatMap((task) => {
            const adoption = this.context.db.getOrchestrationAdoption(task.id);
            return adoption?.backupPath ? [adoption.backupPath] : [];
          }),
        ]
      : [];
    return {
      runId,
      coordinatorRunId,
      orchestrationId: orchestration?.id ?? null,
      runIds,
      runningRunIds: runIds.filter((id) => this.services.activeWorkers.runWorkers.has(id)),
      ownedDirectories,
      branches: runs.filter((entry) => entry.workspaceType === "worktree").map((entry) => entry.branchName),
      artifactPaths: [...new Set(artifactPaths)],
      lockedOrMissingPaths: [...ownedDirectories, ...artifactPaths].filter((path) => !existsSync(path)),
    };
  }

  private createDataRetentionCleanupPlan(dayCount: number, reviewedCutoffAt?: string): DataRetentionCleanupPlan {
    if (!Number.isInteger(dayCount) || dayCount < MIN_DATA_RETENTION_CLEANUP_DAYS || dayCount > MAX_DATA_RETENTION_CLEANUP_DAYS) {
      throw new Error(
        `Data-retention days must be a whole number from ${MIN_DATA_RETENTION_CLEANUP_DAYS} to ${MAX_DATA_RETENTION_CLEANUP_DAYS}.`,
      );
    }

    const nowMs = Date.now();
    const thresholdMs = dayCount * 24 * 60 * 60 * 1_000;
    const cutoffAt = reviewedCutoffAt ?? new Date(nowMs - thresholdMs).toISOString();
    const cutoffMs = Date.parse(cutoffAt);
    if (!Number.isFinite(cutoffMs) || cutoffMs > nowMs - thresholdMs + 5_000) {
      throw new Error("The reviewed data-retention cutoff is invalid.");
    }

    const projects = this.context.db.listProjects();
    const runs = projects.flatMap((project) => this.context.db.listRunsForProject(project.id));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const rootRunIdByRunId = new Map<string, string>();
    for (const run of runs) {
      let rootRunId = retentionRootRunId(run);
      const childTask = this.context.db.getOrchestrationTaskByChildRunId(run.id);
      if (childTask) {
        try {
          rootRunId = this.context.db.getOrchestration(childTask.orchestrationId).coordinatorRunId;
        } catch {
          rootRunId = run.id;
        }
      }
      rootRunIdByRunId.set(run.id, runsById.has(rootRunId) ? rootRunId : run.id);
    }

    const projectLabThreads = projects.flatMap((project) => this.context.db.listProjectLabThreads(project.id));
    const projectLoops = projects.flatMap((project) => this.context.db.listProjectLoops(project.id).map((loop) => ({
      loop,
      runIds: this.context.db.listProjectLoopIterations(loop.id).flatMap((iteration) => iteration.runId ? [iteration.runId] : []),
    })));
    return buildDataRetentionCleanupPlan({
      dayCount,
      cutoffAt,
      runs,
      chats: this.context.db.listAllChats(),
      bookmarks: this.context.db.listBookmarks(),
      chatBookmarks: this.context.db.listChatBookmarks(),
      projectLabThreads,
      projectLoops,
      rootRunIdByRunId,
    });
  }

  async getDataRetentionCleanupImpact(dayCount: number): Promise<DataRetentionCleanupImpact> {
    const plan = this.createDataRetentionCleanupPlan(dayCount);
    return {
      dayCount: plan.dayCount,
      cutoffAt: plan.cutoffAt,
      runIds: plan.runIds,
      chatIds: plan.chatIds,
      projectLabThreadIds: plan.projectLabThreadIds,
      projectLoopIds: plan.projectLoopIds,
      runCount: plan.runCount,
      chatCount: plan.chatCount,
      projectLabThreadCount: plan.projectLabThreadCount,
      projectLoopCount: plan.projectLoopCount,
    };
  }

  async deleteDataRetentionCandidates(dayCount: number, cutoffAt: string): Promise<DataRetentionCleanupImpact> {
    const plan = this.createDataRetentionCleanupPlan(dayCount, cutoffAt);
    const { deletionRootRunIds, ...impact } = plan;
    const previousSelection = this.context.db.getSettings();

    try {
      for (const threadId of plan.projectLabThreadIds) {
        try {
          this.context.db.getProjectLabThread(threadId);
        } catch {
          continue;
        }
        await this.deleteProjectLabThread(threadId);
      }
      for (const loopId of plan.projectLoopIds) {
        try {
          this.context.db.getProjectLoop(loopId);
        } catch {
          continue;
        }
        await this.loopRunner.deleteLoop(loopId);
      }
      for (const runId of deletionRootRunIds) {
        try {
          this.context.db.getRun(runId);
        } catch {
          continue;
        }
        await this.deleteRun(runId);
      }
      for (const chatId of plan.chatIds) {
        try {
          this.context.db.getChat(chatId);
        } catch {
          continue;
        }
        await this.deleteChat(chatId);
      }

      const remainingRunIds = plan.runIds.filter((runId) => {
        try {
          this.context.db.getRun(runId);
          return true;
        } catch {
          return false;
        }
      });
      const remainingChatIds = plan.chatIds.filter((chatId) => {
        try {
          this.context.db.getChat(chatId);
          return true;
        } catch {
          return false;
        }
      });
      if (remainingRunIds.length > 0 || remainingChatIds.length > 0) {
        throw new Error("Some old run or chat data could not be deleted. Retry on the next startup.");
      }
      return impact;
    } finally {
      this.services.appState.restoreSelectionAfterDeletion(previousSelection);
    }
  }

  async deleteRun(runId: string, options: { preserveBranch?: boolean } = {}): Promise<void> {
    this.services.titles.sessionTitleServiceInstance?.cancel("run", runId);
    const run = this.context.db.getRun(runId);
    if (run.kind === "council-review") throw new Error("Validation reviews are removed with the run they belong to.");
    const ownedTask = this.context.db.getOrchestrationTaskByChildRunId(runId);
    if (ownedTask) {
      let owner: OrchestrationRecord | null = null;
      try {
        owner = this.context.db.getOrchestration(ownedTask.orchestrationId);
      } catch {
        /* Treat an orphaned task reference as stale and delete the surviving run normally. */
      }
      if (owner) {
        throw new Error(`This run is owned by an orchestration. Delete coordinator run ${owner.coordinatorRunId} instead.`);
      }
    }
    await this.deleteCouncilChildren(run);
    const orchestration = this.context.db.getOrchestrationByCoordinatorRunId(runId);
    if (orchestration) {
      await this.deleteOrchestrationCascade(run, orchestration);
      return;
    }
    const project = this.context.db.getProject(run.projectId);

    this.context.terminal.killForRunId(runId);
    this.services.turnState.clearRunCheckpoint(runId);
    this.services.turnState.clearRunPromptRestorePoint(runId);
    this.context.db.deleteProviderSessionRuntime(runId, "run");
    for (const runChat of this.context.db.getChatsForRun(runId)) {
      const activeChat = this.services.activeWorkers.chatWorkers.get(runChat.id);
      if (activeChat) {
        activeChat.cancelled = true;
        const stopped = stopWorkerAfterCleanup(activeChat.worker, () => activeChat.worker.postMessage({ type: "cancel" }));
        this.services.activeWorkers.chatWorkers.delete(runChat.id);
        this.chatUserInputRequests.delete(runChat.id);
        this.context.db.closeChatUserInputRequests(runChat.id);
        await stopped;
      }
      this.context.db.deleteProviderSessionRuntime(runChat.id, "chat");
      await this.removeChatWorkspaceBestEffort(runChat.id);
    }
    await this.deleteRunResources(project.repoPath, run, "run", options);
    this.context.db.deleteRun(runId);
    this.services.processes.ownedProcessRegistryInstance?.forgetOwner({ kind: "run", id: runId });
    this.notifyRunDeleted(runId);
    this.context.db.deleteSetting(SELECTED_RUN_KEY);
    this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
  }

  isCouncilReviewRun(runId: string): boolean {
    try {
      return this.context.db.getRun(runId).kind === "council-review";
    } catch {
      return false;
    }
  }

  private async deleteCouncilChildren(run: RunRecord): Promise<void> {
    await this.getCouncilService().stopForRun(run.id);
    for (const childRunId of this.context.db.listCouncilChildRunIds(run.id)) await this.deleteCouncilChildRun(childRunId);
  }

  async deleteCouncilChildRun(childRunId: string): Promise<void> {
    await this.services.processes.stopRunOwnedProcesses(childRunId);
    await this.releaseCouncilChildWorkspace(this.context.db.getRun(childRunId));
    this.context.db.deleteProviderSessionRuntime(childRunId, "run");
    this.context.db.deleteRun(childRunId);
  }

  private async deleteOrchestrationCascade(
    coordinator: RunRecord,
    orchestration: OrchestrationRecord,
    existingManifest?: Record<string, unknown>,
    existingJobId?: string,
  ): Promise<void> {
    const impact = existingManifest
      ? existingManifest as unknown as RunDeletionImpact
      : await this.getRunDeletionImpact(coordinator.id);
    const jobId = existingJobId ?? this.context.db.createOrchestrationCleanupJob({
      coordinatorRunId: coordinator.id,
      orchestrationId: orchestration.id,
      manifest: impact as unknown as Record<string, unknown>,
    });
    this.context.db.updateOrchestration(orchestration.id, { status: "deleting", errorMessage: null });
    this.context.db.updateOrchestrationCleanupJob(jobId, "running");
    await this.context.db.flushDurable();

    const project = this.context.db.getProject(coordinator.projectId);
    const runIds = Array.isArray(impact.runIds) ? impact.runIds : [coordinator.id];
    const childIds = runIds.filter((id) => id !== coordinator.id);
    const orderedRunIds = [...childIds, coordinator.id];
    try {
      for (const id of orderedRunIds) {
        await this.services.processes.stopRunOwnedProcesses(id);
      }
      for (const id of orderedRunIds) {
        let ownedRun: RunRecord;
        try {
          ownedRun = this.context.db.getRun(id);
        } catch {
          continue;
        }
        this.services.turnState.clearRunCheckpoint(id);
        this.services.turnState.clearRunPromptRestorePoint(id);
        this.context.db.deleteProviderSessionRuntime(id, "run");
        for (const runChat of this.context.db.getChatsForRun(id)) {
          this.context.db.deleteProviderSessionRuntime(runChat.id, "chat");
          await this.removeChatWorkspaceBestEffort(runChat.id);
        }
        await this.deleteRunResources(project.repoPath, ownedRun, "run");
        if (
          (ownedRun.workspaceType === "worktree" || ownedRun.workspaceType === "copy") &&
          existsSync(ownedRun.worktreePath)
        ) {
          throw new Error(`A locked app-owned workspace directory remains: ${ownedRun.worktreePath}`);
        }
      }

      const artifactRoot = this.getOrchestrationArtifactRoot();
      const orchestrationArtifactPath = join(artifactRoot, orchestration.id);
      if (existsSync(orchestrationArtifactPath)) {
        await removeOwnedOrchestrationArtifact(artifactRoot, orchestrationArtifactPath);
      }
      if (existsSync(orchestrationArtifactPath)) {
        throw new Error(`An app-owned orchestration artifact directory remains: ${orchestrationArtifactPath}`);
      }

      this.context.db.deleteBookmarksForRunIds(runIds);
      this.context.db.deleteChatBookmarksForRunIds(runIds);
      for (const id of childIds) {
        try {
          this.context.db.deleteRun(id);
        } catch {
          /* An earlier cleanup retry may already have removed this row. */
        }
      }
      this.context.db.deleteRun(coordinator.id);
      // Keep the orchestration journal until every owned run row is gone. A
      // startup retry can then distinguish "filesystem cleanup completed"
      // from an interruption that still requires owned-resource removal.
      this.context.db.deleteOrchestrationData(orchestration.id);
      await this.context.db.flushDurable();
      this.context.db.completeOrchestrationCleanupJob(jobId);
      for (const id of runIds) this.notifyRunDeleted(id);
      this.context.db.deleteSetting(SELECTED_RUN_KEY);
      this.context.db.setSetting(SELECTED_PROJECT_KEY, project.id);
      this.context.events.publish("orchestration", {
        projectId: project.id,
        coordinatorRunId: coordinator.id,
        orchestrationId: orchestration.id,
        status: "completed",
        sequence: orchestration.lastEventSequence + 1,
        deletedRunIds: runIds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.db.updateOrchestrationCleanupJob(jobId, "failed", message);
      try {
        this.context.db.updateOrchestration(orchestration.id, { status: "deletion-failed", errorMessage: message });
        this.context.db.appendOrchestrationEvent({
          orchestrationId: orchestration.id,
          type: "deletion-failed",
          title: "Deletion cleanup failed",
          content: message,
        });
        this.emitOrchestrationChanged(orchestration.id);
      } catch {
        /* The metadata may already be gone after an externally interrupted final flush. */
      }
      await this.context.db.flushDurable();
      throw new Error(`Orchestration deletion is incomplete and can be retried. ${message}`);
    }
  }

  async reconcileOrchestrationsAfterRestart(): Promise<void> {
    // Keep interrupted receipts: a provider side effect may already have happened.
    this.context.db.recoverInterruptedOrchestrationOperations();
    this.context.db.recoverOrchestrationMessageDeliveries();
    await this.orchestrationRuntimeActions.recover();
    await this.context.db.flushDurable();

    const reconcileCleanupJob = async (
      job: ReturnType<BuildWardenDatabase["listPendingOrchestrationCleanupJobs"]>[number],
    ): Promise<void> => {
      try {
        let coordinator: RunRecord | null = null;
        let orchestration: OrchestrationRecord | null = null;
        try {
          coordinator = this.context.db.getRun(job.coordinatorRunId);
        } catch {
          coordinator = null;
        }
        try {
          orchestration = job.orchestrationId ? this.context.db.getOrchestration(job.orchestrationId) : null;
        } catch {
          orchestration = null;
        }
        if (coordinator && orchestration) {
          await this.deleteOrchestrationCascade(coordinator, orchestration, job.manifest, job.id);
        } else {
          await this.completeFinalizedOrchestrationCleanupJob(job);
        }
      } catch (error) {
        this.context.logControllerWarn("Durable orchestration cleanup remains retryable after startup.", {
          coordinatorRunId: job.coordinatorRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    for (const job of this.context.db.listPendingOrchestrationCleanupJobs()) {
      await reconcileCleanupJob(job);
    }

    const active = this.context.db.listOrchestrationsWithStatuses(["active", "waiting", "paused", "attention"]);
    // A workspace a failed launch could not remove stays recorded until it is gone, even after its
    // orchestration ended. Active orchestrations resume their effects below.
    const activeIds = new Set(active.map((orchestration) => orchestration.id));
    for (const effect of this.context.db.listPendingOrchestrationEffects({ kind: "launch-child" })) {
      if (activeIds.has(effect.orchestrationId)) continue;
      try {
        await this.resumeChildLaunch(effect);
      } catch (error) {
        this.context.logControllerWarn("Could not retry removing a failed child launch's workspace.", { effectId: effect.id, error });
      }
    }
    await this.context.db.flushDurable();
    const reconcileActiveOrchestration = async (initial: OrchestrationRecord): Promise<void> => {
      // Finish or roll back interrupted effects first, so the checks below see their outcome.
      await this.resumePendingOrchestrationEffects(initial.id);
      const orchestration = this.context.db.getOrchestration(initial.id);
      const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
      let adoptionRecoveryFailed = false;
      for (const task of this.context.db.listOrchestrationTasks(orchestration.id).filter((entry) => entry.adoptionStatus === "applying")) {
        try {
          const adoption = this.context.db.getOrchestrationAdoption(task.id);
          if (!adoption?.backupPath) throw new Error("The interrupted adoption backup is unavailable.");
          await recoverOrchestrationAdoption({ backupPath: adoption.backupPath, targetPath: coordinator.worktreePath });
          this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
          this.context.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "conflict" });
          this.context.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id,
            type: "adoption-recovered", title: "Interrupted adoption rolled back",
            content: "The saved before/after hashes matched. Review the result again before adopting." });
          await this.context.db.flushDurable();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          adoptionRecoveryFailed = true;
          // Startup has no apply in flight. Release the stale applying state,
          // preserve its backup, and let the user reject it without rewriting files.
          const adoption = this.context.db.getOrchestrationAdoption(task.id);
          this.context.db.updateOrchestration(orchestration.id, { status: "attention", errorMessage: reason });
          this.context.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict", attentionReason: reason });
          this.context.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "conflict",
            manifest: { ...adoption?.manifest, recoveryNeedsReview: true }, errorMessage: reason });
          this.context.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "attention",
            title: "Interrupted adoption needs review", content: `${reason} Inspect the coordinator workspace, then reject the interrupted adoption to abandon it.` });
          await this.context.db.flushDurable();
          this.emitOrchestrationChanged(orchestration.id, task.id);
        }
      }
      if (
        !adoptionRecoveryFailed &&
        orchestration.status === "active" &&
        coordinator.status === "cancelled" &&
        coordinator.errorMessage === SESSION_INTERRUPTED_MESSAGE
      ) {
        const steps = this.context.db.getRunSteps(coordinator.id);
        const elevated = latestUserTurnUsedFullAccess(steps);
        const awaitingApproval = steps.some((step) => {
          try {
            const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
            return metadata.requestKind === "approval" && metadata.requestStatus === "opened";
          } catch {
            return false;
          }
        });
        try {
          if (!existsSync(coordinator.worktreePath)) throw new Error("The coordinator workspace is missing.");
          if (coordinator.pendingUserInputRequest) throw new Error("The coordinator was awaiting user input.");
          if (awaitingApproval) throw new Error("The coordinator was awaiting an approval.");
          if (elevated) throw new Error("The coordinator used elevated permissions and requires explicit recovery.");
          await this.recoverInterruptedRun(coordinator.id);
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "coordinator-recovered",
            title: "Coordinator resumed after restart",
            content: "The saved provider session or checkpoint was valid and resumed without changing providers.",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.context.db.updateOrchestration(orchestration.id, { status: "attention", errorMessage: message });
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "attention",
            title: "Coordinator recovery needs attention",
            content: message,
          });
        }
      } else if (!adoptionRecoveryFailed && orchestration.status === "active" && coordinator.status === "completed") {
        const currentTasks = this.context.db.listOrchestrationTasks(orchestration.id);
        if (currentTasks.length > 0 && !orchestration.wakeMode) {
          const latestWave = this.context.db.listOrchestrationWaves(orchestration.id).at(-1);
          const wakeTaskIds = latestWave
            ? currentTasks.filter((task) => task.waveId === latestWave.id).map((task) => task.id)
            : [];
          this.context.db.updateOrchestration(orchestration.id, {
            status: "waiting",
            wakeMode: "all-terminal",
            wakeTaskIds,
          });
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "yield",
            title: "Default wake condition recovered",
            content: "BuildWarden restored the current-wave wake condition after restart.",
            metadata: { mode: "all-terminal", taskIds: wakeTaskIds, implicit: true, recovered: true },
          });
        }
      }
      const tasks = this.context.db.listOrchestrationTasks(orchestration.id);
      const reconcileTask = async (task: OrchestrationTaskRecord): Promise<void> => {
        if (!["provisioning", "queued", "running", "waiting-input"].includes(task.status)) return;
        if (!task.childRunId) {
          this.context.db.updateOrchestrationTask(task.id, {
            status: "pending",
            attentionReason: null,
            errorMessage: null,
          });
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            type: "requeued",
            title: "Provisioning resumed",
            content: "The persisted task intent had not created a child run, so it was safely requeued.",
          });
          return;
        }
        if (adoptionRecoveryFailed) {
          this.blockOrchestrationTask(task, "Child recovery needs attention", "Review the interrupted adoption before resuming this child.");
          return;
        }
        const stoppedChild = this.context.db.getRun(task.childRunId);
        if (isSettledChildRun(stoppedChild)) {
          // The child finished, but the app stopped before its result was recorded.
          await this.settleOrchestrationChildTerminal(task, stoppedChild, { deliverQueued: false });
          return;
        }
        try {
          const child = this.context.db.getRun(task.childRunId);
          const checkpoint = this.services.turnState.getRunCheckpoint(child.id);
          const model = this.context.db.getModel(child.modelId);
          const provider = this.context.db.getProviderAccount(model.providerAccountId);
          const providerRuntime = this.services.turnState.resolveRunNativeSession(child, provider).session;
          const steps = this.context.db.getRunSteps(child.id);
          const coordinatorSteps = this.context.db.getRunSteps(orchestration.coordinatorRunId);
          const elevated = task.permissionMode !== "supervised" && resolveOrchestrationChildFullAccess(task.intent, steps, coordinatorSteps);
          const awaitingApproval = steps.some((step) => {
            try {
              const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
              return metadata.requestKind === "approval" && metadata.requestStatus === "opened";
            } catch {
              return false;
            }
          });
          const hasAgentActivity = steps.some((step) => AGENT_ACTIVITY_EVENT_TYPES.has(step.eventType));
          let unsafeReason: string | null = null;
          if (!existsSync(child.worktreePath)) unsafeReason = "The isolated child workspace is missing.";
          else if (child.pendingUserInputRequest) unsafeReason = "The child was awaiting user input.";
          else if (awaitingApproval) unsafeReason = "The child was awaiting an approval.";
          else if (elevated) unsafeReason = "The child inherited elevated permissions and requires explicit recovery.";

          if (unsafeReason) {
            this.context.db.updateOrchestrationTask(task.id, { status: "blocked", attentionReason: unsafeReason });
            this.context.db.appendOrchestrationEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              type: "attention",
              title: "Child needs attention",
              content: unsafeReason,
            });
            return;
          }

          const canResume =
            providerSupportsInterruptedRunRecovery(provider.providerType) &&
            Boolean(checkpoint || providerRuntime?.resumeCursor);
          if (canResume) {
            await this.recoverInterruptedRun(child.id);
          } else if (!hasAgentActivity) {
            await this.restartOrchestrationChildFromBeginning(orchestration, task, child, provider, model);
          } else {
            throw new Error("The provider cursor or checkpoint is unavailable for an interrupted child with existing activity.");
          }
          this.context.db.updateOrchestrationTask(task.id, {
            status: "running",
            attentionReason: null,
            errorMessage: null,
            startedAt: task.startedAt ?? new Date().toISOString(),
          });
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            type: "recovered",
            title: "Child resumed",
            content: canResume
              ? "The saved provider session or checkpoint was resumed."
              : "The child had not begun provider work and was restarted from its durable prompt.",
          });
        } catch (error) {
          this.context.db.updateOrchestrationTask(task.id, {
            status: "blocked",
            attentionReason: error instanceof Error ? error.message : String(error),
          });
          this.context.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            type: "attention",
            title: "Child recovery blocked",
            content: error instanceof Error ? error.message : String(error),
          });
        }
      };
      for (const task of tasks) {
        await reconcileTask(task);
      }
      const reconciledOrchestration = this.context.db.getOrchestration(orchestration.id);
      if (reconciledOrchestration.status !== "paused" && reconciledOrchestration.status !== "attention") {
        await this.dispatchOrchestrationTasks(orchestration.id);
        await this.maybeWakeOrchestrationCoordinator(orchestration.id, { afterRestart: true });
      }
      this.emitOrchestrationChanged(orchestration.id);
    };
    for (const orchestration of active) {
      await reconcileActiveOrchestration(orchestration);
    }
  }

  private async completeFinalizedOrchestrationCleanupJob(job: {
    id: string;
    coordinatorRunId: string;
    orchestrationId: string | null;
    manifest: Record<string, unknown>;
  }): Promise<void> {
    const runIds = Array.isArray(job.manifest.runIds)
      ? job.manifest.runIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const ownedDirectories = Array.isArray(job.manifest.ownedDirectories)
      ? job.manifest.ownedDirectories.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const artifactPaths = Array.isArray(job.manifest.artifactPaths)
      ? job.manifest.artifactPaths.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const remainingPaths = [...ownedDirectories, ...artifactPaths].filter((path) => existsSync(path));
    if (remainingPaths.length > 0) {
      throw new Error(`Owned cleanup paths still exist: ${remainingPaths.join(", ")}`);
    }

    this.context.db.deleteBookmarksForRunIds(runIds);
    this.context.db.deleteChatBookmarksForRunIds(runIds);
    for (const runId of runIds) {
      try {
        this.context.db.deleteRun(runId);
      } catch {
        /* The durable cleanup may already have removed this run row. */
      }
    }
    if (job.orchestrationId) {
      try {
        this.context.db.deleteOrchestrationData(job.orchestrationId);
      } catch {
        /* The final database phase may already have removed orchestration rows. */
      }
    }
    await this.context.db.flushDurable();
    this.context.db.completeOrchestrationCleanupJob(job.id);
    for (const runId of runIds) this.notifyRunDeleted(runId);
  }

  private async restartOrchestrationChildFromBeginning(
    orchestration: OrchestrationRecord,
    task: OrchestrationTaskRecord,
    child: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
  ): Promise<void> {
    this.services.providerRuntime.requireProjectMcpSupported(child.projectId, provider);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new OrchestrationToolError("model_unavailable", `Credentials are unavailable for ${provider.label}.`);
    }
    const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
    const modelProfile = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId);
    const effort = role?.effortOverride ?? modelProfile?.defaultEffort;
    const coordinator = this.context.db.getRun(orchestration.coordinatorRunId);
    const childSteps = this.context.db.getRunSteps(child.id);
    const inheritedFullAccess = task.permissionMode !== "supervised" && resolveOrchestrationChildFullAccess(
      task.intent,
      childSteps,
      this.context.db.getRunSteps(coordinator.id),
    );
    const childExecutionOptions = this.services.turnState.getLatestRunExecutionOptions(child.id, provider) ??
      resolveProviderExecutionOptions(provider, {
        executionOptions: applyTaskExecutionOptions(
          mergeOrchestrationExecutionOptions(undefined, effort),
          this.context.db.getOrchestrationTaskExecutionOptions(task.id),
        ),
      });
    const prompt = [
      `You are the ${role?.name ?? task.roleId} child in a durable BuildWarden orchestration.`,
      role?.description?.trim() || "",
      "Work only in this isolated child workspace. Do not attempt to control the parent run or delegate durable tasks.",
      task.intent === "inspect"
        ? "This is an inspect-only task. Do not modify files or execute mutating commands."
        : "Implement the requested work and leave all changes uncommitted for explicit adoption by the coordinator.",
      "",
      task.prompt,
    ].filter(Boolean).join("\n");
    this.context.db.updateRunStatus(child.id, "preparing", { errorMessage: null });
    this.services.skills.skillService.inheritSelection("run", child.id, coordinator.id);
    const worker = await this.startWorker(
      child,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: buildPromptWithRunGoal(prompt, coordinator.goalText),
        providerOptions: childExecutionOptions,
        yoloMode: inheritedFullAccess,
      },
    );
    this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
  }

  async resumeRunFromCheckpoint(runId: string): Promise<void> {
    const run = this.context.db.getRun(runId);
    if (this.services.activeWorkers.runWorkers.has(runId)) {
      throw new Error("This run is already active.");
    }
    const resumed = await this.resumeInterruptedRunFromCheckpoint(run);
    if (!resumed) {
      throw new Error("No resumable checkpoint is available for this run.");
    }
  }

  async recoverInterruptedRun(runId: string): Promise<void> {
    return this.services.workspaceGuard.serializeRunStart(runId, () => this.recoverInterruptedRunUnlocked(runId));
  }

  private async recoverInterruptedRunUnlocked(runId: string): Promise<void> {
    const run = this.context.db.getRun(runId);
    if (this.services.activeWorkers.runWorkers.has(runId)) {
      throw new Error("This run is already active.");
    }

    const model = this.context.db.getModel(run.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    if (!providerSupportsInterruptedRunRecovery(provider.providerType)) {
      throw new Error("Interrupted-session recovery is only available for Codex CLI, Claude Code, Cursor Agent, and ACP agent runs.");
    }

    if (await this.resumeInterruptedRunFromCheckpointUnlocked(run, "manual")) {
      return;
    }

    const providerRuntime = this.services.turnState.resolveRunNativeSession(run, provider).session;
    if (!providerRuntime?.resumeCursor) {
      throw new Error("No provider session or checkpoint is available for this interrupted run.");
    }

    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider credentials are not available.");
    }

    this.context.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      "Recovery confirmed",
      "Starting a new turn with the saved provider session and current workspace state.",
      { recoveredInterruptedSession: true, recoveryKind: "provider-session" },
    );

    const worker = await this.startWorker(run, provider, model, apiKey ?? "", await this.services.settings.resolveNetworkProxyRuntimeConfig(), {
      promptOverride: this.buildInterruptedRunRecoveryPrompt(run),
      recoverSkills: true,
      providerOptions: this.services.turnState.getLatestRunExecutionOptions(run.id, provider),
      yoloMode: latestRunExecutionSettings(this.context.db.getRunSteps(run.id))?.yoloMode === true,
    });
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
  }

  async getRunRewindHistory(runId: string): Promise<RunRewindArchive[]> {
    this.context.db.getRun(runId);
    return this.context.db.getRunRewindHistory(runId);
  }

  /** Serializes rewind with project mutations and rejects active or coordinated work before restoration. */
  async rewindRun(input: RunRewindInput): Promise<RunRewindResult> {
    if (!["conversation", "conversation-and-files"].includes(input.mode)) throw new Error("Invalid rewind mode.");
    const initial = this.context.db.getRun(input.runId);
    return this.services.workspaceGuard.serializeProjectBranchMutation(initial.projectId, async () => {
      const run = this.context.db.getRun(input.runId);
      this.services.workspaceGuard.requireIdleRunWorkspace(run, "rewinding the conversation");
      if (run.delegationEnabled || run.kind !== "standard" || this.context.db.getOrchestrationByCoordinatorRunId(run.id)) {
        throw new Error("Rewind is available for independent runs. Orchestration and delegated run histories must stay aligned with their tasks.");
      }
      if (this.context.db.listCouncilRounds(run.id).some((round) => ["reviewing", "assessing", "applying"].includes(round.status))) {
        throw new Error("Wait for validation and applying findings to finish before rewinding.");
      }
      if (this.context.db.listQueuedFollowUps("run", run.id).length) throw new Error("Remove queued follow-ups before rewinding.");
      const path = canonicalWorkspacePath(run.worktreePath);
      if ([...this.services.workspaceGuard.restoringWorkspaces].some((other) => workspacePathsOverlap(other, path))) throw new Error("A workspace restore is already running.");
      this.services.workspaceGuard.restoringWorkspaces.add(path);
      try {
        if (input.mode === "conversation-and-files") {
          this.services.workspaceGuard.requireGitRun(run, "File rewind");
          this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run);
        }
        const result = await executeRunRewind({ db: this.context.db, git: this.context.gitService, run, input,
          beforeRestoreFiles: () => this.context.terminal.killForRunId(run.id),
          assertSafe: () => this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run), networkProxy: await this.services.settings.resolveNetworkProxyRuntimeConfig() });
        this.services.runEvents.emitEvent({ runId: run.id, type: "status", title: "Conversation rewound", content: "Reload the run to view its retained history.",
          metadata: { conversationRewound: true, providerStrategy: result.providerStrategy }, createdAt: new Date().toISOString() });
        return result;
      } finally { this.services.workspaceGuard.restoringWorkspaces.delete(path); }
    });
  }

  async undoRunToLastPrompt(runId: string): Promise<void> {
    const latest = this.context.db.listRunTurnRestorePoints(runId).at(-1);
    if (latest) {
      await this.rewindRun({ runId, restorePointId: latest.id, mode: "conversation-and-files" });
      return;
    }
    const initialRun = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Undo to last prompt");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, async () => {
      const path = canonicalWorkspacePath(this.context.db.getRun(runId).worktreePath);
      this.services.workspaceGuard.requireWorkspaceNotRestoring(path);
      this.services.workspaceGuard.restoringWorkspaces.add(path);
      try {
        await this.undoRunToLastPromptUnlocked(runId);
      } finally {
        this.services.workspaceGuard.restoringWorkspaces.delete(path);
      }
    });
  }

  private async undoRunToLastPromptUnlocked(runId: string): Promise<void> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "undoing changes");
    const restorePoint = this.services.turnState.getRunPromptRestorePoint(runId);
    if (!restorePoint) {
      throw new Error("No prompt restore point is available for this run.");
    }
    this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run);
    if (run.workspaceType === "worktree") {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const { safetyPatchPath } = await this.context.gitService.restorePromptRestorePatch(run.worktreePath, restorePoint.patch, {
      expectedHeadSha: restorePoint.headSha,
      safetyPatchPath: join(dirname(this.context.db.getFilePath()), "restore-backups", `${runId}-${Date.now().toString()}.patch`),
      assertSafe: () => this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run),
    });
    this.services.turnState.clearRunCheckpoint(runId);

    const description = [
      restorePoint.commandType === "follow-up"
        ? "Restored the run worktree to the state before the latest follow-up prompt."
        : "Restored the run worktree to the state before the initial prompt.",
      ...(safetyPatchPath ? [`The discarded changes were saved to ${safetyPatchPath} and can be reapplied with \`git apply\`.`] : []),
    ].join(" ");
    await this.services.runEvents.appendRunEvent(runId, "status", "Changes undone to last prompt", description, {
      undoneToLastPrompt: true,
      commandType: restorePoint.commandType,
      restorePointCreatedAt: restorePoint.createdAt,
      ...(safetyPatchPath ? { discardedChangesPatchPath: safetyPatchPath } : {}),
    });
    this.services.runEvents.emitEvent({
      runId,
      type: "status",
      title: "Changes undone to last prompt",
      content: description,
      metadata: {
        undoneToLastPrompt: true,
        commandType: restorePoint.commandType,
        restorePointCreatedAt: restorePoint.createdAt,
      },
      createdAt: new Date().toISOString(),
    });
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
      this.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
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
      this.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
    }
  }

  async respondToChatUserInput(chatId: string, requestId: string, answers: RunUserInputAnswers): Promise<void> {
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    const pending = this.chatUserInputRequests.get(chatId);
    if (!active || active.cancelled || !pending?.has(requestId)) throw new Error("This question is no longer active.");
    const step = this.context.db.resolveChatUserInput(chatId, requestId, answers);
    pending.delete(requestId);
    active.worker.postMessage({ type: "user-input-response", requestId, answers });
    this.services.runEvents.emitChatEvent(chatId, {
      runId: chatId, type: "user-input-requested", title: step.title, content: step.content,
      metadata: JSON.parse(step.metadataJson) as Record<string, unknown>, createdAt: new Date().toISOString(), step,
    });
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
        : await this.executeOrchestrationTool(
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
    await this.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
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
    await this.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
  }

  /**
   * Codex reports cumulative usage per thread, so a resumed thread continues from the last
   * totals that thread reported. Only this account's turns count: totals reported by another
   * provider in between belong to a different session.
   */
  private initialUsageReportTracker(
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
      (orchestrationTask ? this.orchestrationBudgetExhaustion(this.context.db.getOrchestration(orchestrationTask.orchestrationId)) : null);
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

  private async startWorker(
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
          this.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        } else {
          await this.failProjectLabImplementation(run, errorMessage);
        }
      }
      if (run.kind === "loop-iteration") {
        this.loopRunner.handleRunTerminal(run.id);
      }
      if (run.kind === "orchestration-task") {
        await this.handleOrchestrationChildTerminal(run.id).catch((error) => {
          this.context.logControllerError("Could not finalize a failed orchestration child.", error, { runId: run.id });
        });
      }
      if (run.kind === "council-review") this.handleCouncilChildTerminal(run.id);
      else this.handleCouncilRunTerminal(run.id, false);
      void this.handlePrWatchRunTerminal(run.id);
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
        this.settleFollowUpSteer(payload);
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
            await this.reviewCompletedProjectLabImplementation(this.context.db.getRun(run.id));
          } catch (labReviewError) {
            this.context.logControllerError("Project Lab implementation review failed.", labReviewError, { runId: run.id });
          }
        } else if ((budgetExhaustion || failedVerification) && run.kind === "lab-implementation") {
          await this.failProjectLabImplementation(
            run,
            budgetExhaustion?.reason ?? "The implementation did not pass its project verification gate.",
          );
        } else if (wasCancelled && run.kind === "lab-implementation") {
          this.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        }
        if (run.kind === "loop-iteration") {
          this.loopRunner.handleRunTerminal(run.id);
        }
        if (run.kind === "orchestration-task") {
          await this.handleOrchestrationChildTerminal(run.id).catch((error) => {
            this.context.logControllerError("Could not finalize an orchestration child.", error, { runId: run.id });
          });
        } else if (run.delegationEnabled) {
          await this.handleOrchestrationCoordinatorTurnTerminal(run.id).catch((error) => {
            this.context.logControllerError("Could not persist the coordinator wake state.", error, { runId: run.id });
          });
        }
        if (run.kind === "council-review") this.handleCouncilChildTerminal(run.id);
        else this.handleCouncilRunTerminal(run.id, terminalOutcome.status === "completed" && !waitingForSubagents);
        const prWatchTurn = this.handlePrWatchRunTerminal(run.id);
        // Cancelled or failed turns hold the queue until the user resumes it or sends another follow-up.
        if (terminalOutcome.status === "completed") void prWatchTurn.then(() => this.dispatchQueuedFollowUpsInBackground("run", run.id));
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

  private buildRunCommitMessage(prompt: string): string {
    const singleLinePrompt = prompt.replace(/\s+/g, " ").trim();
    const summary = singleLinePrompt.length > 60 ? `${singleLinePrompt.slice(0, 60).trim()}...` : singleLinePrompt;
    return `buildwarden: ${summary || "apply run changes"}`;
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

  private buildPriorChatMessages(chatId: string): Array<Record<string, unknown>> {
    const messages = this.context.db
      .getChatSteps(chatId)
      .flatMap((step) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }

        if (step.eventType === "log" && (metadata.source === "user" || metadata.source === RUN_CHAT_CONTEXT_SOURCE)) {
          const attachments = extractAttachmentPayloadsFromMetadata(metadata, this.context.db.resolveAttachmentBlob);
          return [{
            role: "user",
            content: step.content,
            ...(attachments.length > 0 ? { attachments } : {}),
          }];
        }

        if (step.eventType === "user-input-requested" && metadata.requestStatus === "resolved") {
          return [{ role: "user", content: `Answers to the assistant's questions: ${JSON.stringify({ questions: metadata.userInputQuestions, answers: metadata.userInputAnswers })}` }];
        }

        if (step.eventType === "output") {
          if (metadata.assistantKind === "reasoning" || metadata.assistantKind === "image" || step.title === "Reasoning") {
            return [];
          }
          return [{ role: "assistant", content: typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content }];
        }

        return [];
      });
    if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
      messages.pop();
    }
    return messages;
  }

  private async resumeInterruptedRunFromCheckpoint(run: RunRecord, origin: "startup" | "manual" = "startup"): Promise<boolean> {
    return this.services.workspaceGuard.serializeRunStart(run.id, () => this.resumeInterruptedRunFromCheckpointUnlocked(this.context.db.getRun(run.id), origin));
  }

  private async resumeInterruptedRunFromCheckpointUnlocked(run: RunRecord, origin: "startup" | "manual" = "startup"): Promise<boolean> {
    const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
    if (!checkpoint) {
      return false;
    }

    const model = this.context.db.getModel(run.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(run.projectId, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      return false;
    }

    this.context.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      origin === "manual" ? "Recovery confirmed" : "Run resumed from checkpoint",
      checkpoint.memo || "Restarted from the last completed tool round.",
      { resumedFromCheckpoint: true, recoveredInterruptedSession: origin === "manual", round: checkpoint.round },
    );

    const worker = await this.startWorker(run, provider, model, apiKey ?? "", await this.services.settings.resolveNetworkProxyRuntimeConfig(), {
      providerOptions: this.services.turnState.getLatestRunExecutionOptions(run.id, provider),
      yoloMode: latestRunExecutionSettings(this.context.db.getRunSteps(run.id))?.yoloMode === true,
    });
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
    return true;
  }

  private buildInterruptedRunRecoveryPrompt(run: RunRecord): string {
    const memory = this.services.turnState.buildRunFollowUpMemo(run.id);
    return [
      "The previous BuildWarden run was interrupted because the desktop app closed while the agent was active.",
      "Continue carefully from the current workspace state and the saved provider session. Do not assume the previous process finished.",
      "First inspect what already changed or what the activity log says, avoid repeating completed work, then continue the original task.",
      "",
      `Original task:\n${run.prompt}`,
      memory ? `\nRecent run memory:\n${memory}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildRunPullRequestBody(projectName: string, prompt: string, targetBranch: string): string {
    return [
      "## Summary",
      `- Automated changes from BuildWarden for \`${projectName}\`.`,
      `- Original run prompt: ${prompt}`,
      "",
      "## Target branch",
      `- ${targetBranch}`,
      "",
      "## Test plan",
      "- [ ] Review the generated diff",
      "- [ ] Run relevant tests locally",
    ].join("\n");
  }

  private async handleChatWorkerChunk(
    chat: ChatRecord,
    _provider: ProviderAccountRecord,
    _model: ModelRecord,
    payload: ChatWorkerChunkPayload,
    streamingStepIds: Map<string, string>,
    usageTracker: UsageReportTracker,
  ): Promise<void> {
    if (payload.chunk.metadata?.skillEvent === true) this.services.skills.skillService.recordEvent("chat", chat.id, payload.chunk.metadata);
    const eventType = runChunkEventType(payload.chunk.type);
    const usageTotals =
      typeof payload.chunk.metadata?.usageTotals === "object" && payload.chunk.metadata.usageTotals
        ? (payload.chunk.metadata.usageTotals as Partial<RunTokenUsage>)
        : null;
    resetUsageBaselineForFreshSession(usageTracker, payload.chunk.metadata);
    if (usageTotals) this.applyChatWorkerUsageUpdate(chat, usageTotals, usageTracker);
    await this.services.turnState.persistFailedTurnAccounting("chat", chat.id, _provider, _model.modelId, payload.chunk.metadata);
    const replaceableChunk =
      payload.chunk.type === "message" ||
      payload.chunk.type === "tool-result" ||
      payload.chunk.type === "tool-progress";
    const streamId = replaceableChunk && typeof payload.chunk.metadata?.streamId === "string"
      ? payload.chunk.metadata.streamId
      : null;
    const shouldReplace = replaceableChunk && payload.chunk.metadata?.replace === true && streamId;

    let persistedStep: ChatStepRecord;
    if (shouldReplace) {
      const existingStepId = streamingStepIds.get(streamId);
      if (existingStepId) {
        persistedStep = this.context.db.updateChatStep(existingStepId, {
          title: payload.chunk.title ?? "Agent output",
          content: payload.chunk.value,
          metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
        });
      } else {
        const step = await this.services.runEvents.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
        streamingStepIds.set(streamId, step.id);
        persistedStep = step;
      }
    } else {
      persistedStep = await this.services.runEvents.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
    }
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: eventType,
      title: payload.chunk.title ?? "Agent output",
      content: payload.chunk.value,
      metadata: payload.chunk.metadata,
      createdAt: new Date().toISOString(),
      step: persistedStep,
    });
  }

  private applyChatWorkerUsageUpdate(
    chat: ChatRecord,
    usageTotals: Partial<RunTokenUsage> | null,
    tracker: UsageReportTracker,
  ): ChatRecord {
    if (!usageTotals) return this.context.db.getChat(chat.id);
    let currentChat = this.context.db.getChat(chat.id);
    const projectId = currentChat.runId ? this.context.db.getRun(currentChat.runId).projectId : null;
    for (const delta of advanceUsageTracker(tracker, usageTotals)) {
      currentChat = this.context.db.recordChatTokenUsage(currentChat.id, projectId, delta.inputTokensDelta, delta.outputTokensDelta, delta.attribution);
    }
    return currentChat;
  }

  private async startChatWorker(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    promptOverride?: string,
    attachments?: ChatAttachmentPayload[],
    providerOptions?: ProviderExecutionOptions,
    skillPrompt?: string,
  ): Promise<Worker> {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const parentRun = chat.runId ? this.context.db.getRun(chat.runId) : undefined;
    if (parentRun) this.services.skills.skillService.inheritSelection("chat", chat.id, parentRun.id);
    const skills = {
      snapshot: await this.services.skills.prepareSessionSkills("chat", chat.id, skillPrompt ?? chat.prompt, parentRun?.projectId),
      storePath: this.services.skills.skillService.storePath,
      recovering: false,
    };
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "chat-worker.js");
    // Only this app-owned directory is eligible for inline local chat images.
    const chatWorkspace = getChatWorkspacePath(this.context.db.getFilePath(), chat.id);
    this.services.workspaceGuard.requireWorkspaceNotRestoring(chatWorkspace);
    mkdirSync(chatWorkspace, { recursive: true });
    this.context.db.closeChatUserInputRequests(chat.id);
    const pendingInputs = new Set<string>();
    this.chatUserInputRequests.set(chat.id, pendingInputs);
    const streamingStepIds = new Map<string, string>();
    const chatSteps = this.context.db.getChatSteps(chat.id);
    // The worker starts after the current user turn was persisted; judge the session on the history before it.
    const nativeSession = this.services.turnState.resolveChatNativeSession(chat, provider, stepsBeforeLatestTurn(chatSteps));
    const usageTracker = this.initialUsageReportTracker(provider, chatSteps, nativeSession.session !== null, model);
    const settings = this.context.db.getSettings();
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.context.logDirPath, { recursive: true });
    }
    const worker = new Worker(workerPath, {
      workerData: {
        ...getCompileCacheWorkerData(),
        acknowledgeChunks: true,
        request: {
          runId: chat.id,
          worktreePath: chatWorkspace,
          mode: "ask" as const,
          prompt: promptOverride ?? chat.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: nativeSession.previousResponseId,
          providerSessionRuntime: nativeSession.session,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          modelCapabilities: parseMetadataRecord(model.capabilitiesJson),
          providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          skills,
          isChat: true,
          attachments: attachments ?? [],
          priorMessages: this.buildPriorChatMessages(chat.id),
          priorChatMessages: buildPriorChatCompletionMessagesFromSteps(chatSteps),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.context.logDirPath } } : {}),
        },
      },
    });

    this.context.db.updateChatStatus(chat.id, "running");
    // As with runs, keep streamed steps slim while sending the authoritative status transition once.
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat started",
      content: "The assistant is responding.",
      createdAt: new Date().toISOString(),
    });

    worker.on("message", async (message: unknown) => {
      const payload = message as ChatWorkerPayload;
      if (payload.type === "steer-result") {
        this.settleFollowUpSteer(payload);
        return;
      }
      if (payload.type === "process-spawned") {
        this.services.processes.ownedProcesses.registerSpawn({ kind: "chat", id: chat.id }, payload, chatWorkspace);
        return;
      }

      if (this.services.activeWorkers.chatWorkers.get(chat.id)?.worker !== worker || this.services.activeWorkers.chatWorkers.get(chat.id)?.cancelled) {
        if (payload.type === "chunk" && payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        return;
      }

      if (payload.type === "user-input-request") {
        if (this.services.activeWorkers.chatWorkers.get(chat.id)?.worker !== worker) return;
        const metadata = {
          ...payload.metadata, requestKind: "user-input", requestStatus: "opened",
          userInputRequestId: payload.requestId, userInputQuestions: payload.questions ?? [],
        };
        const step = await this.services.runEvents.appendChatEvent(chat.id, "user-input-requested", payload.title || "Question",
          payload.content || "", metadata);
        pendingInputs.add(payload.requestId);
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id, type: "user-input-requested", title: step.title, content: step.content,
          metadata, createdAt: step.createdAt, step,
        });
        return;
      }

      if (payload.type === "chunk") {
        try {
          await this.handleChatWorkerChunk(chat, provider, model, payload, streamingStepIds, usageTracker);
        } finally {
          if (payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        }
        return;
      }

      if (payload.type === "done") {
        const currentChat = this.applyChatWorkerUsageUpdate(chat, payload.result.usage, usageTracker);
        const nextInputTokens = currentChat.inputTokens;
        const nextOutputTokens = currentChat.outputTokens;
        if (payload.result.providerSessionRuntime) {
          this.services.turnState.upsertProviderSessionRuntime("chat", chat.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        this.context.db.updateChatStatus(chat.id, "completed", {
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          finishedAt: new Date().toISOString(),
        });
        await this.services.runEvents.appendChatEvent(chat.id, "status", "Chat completed", "Chat completed successfully.", {
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          usageTotals: payload.result.usage,
        });
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "status",
          title: "Chat completed",
          content: "Chat completed successfully.",
          metadata: { inputTokens: nextInputTokens, outputTokens: nextOutputTokens, usageTotals: payload.result.usage },
          createdAt: new Date().toISOString(),
        });
        this.services.activeWorkers.chatWorkers.delete(chat.id);
        this.chatUserInputRequests.delete(chat.id);
        this.context.db.closeChatUserInputRequests(chat.id);
        await worker.terminate();
        this.dispatchQueuedFollowUpsInBackground("chat", chat.id);
        return;
      }

      if (payload.type === "error") {
        const active = this.services.activeWorkers.chatWorkers.get(chat.id);
        const status = active?.cancelled ? "cancelled" : "failed";
        this.context.logControllerError("Chat worker reported an error payload.", payload.error, {
          chatId: chat.id,
          status,
        });
        this.context.db.updateChatStatus(chat.id, status, {
          errorMessage: payload.error,
          finishedAt: new Date().toISOString(),
        });
        await this.services.runEvents.appendChatEvent(chat.id, "error", "Chat failed", payload.error);
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "error",
          title: status === "cancelled" ? "Chat cancelled" : "Chat failed",
          content: payload.error,
          createdAt: new Date().toISOString(),
        });
        this.services.activeWorkers.chatWorkers.delete(chat.id);
        this.chatUserInputRequests.delete(chat.id);
        this.context.db.closeChatUserInputRequests(chat.id);
        await worker.terminate();
      }
    });

    worker.on("error", async (error) => {
      this.context.logControllerError("Chat worker emitted a thread error.", error, { chatId: chat.id });
      const active = this.services.activeWorkers.chatWorkers.get(chat.id);
      if (active?.worker !== worker || active.cancelled) return;
      this.context.db.updateChatStatus(chat.id, "failed", { errorMessage: error.message, finishedAt: new Date().toISOString() });
      await this.services.runEvents.appendChatEvent(chat.id, "error", "Worker error", error.message);
      this.services.activeWorkers.chatWorkers.delete(chat.id);
      this.chatUserInputRequests.delete(chat.id);
      this.context.db.closeChatUserInputRequests(chat.id);
    });

    return worker;
  }

  /**
   * Run cleanup force-deletes only the branch BuildWarden generated for the worktree (named like its
   * folder). A branch the user named, for example when publishing, may hold unpushed work and is kept.
   */
  private getOwnedRunBranchForDeletion(run: RunRecord, options: { preserveBranch?: boolean }): string | undefined {
    if (options.preserveBranch === true || run.branchName !== basename(run.worktreePath)) {
      return undefined;
    }
    return run.branchName;
  }

  private councilService?: CouncilService;

  getCouncilService(): CouncilService {
    return this.councilService ??= new CouncilService(this.context.db, {
      getRun: (runId) => this.context.db.getRun(runId),
      getSettings: () => parseCouncilSettings(this.context.db.getSettings()[APP_SETTING_KEYS.council]),
      getReviewers: () => resolveCouncilReviewers(parseCouncilSettings(this.context.db.getSettings()[APP_SETTING_KEYS.council]), this.context.db.listModels()),
      describeModel: (modelId) => {
        const model = this.context.db.getModel(modelId);
        return { label: model.displayName, providerLabel: this.context.db.getProviderAccount(model.providerAccountId).label };
      },
      isRunBusy: (runId) => this.services.activeWorkers.runWorkers.has(runId) || ["queued", "preparing", "running"].includes(this.context.db.getRun(runId).status),
      captureSubject: (run) => this.captureCouncilSubject(run),
      currentFingerprint: async (run, kind) => {
        if (kind === "code") return councilCodeFingerprint(await this.captureCouncilRevision(run));
        const answer = latestRunAnswerText(this.context.db.getRunSteps(run.id));
        return answer ? councilTextFingerprint(answer) : null;
      },
      readConversation: (run) => {
        // The progress card is noise here, but the fix turns that carry earlier findings are history.
        const steps = this.context.db.getRunSteps(run.id).filter((step) => step.eventType !== "status" || !parseMetadataRecord(step.metadataJson).councilRoundId);
        return buildContextHandoffBlock(steps, { strategy: "full", fromStepIndex: 0, turnCount: 1 });
      },
      getLimitReason: (modelId) => this.getCouncilLimitReason(modelId),
      startChild: (round, input) => this.startCouncilChild(round, input),
      messageChild: async (childRunId, prompt) => {
        const child = this.context.db.getRun(childRunId);
        await this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(childRunId, prompt, { mode: "ask", modelId: child.modelId, yoloMode: false }, { source: "council" }));
      },
      stopChild: async (childRunId) => {
        await this.services.processes.stopRunOwnedProcesses(childRunId);
        const child = this.context.db.getRun(childRunId);
        if (["queued", "preparing", "running"].includes(child.status)) this.context.db.updateRunStatus(childRunId, "cancelled", { errorMessage: "Stopped by validation." });
      },
      releaseChild: (childRunId) => this.releaseCouncilChildWorkspace(this.context.db.getRun(childRunId)),
      readChild: (childRunId) => {
        const child = this.context.db.getRun(childRunId);
        return {
          status: child.status,
          text: latestRunAnswerText(this.context.db.getRunSteps(childRunId)) || child.summary?.trim() || "",
          errorMessage: child.errorMessage,
          inputTokens: child.inputTokens,
          outputTokens: child.outputTokens,
        };
      },
      startApply: (round, prompt, record) => this.startCouncilApply(round, prompt, record),
      setRunMode: (runId, mode) => { this.context.db.updateRunConfiguration(runId, { mode }); },
      appendStep: (round, content) => this.context.db.appendRunStep(round.runId, "status", COUNCIL_REVIEW_EVENT_TITLE, content, JSON.stringify({ councilRoundId: round.id })).id,
      publish: (round, content) => {
        const metadata = { councilRoundId: round.id, councilStatus: round.status };
        const step = round.stepId ? this.context.db.updateRunStep(round.stepId, { content, metadataJson: JSON.stringify(metadata) }) : undefined;
        this.services.runEvents.emitEvent({ runId: round.runId, type: "status", title: COUNCIL_REVIEW_EVENT_TITLE, content, metadata, createdAt: new Date().toISOString(), ...(step ? { step } : {}) });
      },
      logError: (message, error, context) => this.context.logControllerError(message, error, context),
    });
  }

  async startCouncil(runId: string): Promise<CouncilRound> {
    return this.getCouncilService().start(runId);
  }

  async getCouncilRounds(runId: string): Promise<CouncilRound[]> {
    const rounds = this.context.db.listCouncilRounds(runId);
    const latest = rounds.at(-1);
    if (!latest || latest.status !== "ready") return rounds;
    const run = this.context.db.getRun(runId);
    const current = await (latest.kind === "code"
      ? this.captureCouncilRevision(run).then(councilCodeFingerprint)
      : Promise.resolve(councilTextFingerprint(latestRunAnswerText(this.context.db.getRunSteps(runId))))).catch(() => null);
    return rounds.map((round) => (round === latest ? { ...round, stale: current !== null && current !== round.subjectFingerprint } : round));
  }

  async cancelCouncil(roundId: string): Promise<CouncilRound> {
    return this.getCouncilService().cancel(roundId);
  }

  async applyCouncilFindings(roundId: string, groupIds: string[]): Promise<CouncilRound> {
    return this.getCouncilService().applyFindings(roundId, groupIds);
  }

  async reconcileCouncilAfterRestart(): Promise<void> {
    await this.getCouncilService().reconcileAfterRestart();
  }

  prWatchService?: PrWatchService;

  getPrWatchService(): PrWatchService {
    return this.prWatchService ??= new PrWatchService(this.context.db, {
      getRun: (runId) => this.context.db.getRun(runId),
      isRunBusy: (runId) => this.services.activeWorkers.runWorkers.has(runId) || ["queued", "preparing", "running"].includes(this.context.db.getRun(runId).status),
      readForge: (run, prUrl, includeDetails) => this.readPrWatchForge(run, prUrl, includeDetails),
      readCheckLog: async (run, prUrl, check) => (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getCheckLog({ prUrl, check }),
      getInstructions: (projectId) => parseProjectPrWatchInstructionsSetting(this.context.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions])[projectId] ?? "",
      checkWorkspace: (run, summary, mode) => this.checkPrWatchWorkspace(run, summary, mode),
      startTurn: async (run, prompt, wake) => {
        await this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(
          run.id,
          prompt,
          { mode: "code", modelId: run.modelId, yoloMode: latestUserTurnUsedFullAccess(this.context.db.getRunSteps(run.id)) },
          { displayPrompt: prompt, prWatchWake: wake },
        ));
      },
      readTurn: (runId, wakeId) => readPrWatchTurnResult(this.context.db.getRun(runId), this.context.db.getRunSteps(runId), wakeId),
      hasUncommittedChanges: (run) => this.context.gitService.hasChanges(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.context.db.getProject(run.projectId))),
      pushRunBranch: async (run, remoteHeadSha) => {
        const head = await this.context.gitService.getHeadCommitSha(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.context.db.getProject(run.projectId)));
        if (remoteHeadSha && head.toLowerCase() === remoteHeadSha.toLowerCase()) return false;
        await this.publishRunBranch(run.id);
        return true;
      },
      resolveCommit: (run, sha) => this.context.gitService.resolveCommitInHistory(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.context.db.getProject(run.projectId)), sha),
      replyInThread: async (run, input) => {
        await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).replyToThread(input);
      },
      postComment: async (run, input) => {
        await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).postComment(input);
      },
      // Only a client error is a definite refusal; a timeout, network error or 5xx may follow an accepted write.
      isReplyRejected: (error) => error instanceof PrReviewHttpError && error.status >= 400 && error.status < 500,
      hasPostedReply: async (run, prUrl, text) => {
        const details = await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getRequestDetails({ prUrl });
        // A collection that failed to load comes back empty with a warning: absence there proves nothing.
        if (details.warnings.length) throw new Error(`The request's comments could not be read in full: ${details.warnings.join(" ")}`);
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\r\n/g, "\n").trim();
        const wanted = normalize(text);
        // Usually a delivery marker, which only that one reply carries.
        return details.activity.some((item) => normalize(item.body).includes(wanted)) ||
          details.reviewThreads.some((thread) => thread.comments.some((comment) => normalize(comment.body).includes(wanted)));
      },
      publish: (record) => {
        const forgeRequest = this.context.db.getRunForgeRequestCache(record.runId)?.summary ?? null;
        this.context.events.publish("forge", { runId: record.runId, projectId: record.projectId, forgeRequest, prWatch: toPrWatchView(record) });
      },
      logError: (message, error, context) => this.context.logControllerError(message, error, context),
    });
  }

  /** Forces a read of the watched request. A failed read throws instead of returning the stale copy. */
  private async readPrWatchForge(run: RunRecord, prUrl: string, includeDetails: boolean): Promise<PrWatchForgeState | null> {
    const summary = await this.services.runForge.syncRunForgeRequest(run.id, true, includeDetails, prUrl);
    if (summary?.syncError) throw new Error(summary.syncError);
    if (!summary) return null;
    const details = this.context.db.getRunForgeRequestCache(run.id)?.details ?? null;
    return {
      summary,
      checks: details?.checks ?? [],
      reviewThreads: details?.reviewThreads ?? null,
      activity: details?.activity ?? null,
    };
  }

  private async checkPrWatchWorkspace(run: RunRecord, summary: RunForgeRequestSummary, mode: "start" | "wake"): Promise<PrWatchWorkspaceCheck> {
    const label = prWatchRequestLabel(summary.provider);
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.context.db.getProject(run.projectId));
    if (!existsSync(workspacePath)) return { ok: false, message: "The run's workspace no longer exists." };
    let branch = await this.context.gitService.getCurrentBranch(workspacePath).catch(() => null);
    // Leaving a run releases its branch, detaching the worktree on the same commit. Take it back.
    if (!branch && run.workspaceType === "worktree" && run.branchName === summary.sourceBranch &&
      await this.context.gitService.isWorktreeOnBranch(workspacePath, run.branchName).catch(() => false)) {
      await this.context.gitService.checkoutWorktreeBranch(workspacePath, run.branchName);
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      branch = run.branchName;
    }
    if (branch !== summary.sourceBranch || run.branchName !== summary.sourceBranch) {
      return { ok: false, message: `The workspace is on ${branch ? `"${branch}"` : "no branch"}, not on the ${label} branch "${summary.sourceBranch}".` };
    }
    if (mode === "start") {
      // A wake fetches from the branch's push remote, which never has a fork's commits.
      const project = this.context.db.getProject(run.projectId);
      const source = await resolveRunForgeSourceRepository(this.context.gitService, project.repoPath, summary.sourceBranch, await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId));
      if (source && summary.sourceRepository && source !== summary.sourceRepository) {
        return { ok: false, message: `The ${label} comes from another repository (${summary.sourceRepository}), so its commits cannot be fetched here.` };
      }
      return { ok: true };
    }
    if (await this.context.gitService.hasChanges(workspacePath)) {
      return { ok: false, message: "The workspace has uncommitted changes. Commit or discard them, then resume the watch." };
    }
    if (!summary.headSha) return { ok: true };
    const sync = await this.context.gitService.syncWithRemoteHead(workspacePath, summary.sourceBranch, summary.headSha);
    if (sync === "diverged") {
      return { ok: false, message: `The workspace and the ${label} branch have different commits. Reconcile them, then resume the watch.` };
    }
    return { ok: true };
  }

  async getRunPrWatchCandidates(runId: string): Promise<RunPrWatchCandidates> {
    const run = this.context.db.getRun(runId);
    const project = this.context.db.getProject(run.projectId);
    const cache = this.context.db.getRunForgeRequestCache(runId);
    const linked = cache?.summary ?? null;
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const workspaceBranch = run.workspaceVcs === "git" && existsSync(workspacePath)
      ? await this.context.gitService.getCurrentBranch(workspacePath).catch(() => null)
      : null;
    const result: RunPrWatchCandidates = { workspaceBranch, linked, linkSource: cache?.linkSource ?? "auto", candidates: [], error: null };
    if (run.workspaceVcs !== "git") return { ...result, error: "Only Git runs can watch a request." };
    const watchers = new Map(this.context.db.listPrWatchesWithStatuses(["watching", "working"]).map((watch) => [watch.prUrl, watch.runId]));
    let sourceRepository: string | null = null;
    let requests: ProjectForgeRequestSummary[] = [];
    try {
      const provider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
      const branch = workspaceBranch ?? run.branchName;
      sourceRepository = await resolveRunForgeSourceRepository(this.context.gitService, project.repoPath, branch, provider);
      requests = (await this.services.forgeRequests.loadProjectForgeRequests(run.projectId, provider, {
        state: "open", sourceBranch: branch, ...(sourceRepository ? { sourceRepository } : {}),
      }, true)).items.filter((request) => request.sourceBranch === branch);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    const assess = (request: ProjectForgeRequestSummary): RunPrWatchCandidate => {
      const watchedByRunId = watchers.get(request.url) ?? null;
      let reason: string | null = null;
      // GitLab reports open merge requests as "opened".
      if (!isOpenForgeRequestState(request.state)) reason = "Only open requests can be watched.";
      else if (!workspaceBranch) reason = "The run's workspace is not on a branch.";
      else if (request.sourceBranch !== workspaceBranch || request.sourceBranch !== run.branchName) {
        reason = `Its branch "${request.sourceBranch}" is not checked out in this run's workspace.`;
      } else if (sourceRepository && request.sourceRepository && request.sourceRepository !== sourceRepository) {
        reason = "It comes from another repository.";
      }
      return { request, watchable: reason === null, reason, watchedByRunId: watchedByRunId === runId ? null : watchedByRunId };
    };
    result.candidates = requests.map(assess);
    if (linked && !requests.some((request) => request.url === linked.url)) {
      result.candidates.unshift(assess({
        provider: linked.provider, number: linked.number, title: linked.title, url: linked.url, state: linked.state, draft: linked.draft,
        author: linked.author, sourceBranch: linked.sourceBranch, sourceRepository: linked.sourceRepository ?? null,
        targetBranch: linked.targetBranch, createdAt: null, updatedAt: linked.updatedAt,
      }));
    }
    return result;
  }

  async setRunForgeLink(runId: string, prUrl: string | null): Promise<RunForgeRequestSummary | null> {
    const run = this.context.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Linking a request");
    if (isPrWatchActive(this.context.db.getPrWatch(runId))) throw new Error("Stop watching before changing the linked request.");
    const url = prUrl?.trim() ?? "";
    if (!url) {
      this.context.db.saveRunForgeUnlinked(runId, run.branchName);
      this.services.runForge.publishRunForgeRequest(run, null);
      return null;
    }
    // Rejects requests from other repositories before anything is saved.
    await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getRequestSummary({ prUrl: url });
    const summary = await this.services.runForge.syncRunForgeRequest(runId, true, true, url);
    if (!summary || summary.syncError) throw new Error(summary?.syncError ?? "The request could not be linked.");
    this.context.db.setRunForgeLinkSource(runId, "user");
    return summary;
  }

  async startPrWatch(runId: string, input: StartPrWatchInput): Promise<PrWatchView> {
    // The watch reads the confirmed URL with force, which would relink it. Check the saved link first,
    // so a confirmation for a request the run is no longer linked to cannot take effect.
    const cache = this.context.db.getRunForgeRequestCache(runId);
    if (cache?.linkSource === "none" || !cache?.summary || cache.summary.url !== input.prUrl.trim()) {
      throw new Error("This run is no longer linked to that request. Check the link and try again.");
    }
    const record = await this.getPrWatchService().start(runId, input);
    // The confirmed request stays linked, so discovery cannot move the watch to another one.
    this.context.db.setRunForgeLinkSource(runId, "user");
    return toPrWatchView(record);
  }

  async stopPrWatch(runId: string): Promise<PrWatchView | null> {
    const record = await this.getPrWatchService().stop(runId);
    return record ? toPrWatchView(record) : null;
  }

  async resumePrWatch(runId: string): Promise<PrWatchView> {
    return toPrWatchView(await this.getPrWatchService().resume(runId));
  }

  async getProjectPrWatchInstructions(projectId: string): Promise<string> {
    this.context.db.getProject(projectId);
    return parseProjectPrWatchInstructionsSetting(this.context.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions])[projectId] ?? "";
  }

  async saveProjectPrWatchInstructions(projectId: string, instructions: string): Promise<string> {
    this.context.db.getProject(projectId);
    const text = instructions.trim();
    if (text.length > PR_WATCH_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`Watch instructions must be at most ${String(PR_WATCH_INSTRUCTIONS_MAX_CHARS)} characters.`);
    }
    const settings = parseProjectPrWatchInstructionsSetting(this.context.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions]);
    if (text) settings[projectId] = text;
    else delete settings[projectId];
    if (Object.keys(settings).length) this.context.db.setSetting(APP_SETTING_KEYS.projectPrWatchInstructions, JSON.stringify(settings));
    else this.context.db.deleteSetting(APP_SETTING_KEYS.projectPrWatchInstructions);
    return text;
  }

  /**
   * Runs after every turn of a run. A watch turn pushes and answers before the run's queued
   * follow-ups may start, because those would hold the workspace the push needs.
   */
  private async handlePrWatchRunTerminal(runId: string): Promise<void> {
    if (this.context.db.getPrWatch(runId)?.status !== "working") return;
    await this.getPrWatchService().onRunTerminal(runId)
      .catch((error: unknown) => this.context.logControllerError("Could not finish a PR watch turn.", error, { runId }));
  }

  /** Runs after a turn ends. Validation problems are logged and never touch the finished run. */
  private handleCouncilRunTerminal(runId: string, startEligible: boolean): void {
    const service = this.getCouncilService();
    service.restoreRunMode(runId);
    void service.onRunTerminal(runId)
      .then((wasApplyTurn) => (wasApplyTurn || !startEligible ? undefined : service.autoStart(runId)))
      .catch((error: unknown) => this.context.logControllerError("Could not update validation after a run finished.", error, { runId }));
  }

  private handleCouncilChildTerminal(childRunId: string): void {
    void this.getCouncilService().onChildTerminal(childRunId)
      .catch((error: unknown) => this.context.logControllerError("Could not record a validation result.", error, { childRunId }));
  }

  private captureCouncilRevision(run: RunRecord) {
    return captureWorkspaceRevision(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.context.db.getProject(run.projectId)), run.workspaceVcs);
  }

  private async readCouncilDiff(run: RunRecord): Promise<string> {
    const project = this.context.db.getProject(run.projectId);
    const { diff, worktreeUnavailable, diffUnavailableReason } = await this.services.runDetails.readRunWorktreeDiff(run.id);
    // A deleted workspace leaves only the answer to review, but this folder still holds unknown changes.
    if (diffUnavailableReason === FOLDER_BASELINE_MISSING_REASON) {
      throw new Error("This run's folder baseline is missing, so its changes cannot be reviewed.");
    }
    if (worktreeUnavailable) return "";
    if (run.workspaceVcs !== "git") return diff;
    // A committed run has a clean working tree, so its work has to be read from history.
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const onRunBranch = !run.branchName.trim() || (run.workspaceType === "worktree"
      ? await this.context.gitService.isWorktreeOnBranch(workspacePath, run.branchName)
      : await this.context.gitService.getCurrentBranch(workspacePath) === run.branchName);
    if (!onRunBranch) throw new Error(`Check out the run branch "${run.branchName}" before validating it.`);
    const readCommits = async (): Promise<string> => {
      const baseRef = councilCommittedBaseRef(run, project.baseBranch, this.context.db.getRunReviewBaseline(run.id))
        ?? await this.context.gitService.findCommitAtTime(workspacePath, run.createdAt);
      return baseRef ? this.context.gitService.getCommittedDiffSince(workspacePath, baseRef) : "";
    };
    // Carrying on without them would pass a partial review off as a complete one.
    const committed = await readCommits().catch((error: unknown) => {
      throw new Error("Could not read this run's commits, so its changes cannot be reviewed.", { cause: error });
    });
    return [committed, diff].filter((part) => part.trim()).join("\n");
  }

  private async captureCouncilSubject(run: RunRecord): Promise<CouncilSubject> {
    const steps = this.context.db.getRunSteps(run.id);
    const requests = runUserRequests(run, steps);
    const before = await this.captureCouncilRevision(run).catch(() => null);
    const diff = await this.readCouncilDiff(run);
    const after = before && await this.captureCouncilRevision(run).catch(() => null);
    // A change mid-read leaves a subject that mixes two states, and the fingerprint can't reveal it later.
    if (before && (before.fingerprint !== after?.fingerprint || before.head !== after.head)) {
      throw new Error("This run's workspace changed while it was being read. Validate it again.");
    }
    if (diff.trim()) {
      const clipped = diff.length > MAX_DIFF_CHARS_FOR_REVIEW
        ? `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated. Read the changed files directly.]`
        : diff;
      return { kind: "code", requests, diff: clipped, answer: null, fingerprint: councilCodeFingerprint(before ?? await this.captureCouncilRevision(run)) };
    }
    const answer = latestRunAnswerText(steps);
    if (!answer) throw new Error("This run has no changes or answer to validate.");
    return { kind: "text", requests, diff: null, answer, fingerprint: councilTextFingerprint(answer) };
  }

  /** Best effort: an unknown limit never blocks a reviewer, which would simply fail on its own. */
  private async getCouncilLimitReason(modelId: string): Promise<string | null> {
    return (await this.services.providerRuntime.getProviderLimitState(modelId))?.reason ?? null;
  }

  /** Every child gets its own copy, so nothing it does can reach the user's workspace. */
  private async prepareCouncilWorkspace(
    round: CouncilRound,
    parent: RunRecord,
    project: ProjectRecord,
    configuredWorktreeRoot: string | undefined,
  ): ReturnType<AppController["prepareContinuationWorkspace"]> {
    const source = { ...parent, worktreePath: this.services.workspaceGuard.getEffectiveRunWorkspacePath(parent, project) };
    if (round.kind === "code" || existsSync(source.worktreePath)) {
      return this.prepareContinuationWorkspace(source, project, true, configuredWorktreeRoot, true);
    }
    // The run's workspace is gone, and its branch may be too. A text review only needs the project.
    const branchName = parent.workspaceVcs === "git" ? await this.resolveWorktreeStartPoint(project, project.baseBranch) : parent.branchName;
    return this.prepareContinuationWorkspace({ ...source, branchName }, project, false, configuredWorktreeRoot, true);
  }

  private async startCouncilChild(
    round: CouncilRound,
    input: { modelId: string; effort: string | null; title: string; prompt: string },
  ): Promise<string> {
    const parent = this.context.db.getRun(round.runId);
    const project = this.context.db.getProject(parent.projectId);
    const model = this.context.db.getModel(input.modelId);
    const provider = this.context.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.context.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error(`Credentials are unavailable for ${provider.label}.`);
    }
    const configuredWorktreeRoot = this.context.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    const workspace = await this.prepareCouncilWorkspace(round, parent, project, configuredWorktreeRoot);
    let child: RunRecord;
    try {
      child = this.context.db.createRun({
        projectId: parent.projectId,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: getHarnessTypeForProvider(provider.providerType),
        mode: "ask",
        workspaceType: workspace.workspaceType,
        workspaceVcs: workspace.workspaceVcs,
        prompt: input.title,
        goalText: parent.goalText,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        kind: "council-review",
        parentRunId: parent.id,
        rootRunId: parent.rootRunId ?? parent.id,
        lineageTitle: input.title,
        workspaceSetupProfile: null,
        delegationEnabled: false,
      });
    } catch (error) {
      await this.discardPreparedRunWorkspace(project.repoPath, workspace);
      throw error;
    }
    this.context.db.upsertWorktree({ id: child.id, projectId: child.projectId, runId: child.id, branchName: child.branchName, worktreePath: child.worktreePath, status: "ready" });
    const inherited = input.modelId === parent.modelId ? this.services.turnState.getLatestRunExecutionOptions(parent.id, provider) : undefined;
    const executionOptions = resolveProviderExecutionOptions(provider, {
      executionOptions: mergeOrchestrationExecutionOptions(inherited, input.effort ?? undefined),
    });
    await this.services.runEvents.appendRunEvent(child.id, "log", "Validation task", input.title, {
      source: "council",
      commandType: "initial",
      councilRoundId: round.id,
      modelId: model.id,
      yoloMode: false,
      executionOptions,
    });
    child = this.context.db.updateRunStatus(child.id, "preparing");
    try {
      const worker = await this.startWorker(child, provider, model, apiKey ?? "", await this.services.settings.resolveNetworkProxyRuntimeConfig(), {
        promptOverride: input.prompt,
        providerOptions: executionOptions,
        yoloMode: false,
      });
      this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
    } catch (error) {
      this.context.db.updateRunStatus(child.id, "failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      await this.releaseCouncilChildWorkspace(child);
      throw error;
    }
    return child.id;
  }

  private async releaseCouncilChildWorkspace(child: RunRecord): Promise<void> {
    if (!existsSync(child.worktreePath)) return;
    const project = this.context.db.getProject(child.projectId);
    await this.discardPreparedRunWorkspace(project.repoPath, child);
    this.context.db.deleteProviderSessionRuntime(child.id, "run");
    this.services.turnState.clearRunCheckpoint(child.id);
  }

  private async startCouncilApply(round: CouncilRound, prompt: string, record: CouncilApplyRecord): Promise<void> {
    const run = this.context.db.getRun(round.runId);
    let mode: RunRecord["mode"] = run.mode;
    if (round.kind === "code") mode = "code";
    else if (round.restoreMode) mode = "ask";
    await this.services.appState.withPreservedRunSelection(() => this.followUpRunInternal(
      run.id,
      prompt,
      { mode, modelId: run.modelId, yoloMode: round.kind === "code" && latestUserTurnUsedFullAccess(this.context.db.getRunSteps(run.id)) },
      { councilRoundId: round.id, councilApply: record, displayPrompt: councilApplyStepContent(record) },
    ));
  }

  private async removeRunWorktreeForDeletion(repoPath: string, run: RunRecord, branchName: string | undefined): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.context.gitService.removeWorktree(repoPath, run.worktreePath, branchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
        return;
      } catch (error) {
        const retryDelay = WORKTREE_CLEANUP_RETRY_DELAYS_MS[attempt];
        const message = error instanceof Error ? error.message : String(error);
        if (retryDelay === undefined || !TRANSIENT_WORKTREE_CLEANUP_ERROR.test(message)) {
          throw error;
        }
        await delay(retryDelay);
      }
    }
  }

  /**
   * Removes a workspace prepared for a run that could not be created, so no unowned worktree
   * remains. Returns false, after logging why, when the workspace could not be removed.
   */
  private async discardPreparedRunWorkspace(
    repoPath: string,
    workspace: Pick<RunRecord, "workspaceType" | "branchName" | "worktreePath">,
  ): Promise<boolean> {
    try {
      if (workspace.workspaceType === "worktree") {
        await this.context.gitService.removeWorktree(repoPath, workspace.worktreePath, workspace.branchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
      } else if (workspace.workspaceType === "copy") {
        await removeFolderWorkspaceCopy(workspace.worktreePath);
      }
      return true;
    } catch (error) {
      this.context.logControllerWarn("Could not remove a prepared run workspace after run creation failed.", {
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        error,
      });
      return false;
    }
  }

  /**
   * Restores the previous checkout and run branch when a publish flow failed after creating a new
   * branch from the run HEAD, unless that branch already reached the remote or the project checkout.
   */
  private async rollbackCreatedRunBranch(
    run: RunRecord,
    repoPath: string,
    branches: { previousCheckout: string | null; originalRunBranch: string; created: string },
  ): Promise<void> {
    try {
      const pushRemote = await this.context.gitService.getPushRemote(run.worktreePath, branches.created).catch(() => undefined);
      if (!branches.previousCheckout || (await this.context.gitService.hasRemoteBranch(run.worktreePath, branches.created, pushRemote))) {
        return;
      }
      if (run.workspaceType === "worktree" && (await this.context.gitService.getCurrentBranch(repoPath).catch(() => "")) === branches.created) {
        return;
      }
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, branches.previousCheckout);
      this.context.db.updateRunBranchName(run.id, branches.originalRunBranch);
      await this.context.gitService.deleteProjectBranch(run.worktreePath, branches.created);
    } catch (error) {
      this.context.logControllerWarn("Could not restore the original run branch after a failed publish.", {
        runId: run.id,
        ...branches,
        error,
      });
    }
  }

  private async promoteRunBranchToProjectCheckout(
    run: RunRecord,
    repoPath: string,
    branchName: string,
    options?: { transferOpenChanges?: boolean; deleteReleasedBranchName?: string },
  ): Promise<void> {
    if (run.workspaceType !== "worktree") {
      await this.context.gitService.checkoutProjectBranch(repoPath, branchName);
      return;
    }

    const transferOpenChanges = options?.transferOpenChanges === true && (await this.context.gitService.hasChanges(run.worktreePath));

    await this.context.gitService.releaseWorktreeBranch(run.worktreePath, branchName);
    try {
      await this.context.gitService.checkoutProjectBranch(repoPath, branchName);
      if (transferOpenChanges) {
        // The target is the user's own checkout: never overwrite changes they made there.
        await this.context.gitService.cloneWorkspaceChanges(run.worktreePath, repoPath, { protectTargetChanges: true });
      }
    } catch (error) {
      await this.context.gitService.checkoutWorktreeBranch(run.worktreePath, branchName).catch(() => {});
      throw new Error(
        [
          `BuildWarden created branch "${branchName}", but could not check it out in the project repository or transfer the open changes.`,
          "Commit, stash, or discard local changes in the project repository and try again.",
          "",
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
      );
    }

    await this.context.gitService.removeWorktree(repoPath, run.worktreePath, options?.deleteReleasedBranchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
    this.context.db.updateRunWorkspace(run.id, "local", repoPath);
  }

  async deleteRunResources(
    repoPath: string,
    run: RunRecord,
    context: "run" | "project",
    options: { preserveBranch?: boolean } = {},
  ): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(run.id);
    const cleanupErrors: string[] = [];

    if (active) {
      // Detach before requesting shutdown: final messages must not mutate a deleting run.
      this.services.activeWorkers.runWorkers.delete(run.id);
      try {
        await stopWorkerAfterCleanup(active.worker, () => this.services.activeWorkers.requestRunWorkerStop(active));
      } catch (error) {
        cleanupErrors.push(`worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Servers the run left running would otherwise keep its workspace files open.
    await this.services.processes.stopOwnedProcessesForRemoval({ kind: "run", id: run.id });

    if (run.workspaceType === "worktree") {
      const ownedBranch = this.getOwnedRunBranchForDeletion(run, options);
      try {
        await this.removeRunWorktreeForDeletion(repoPath, run, ownedBranch);
      } catch (error) {
        const [worktreeRegistered, gitMetadataPresent, branchPresent] = await Promise.all([
          this.context.gitService.isWorktreeRegistered(repoPath, run.worktreePath).catch(() => true),
          this.context.gitService.hasWorktreeGitMetadata(run.worktreePath).catch(() => true),
          ownedBranch ? this.context.gitService.hasLocalBranch(repoPath, ownedBranch).catch(() => true) : Promise.resolve(false),
        ]);
        if (!worktreeRegistered && !gitMetadataPresent && !branchPresent) {
          const message = [
            "The run was removed from BuildWarden and Git cleanup completed, but Windows kept part of the old worktree folder locked.",
            "Close any running packaged BuildWarden app from that folder, Explorer preview, terminal, or antivirus scan, then delete the folder manually.",
          ].join(" ");
          logWarn("Run deletion left non-git filesystem residue after successful git cleanup.", {
            runId: run.id,
            branchName: run.branchName,
            worktreePath: run.worktreePath,
            error,
          });
          this.services.runEvents.emitAppWarning({
            title: "Run deleted, folder still locked",
            message,
            detail: run.worktreePath,
          });
        } else {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (run.workspaceType === "copy") {
      try {
        await removeFolderWorkspaceCopy(run.worktreePath);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (run.workspaceVcs === "folder") {
      try {
        await deleteFolderSnapshot(this.services.workspaceGuard.getFolderSnapshotRoot(), run.id);
      } catch (error) {
        logWarn("Failed to delete folder run snapshot.", {
          runId: run.id,
          worktreePath: run.worktreePath,
          error,
        });
      }
    }

    if (cleanupErrors.length > 0) {
      const message = [
        `Failed to delete resources for ${context === "project" ? "project cleanup" : "run deletion"}.`,
        `Run branch: ${run.branchName}`,
        ...cleanupErrors,
      ].join("\n");

      await this.services.runEvents.appendRunEvent(run.id, "error", "Deletion cleanup failed", message);
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: "error",
        title: "Deletion cleanup failed",
        content: message,
        createdAt: new Date().toISOString(),
      });

      throw new Error(message);
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
}
