import {
  effectiveHarnessCapabilities,
  isSteerOutcomeUnknownError,
  type OrchestrationMessageDelivery,
  type OrchestrationTaskMessageInput,
  type OrchestrationTaskMessageRecord,
  type OrchestrationTaskRecord,
  OrchestrationToolError,
} from "@buildwarden/shared";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES } from "../orchestration-runtime-actions";
import { childTaskMessagesDisplayText, formatChildTaskMessages } from "../orchestration-tools";
import { AppService } from "./app-service";
import { latestRunExecutionSettings } from "./run-execution-settings";
import { parseMetadataRecord } from "./run-step-content";

/** Delivers messages from coordinators and users to child runs. */
export class OrchestrationMessageService extends AppService<
  | "activeWorkers"
  | "followUps"
  | "orchestration"
  | "orchestrationCoordinator"
  | "orchestrationDispatch"
  | "orchestrationResults"
  | "providerRuntime"
  | "runEvents"
  | "runTurns"
> {
  async deliverQueuedOrchestrationMessages(task: OrchestrationTaskRecord, reserved = false): Promise<boolean> {
    if (!task.childRunId) return false;
    const messages = this.db.listOrchestrationTaskMessages(task.orchestrationId)
      .filter((message) => message.taskId === task.id && message.status === "queued");
    if (messages.length === 0) return false;
    // Recovery still targets this child. Starting another turn would let that cancellation stop it.
    if (this.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "cancel-child" }).length > 0) return false;
    const child = this.db.getRun(task.childRunId);
    if (this.services.activeWorkers.runWorkers.has(child.id)) return false;
    // Keep older terminal results addressable, including tasks created before versioned results.
    if (ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) && this.db.listOrchestrationTaskResults(task.id).length === 0) {
      await this.services.orchestrationResults.publishOrchestrationResult(task);
    }
    if (!reserved && !this.services.orchestrationDispatch.reserveOrchestrationTask(task)) {
      this.db.updateOrchestrationTask(task.id, { status: "pending" });
      return false;
    }
    const childExecutionSettings = latestRunExecutionSettings(this.db.getRunSteps(child.id));
    this.db.updateOrchestrationTask(task.id, {
      status: "queued",
      adoptionStatus: "none",
      errorMessage: null,
      attentionReason: null,
      finishedAt: null,
    });
    try {
      for (const message of messages) this.db.updateOrchestrationTaskMessage(message.id, "delivering");
      await this.db.flushDurable();
      await this.services.runTurns.followUpRunInternal(
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
        { background: true },
      );
    } catch (error) {
      if (!this.childTurnTookMessages(child.id, messages)) {
        // The child never saw these messages, so it keeps the state it stopped in. Reporting the
        // failure lets the wave finish and tells the coordinator to send them again.
        const reason = `A message could not be delivered: ${error instanceof Error ? error.message : String(error)}`;
        for (const message of messages) this.db.updateOrchestrationTaskMessage(message.id, "failed");
        this.db.updateOrchestrationTask(task.id, {
          status: ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) ? task.status : "blocked",
          summary: task.summary,
          adoptionStatus: task.adoptionStatus,
          errorMessage: task.errorMessage,
          attentionReason: reason,
          finishedAt: task.finishedAt,
        });
        this.db.appendOrchestrationEvent({
          orchestrationId: task.orchestrationId,
          taskId: task.id,
          type: "attention",
          title: "Message not delivered",
          content: reason,
        });
        return false;
      }
      this.logControllerWarn("A child turn started with its messages but reported an error.", { taskId: task.id, childRunId: child.id, error });
    }
    for (const message of messages) this.db.updateOrchestrationTaskMessage(message.id, "delivered");
    this.db.updateOrchestrationTask(task.id, { status: "running", startedAt: new Date().toISOString() });
    return true;
  }

  /** A live worker alone may belong to another turn; the turn's own step names the messages it carries. */
  private childTurnTookMessages(childRunId: string, messages: OrchestrationTaskMessageRecord[]): boolean {
    return this.services.activeWorkers.runWorkers.has(childRunId) && this.db.getRunSteps(childRunId).some((step) => {
      const { orchestrationMessageIds } = parseMetadataRecord(step.metadataJson);
      return Array.isArray(orchestrationMessageIds) && messages.every((message) => orchestrationMessageIds.includes(message.id));
    });
  }

  async sendOrchestrationTaskMessage(input: OrchestrationTaskMessageInput): Promise<void> {
    const { orchestrationId } = this.db.getOrchestrationTask(input.taskId);
    await this.services.orchestration.withOrchestrationMutation(orchestrationId, async () => {
      try {
        await this.queueOrchestrationTaskMessage(input, "user");
      } finally {
        await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationId);
      }
    });
  }

  /** Runs inside the orchestration's mutation lock, so two senders cannot deliver one message twice. */
  async queueOrchestrationTaskMessage(
    input: OrchestrationTaskMessageInput,
    source: OrchestrationTaskMessageRecord["source"],
    delivery: OrchestrationMessageDelivery = "auto",
  ) {
    const task = this.db.getOrchestrationTask(input.taskId);
    if (task.remote) {
      throw new OrchestrationToolError("delivery_unavailable", `Task ${task.id} runs on ${task.remote.hostLabel}; delegate a new task, or continue its run on that host.`);
    }
    const content = input.content.trim();
    if (!content) throw new Error("Enter a message for the child task.");
    if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
      throw new Error("Create a new task for follow-up work after adoption, or undo adoption first.");
    }
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    if (["deleting", "deletion-failed", "completed", "cancelled"].includes(orchestration.status)) {
      throw new Error(`Messages cannot be sent while the orchestration is ${orchestration.status}.`);
    }
    const active = task.childRunId ? this.services.activeWorkers.runWorkers.get(task.childRunId) : undefined;
    const runningWorker = active && !active.cancelled ? active : undefined;
    const steerable = Boolean(runningWorker) && task.status === "running" && this.services.followUps.acceptsLiveSteering(task.childRunId, runningWorker?.providerType);
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
    const message = this.db.createOrchestrationTaskMessage({
      orchestrationId: orchestration.id,
      taskId: task.id,
      source,
      content,
    });
    await this.db.flushDurable();
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: "message",
      title: "Message queued",
      content,
    });
    const outcome = await this.deliverOrchestrationTaskMessage(task, message, effectiveDelivery, steerable);
    this.services.orchestration.emitOrchestrationChanged(orchestration.id, task.id);
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
      if (this.db.listOrchestrationTaskMessages(task.orchestrationId).some((entry) => entry.id === message.id && entry.status === "failed")) {
        throw new Error(this.db.getOrchestrationTask(task.id).attentionReason ?? "The message could not be delivered.");
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
          this.db.updateOrchestrationTaskMessage(message.id, "unconfirmed");
          await this.db.flushDurable();
          return {
            queued: false,
            delivery: "unconfirmed",
            note: "The running turn did not confirm this message. It may have arrived, so check the child before resending.",
          };
        }
        if (delivery === "steer") {
          this.db.updateOrchestrationTaskMessage(message.id, "failed");
          throw error;
        }
        this.db.updateOrchestrationTaskMessage(message.id, "queued");
      }
    }
    if (task.status === "waiting-input") {
      const blockedOnQuestion = task.childRunId ? this.services.orchestrationCoordinator.pendingChildQuestions(task.childRunId).length > 0 : false;
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
    await this.services.orchestration.orchestrationRuntimeActions.steer(task, message, () => this.services.followUps.requestWorkerSteer(active.worker, formatChildTaskMessages([message]), []));
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
      this.logControllerWarn("Could not append the delivered steering message to the timeline.", { childRunId, messageId: message.id, error });
    }
  }
}
