import type {
  OrchestrationEffectRecord,
  OrchestrationRecord,
  OrchestrationTaskRecord,
  OrchestrationWakeMode,
  RunUserInputQuestion,
} from "@buildwarden/shared";
import { AGENT_ACTIVITY_EVENT_TYPES, settleCoordinatorWaitDeliveries } from "../orchestration-delivery";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES } from "../orchestration-runtime-actions";
import {
  fenceChildOutput,
  formatOrchestrationResumeTasks,
  orchestrationUpdateDisplayText,
  type PendingChildQuestion,
  truncateForCoordinator,
  wrapOrchestrationUpdate,
} from "../orchestration-tools";
import { orchestrationWakeSatisfied } from "../orchestration-wake-policy";
import { AppService } from "./app-service";
import { ORCHESTRATION_WAKE_NEWS_EVENT_TYPES } from "./orchestration-policy";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";
import { latestUserTurnUsedFullAccess } from "./run-execution-settings";
import { parseMetadataRecord } from "./run-step-content";

/** Wakes coordinators and delivers news about their tasks. */
export class OrchestrationCoordinatorService extends AppService<
  | "activeWorkers"
  | "followUps"
  | "orchestration"
  | "runEvents"
  | "runTurns"
> implements RunEndedListener {
  /** Coalesces automatic and user-triggered coordinator continuations. */
  readonly orchestrationWakeLocks = new Set<string>();

  /**
   * Advances the delivery cursor only when the agent demonstrably received the update: the run
   * shows agent activity after the tagged follow-up step. That step is written before the worker
   * starts, so on its own it proves nothing. Without the evidence the update counts as not
   * delivered. An automatic wake gets its exact wait back and is repeated, since a repeated update
   * is safer than a lost one. A user's follow-up is held for the user to send again, because
   * resuming the provider session would not carry its text.
   */
  resumeCoordinatorDelivery(effect: OrchestrationEffectRecord): void {
    if (effect.payload.viaWait === true) {
      this.settleCoordinatorWaitDeliveries(effect.orchestrationId, { turnEnded: true });
      return;
    }
    const orchestration = this.db.getOrchestration(effect.orchestrationId);
    const steps = this.db.getRunSteps(orchestration.coordinatorRunId);
    const deliveryIndex = steps.findIndex((step) => parseMetadataRecord(step.metadataJson).orchestrationDeliveryId === effect.id);
    const started = deliveryIndex >= 0 && steps.slice(deliveryIndex + 1).some((step) => AGENT_ACTIVITY_EVENT_TYPES.has(step.eventType));
    const targetSequence = typeof effect.payload.targetSequence === "number" ? effect.payload.targetSequence : 0;
    if (started) {
      this.db.transaction(() => {
        this.db.updateOrchestration(orchestration.id, { lastDeliveredSequence: Math.max(orchestration.lastDeliveredSequence, targetSequence) });
        this.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
      return;
    }
    const previousWakeMode = effect.payload.previousWakeMode as OrchestrationWakeMode | null | undefined;
    const previousWakeTaskIds = Array.isArray(effect.payload.previousWakeTaskIds) ? effect.payload.previousWakeTaskIds.map(String) : [];
    const userWake = effect.payload.userWake === true;
    const unchangedSince = orchestration.status === "active" && !orchestration.wakeMode;
    this.db.transaction(() => {
      if (unchangedSince && userWake) {
        const reason = "The app stopped before your follow-up reached the coordinator. Send it again to continue.";
        this.db.updateOrchestration(orchestration.id, {
          status: "attention", wakeMode: previousWakeMode ?? null, wakeTaskIds: previousWakeTaskIds, errorMessage: reason,
        });
        this.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "attention", title: "Follow-up not delivered", content: reason });
      } else if (unchangedSince && previousWakeMode) {
        this.db.updateOrchestration(orchestration.id, { status: "waiting", wakeMode: previousWakeMode, wakeTaskIds: previousWakeTaskIds });
      }
      this.db.updateOrchestrationEffect(effect.id, {
        status: "failed", incrementAttempts: true,
        errorMessage: "The app stopped before the coordinator turn showed activity; the update counts as not delivered.",
      });
    });
  }

  async handleOrchestrationCoordinatorTurnTerminal(coordinatorRunId: string): Promise<void> {
    const ended = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (ended) {
      this.settleCoordinatorWaitDeliveries(ended.id, { turnEnded: true });
      await this.db.flushDurable();
    }
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration || ["completed", "cancelled", "deleting", "deletion-failed"].includes(orchestration.status)) return;
    const tasks = this.db.listOrchestrationTasks(orchestration.id);
    if (tasks.length === 0) return;
    const allTasksTerminal = tasks.every((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status));
    const adoptionApplying = tasks.some((task) => task.adoptionStatus === "applying");
    if (
      orchestration.status === "active" &&
      !orchestration.wakeMode &&
      orchestration.lastDeliveredSequence > 0 &&
      this.undeliveredOrchestrationTaskIds(orchestration).size === 0 &&
      allTasksTerminal &&
      !adoptionApplying
    ) {
      await this.services.orchestration.finishOrchestration(coordinatorRunId);
      return;
    }
    if (!orchestration.wakeMode && orchestration.status === "active") {
      const latestWave = this.db.listOrchestrationWaves(orchestration.id).at(-1);
      const waveTaskIds = latestWave ? tasks.filter((task) => task.waveId === latestWave.id).map((task) => task.id) : [];
      this.db.updateOrchestration(orchestration.id, {
        status: "waiting",
        wakeMode: "all-terminal",
        wakeTaskIds: waveTaskIds,
      });
      this.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "yield",
        title: "Default wake condition",
        content: "The coordinator ended its turn without yielding; BuildWarden will resume it when the current wave is terminal or needs attention.",
        metadata: { mode: "all-terminal", taskIds: waveTaskIds, implicit: true },
      });
    }
    await this.maybeWakeOrchestrationCoordinator(orchestration.id);
    this.services.orchestration.emitOrchestrationChanged(orchestration.id);
  }

  /** Tasks whose child reported a state the coordinator has not been told about yet. */
  undeliveredOrchestrationTaskIds(orchestration: OrchestrationRecord): Set<string> {
    return new Set(this.db.listOrchestrationEvents(orchestration.id).flatMap((event) =>
      event.taskId && ORCHESTRATION_WAKE_NEWS_EVENT_TYPES.has(event.type) && event.sequence > orchestration.lastDeliveredSequence
        ? [event.taskId]
        : []));
  }

  /** Tasks whose question the coordinator has not been told about yet. */
  undeliveredQuestionTaskIds(orchestration: OrchestrationRecord): Set<string> {
    return new Set(this.db.listOrchestrationEvents(orchestration.id).flatMap((event) =>
      event.taskId && event.metadata.kind === "user-input" && event.sequence > orchestration.lastDeliveredSequence
        ? [event.taskId]
        : []));
  }

  /** Questions a child is blocked on. Approvals are absent: only the user can decide those. */
  pendingChildQuestions(childRunId: string): PendingChildQuestion[] {
    const opened = new Map<string, PendingChildQuestion>();
    for (const step of this.db.getRunSteps(childRunId)) {
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
  orchestrationWakeSatisfied(
    orchestration: OrchestrationRecord,
    tasks: OrchestrationTaskRecord[],
    undeliveredTaskIds: ReadonlySet<string> = new Set(),
    undeliveredQuestionTaskIds: ReadonlySet<string> = new Set(),
  ): boolean {
    return orchestrationWakeSatisfied(orchestration, tasks, undeliveredTaskIds, undeliveredQuestionTaskIds);
  }

  /**
   * Everything the coordinator has not been told since the delivery cursor: each task's compact
   * state, the user's adoption decisions, and the new events. Wakes and the blocking wait both
   * report through this, so neither can leave part of the news out.
   */
  buildOrchestrationNews(orchestration: OrchestrationRecord): string[] {
    const tasks = this.db.listOrchestrationTasks(orchestration.id);
    const events = this.db.listOrchestrationEvents(orchestration.id)
      .filter((event) => event.sequence > orchestration.lastDeliveredSequence);
    const undelivered = this.undeliveredOrchestrationTaskIds(orchestration);
    const lines = formatOrchestrationResumeTasks(tasks.map((task) => ({
      task,
      modelName: this.orchestrationTaskModelName(task),
      hasNews: undelivered.has(task.id),
      questions: task.status === "waiting-input" && task.childRunId ? this.pendingChildQuestions(task.childRunId) : [],
    })));
    const adoptionDecisions = events.filter((event) => event.type.startsWith("adoption-") && event.type !== "adoption-proposed")
      // A conflict names files the child chose; the other decisions are BuildWarden's own words.
      .map((event) => `- ${event.type === "adoption-conflict" ? fenceChildOutput(event.content) : event.content}`);
    return [
      ...lines,
      ...(adoptionDecisions.length > 0 ? ["", "Adoption decisions:", ...adoptionDecisions] : []),
      "",
      `New durable events: ${events.map((event) => `${event.sequence}:${event.type}`).join(", ") || "none"}`,
    ];
  }

  buildOrchestrationResumePrompt(orchestration: OrchestrationRecord): string {
    return wrapOrchestrationUpdate([
      "BuildWarden durable orchestration resumed you because the persisted wake condition was met.",
      "Review these compact results and inspect individual tasks with buildwarden_tasks_read when needed. Delegate another wave if useful; otherwise provide the final summary. BuildWarden completes the orchestration automatically when this turn ends without new work.",
      "",
      ...this.buildOrchestrationNews(orchestration),
    ]);
  }

  /** Moves the cursor for blocking waits the coordinator received (see orchestration-delivery). */
  settleCoordinatorWaitDeliveries(orchestrationId: string, options: { turnEnded: boolean }): void {
    settleCoordinatorWaitDeliveries(this.db, orchestrationId, options);
  }

  /** The model a task runs with; a remote task's runs with the host's model. */
  orchestrationTaskModelName(task: Pick<OrchestrationTaskRecord, "modelId" | "remote">): string {
    if (task.remote) return `${task.remote.modelId ?? "default model"} on ${task.remote.hostLabel}`;
    return this.orchestrationModelName(task.modelId);
  }

  orchestrationModelName(modelId: string): string {
    try {
      return this.db.getModel(modelId).displayName;
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
  async deliverOrchestrationUpdate<T>(
    orchestration: OrchestrationRecord,
    startTurn: (deliveryMetadata: { orchestrationDeliveryId: string }) => Promise<T>,
    options: { userWake?: boolean } = {},
  ): Promise<T> {
    const effect = this.db.transaction(() => {
      const created = this.db.createOrchestrationEffect({
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
      this.db.updateOrchestration(orchestration.id, { status: "active", wakeMode: null, wakeTaskIds: [], errorMessage: null });
      return created;
    });
    await this.db.flushDurable();
    try {
      const result = await startTurn({ orchestrationDeliveryId: effect.id });
      this.db.transaction(() => {
        this.db.updateOrchestration(orchestration.id, { lastDeliveredSequence: orchestration.lastEventSequence });
        this.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
      await this.db.flushDurable();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.transaction(() => {
        this.db.updateOrchestration(orchestration.id, {
          status: "attention",
          wakeMode: orchestration.wakeMode,
          wakeTaskIds: orchestration.wakeTaskIds,
          errorMessage: message,
        });
        this.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: message, incrementAttempts: true });
      });
      throw error;
    }
  }

  async maybeWakeOrchestrationCoordinator(
    orchestrationId: string,
    options?: { afterRestart?: boolean },
  ): Promise<void> {
    const orchestration = this.db.getOrchestration(orchestrationId);
    if (["active", "waiting"].includes(orchestration.status) && this.services.activeWorkers.runWorkers.has(orchestration.coordinatorRunId)) {
      await this.notifyRunningOrchestrationCoordinator(orchestration);
      return;
    }
    if (orchestration.status !== "waiting" || this.orchestrationWakeLocks.has(orchestrationId)) return;
    const tasks = this.db.listOrchestrationTasks(orchestrationId);
    const undelivered = this.undeliveredOrchestrationTaskIds(orchestration);
    if (!this.orchestrationWakeSatisfied(orchestration, tasks, undelivered, this.undeliveredQuestionTaskIds(orchestration))) return;
    if (this.services.activeWorkers.runWorkers.has(orchestration.coordinatorRunId)) return;
    // A wake continues the user's turn, so it keeps the access that turn granted, as children do.
    const fullAccess = latestUserTurnUsedFullAccess(this.db.getRunSteps(orchestration.coordinatorRunId));
    if (fullAccess && options?.afterRestart) {
      const message = "The coordinator used elevated permissions and requires explicit recovery.";
      this.db.updateOrchestration(orchestrationId, { status: "attention", errorMessage: message });
      this.db.appendOrchestrationEvent({
        orchestrationId,
        type: "attention",
        title: "Coordinator recovery needs attention",
        content: message,
      });
      this.services.orchestration.emitOrchestrationChanged(orchestrationId);
      return;
    }
    this.orchestrationWakeLocks.add(orchestrationId);
    try {
      const prompt = this.buildOrchestrationResumePrompt(orchestration);
      const coordinator = this.db.getRun(orchestration.coordinatorRunId);
      await this.deliverOrchestrationUpdate(orchestration, (deliveryMetadata) => this.services.runTurns.followUpRunInternal(
        coordinator.id,
        prompt,
        { mode: coordinator.mode, modelId: coordinator.modelId, delegationEnabled: true, yoloMode: fullAccess },
        { source: "orchestration", orchestrationResume: true, displayPrompt: orchestrationUpdateDisplayText(prompt), ...deliveryMetadata },
        { background: true },
      ));
      this.db.appendOrchestrationEvent({
        orchestrationId,
        type: "coordinator-resumed",
        title: "Coordinator resumed",
        content: "Delivered new durable task results.",
      });
      this.services.orchestration.emitOrchestrationChanged(orchestrationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.appendOrchestrationEvent({
        orchestrationId,
        type: "attention",
        title: "Coordinator could not resume",
        content: message,
      });
      this.services.orchestration.emitOrchestrationChanged(orchestrationId);
    } finally {
      this.orchestrationWakeLocks.delete(orchestrationId);
    }
  }

  /** Urgent notices do not consume the result cursor or replace the persisted wake condition. */
  private async notifyRunningOrchestrationCoordinator(orchestration: OrchestrationRecord): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(orchestration.coordinatorRunId);
    if (!active || active.cancelled || !this.services.followUps.acceptsLiveSteering(orchestration.coordinatorRunId, active.providerType)
      || this.orchestrationWakeLocks.has(orchestration.id)) return;
    const events = this.db.listOrchestrationEvents(orchestration.id);
    const attempted = new Set(events.filter((event) => event.type === "coordinator-notice")
      .flatMap((event) => Array.isArray(event.metadata.sequences) ? event.metadata.sequences : []));
    const urgent = events.filter((event) => event.sequence > orchestration.lastDeliveredSequence
      && event.type === "attention" && event.taskId && !attempted.has(event.sequence)).slice(0, 8);
    if (!urgent.length) return;
    this.orchestrationWakeLocks.add(orchestration.id);
    try {
      this.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "coordinator-notice",
        title: "Urgent child update", content: "Delivery attempted to the running coordinator.",
        metadata: { sequences: urgent.map((event) => event.sequence), phase: "attempted" } });
      await this.db.flushDurable();
      const prompt = wrapOrchestrationUpdate([
        "A child needs attention. Read the task for its current question or failure. Use buildwarden_tasks_respond to answer questions; shell approvals remain with the user.",
        ...urgent.map((event) => `Task ${event.taskId}: ${fenceChildOutput(truncateForCoordinator(event.content, 1_000))}`),
      ]);
      await this.services.followUps.requestWorkerSteer(active.worker, prompt, []);
      await this.services.runEvents.appendRunEvent(orchestration.coordinatorRunId, "log", "Child attention notice", prompt, { source: "orchestration", steered: true });
    } catch (error) {
      this.db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "coordinator-notice-outcome",
        title: "Child update retained", content: "The coordinator will receive this update after its turn ends.",
        metadata: { error: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.orchestrationWakeLocks.delete(orchestration.id);
    }
  }

  /**
   * Only a turn that finished may finish the orchestration or wait for a wake. After a failed turn the
   * orchestration stays active until the user follows up: waking it would repeat the failure without
   * end, and finishing it would report unseen work as complete. That follow-up carries all news the
   * failed turn did not receive, because the delivery cursor has not moved.
   */
  async onRunEnded({ run, turnFinished }: RunEnded): Promise<void> {
    if (turnFinished && run.delegationEnabled && run.kind !== "orchestration-task") await this.handleOrchestrationCoordinatorTurnTerminal(run.id);
  }
}
