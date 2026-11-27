import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isSameWorktreePath } from "@buildwarden/git-service";
import type { OrchestrationEffectRecord, OrchestrationTaskRecord, OrchestrationTaskStatus, RunRecord } from "@buildwarden/shared";
import { abandonedSubagentNote, closeAbandonedChildSubagents, resultAbandonedSubagentCount } from "../orchestration-native-work";
import { publishedFollowUpSummary } from "../orchestration-result-summary";
import { captureOrchestrationBaseline } from "../orchestration-workspace";
import { AppService } from "./app-service";
import { orchestrationTaskStatusForRun, readPublishResultPayload } from "./orchestration-policy";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";

const CHILD_WORKSPACE_REMOVAL_RETRY = "The child workspace could not be removed; BuildWarden tries again at the next start.";

/** Publishes child results and resumes interrupted runtime effects. */
export class OrchestrationResultService extends AppService<
  | "activeWorkers"
  | "orchestration"
  | "orchestrationCoordinator"
  | "orchestrationDispatch"
  | "orchestrationMessages"
  | "runDeletion"
  | "runWorkerHost"
> implements RunEndedListener {
  /** Closes native subagents a stopped child left open; a running child keeps its own (see orchestration-native-work). */
  closeAbandonedChildSubagents(runId: string): number {
    return this.services.activeWorkers.runWorkers.has(runId) ? 0 : closeAbandonedChildSubagents(this.db, runId);
  }

  /** Snapshots a completed implementation child, so adoption reviews exactly what was published. */
  private async captureOrchestrationResultSnapshot(
    task: OrchestrationTaskRecord,
    status: OrchestrationTaskStatus,
  ): Promise<string | undefined> {
    if (status !== "completed" || task.intent !== "implement" || !task.childRunId) return undefined;
    const child = this.db.getRun(task.childRunId);
    return captureOrchestrationBaseline({
      workspacePath: child.worktreePath, workspaceVcs: child.workspaceVcs,
      artifactRoot: this.services.orchestration.getOrchestrationArtifactRoot(), orchestrationId: task.orchestrationId,
      waveId: `result-${randomUUID()}`,
    });
  }

  /** Publishes a task that is already terminal, such as a record from before versioned results. */
  async publishOrchestrationResult(task: OrchestrationTaskRecord): Promise<void> {
    const workspaceSnapshotPath = await this.captureOrchestrationResultSnapshot(task, task.status);
    this.db.publishOrchestrationTaskResult(task.id, workspaceSnapshotPath, this.orchestrationResultModels(
      task, task.childRunId, task.childRunId ? this.services.runWorkerHost.runExecutedModels.get(task.childRunId) : undefined,
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
      requestedModel = this.db.getModel(childRunId ? this.db.getRun(childRunId).modelId : task.modelId).modelId;
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
    const pending = this.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "publish-result" }).at(-1);
    const reportedModel = this.services.runWorkerHost.runExecutedModels.get(run.id);
    const previousResult = this.db.listOrchestrationTaskResults(task.id).at(-1);
    const previousWarning = previousResult
      ? abandonedSubagentNote(resultAbandonedSubagentCount(this.db, task.id, previousResult.id)) : "";
    const previousSummary = previousResult?.summary ?? null;
    const previousReport = previousWarning && previousSummary?.endsWith(previousWarning)
      ? previousSummary.slice(0, -previousWarning.length).trimEnd() || null : previousSummary;
    let effect = pending ?? this.db.createOrchestrationEffect({
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
    if (!pending) await this.db.flushDurable();
    // The effect now holds the report, also for a publication resumed after a crash.
    this.services.runWorkerHost.runExecutedModels.delete(run.id);
    const outcome = readPublishResultPayload(effect.payload, run);
    // Recorded once, so a publication resumed after a crash reports the same count. Closing the
    // subagents and recording how many were open is one transaction: otherwise a failure between
    // them leaves them closed, and the resumed publication counts none and drops the warning.
    if (typeof effect.payload.abandonedSubagents !== "number") {
      const pendingEffect = effect;
      effect = this.db.transaction(() => this.db.updateOrchestrationEffect(pendingEffect.id, {
        payload: { ...pendingEffect.payload, abandonedSubagents: this.closeAbandonedChildSubagents(run.id) },
      }));
      await this.db.flushDurable();
    }
    const abandonedSubagents = Number(effect.payload.abandonedSubagents);
    let snapshotPath = typeof effect.payload.workspaceSnapshotPath === "string" && existsSync(effect.payload.workspaceSnapshotPath)
      ? effect.payload.workspaceSnapshotPath
      : undefined;
    try {
      if (!snapshotPath) {
        snapshotPath = await this.captureOrchestrationResultSnapshot(task, outcome.status);
        if (snapshotPath) {
          effect = this.db.updateOrchestrationEffect(effect.id, { payload: { ...effect.payload, workspaceSnapshotPath: snapshotPath } });
          await this.db.flushDurable();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.transaction(() => {
        const updated = this.db.updateOrchestrationTask(task.id, {
          summary: outcome.summary, errorMessage: outcome.errorMessage,
          inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
        });
        this.services.orchestrationDispatch.blockOrchestrationTask(updated, "Result snapshot failed", message);
        this.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
      });
      await this.db.flushDurable();
      return "blocked";
    }
    const effectId = effect.id;
    // The caveat belongs to the published result itself, so every reader of it (wakes, waits,
    // task reads, the user) sees that part of the work never finished.
    const abandonedNote = abandonedSubagentNote(abandonedSubagents);
    const publishedSummary = abandonedNote ? [outcome.summary, abandonedNote].filter(Boolean).join("\n\n") : outcome.summary;
    this.db.transaction(() => {
      const updated = this.db.updateOrchestrationTask(task.id, {
        status: outcome.status,
        summary: publishedSummary,
        errorMessage: outcome.errorMessage,
        attentionReason: outcome.status === "failed" ? outcome.errorMessage : null,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        finishedAt: new Date().toISOString(),
      });
      const result = this.db.publishOrchestrationTaskResult(task.id, snapshotPath, this.orchestrationResultModels(
        task, run.id, typeof effect.payload.executedModel === "string" ? effect.payload.executedModel : undefined,
      ));
      this.db.appendOrchestrationEvent({
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
      this.db.updateOrchestrationEffect(effectId, { status: "completed", incrementAttempts: true });
    });
    await this.db.flushDurable();
    return "published";
  }

  /**
   * Settles a task whose child run stopped: defers it on a usage limit, otherwise publishes its
   * result and starts any queued follow-up. Returns "continued" when a follow-up turn started.
   */
  async settleOrchestrationChildTerminal(
    task: OrchestrationTaskRecord,
    run: RunRecord,
    options: { deliverQueued: boolean } = { deliverQueued: true },
  ): Promise<"deferred" | "blocked" | "settled" | "continued" | "coordinating"> {
    if (this.services.orchestration.isStillCoordinating(run.id)) return "coordinating";
    // Once an outcome is recorded for publication, it is published. Deferring then would leave the
    // effect pending and let a later, different outcome be published from its stale payload.
    const publicationPending = this.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "publish-result" }).length > 0;
    if (!publicationPending && orchestrationTaskStatusForRun(run) === "failed" && await this.services.orchestrationDispatch.deferChildAfterUsageLimit(task, run)) return "deferred";
    if (await this.finalizeOrchestrationChildResult(task, run) === "blocked") return "blocked";
    if (!options.deliverQueued) return "settled";
    return await this.services.orchestrationMessages.deliverQueuedOrchestrationMessages(this.db.getOrchestrationTask(task.id)) ? "continued" : "settled";
  }

  async handleOrchestrationChildTerminal(childRunId: string): Promise<void> {
    const task = this.db.getOrchestrationTaskByChildRunId(childRunId);
    if (!task) return;
    await this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
      const outcome = await this.settleOrchestrationChildTerminal(this.db.getOrchestrationTask(task.id), this.db.getRun(childRunId));
      if (outcome === "continued") {
        this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
        return;
      }
      await this.services.orchestrationDispatch.dispatchOrchestrationTasks(task.orchestrationId);
      await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(task.orchestrationId);
      this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
    });
    // Capacity is global across orchestrations. A terminal child may unblock a
    // different coordinator, so do not leave its persisted queue stranded.
    await this.services.orchestrationDispatch.dispatchOtherOrchestrationTasks(task.orchestrationId);
  }

  /**
   * Finishes or rolls back side effects a crash interrupted. Runs at startup, before tasks are
   * reconciled, so their state reflects every effect that already happened.
   */
  async resumePendingOrchestrationEffects(orchestrationId: string): Promise<void> {
    for (const effect of this.db.listPendingOrchestrationEffects({ orchestrationId })) {
      try {
        if (effect.kind === "publish-result") await this.resumeResultPublication(effect);
        else if (effect.kind === "launch-child") await this.resumeChildLaunch(effect);
        else if (effect.kind === "deliver-update") this.services.orchestrationCoordinator.resumeCoordinatorDelivery(effect);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
        this.db.appendOrchestrationEvent({
          orchestrationId, taskId: effect.taskId, type: "attention",
          title: "Interrupted operation needs review", content: message, metadata: { effectId: effect.id, effectKind: effect.kind },
        });
      }
    }
    await this.db.flushDurable();
  }

  private async resumeResultPublication(effect: OrchestrationEffectRecord): Promise<void> {
    const task = this.db.getOrchestrationTask(effect.taskId ?? "");
    const childRunId = typeof effect.payload.childRunId === "string" ? effect.payload.childRunId : task.childRunId;
    if (!childRunId) throw new Error("The interrupted result publication has no child run.");
    // Queued follow-ups stay queued: startup does not start child turns before recovery checks run.
    const outcome = await this.settleOrchestrationChildTerminal(task, this.db.getRun(childRunId), { deliverQueued: false });
    this.db.appendOrchestrationEvent({
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
  async resumeChildLaunch(effect: OrchestrationEffectRecord): Promise<void> {
    const task = this.db.getOrchestrationTask(effect.taskId ?? "");
    const workspace = effect.payload.workspace as Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath"> | undefined;
    // A later attempt may have launched the task in another workspace, so a child run owns this
    // one only when it uses this exact path.
    const ownerPath = task.childRunId ? this.db.getRun(task.childRunId).worktreePath : null;
    if (workspace?.worktreePath && !(ownerPath && isSameWorktreePath(ownerPath, workspace.worktreePath))) {
      const project = this.db.getProject(this.db.getOrchestration(task.orchestrationId).projectId);
      if (!(await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, workspace))) {
        this.db.updateOrchestrationEffect(effect.id, {
          payload: { ...effect.payload, phase: "cleanup" }, incrementAttempts: true,
          errorMessage: CHILD_WORKSPACE_REMOVAL_RETRY,
        });
        return;
      }
      this.db.updateOrchestrationEffect(effect.id, {
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
    this.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
  }

  /**
   * Ends a child launch that failed before its run existed. The launch effect is the only record
   * of the workspace, so it stays pending until the workspace is gone, and startup retries the
   * removal if it fails now.
   */
  async closeFailedChildLaunch(
    launch: OrchestrationEffectRecord,
    repoPath: string,
    workspace: Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (await this.services.runDeletion.discardPreparedRunWorkspace(repoPath, workspace)) {
      this.db.updateOrchestrationEffect(launch.id, { status: "failed", incrementAttempts: true, errorMessage: message });
    } else {
      this.db.updateOrchestrationEffect(launch.id, {
        payload: { workspace, phase: "cleanup" }, incrementAttempts: true,
        errorMessage: `${message} ${CHILD_WORKSPACE_REMOVAL_RETRY}`,
      });
    }
    await this.db.flushDurable();
  }

  async onRunEnded({ run }: RunEnded): Promise<void> {
    if (run.kind === "orchestration-task") await this.handleOrchestrationChildTerminal(run.id);
  }
}
