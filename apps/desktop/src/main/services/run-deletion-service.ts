import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ChatRecord,
  type DataRetentionCleanupImpact,
  MAX_DATA_RETENTION_CLEANUP_DAYS,
  MIN_DATA_RETENTION_CLEANUP_DAYS,
  type OrchestrationRecord,
  type ProjectLabThreadRecord,
  type RunDeletionImpact,
  type RunRecord,
} from "@buildwarden/shared";
import { buildDataRetentionCleanupPlan, type DataRetentionCleanupPlan, retentionRootRunId } from "../data-retention";
import { deleteFolderSnapshot } from "../folder-diff";
import { removeFolderWorkspaceCopy } from "../folder-workspace";
import { logWarn } from "../logger";
import { stopWorkerAfterCleanup } from "../worker-shutdown";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";

const TRANSIENT_WORKTREE_CLEANUP_ERROR = /\b(?:EBUSY|EPERM|ENOTEMPTY)\b/i;
const WORKTREE_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

/** Deletes runs, their workspaces and data that is past its retention. */
export class RunDeletionService extends AppService<
  | "activeWorkers"
  | "appState"
  | "chatWorkerHost"
  | "chats"
  | "council"
  | "orchestration"
  | "orchestrationRecovery"
  | "processes"
  | "projectLab"
  | "projectLoops"
  | "runBranches"
  | "runEvents"
  | "runForge"
  | "titles"
  | "turnState"
  | "workspaceGuard"
> {
  notifyRunDeleted(runId: string): void {
    this.services.runForge.runForgeViewRefreshedAt.delete(runId);
    try {
      this.lifecycle.onRunDeleted?.(runId);
    } catch (error) {
      this.logControllerWarn("A run-deletion lifecycle callback failed.", { runId, error });
    }
  }

  async getRunDeletionImpact(runId: string): Promise<RunDeletionImpact> {
    this.db.getRun(runId);
    const childTask = this.db.getOrchestrationTaskByChildRunId(runId);
    const orchestration = childTask
      ? this.db.getOrchestration(childTask.orchestrationId)
      : this.db.getOrchestrationByCoordinatorRunId(runId);
    const coordinatorRunId = orchestration?.coordinatorRunId ?? runId;
    const childRunIds = orchestration
      ? this.db.listOrchestrationTasks(orchestration.id).flatMap((task) => task.childRunId ? [task.childRunId] : [])
      : [];
    const runIds = [...new Set([coordinatorRunId, ...childRunIds])];
    const runs = runIds.flatMap((id) => {
      try { return [this.db.getRun(id)]; } catch { return []; }
    });
    const ownedDirectories = runs
      .filter((entry) => entry.workspaceType === "worktree" || entry.workspaceType === "copy")
      .map((entry) => entry.worktreePath);
    const artifactPaths = orchestration
      ? [
          join(this.services.orchestration.getOrchestrationArtifactRoot(), orchestration.id),
          ...this.db.listOrchestrationWaves(orchestration.id).flatMap((wave) => wave.baselinePath ? [wave.baselinePath] : []),
          ...this.db.listOrchestrationTasks(orchestration.id).flatMap((task) => {
            const adoption = this.db.getOrchestrationAdoption(task.id);
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

  /** The run that a run is deleted with. A review belongs to its run, and that run may in turn belong to a coordinator. */
  private resolveRetentionRootRunId(run: RunRecord): string {
    const rootRunId = retentionRootRunId(run);
    const childTask = this.db.getOrchestrationTaskByChildRunId(rootRunId);
    if (!childTask) return rootRunId;
    try {
      return this.db.getOrchestration(childTask.orchestrationId).coordinatorRunId;
    } catch {
      /* The orchestration is gone; the run it left behind stands on its own. */
      return rootRunId;
    }
  }

  /** Every run that would now be deleted together with these runs, reviews that joined since the plan included. */
  private currentRetentionGroup(runIds: readonly string[]): string[] {
    const group = new Set<string>();
    for (const runId of runIds) {
      let run: RunRecord;
      try {
        run = this.db.getRun(runId);
      } catch {
        continue;
      }
      const rootRunId = this.resolveRetentionRootRunId(run);
      const orchestration = this.db.getOrchestrationByCoordinatorRunId(rootRunId);
      const childRunIds = orchestration
        ? this.db.listOrchestrationTasks(orchestration.id).flatMap((task) => task.childRunId ? [task.childRunId] : [])
        : [];
      for (const memberId of [runId, rootRunId, ...childRunIds]) {
        group.add(memberId);
        for (const reviewRunId of this.db.listCouncilChildRunIds(memberId)) group.add(reviewRunId);
      }
    }
    return [...group];
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

    const projects = this.db.listProjects();
    const runs = projects.flatMap((project) => this.db.listRunsForProject(project.id));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const rootRunIdByRunId = new Map<string, string>();
    for (const run of runs) {
      const rootRunId = this.resolveRetentionRootRunId(run);
      rootRunIdByRunId.set(run.id, runsById.has(rootRunId) ? rootRunId : run.id);
    }

    const projectLabThreads = projects.flatMap((project) => this.db.listProjectLabThreads(project.id));
    const projectLoops = projects.flatMap((project) => this.db.listProjectLoops(project.id).map((loop) => ({
      loop,
      runIds: this.db.listProjectLoopIterations(loop.id).flatMap((iteration) => iteration.runId ? [iteration.runId] : []),
    })));
    return buildDataRetentionCleanupPlan({
      dayCount,
      cutoffAt,
      runs,
      chats: this.db.listAllChats(),
      bookmarks: this.db.listBookmarks(),
      chatBookmarks: this.db.listChatBookmarks(),
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

  /** Whether a run that cleanup planned to delete was bookmarked, kept for later or used since. */
  private isRetentionGroupProtected(runIds: readonly string[], cutoffAt: string): boolean {
    const cutoffMs = Date.parse(cutoffAt);
    const chats = this.db.listAllChats();
    const bookmarkedRunIds = new Set(this.db.listBookmarks().map((bookmark) => bookmark.originalRunId));
    const bookmarkedChatIds = new Set(this.db.listChatBookmarks().map((bookmark) => bookmark.originalChatId));
    return runIds.some((runId) => {
      let run: RunRecord;
      try {
        run = this.db.getRun(runId);
      } catch {
        return false;
      }
      return bookmarkedRunIds.has(runId) || run.listVisibility === "for-later" || Date.parse(run.updatedAt) >= cutoffMs
        || chats.some((chat) => chat.runId === runId && (bookmarkedChatIds.has(chat.id) || Date.parse(chat.updatedAt) >= cutoffMs));
    });
  }

  async deleteDataRetentionCandidates(dayCount: number, cutoffAt: string): Promise<DataRetentionCleanupImpact> {
    const plan = this.createDataRetentionCleanupPlan(dayCount, cutoffAt);
    const { deletionRootRunIds, ...impact } = plan;
    const previousSelection = this.db.getSettings();
    // Deleting takes a while, so protection given meanwhile is read again before each deletion.
    const skippedRunIds = new Set<string>();
    const skipProtected = (runIds: readonly string[]): boolean => {
      const group = this.currentRetentionGroup(runIds);
      if (!this.isRetentionGroupProtected(group, cutoffAt)) return false;
      for (const runId of group) skippedRunIds.add(runId);
      return true;
    };
    const skippedChatIds = new Set<string>();

    try {
      for (const threadId of plan.projectLabThreadIds) {
        let thread: ProjectLabThreadRecord;
        try {
          thread = this.db.getProjectLabThread(threadId);
        } catch {
          continue;
        }
        if (thread.implementationRunId && skipProtected([thread.implementationRunId])) continue;
        await this.services.projectLab.deleteProjectLabThread(threadId);
      }
      for (const loopId of plan.projectLoopIds) {
        try {
          this.db.getProjectLoop(loopId);
        } catch {
          continue;
        }
        if (skipProtected(this.db.listProjectLoopIterations(loopId).flatMap((iteration) => iteration.runId ? [iteration.runId] : []))) continue;
        await this.services.projectLoops.loopRunner.deleteLoop(loopId);
      }
      for (const runId of deletionRootRunIds) {
        try {
          this.db.getRun(runId);
        } catch {
          continue;
        }
        if (skipProtected([runId])) continue;
        await this.deleteRun(runId);
      }
      for (const chatId of plan.chatIds) {
        let chat: ChatRecord;
        try {
          chat = this.db.getChat(chatId);
        } catch {
          continue;
        }
        if (
          Date.parse(chat.updatedAt) >= Date.parse(cutoffAt)
          || (chat.runId && skippedRunIds.has(chat.runId))
          || this.db.listChatBookmarks().some((bookmark) => bookmark.originalChatId === chatId)
        ) {
          skippedChatIds.add(chatId);
          continue;
        }
        await this.services.chats.deleteChat(chatId);
      }

      const exists = (read: () => unknown): boolean => {
        try {
          read();
          return true;
        } catch {
          return false;
        }
      };
      const remainingRunIds = plan.runIds.filter((runId) => exists(() => this.db.getRun(runId)));
      const remainingChatIds = plan.chatIds.filter((chatId) => exists(() => this.db.getChat(chatId)));
      if (remainingRunIds.some((runId) => !skippedRunIds.has(runId)) || remainingChatIds.some((chatId) => !skippedChatIds.has(chatId))) {
        throw new Error("Some old run or chat data could not be deleted. Retry on the next startup.");
      }
      const runIds = impact.runIds.filter((runId) => !remainingRunIds.includes(runId));
      const chatIds = impact.chatIds.filter((chatId) => !remainingChatIds.includes(chatId));
      const projectLabThreadIds = impact.projectLabThreadIds.filter((threadId) => !exists(() => this.db.getProjectLabThread(threadId)));
      const projectLoopIds = impact.projectLoopIds.filter((loopId) => !exists(() => this.db.getProjectLoop(loopId)));
      return {
        ...impact,
        runIds,
        chatIds,
        projectLabThreadIds,
        projectLoopIds,
        runCount: runIds.length,
        chatCount: chatIds.length,
        projectLabThreadCount: projectLabThreadIds.length,
        projectLoopCount: projectLoopIds.length,
      };
    } finally {
      this.services.appState.restoreSelectionAfterDeletion(previousSelection);
    }
  }

  async deleteRun(runId: string, options: { preserveBranch?: boolean } = {}): Promise<void> {
    this.services.titles.sessionTitleServiceInstance?.cancel("run", runId);
    const run = this.db.getRun(runId);
    if (run.kind === "council-review") throw new Error("Validation reviews are removed with the run they belong to.");
    const ownedTask = this.db.getOrchestrationTaskByChildRunId(runId);
    if (ownedTask) {
      let owner: OrchestrationRecord | null = null;
      try {
        owner = this.db.getOrchestration(ownedTask.orchestrationId);
      } catch {
        /* Treat an orphaned task reference as stale and delete the surviving run normally. */
      }
      if (owner) {
        throw new Error(`This run is owned by an orchestration. Delete coordinator run ${owner.coordinatorRunId} instead.`);
      }
    }
    await this.services.council.deleteCouncilChildren(run);
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(runId);
    if (orchestration) {
      await this.services.orchestrationRecovery.deleteOrchestrationCascade(run, orchestration);
      return;
    }
    const project = this.db.getProject(run.projectId);

    this.terminal.killForRunId(runId);
    this.services.turnState.clearRunCheckpoint(runId);
    this.services.turnState.clearRunPromptRestorePoint(runId);
    this.db.deleteProviderSessionRuntime(runId, "run");
    for (const runChat of this.db.getChatsForRun(runId)) {
      await this.services.chats.cancelStartingChat(runChat.id);
      const activeChat = this.services.activeWorkers.chatWorkers.get(runChat.id);
      if (activeChat) {
        activeChat.cancelled = true;
        const stopped = stopWorkerAfterCleanup(activeChat.worker, () => activeChat.worker.postMessage({ type: "cancel" }));
        this.services.activeWorkers.chatWorkers.delete(runChat.id);
        this.services.chatWorkerHost.chatUserInputRequests.delete(runChat.id);
        this.db.closeChatUserInputRequests(runChat.id);
        await stopped;
      }
      this.db.deleteProviderSessionRuntime(runChat.id, "chat");
      await this.services.chats.removeChatWorkspaceBestEffort(runChat.id);
    }
    await this.deleteRunResources(project.repoPath, run, "run", options);
    this.db.deleteRun(runId);
    this.services.processes.ownedProcessRegistryInstance?.forgetOwner({ kind: "run", id: runId });
    this.notifyRunDeleted(runId);
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
  }

  private async removeRunWorktreeForDeletion(repoPath: string, run: RunRecord, branchName: string | undefined): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.gitService.removeWorktree(repoPath, run.worktreePath, branchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
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
  async discardPreparedRunWorkspace(
    repoPath: string,
    workspace: Pick<RunRecord, "workspaceType" | "branchName" | "worktreePath">,
  ): Promise<boolean> {
    try {
      if (workspace.workspaceType === "worktree") {
        await this.gitService.removeWorktree(repoPath, workspace.worktreePath, workspace.branchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
      } else if (workspace.workspaceType === "copy") {
        await removeFolderWorkspaceCopy(workspace.worktreePath);
      }
      return true;
    } catch (error) {
      this.logControllerWarn("Could not remove a prepared run workspace after run creation failed.", {
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
  async rollbackCreatedRunBranch(
    run: RunRecord,
    repoPath: string,
    branches: { previousCheckout: string | null; originalRunBranch: string; created: string },
  ): Promise<void> {
    try {
      const pushRemote = await this.gitService.getPushRemote(run.worktreePath, branches.created).catch(() => undefined);
      if (!branches.previousCheckout || (await this.gitService.hasRemoteBranch(run.worktreePath, branches.created, pushRemote))) {
        return;
      }
      if (run.workspaceType === "worktree" && (await this.gitService.getCurrentBranch(repoPath).catch(() => "")) === branches.created) {
        return;
      }
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, branches.previousCheckout);
      this.db.updateRunBranchName(run.id, branches.originalRunBranch);
      await this.gitService.deleteProjectBranch(run.worktreePath, branches.created);
    } catch (error) {
      this.logControllerWarn("Could not restore the original run branch after a failed publish.", {
        runId: run.id,
        ...branches,
        error,
      });
    }
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
      const ownedBranch = this.services.runBranches.getOwnedRunBranchForDeletion(run, options);
      try {
        await this.removeRunWorktreeForDeletion(repoPath, run, ownedBranch);
      } catch (error) {
        const [worktreeRegistered, gitMetadataPresent, branchPresent] = await Promise.all([
          this.gitService.isWorktreeRegistered(repoPath, run.worktreePath).catch(() => true),
          this.gitService.hasWorktreeGitMetadata(run.worktreePath).catch(() => true),
          ownedBranch ? this.gitService.hasLocalBranch(repoPath, ownedBranch).catch(() => true) : Promise.resolve(false),
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
}
