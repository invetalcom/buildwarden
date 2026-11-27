import { dirname, join } from "node:path";
import type { RunRecord, RunRewindArchive, RunRewindInput, RunRewindResult } from "@buildwarden/shared";
import { executeRunRewind } from "../run-rewind-service";
import { canonicalWorkspacePath, workspacePathsOverlap } from "../workspace-restore-safety";
import { AppService } from "./app-service";
import { SESSION_INTERRUPTED_MESSAGE } from "./app-service-constants";
import { providerAllowsMissingApiKey, providerSupportsInterruptedRunRecovery } from "./provider-model-support";
import { latestRunExecutionSettings } from "./run-execution-settings";
import { resolveRecoveryKind } from "./run-recovery-kind";
import { AUTOMATION_RUN_NOTE, latestTurnRequest } from "./run-step-content";

/** Resumes interrupted runs and rewinds runs to earlier prompts. */
export class RunRecoveryService extends AppService<
  | "activeWorkers"
  | "followUps"
  | "providerRuntime"
  | "runEvents"
  | "runWorkerHost"
  | "settings"
  | "turnState"
  | "workspaceGuard"
> {
  /**
   * Workers live only in memory; after a cold start the DB may still list runs/chats as queued/running.
   * Mark those rows terminal, reset worktree bookkeeping, and append an explanatory step.
   */
  async reconcileOrphanedActiveSessions(): Promise<void> {
    this.db.clearPendingSessionTitles();
    const activeStatuses: RunRecord["status"][] = ["queued", "preparing", "running"];
    this.services.followUps.reconcileInterruptedFollowUpDeliveries();

    // Every row is handled on its own: one run whose model, provider or worktree cannot be read
    // must not leave the runs and chats after it marked as running.
    const staleRuns = this.db.listRunsWithStatuses(activeStatuses).filter((run) => !this.services.activeWorkers.runWorkers.has(run.id));
    for (const run of staleRuns) {
      const recovery = this.readInterruptedRunRecovery(run);
      this.db.updateRunStatus(run.id, "cancelled", { errorMessage: SESSION_INTERRUPTED_MESSAGE });
      // The run is no longer picked up at the next start, so each step is attempted even when another fails.
      const ids = { runId: run.id };
      await this.attemptRecoveryStep("Could not mark an interrupted run's worktree ready.", ids, () =>
        this.services.workspaceGuard.updateWorktreeStatus(run, "ready"));
      await this.attemptRecoveryStep("Marked an interrupted run cancelled but could not record why.", ids, () =>
        this.services.runEvents.appendRunEvent(run.id, "status", "Session interrupted", SESSION_INTERRUPTED_MESSAGE, {
          sessionInterrupted: true,
          ...recovery,
        }));
    }

    const staleChats = this.db.listChatsWithStatuses(activeStatuses).filter((chat) => !this.services.activeWorkers.chatWorkers.has(chat.id));
    for (const chat of staleChats) {
      this.db.updateChatStatus(chat.id, "cancelled", { finishedAt: new Date().toISOString() });
      const ids = { chatId: chat.id };
      await this.attemptRecoveryStep("Could not close an interrupted chat's open questions.", ids, () =>
        this.db.closeChatUserInputRequests(chat.id));
      await this.attemptRecoveryStep("Marked an interrupted chat cancelled but could not record why.", ids, () =>
        this.services.runEvents.appendChatEvent(chat.id, "status", "Session interrupted", SESSION_INTERRUPTED_MESSAGE, {
          sessionInterrupted: true,
        }));
    }
  }

  private async attemptRecoveryStep(failure: string, ids: Record<string, string>, step: () => unknown): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logControllerError(failure, error, ids);
    }
  }

  /** Whether an interrupted run can continue; a run whose model or provider cannot be read cannot. */
  private readInterruptedRunRecovery(run: RunRecord): { canRecoverInterruptedSession: boolean; recoveryKind: ReturnType<typeof resolveRecoveryKind> } {
    try {
      const checkpoint = Boolean(this.services.turnState.getRunCheckpoint(run.id));
      const model = this.db.getModel(run.modelId);
      const provider = this.db.getProviderAccount(model.providerAccountId);
      const resumeCursor = Boolean(this.services.turnState.resolveRunNativeSession(run, provider).session?.resumeCursor);
      const supported = providerSupportsInterruptedRunRecovery(provider.providerType);
      return {
        canRecoverInterruptedSession: supported && (checkpoint || resumeCursor),
        recoveryKind: resolveRecoveryKind(supported, checkpoint, resumeCursor),
      };
    } catch (error) {
      this.logControllerError("Could not read how to recover an interrupted run; it is marked cancelled without recovery.", error, { runId: run.id });
      return { canRecoverInterruptedSession: false, recoveryKind: null };
    }
  }

  async resumeRunFromCheckpoint(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
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
    const run = this.db.getRun(runId);
    if (this.services.activeWorkers.runWorkers.has(runId)) {
      throw new Error("This run is already active.");
    }

    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
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

    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider credentials are not available.");
    }

    // A failing lookup must leave the interrupted run recoverable.
    const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      "Recovery confirmed",
      "Starting a new turn with the saved provider session and current workspace state.",
      { recoveredInterruptedSession: true, recoveryKind: "provider-session" },
    );

    const worker = await this.services.runWorkerHost.startWorker(run, provider, model, apiKey ?? "", networkProxy, {
      promptOverride: this.buildInterruptedRunRecoveryPrompt(run),
      recoverSkills: true,
      providerOptions: this.services.turnState.getLatestRunExecutionOptions(run.id, provider),
      yoloMode: latestRunExecutionSettings(this.db.getRunSteps(run.id))?.yoloMode === true,
    });
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
  }

  async getRunRewindHistory(runId: string): Promise<RunRewindArchive[]> {
    this.db.getRun(runId);
    return this.db.getRunRewindHistory(runId);
  }

  /** Serializes rewind with project mutations and rejects active or coordinated work before restoration. */
  async rewindRun(input: RunRewindInput): Promise<RunRewindResult> {
    if (!["conversation", "conversation-and-files"].includes(input.mode)) throw new Error("Invalid rewind mode.");
    const initial = this.db.getRun(input.runId);
    return this.services.workspaceGuard.serializeProjectBranchMutation(initial.projectId, async () => {
      const run = this.db.getRun(input.runId);
      this.services.workspaceGuard.requireIdleRunWorkspace(run, "rewinding the conversation");
      // Delegation switched on is fine until the run hands out tasks; then its turns belong to them.
      if (run.kind !== "standard" || this.db.getOrchestrationByCoordinatorRunId(run.id)) {
        throw new Error("Rewind is available for independent runs. Runs that delegated tasks, and the delegated runs, must stay aligned with their tasks.");
      }
      if (this.db.listCouncilRounds(run.id).some((round) => ["reviewing", "assessing", "applying"].includes(round.status))) {
        throw new Error("Wait for validation and applying findings to finish before rewinding.");
      }
      if (this.db.listQueuedFollowUps("run", run.id).length) throw new Error("Remove queued follow-ups before rewinding.");
      const path = canonicalWorkspacePath(run.worktreePath);
      if ([...this.services.workspaceGuard.restoringWorkspaces].some((other) => workspacePathsOverlap(other, path))) throw new Error("A workspace restore is already running.");
      this.services.workspaceGuard.restoringWorkspaces.add(path);
      try {
        if (input.mode === "conversation-and-files") {
          this.services.workspaceGuard.requireGitRun(run, "File rewind");
          this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run);
        }
        const result = await executeRunRewind({ db: this.db, git: this.gitService, run, input,
          beforeRestoreFiles: () => this.terminal.killForRunId(run.id),
          assertSafe: () => this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run), networkProxy: await this.services.settings.resolveNetworkProxyRuntimeConfig() });
        this.services.runEvents.emitEvent({ runId: run.id, type: "status", title: "Conversation rewound", content: "Reload the run to view its retained history.",
          metadata: { conversationRewound: true, providerStrategy: result.providerStrategy }, createdAt: new Date().toISOString() });
        return result;
      } finally { this.services.workspaceGuard.restoringWorkspaces.delete(path); }
    });
  }

  async undoRunToLastPrompt(runId: string): Promise<void> {
    const latest = this.db.listRunTurnRestorePoints(runId).at(-1);
    if (latest) {
      await this.rewindRun({ runId, restorePointId: latest.id, mode: "conversation-and-files" });
      return;
    }
    const initialRun = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Undo to last prompt");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, async () => {
      const path = canonicalWorkspacePath(this.db.getRun(runId).worktreePath);
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
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "undoing changes");
    const restorePoint = this.services.turnState.getRunPromptRestorePoint(runId);
    if (!restorePoint) {
      throw new Error("No prompt restore point is available for this run.");
    }
    this.services.workspaceGuard.requireIsolatedRestoreWorkspace(run);
    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const { safetyPatchPath } = await this.gitService.restorePromptRestorePatch(run.worktreePath, restorePoint.patch, {
      expectedHeadSha: restorePoint.headSha,
      safetyPatchPath: join(dirname(this.db.getFilePath()), "restore-backups", `${runId}-${Date.now().toString()}.patch`),
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

  private async resumeInterruptedRunFromCheckpoint(run: RunRecord, origin: "startup" | "manual" = "startup"): Promise<boolean> {
    return this.services.workspaceGuard.serializeRunStart(run.id, () => this.resumeInterruptedRunFromCheckpointUnlocked(this.db.getRun(run.id), origin));
  }

  private async resumeInterruptedRunFromCheckpointUnlocked(run: RunRecord, origin: "startup" | "manual" = "startup"): Promise<boolean> {
    const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
    if (!checkpoint) {
      return false;
    }

    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(run.projectId, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      return false;
    }

    const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.services.runEvents.appendRunEvent(
      run.id,
      "status",
      origin === "manual" ? "Recovery confirmed" : "Run resumed from checkpoint",
      checkpoint.memo || "Restarted from the last completed tool round.",
      { resumedFromCheckpoint: true, recoveredInterruptedSession: origin === "manual", round: checkpoint.round },
    );

    const worker = await this.services.runWorkerHost.startWorker(run, provider, model, apiKey ?? "", networkProxy, {
      providerOptions: this.services.turnState.getLatestRunExecutionOptions(run.id, provider),
      yoloMode: latestRunExecutionSettings(this.db.getRunSteps(run.id))?.yoloMode === true,
    });
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
    return true;
  }

  private buildInterruptedRunRecoveryPrompt(run: RunRecord): string {
    // The app may have closed during a follow-up, so the request to finish is the latest one.
    const latest = latestTurnRequest(this.db.getRunSteps(run.id));
    const latestRequest = latest?.text ?? run.prompt;
    const memory = this.services.turnState.buildRunFollowUpMemo(run.id, { sessionHoldsHistory: false, includeGoal: true });
    return [
      run.kind === "automation" ? `${AUTOMATION_RUN_NOTE}\n` : "",
      "BuildWarden closed while you were working on this run, so your last turn was interrupted.",
      "Continue from the current workspace state and the saved session. Do not assume the interrupted work finished: first check what already changed, avoid repeating completed work, then finish the request below.",
      "",
      `<interrupted_request>\n${latestRequest}\n</interrupted_request>`,
      latest?.internal
        ? "BuildWarden started that turn itself, so the text above may be only its short label. If your saved session holds the full message, follow that."
        : "",
      latestRequest.trim() === run.prompt.trim() ? "" : `<original_run_task>\n${run.prompt}\n</original_run_task>`,
      memory,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
