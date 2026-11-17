import type { OrchestrationRecord, OrchestrationTaskRecord, OrchestrationAdoptionStatus } from "@buildwarden/shared";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES } from "./orchestration-runtime-actions";
const ORCHESTRATION_PENDING_ADOPTION_STATUSES = new Set<OrchestrationAdoptionStatus>(["proposed", "applying"]);

/** Pure wake decision shared by controller scheduling and blocking waits. */
export const orchestrationWakeSatisfied = (
  orchestration: OrchestrationRecord,
  tasks: OrchestrationTaskRecord[],
  undeliveredTaskIds: ReadonlySet<string> = new Set(),
  undeliveredQuestionTaskIds: ReadonlySet<string> = new Set(),
): boolean => {
    if (!orchestration.wakeMode) return false;
    if (tasks.some((task) => task.status === "waiting-input" && undeliveredQuestionTaskIds.has(task.id))) return true;
    const relevant = orchestration.wakeTaskIds.length > 0
      ? tasks.filter((task) => orchestration.wakeTaskIds.includes(task.id))
      : tasks;
    if (orchestration.wakeMode === "adoption-decided") {
      return !relevant.some((task) => ORCHESTRATION_PENDING_ADOPTION_STATUSES.has(task.adoptionStatus));
    }
    if (relevant.length === 0) return true;
    if (relevant.every((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status))) return true;
    if (orchestration.wakeMode === "all-terminal") return false;
    const changed = relevant.filter((task) => undeliveredTaskIds.has(task.id));
    if (orchestration.wakeMode === "any-terminal") {
      return changed.some((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status));
    }
    return changed.some((task) =>
      task.status === "waiting-input" || task.status === "blocked" || task.status === "interrupted" || task.status === "failed" ||
      task.deferredUntil !== null);
};
