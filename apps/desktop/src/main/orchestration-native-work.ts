import type { BuildWardenDatabase } from "@buildwarden/db";
import {
  buildRunSubagentChunk,
  isTerminalRunSubagentStatus,
  type OrchestrationTaskRecord,
  type RunSubagentInfo,
  type RunSubagentStatus,
} from "@buildwarden/shared";
import { ORCHESTRATION_TASK_READ_MAX_EVENTS } from "./orchestration-task-read";
import { truncateForCoordinator } from "./orchestration-tools";

/**
 * Provider-native subagents a delegated child starts, and how they bear on whether its task is
 * done. One rule serves task reads, waits, completion and adoption: once a child run has stopped,
 * the provider process that ran its subagents is gone, so any subagent still recorded as open is
 * closed as cancelled and its result says that part of the work never finished.
 */

type SubagentState = Record<string, unknown>;

const isOpen = (entry: SubagentState) =>
  typeof entry.status !== "string" || !isTerminalRunSubagentStatus(entry.status as RunSubagentStatus);

const parseMetadata = (json: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/**
 * Records the subagents a stopped child left open as cancelled, updating each one's latest step
 * in place so the run timeline shows them finished. The caller must know the child's worker has
 * exited. Returns how many were closed.
 */
export const closeAbandonedChildSubagents = (db: BuildWardenDatabase, runId: string): number => {
  const open = db.listRunSubagentStates(runId).filter(isOpen);
  if (open.length === 0) return 0;
  const ids = new Set(open.map((entry) => String(entry.id)));
  const latestStepIds = new Map<string, string>();
  for (const step of db.getRunSteps(runId)) {
    const subagent = parseMetadata(step.metadataJson).subagent;
    if (subagent && typeof subagent === "object" && ids.has(String((subagent as SubagentState).id))) {
      latestStepIds.set(String((subagent as SubagentState).id), step.id);
    }
  }
  for (const entry of open) {
    const subagent = { ...entry, status: "cancelled", activity: "Stopped when the child run ended", endedAtMs: Date.now() } as unknown as RunSubagentInfo;
    const stepId = latestStepIds.get(subagent.id);
    if (!stepId) continue;
    const chunk = buildRunSubagentChunk(subagent, { endedReason: "parent-run-ended" });
    db.updateRunStep(stepId, {
      eventType: chunk.type,
      title: chunk.title ?? "Subagent",
      content: chunk.value,
      metadataJson: JSON.stringify(chunk.metadata ?? {}),
    });
  }
  return open.length;
};

/** The caveat a published result carries when subagents were still running as its child stopped. */
export const abandonedSubagentNote = (count: number): string => count > 0
  ? `[${String(count)} provider subagent${count === 1 ? " was" : "s were"} still running when the child stopped; that work is not part of this result.]`
  : "";

/** How many native subagents were still open when the child stopped, for one published result. */
export const resultAbandonedSubagentCount = (db: BuildWardenDatabase, taskId: string, resultId: string): number => {
  const event = db.listOrchestrationTaskEvents(taskId, ORCHESTRATION_TASK_READ_MAX_EVENTS)
    .findLast((entry) => entry.metadata.resultId === resultId);
  return typeof event?.metadata.abandonedSubagents === "number" ? event.metadata.abandonedSubagents : 0;
};

/**
 * Where a task stands beyond its status: whether its result is still being published, and
 * whether provider-native subagents the child started are still open or were cut off.
 */
export const describeChildPendingWork = (
  db: BuildWardenDatabase,
  task: OrchestrationTaskRecord,
  state: { childRunning: boolean; taskActive: boolean },
) => {
  if (!task.childRunId) return null;
  const subagents = db.listRunSubagentStates(task.childRunId);
  const open = subagents.filter(isOpen);
  const finalizing = db.listPendingOrchestrationEffects({ taskId: task.id, kind: "publish-result" }).length > 0;
  let completionState: string;
  if (finalizing) completionState = "finalizing";
  else if (task.status === "waiting-input") completionState = "waiting-input";
  else if (state.childRunning || state.taskActive) completionState = open.length > 0 ? "waiting-for-subagents" : "running";
  else if (task.status === "pending") completionState = task.deferredUntil ? "deferred" : "queued";
  else {
    const latest = db.listOrchestrationTaskResults(task.id).at(-1);
    if (!latest) completionState = "no-result";
    else if (open.length > 0) completionState = "result-available-subagents-unfinished";
    else if (resultAbandonedSubagentCount(db, task.id, latest.id) > 0) completionState = "result-available-subagents-abandoned";
    else completionState = "result-available";
  }
  return {
    completionState,
    ...(subagents.length > 0 ? {
      nativeSubagents: {
        total: subagents.length,
        open: open.length,
        openItems: open.slice(0, 10).map((entry) => ({
          id: String(entry.id),
          status: typeof entry.status === "string" ? entry.status : "unknown",
          ...(typeof entry.name === "string" ? { name: truncateForCoordinator(entry.name, 80) } : {}),
          ...(typeof entry.description === "string" ? { description: truncateForCoordinator(entry.description, 200) } : {}),
        })),
      },
    } : {}),
  };
};
