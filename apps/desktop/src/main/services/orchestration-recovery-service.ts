import { existsSync } from "node:fs";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { OrchestrationRecord, OrchestrationTaskRecord, RunDeletionImpact, RunRecord } from "@buildwarden/shared";
import { AGENT_ACTIVITY_EVENT_TYPES } from "../orchestration-delivery";
import { recoverOrchestrationAdoption, removeOwnedOrchestrationArtifact } from "../orchestration-workspace";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY, SESSION_INTERRUPTED_MESSAGE } from "./app-service-constants";
import { isSettledChildRun } from "./orchestration-policy";
import { providerSupportsInterruptedRunRecovery } from "./provider-model-support";
import { latestUserTurnUsedFullAccess, resolveOrchestrationChildFullAccess } from "./run-execution-settings";

/** Reconciles orchestrations after a restart and deletes them completely. */
export class OrchestrationRecoveryService extends AppService<
  | "chats"
  | "orchestration"
  | "orchestrationCoordinator"
  | "orchestrationDispatch"
  | "orchestrationResults"
  | "processes"
  | "runDeletion"
  | "runRecovery"
  | "turnState"
> {
  async deleteOrchestrationCascade(
    coordinator: RunRecord,
    orchestration: OrchestrationRecord,
    existingManifest?: Record<string, unknown>,
    existingJobId?: string,
  ): Promise<void> {
    const impact = existingManifest
      ? existingManifest as unknown as RunDeletionImpact
      : await this.services.runDeletion.getRunDeletionImpact(coordinator.id);
    const jobId = existingJobId ?? this.db.createOrchestrationCleanupJob({
      coordinatorRunId: coordinator.id,
      orchestrationId: orchestration.id,
      manifest: impact as unknown as Record<string, unknown>,
    });
    this.db.updateOrchestration(orchestration.id, { status: "deleting", errorMessage: null });
    this.db.updateOrchestrationCleanupJob(jobId, "running");
    await this.db.flushDurable();

    const project = this.db.getProject(coordinator.projectId);
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
          ownedRun = this.db.getRun(id);
        } catch {
          continue;
        }
        this.services.turnState.clearRunCheckpoint(id);
        this.services.turnState.clearRunPromptRestorePoint(id);
        this.db.deleteProviderSessionRuntime(id, "run");
        for (const runChat of this.db.getChatsForRun(id)) {
          this.db.deleteProviderSessionRuntime(runChat.id, "chat");
          await this.services.chats.removeChatWorkspaceBestEffort(runChat.id);
        }
        await this.services.runDeletion.deleteRunResources(project.repoPath, ownedRun, "run");
        if (
          (ownedRun.workspaceType === "worktree" || ownedRun.workspaceType === "copy") &&
          existsSync(ownedRun.worktreePath)
        ) {
          throw new Error(`A locked app-owned workspace directory remains: ${ownedRun.worktreePath}`);
        }
      }

      const artifactRoot = this.services.orchestration.getOrchestrationArtifactRoot();
      const orchestrationArtifactPath = join(artifactRoot, orchestration.id);
      if (existsSync(orchestrationArtifactPath)) {
        await removeOwnedOrchestrationArtifact(artifactRoot, orchestrationArtifactPath);
      }
      if (existsSync(orchestrationArtifactPath)) {
        throw new Error(`An app-owned orchestration artifact directory remains: ${orchestrationArtifactPath}`);
      }

      this.db.deleteBookmarksForRunIds(runIds);
      this.db.deleteChatBookmarksForRunIds(runIds);
      for (const id of childIds) this.db.deleteRun(id);
      this.db.deleteRun(coordinator.id);
      // Keep the orchestration journal until every owned run row is gone. A
      // startup retry can then distinguish "filesystem cleanup completed"
      // from an interruption that still requires owned-resource removal.
      this.db.deleteOrchestrationData(orchestration.id);
      await this.db.flushDurable();
      this.db.completeOrchestrationCleanupJob(jobId);
      for (const id of runIds) this.services.runDeletion.notifyRunDeleted(id);
      this.db.deleteSetting(SELECTED_RUN_KEY);
      this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
      this.events.publish("orchestration", {
        projectId: project.id,
        coordinatorRunId: coordinator.id,
        orchestrationId: orchestration.id,
        status: "completed",
        sequence: orchestration.lastEventSequence + 1,
        deletedRunIds: runIds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateOrchestrationCleanupJob(jobId, "failed", message);
      try {
        this.db.updateOrchestration(orchestration.id, { status: "deletion-failed", errorMessage: message });
        this.db.appendOrchestrationEvent({
          orchestrationId: orchestration.id,
          type: "deletion-failed",
          title: "Deletion cleanup failed",
          content: message,
        });
        this.services.orchestration.emitOrchestrationChanged(orchestration.id);
      } catch {
        /* The metadata may already be gone after an externally interrupted final flush. */
      }
      await this.db.flushDurable();
      throw new Error(`Orchestration deletion is incomplete and can be retried. ${message}`);
    }
  }

  async reconcileOrchestrationsAfterRestart(): Promise<void> {
    // Keep interrupted receipts: a provider side effect may already have happened.
    this.db.recoverInterruptedOrchestrationOperations();
    this.db.recoverOrchestrationMessageDeliveries();
    await this.services.orchestration.orchestrationRuntimeActions.recover();
    await this.db.flushDurable();

    const reconcileCleanupJob = async (
      job: ReturnType<BuildWardenDatabase["listPendingOrchestrationCleanupJobs"]>[number],
    ): Promise<void> => {
      try {
        let coordinator: RunRecord | null = null;
        let orchestration: OrchestrationRecord | null = null;
        try {
          coordinator = this.db.getRun(job.coordinatorRunId);
        } catch {
          coordinator = null;
        }
        try {
          orchestration = job.orchestrationId ? this.db.getOrchestration(job.orchestrationId) : null;
        } catch {
          orchestration = null;
        }
        if (coordinator && orchestration) {
          await this.deleteOrchestrationCascade(coordinator, orchestration, job.manifest, job.id);
        } else {
          await this.completeFinalizedOrchestrationCleanupJob(job);
        }
      } catch (error) {
        this.logControllerWarn("Durable orchestration cleanup remains retryable after startup.", {
          coordinatorRunId: job.coordinatorRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    for (const job of this.db.listPendingOrchestrationCleanupJobs()) {
      await reconcileCleanupJob(job);
    }

    const active = this.db.listOrchestrationsWithStatuses(["active", "waiting", "paused", "attention"]);
    // A workspace a failed launch could not remove stays recorded until it is gone, even after its
    // orchestration ended. Active orchestrations resume their effects below.
    const activeIds = new Set(active.map((orchestration) => orchestration.id));
    for (const effect of this.db.listPendingOrchestrationEffects({ kind: "launch-child" })) {
      if (activeIds.has(effect.orchestrationId)) continue;
      try {
        await this.services.orchestrationResults.resumeChildLaunch(effect);
      } catch (error) {
        this.logControllerWarn("Could not retry removing a failed child launch's workspace.", { effectId: effect.id, error });
      }
    }
    await this.db.flushDurable();
    const reconcileActiveOrchestration = async (initial: OrchestrationRecord): Promise<void> => {
      // Finish or roll back interrupted effects first, so the checks below see their outcome.
      await this.services.orchestrationResults.resumePendingOrchestrationEffects(initial.id);
      const orchestration = this.db.getOrchestration(initial.id);
      const coordinator = this.db.getRun(orchestration.coordinatorRunId);
      let adoptionRecoveryFailed = false;
      for (const task of this.db.listOrchestrationTasks(orchestration.id).filter((entry) => entry.adoptionStatus === "applying")) {
        try {
          const adoption = this.db.getOrchestrationAdoption(task.id);
          if (!adoption?.backupPath) throw new Error("The interrupted adoption backup is unavailable.");
          await recoverOrchestrationAdoption({ backupPath: adoption.backupPath, targetPath: coordinator.worktreePath });
          this.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
          this.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "conflict" });
          this.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id,
            type: "adoption-recovered", title: "Interrupted adoption rolled back",
            content: "The saved before/after hashes matched. Review the result again before adopting." });
          await this.db.flushDurable();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          adoptionRecoveryFailed = true;
          // Startup has no apply in flight. Release the stale applying state,
          // preserve its backup, and let the user reject it without rewriting files.
          const adoption = this.db.getOrchestrationAdoption(task.id);
          this.db.updateOrchestration(orchestration.id, { status: "attention", errorMessage: reason });
          this.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict", attentionReason: reason });
          this.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "conflict",
            manifest: { ...adoption?.manifest, recoveryNeedsReview: true }, errorMessage: reason });
          this.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "attention",
            title: "Interrupted adoption needs review", content: `${reason} Inspect the coordinator workspace, then reject the interrupted adoption to abandon it.` });
          await this.db.flushDurable();
          this.services.orchestration.emitOrchestrationChanged(orchestration.id, task.id);
        }
      }
      if (
        !adoptionRecoveryFailed &&
        orchestration.status === "active" &&
        coordinator.status === "cancelled" &&
        coordinator.errorMessage === SESSION_INTERRUPTED_MESSAGE
      ) {
        const steps = this.db.getRunSteps(coordinator.id);
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
          await this.services.runRecovery.recoverInterruptedRun(coordinator.id);
          this.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "coordinator-recovered",
            title: "Coordinator resumed after restart",
            content: "The saved provider session or checkpoint was valid and resumed without changing providers.",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.db.updateOrchestration(orchestration.id, { status: "attention", errorMessage: message });
          this.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "attention",
            title: "Coordinator recovery needs attention",
            content: message,
          });
        }
      } else if (!adoptionRecoveryFailed && orchestration.status === "active" && coordinator.status === "completed") {
        const currentTasks = this.db.listOrchestrationTasks(orchestration.id);
        if (currentTasks.length > 0 && !orchestration.wakeMode) {
          const latestWave = this.db.listOrchestrationWaves(orchestration.id).at(-1);
          const wakeTaskIds = latestWave
            ? currentTasks.filter((task) => task.waveId === latestWave.id).map((task) => task.id)
            : [];
          this.db.updateOrchestration(orchestration.id, {
            status: "waiting",
            wakeMode: "all-terminal",
            wakeTaskIds,
          });
          this.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            type: "yield",
            title: "Default wake condition recovered",
            content: "BuildWarden restored the current-wave wake condition after restart.",
            metadata: { mode: "all-terminal", taskIds: wakeTaskIds, implicit: true, recovered: true },
          });
        }
      }
      const tasks = this.db.listOrchestrationTasks(orchestration.id);
      const reconcileTask = async (task: OrchestrationTaskRecord): Promise<void> => {
        if (!["provisioning", "queued", "running", "waiting-input"].includes(task.status)) return;
        if (!task.childRunId) {
          this.db.updateOrchestrationTask(task.id, {
            status: "pending",
            attentionReason: null,
            errorMessage: null,
          });
          this.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            type: "requeued",
            title: "Provisioning resumed",
            content: "The persisted task intent had not created a child run, so it was safely requeued.",
          });
          return;
        }
        if (adoptionRecoveryFailed) {
          this.services.orchestrationDispatch.blockOrchestrationTask(task, "Child recovery needs attention", "Review the interrupted adoption before resuming this child.");
          return;
        }
        const stoppedChild = this.db.getRun(task.childRunId);
        if (isSettledChildRun(stoppedChild)) {
          // The child finished, but the app stopped before its result was recorded.
          await this.services.orchestrationResults.settleOrchestrationChildTerminal(task, stoppedChild, { deliverQueued: false });
          return;
        }
        try {
          const child = this.db.getRun(task.childRunId);
          const checkpoint = this.services.turnState.getRunCheckpoint(child.id);
          const model = this.db.getModel(child.modelId);
          const provider = this.db.getProviderAccount(model.providerAccountId);
          const providerRuntime = this.services.turnState.resolveRunNativeSession(child, provider).session;
          const steps = this.db.getRunSteps(child.id);
          const coordinatorSteps = this.db.getRunSteps(orchestration.coordinatorRunId);
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
            this.db.updateOrchestrationTask(task.id, { status: "blocked", attentionReason: unsafeReason });
            this.db.appendOrchestrationEvent({
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
            await this.services.runRecovery.recoverInterruptedRun(child.id);
          } else if (!hasAgentActivity) {
            await this.services.orchestrationDispatch.restartOrchestrationChildFromBeginning(orchestration, task, child, provider, model);
          } else {
            throw new Error("The provider cursor or checkpoint is unavailable for an interrupted child with existing activity.");
          }
          this.db.updateOrchestrationTask(task.id, {
            status: "running",
            attentionReason: null,
            errorMessage: null,
            startedAt: task.startedAt ?? new Date().toISOString(),
          });
          this.db.appendOrchestrationEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            type: "recovered",
            title: "Child resumed",
            content: canResume
              ? "The saved provider session or checkpoint was resumed."
              : "The child had not begun provider work and was restarted from its durable prompt.",
          });
        } catch (error) {
          this.db.updateOrchestrationTask(task.id, {
            status: "blocked",
            attentionReason: error instanceof Error ? error.message : String(error),
          });
          this.db.appendOrchestrationEvent({
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
      const reconciledOrchestration = this.db.getOrchestration(orchestration.id);
      if (reconciledOrchestration.status !== "paused" && reconciledOrchestration.status !== "attention") {
        await this.services.orchestrationDispatch.dispatchOrchestrationTasks(orchestration.id);
        await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestration.id, { afterRestart: true });
      }
      this.services.orchestration.emitOrchestrationChanged(orchestration.id);
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

    this.db.deleteBookmarksForRunIds(runIds);
    this.db.deleteChatBookmarksForRunIds(runIds);
    // Deleting a row that is already gone does nothing, so an error here means the row is still there.
    for (const runId of runIds) this.db.deleteRun(runId);
    if (job.orchestrationId) this.db.deleteOrchestrationData(job.orchestrationId);
    await this.db.flushDurable();
    this.db.completeOrchestrationCleanupJob(job.id);
    for (const runId of runIds) this.services.runDeletion.notifyRunDeleted(runId);
  }
}
