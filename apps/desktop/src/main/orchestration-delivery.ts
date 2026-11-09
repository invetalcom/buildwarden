import type { BuildWardenDatabase } from "@buildwarden/db";

/** Run steps that show the agent acted, so it received whatever came before them. */
export const AGENT_ACTIVITY_EVENT_TYPES = new Set([
  "output", "tool-call", "tool-result", "tool-progress", "approval-requested", "user-input-requested",
]);

const WAIT_TOOL_NAME = "buildwarden_orchestration_wait";

const stepMetadata = (json: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/**
 * Whether a step is the wait call's own record. Transports log a host tool's result before they
 * hand it to the model (Codex records it, then answers the app server), so that step shows only
 * that BuildWarden produced the result, not that the model saw it.
 */
const isWaitOwnStep = (metadataJson: string, toolCallId: string | undefined): boolean => {
  const metadata = stepMetadata(metadataJson);
  if (toolCallId && metadata.callId === toolCallId) return true;
  return metadata.toolName === WAIT_TOOL_NAME && (metadata.callId === undefined || metadata.callId === toolCallId);
};

/**
 * Moves the delivery cursor for blocking waits whose result the coordinator demonstrably
 * received: after the wait returned, its run shows agent activity other than the wait's own
 * record, such as its next tool call or its output. A wait's result is only a tool result, so a
 * crash or an aborted turn before that evidence leaves the news undelivered and the next wake
 * repeats it. Once the turn has ended, an unconfirmed wait counts as failed.
 *
 * Limitation: a tool the model called in parallel with the wait, whose result is recorded after
 * the wait's, also counts as evidence, although the model has not read either result yet.
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
    const toolCallId = typeof effect.payload.toolCallId === "string" ? effect.payload.toolCallId : undefined;
    const received = steps.slice(stepsBefore).some((step) =>
      AGENT_ACTIVITY_EVENT_TYPES.has(step.eventType) && !isWaitOwnStep(step.metadataJson, toolCallId));
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
 * Settles wait deliveries of an orchestration that is ending. Nothing reads its news after that,
 * and startup recovery skips finished orchestrations, so leaving them pending would strand them.
 */
export const closeCoordinatorWaitDeliveries = (db: BuildWardenDatabase, orchestrationId: string): void => {
  for (const effect of db.listPendingOrchestrationEffects({ orchestrationId, kind: "deliver-update" })) {
    if (effect.payload.viaWait !== true) continue;
    db.updateOrchestrationEffect(effect.id, {
      status: "failed", incrementAttempts: true,
      errorMessage: "The orchestration ended before the coordinator showed it received the wait's result.",
    });
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
