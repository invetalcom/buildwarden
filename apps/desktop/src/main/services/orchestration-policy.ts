import { createHash } from "node:crypto";
import type { OrchestrationAdoptionStatus, OrchestrationTaskStatus, RunRecord } from "@buildwarden/shared";
import { SESSION_INTERRUPTED_MESSAGE } from "./app-service-constants";

export const ORCHESTRATION_ACTIVE_TASK_STATUSES = new Set<OrchestrationTaskStatus>([
  "provisioning",
  "queued",
  "running",
  "waiting-input",
]);

/** Events that report a child's own state. A task's other events are coordinator or user actions. */
export const ORCHESTRATION_WAKE_NEWS_EVENT_TYPES = new Set(["task-completed", "attention"]);

/** The task status a stopped child run reports. */
export const orchestrationTaskStatusForRun = (run: Pick<RunRecord, "status">): OrchestrationTaskStatus => {
  if (run.status === "completed") return "completed";
  if (run.status === "cancelled") return "cancelled";
  return "failed";
};

/** The outcome a `publish-result` effect recorded, falling back to the run for older or partial payloads. */
export const readPublishResultPayload = (payload: Record<string, unknown>, run: RunRecord) => {
  const text = (key: string, fallback: string | null): string | null =>
    typeof payload[key] === "string" ? payload[key] : payload[key] === null ? null : fallback;
  const count = (key: string, fallback: number): number =>
    typeof payload[key] === "number" && Number.isFinite(payload[key]) ? payload[key] : fallback;
  const status = typeof payload.status === "string" && ["completed", "failed", "cancelled"].includes(payload.status)
    ? payload.status as OrchestrationTaskStatus
    : orchestrationTaskStatusForRun(run);
  return {
    status,
    summary: text("summary", run.summary),
    errorMessage: text("errorMessage", run.errorMessage),
    inputTokens: count("inputTokens", run.inputTokens),
    outputTokens: count("outputTokens", run.outputTokens),
  };
};

export const isSettledChildRun = (run: Pick<RunRecord, "status" | "errorMessage">): boolean =>
  run.status === "completed" || run.status === "failed"
  || (run.status === "cancelled" && run.errorMessage !== SESSION_INTERRUPTED_MESSAGE);

export const ORCHESTRATION_PENDING_ADOPTION_STATUSES = new Set<OrchestrationAdoptionStatus>(["proposed", "applying"]);

export const ORCHESTRATION_CANCELLABLE_STATUSES = new Set([
  "active",
  "waiting",
  "paused",
  "attention",
]);

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
};

export const orchestrationRequestHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
