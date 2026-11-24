import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  APP_SETTING_KEYS,
  parseCouncilSettings,
  parseProjectRunDefaultsSetting,
  previewLargeStepContents,
  resolveCouncilReviewers,
  type RunDetail,
  type RunHistoryPage,
  type RunWorkspaceFileInput,
  type RunWorkspaceFileResult,
  type RunWorktreeDiffResult,
  type RunWorktreeDiffSummary,
  type RunWorktreeDiffSummaryResult,
  type UserAnchoredHistoryPageRequest,
  type WorkspaceCodeMapResult,
} from "@buildwarden/shared";
import { diffFolderAgainstSnapshot, summarizeFolderAgainstSnapshot } from "../folder-diff";
import { hydrateResponseImageSteps } from "../response-images";
import { readRunWorkspaceFileForPreview } from "../run-workspace-file";
import { runWorktreeDiffInWorker } from "../run-worktree-diff-worker";
import { scanWorkspaceCodeMap } from "../workspace-code-map";
import { captureWorkspaceRevision } from "../workspace-revision";
import { AppService } from "./app-service";
import { FOLDER_BASELINE_MISSING_REASON } from "./app-service-constants";
import { providerSupportsInterruptedRunRecovery } from "./provider-model-support";
import { resolveRecoveryKind } from "./run-recovery-service";

const describeInterruptedRecoveryDetail = (hasCheckpoint: boolean, providerSessionAvailable: boolean): string => {
  if (hasCheckpoint) {
    return "BuildWarden saved a checkpoint from the last completed tool round and can start a deliberate recovery turn.";
  }
  if (providerSessionAvailable) {
    return "BuildWarden saved the provider session cursor and can continue from the current workspace state.";
  }
  return "No checkpoint or provider session cursor was saved before the application closed.";
};

/** Reads run history, workspace files and diffs for the run page. */
export class RunDetailService extends AppService<"activeWorkers" | "turnState" | "workspaceGuard"> {
  private readonly runWorktreeDiffSummaryInflight = new Map<string, Promise<RunWorktreeDiffSummary>>();
  private readonly workspaceCodeMapInflight = new Map<string, Promise<WorkspaceCodeMapResult>>();

  /** Read-only scan of the project's checkout; concurrent requests for the same repository share one scan. */
  async getProjectCodeMap(projectId: string): Promise<WorkspaceCodeMapResult> {
    const workspacePath = resolve(this.db.getProject(projectId).repoPath);
    if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
      return { files: [], truncated: false, workspaceUnavailable: true };
    }
    const pending = this.workspaceCodeMapInflight.get(workspacePath) ?? scanWorkspaceCodeMap(workspacePath);
    this.workspaceCodeMapInflight.set(workspacePath, pending);
    try {
      return await pending;
    } catch (error) {
      this.logControllerWarn("Could not build the project code map.", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { files: [], truncated: false, workspaceUnavailable: true };
    } finally {
      if (this.workspaceCodeMapInflight.get(workspacePath) === pending) {
        this.workspaceCodeMapInflight.delete(workspacePath);
      }
    }
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const providerRecoverySupported = providerSupportsInterruptedRunRecovery(provider.providerType);
    const branchPromotedToProject = this.services.workspaceGuard.wasRunPromotedToProject(runId);
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const checkpoint = this.services.turnState.getRunCheckpoint(runId);
    const promptRestorePoint = this.services.turnState.getRunPromptRestorePoint(runId);
    const history = this.db.getInitialRunHistory(runId);
    const providerRuntime = this.services.turnState.resolveRunNativeSession(run, provider).session;
    const { latestInterruptedAt, latestRecoveryAt } = this.db.getRunRecoveryEventTimestamps(runId);
    const sessionInterrupted = Boolean(latestInterruptedAt) && latestInterruptedAt > latestRecoveryAt;
    const providerSessionAvailable = Boolean(providerRuntime?.resumeCursor);
    const canRecoverInterruptedSession =
      providerRecoverySupported && sessionInterrupted && !this.services.activeWorkers.runWorkers.has(runId) && (Boolean(checkpoint) || providerSessionAvailable);
    const recoveryKind = resolveRecoveryKind(true, Boolean(checkpoint), providerSessionAvailable);
    return {
      run,
      steps: previewLargeStepContents(hydrateResponseImageSteps(workspacePath, history.steps)),
      queuedFollowUps: this.db.listQueuedFollowUps("run", runId),
      historyPage: history.page,
      notes: this.db.listRunNotes(runId),
      workspaceSetup: this.db.getRunWorkspaceSetup(runId),
      diff: "",
      orchestration: this.db.getOrchestrationDetailByCoordinatorRunId(runId),
      councilRounds: this.db.listCouncilRounds(runId),
      councilAvailable: resolveCouncilReviewers(parseCouncilSettings(this.db.getSettings()[APP_SETTING_KEYS.council]), this.db.listModels()).length > 0,
      workspacePath,
      branchPromotedToProject,
      diffLoaded: false,
      diffPending: false,
      diffSummaryPending: true,
      worktreeUnavailable: false,
      latestCheckpoint: checkpoint ? { round: checkpoint.round, memo: checkpoint.memo } : null,
      canResumeFromCheckpoint: Boolean(checkpoint) && !this.services.activeWorkers.runWorkers.has(runId),
      canRecoverInterruptedSession,
      interruptedRecovery: sessionInterrupted && providerRecoverySupported
        ? {
            available: canRecoverInterruptedSession,
            kind: recoveryKind ?? "provider-session",
            title: canRecoverInterruptedSession ? "Recovery path available" : "Session interrupted",
            detail: describeInterruptedRecoveryDetail(Boolean(checkpoint), providerSessionAvailable),
            providerType: providerRuntime?.providerType,
            checkpointRound: checkpoint?.round,
            providerSessionAvailable,
          }
        : null,
      promptRestorePoints: this.db.listRunTurnRestorePoints(runId),
      pendingRewind: this.db.getPendingRunRewind(runId)?.input ?? null,
      latestPromptRestorePoint: promptRestorePoint
        ? { createdAt: promptRestorePoint.createdAt, commandType: promptRestorePoint.commandType }
        : null,
    };
  }

  async getEarlierRunHistory(runId: string, request: UserAnchoredHistoryPageRequest): Promise<RunHistoryPage> {
    const history = this.db.getEarlierRunHistory(runId, request);
    return {
      ...history,
      steps: previewLargeStepContents(hydrateResponseImageSteps(this.services.workspaceGuard.getEffectiveRunWorkspacePath(this.db.getRun(runId)), history.steps)),
    };
  }

  async getRunWorkspaceFile(input: RunWorkspaceFileInput): Promise<RunWorkspaceFileResult> {
    const run = this.db.getRun(input.runId);
    const project = this.db.getProject(run.projectId);
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const requestedPath = typeof input.path === "string" ? input.path : "";

    try {
      return await readRunWorkspaceFileForPreview({ workspacePath, requestedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read file.";
      this.logControllerWarn("Could not read run workspace file.", { runId: run.id, path: requestedPath, error: message });
      return {
        path: requestedPath,
        requestedPath,
        workspacePath,
        content: null,
        sizeBytes: null,
        truncated: false,
        line: null,
        column: null,
        unavailableReason: "read-error",
        error: message,
      };
    }
  }

  async getRunWorktreeDiff(runId: string): Promise<RunWorktreeDiffResult> {
    const run = this.db.getRun(runId);
    const commands = parseProjectRunDefaultsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults])[run.projectId]?.verificationCommands ?? [];
    // Only bind the displayed patch to a verification revision when verification is configured.
    if (!commands.length || ["queued", "preparing", "running"].includes(run.status)) return this.readRunWorktreeDiff(runId);
    const path = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId));
    const before = await captureWorkspaceRevision(path, run.workspaceVcs).catch(() => null);
    const result = await this.readRunWorktreeDiff(runId);
    if (!before || result.worktreeUnavailable) return { ...result, diffRevision: null };
    const after = await captureWorkspaceRevision(path, run.workspaceVcs).catch(() => null);
    return { ...result, diffRevision: before.fingerprint === after?.fingerprint && before.head === after.head ? before : null };
  }

  async readRunWorktreeDiff(runId: string): Promise<RunWorktreeDiffResult> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    if (run.workspaceVcs === "folder") {
      if (!existsSync(run.worktreePath) || !statSync(run.worktreePath).isDirectory()) {
        return {
          diff: "",
          worktreeUnavailable: true,
          diffUnavailableReason: "The folder workspace is no longer available.",
        };
      }
      const outcome = await diffFolderAgainstSnapshot({
        runId: run.id,
        workspacePath: run.worktreePath,
        snapshotsRoot: this.services.workspaceGuard.getFolderSnapshotRoot(),
      });
      return {
        diff: outcome.diff,
        worktreeUnavailable: outcome.missingSnapshot,
        diffUnavailableReason: outcome.missingSnapshot ? FOLDER_BASELINE_MISSING_REASON : null,
      };
    }

    const diffPath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const outcome = await runWorktreeDiffInWorker(diffPath);
    if (!outcome.ok) {
      return { diff: "", worktreeUnavailable: true, diffUnavailableReason: "The Git workspace is no longer available." };
    }
    return { diff: outcome.diff, worktreeUnavailable: false };
  }

  async getRunWorktreeDiffSummary(runId: string): Promise<RunWorktreeDiffSummaryResult> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const diffPath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    if (!existsSync(diffPath) || !statSync(diffPath).isDirectory()) {
      return {
        summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 },
        worktreeUnavailable: true,
        diffUnavailableReason: run.workspaceVcs === "folder"
          ? "The folder workspace is no longer available."
          : "The Git workspace is no longer available.",
      };
    }

    if (run.workspaceVcs === "folder") {
      const outcome = await summarizeFolderAgainstSnapshot({
        runId: run.id,
        workspacePath: diffPath,
        snapshotsRoot: this.services.workspaceGuard.getFolderSnapshotRoot(),
      });
      return {
        summary: outcome.summary,
        worktreeUnavailable: outcome.missingSnapshot,
        diffUnavailableReason: outcome.missingSnapshot ? FOLDER_BASELINE_MISSING_REASON : null,
      };
    }

    try {
      const normalizedPath = resolve(diffPath);
      const existing = this.runWorktreeDiffSummaryInflight.get(normalizedPath);
      const pending = existing ?? this.gitService.getDiffSummary(normalizedPath);
      this.runWorktreeDiffSummaryInflight.set(normalizedPath, pending);
      try {
        return { summary: await pending, worktreeUnavailable: false };
      } finally {
        if (this.runWorktreeDiffSummaryInflight.get(normalizedPath) === pending) {
          this.runWorktreeDiffSummaryInflight.delete(normalizedPath);
        }
      }
    } catch (error) {
      this.logControllerWarn("Could not compute the run worktree diff summary.", {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 },
        worktreeUnavailable: true,
        diffUnavailableReason: "The Git workspace is no longer available.",
      };
    }
  }
}
