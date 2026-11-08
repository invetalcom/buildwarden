import type { BuildWardenDatabase } from "@buildwarden/db";

/** Run steps that show the agent acted, so it received whatever came before them. */
export const AGENT_ACTIVITY_EVENT_TYPES = new Set([
  "output", "tool-call", "tool-result", "tool-progress", "approval-requested", "user-input-requested",
]);

/**
 * Moves the delivery cursor for blocking waits whose result the coordinator demonstrably
 * received: its run shows agent activity after the wait returned. A wait's result is only a
 * tool result, so a crash or an aborted turn before that evidence leaves the news undelivered
 * and the next wake repeats it. Once the turn has ended, an unconfirmed wait counts as failed.
 */
export const settleCoordinatorWaitDeliveries = (
  db: BuildWardenDatabase,
  orchestrationId: string,
  options: { turnEnded: boolean },
): void => {
  const pending = db.listPendingOrchestrationEffects({ orchestrationId, kind: "deliver-update" })
    .filter((effect) => effect.payload.viaWait === true);
  if (pending.length === 0) return;
  const steps = db.getRunSteps(db.getOrchestration(orchestrationId).coordinatorRunId);
  for (const effect of pending) {
    const stepsBefore = typeof effect.payload.stepsBefore === "number" ? effect.payload.stepsBefore : steps.length;
    const received = steps.slice(stepsBefore).some((step) => AGENT_ACTIVITY_EVENT_TYPES.has(step.eventType));
    const targetSequence = typeof effect.payload.targetSequence === "number" ? effect.payload.targetSequence : 0;
    if (received) {
      db.transaction(() => {
        const current = db.getOrchestration(orchestrationId);
        db.updateOrchestration(orchestrationId, { lastDeliveredSequence: Math.max(current.lastDeliveredSequence, targetSequence) });
        db.updateOrchestrationEffect(effect.id, { status: "completed", incrementAttempts: true });
      });
    } else if (options.turnEnded) {
      db.updateOrchestrationEffect(effect.id, {
        status: "failed", incrementAttempts: true,
        errorMessage: "The coordinator turn ended before it showed it received the wait's result; the next wake repeats that news.",
      });
    }
  }
};

/**
 * Records a blocking wait's result as an attempted delivery. The cursor moves later, through
 * {@link settleCoordinatorWaitDeliveries}, once the coordinator shows it received the result.
 */
export const recordCoordinatorWaitDelivery = (
  db: BuildWardenDatabase,
  orchestrationId: string,
  coordinatorRunId: string,
  toolCallId: string,
): void => {
  db.createOrchestrationEffect({
    orchestrationId,
    kind: "deliver-update",
    payload: {
      viaWait: true,
      toolCallId,
      targetSequence: db.getOrchestration(orchestrationId).lastEventSequence,
      stepsBefore: db.getRunSteps(coordinatorRunId).length,
    },
  });
};
