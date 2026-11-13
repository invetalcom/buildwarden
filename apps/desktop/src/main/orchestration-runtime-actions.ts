import type { BuildWardenDatabase } from "@buildwarden/db";
import { SteerOutcomeUnknownError, isSteerOutcomeUnknownError,
  type OrchestrationTaskStatus, type OrchestrationEffectRecord, type OrchestrationTaskRecord, type OrchestrationTaskMessageRecord } from "@buildwarden/shared";

export const ORCHESTRATION_TERMINAL_TASK_STATUSES: ReadonlySet<OrchestrationTaskStatus> = new Set(["completed", "failed", "cancelled", "interrupted", "blocked"]);

/** Runtime actions with different recovery rules: cancellation is idempotent; message delivery is not. */
export class OrchestrationRuntimeActions {
  constructor(private readonly db: BuildWardenDatabase, private readonly cancelRun: (runId: string) => Promise<void>) {}

  async steer(task: OrchestrationTaskRecord, message: OrchestrationTaskMessageRecord, send: () => Promise<void>): Promise<void> {
    const effect = this.db.prepareOrchestrationRuntimeEffect({ orchestrationId: task.orchestrationId, taskId: task.id,
      kind: "steer-child", payload: { childRunId: task.childRunId, messageId: message.id, replay: "never" } });
    await this.db.flushDurable();
    let acknowledged = false;
    try {
      await send();
      acknowledged = true;
      this.db.transaction(() => {
        this.db.updateOrchestrationTaskMessage(message.id, "delivered");
        this.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
      await this.db.flushDurable();
    } catch (error) {
      const uncertain = acknowledged || isSteerOutcomeUnknownError(error);
      try {
        this.db.transaction(() => {
          this.db.updateOrchestrationTaskMessage(message.id, uncertain ? "unconfirmed" : "failed");
          this.db.updateOrchestrationEffect(effect.id, { status: "failed", incrementAttempts: true,
            errorMessage: uncertain ? "Delivery may have occurred; inspect the child before resending." : String(error) });
        });
        await this.db.flushDurable();
      } catch (recordingError) {
        // Losing the error record cannot make a possibly delivered message safe to resend.
        if (uncertain) throw new SteerOutcomeUnknownError("Delivery and its error record could not be confirmed.");
        throw recordingError;
      }
      if (uncertain) throw new SteerOutcomeUnknownError("Delivery could not be recorded reliably; inspect the child before resending.");
      throw error;
    }
  }

  async cancel(tasks: OrchestrationTaskRecord[], cancelOrchestrationId?: string): Promise<void> {
    const effects = this.db.transaction(() => {
      const prepared = tasks.filter((task) => !ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status)).map((task) =>
        this.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "cancel-child" })[0]
        ?? this.db.prepareOrchestrationRuntimeEffect({ orchestrationId: task.orchestrationId, taskId: task.id,
          kind: "cancel-child", payload: { childRunId: task.childRunId, replay: "idempotent" } }));
      if (cancelOrchestrationId) this.db.updateOrchestration(cancelOrchestrationId, { status: "cancelled", finishedAt: new Date().toISOString() });
      return prepared;
    });
    await this.db.flushDurable();
    const errors: unknown[] = [];
    for (const effect of effects) {
      try { await this.applyCancellation(effect); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Child cancellation failed: ${errors.map(String).join("; ")}`);
  }

  private async applyCancellation(effect: OrchestrationEffectRecord): Promise<void> {
    const task = effect.taskId ? this.db.findOrchestrationTask(effect.taskId) : null;
    if (!task || task.childRunId !== effect.payload.childRunId) {
      this.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: "Cancellation target no longer matches its recorded child." });
      await this.db.flushDurable();
      return;
    }
    if (task.childRunId) await this.cancelRun(task.childRunId);
    this.db.transaction(() => {
      this.db.updateOrchestrationTask(task.id, { status: "cancelled", deferredUntil: null, finishedAt: new Date().toISOString(), attentionReason: null });
      this.db.appendOrchestrationEvent({ orchestrationId: task.orchestrationId, taskId: task.id, type: "task-cancelled",
        title: task.title, content: "Cancellation requested.", metadata: { effectId: effect.id } });
      this.db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
    });
    await this.db.flushDurable();
  }

  /** Called before ordinary run recovery, including for already-cancelled orchestrations. */
  async recover(): Promise<void> {
    for (const effect of this.db.listPendingOrchestrationEffects({ kind: "steer-child" })) {
      this.db.transaction(() => {
        if (typeof effect.payload.messageId === "string") this.db.updateOrchestrationTaskMessage(effect.payload.messageId, "unconfirmed");
        this.db.updateOrchestrationEffect(effect.id, { status: "failed", errorMessage: "Interrupted steering is not safe to replay." });
      });
    }
    await this.db.flushDurable();
    for (const effect of this.db.listPendingOrchestrationEffects({ kind: "cancel-child" })) {
      try {
        await this.applyCancellation(effect);
      } catch (error) {
        this.db.transaction(() => {
          this.db.updateOrchestrationEffect(effect.id, { errorMessage: String(error), incrementAttempts: true });
          if (effect.taskId && this.db.findOrchestrationTask(effect.taskId)) {
            this.db.updateOrchestrationTask(effect.taskId, { status: "blocked", attentionReason: "Cancellation recovery failed; retry after checking the child." });
          }
        });
        await this.db.flushDurable();
      }
    }
  }
}
