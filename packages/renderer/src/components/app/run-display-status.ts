import type { OrchestrationStatus, RunStatus } from "@buildwarden/shared";

export type RunDisplayStatus = RunStatus | Exclude<OrchestrationStatus, "active">;

const ORCHESTRATION_DISPLAY_STATUSES: Record<OrchestrationStatus, RunDisplayStatus> = {
  active: "running",
  waiting: "waiting",
  paused: "paused",
  attention: "attention",
  deleting: "deleting",
  "deletion-failed": "deletion-failed",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
};

export const RUN_DISPLAY_STATUS_LABELS: Record<RunDisplayStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  attention: "Attention",
  deleting: "Deleting",
  "deletion-failed": "Cleanup failed",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const resolveRunDisplayStatus = (
  runStatus: RunStatus,
  orchestrationStatus?: OrchestrationStatus | null,
): RunDisplayStatus =>
  orchestrationStatus ? ORCHESTRATION_DISPLAY_STATUSES[orchestrationStatus] : runStatus;

export const runDisplayStatusTone = (
  status: RunDisplayStatus,
): "queued" | "preparing" | "running" | "completed" | "failed" | "cancelled" => {
  if (status === "waiting" || status === "paused") return "queued";
  if (status === "attention" || status === "deletion-failed") return "failed";
  if (status === "deleting") return "preparing";
  return status;
};

export const isRunDisplayStatusActive = (status: RunDisplayStatus): boolean =>
  !["completed", "failed", "cancelled", "deletion-failed"].includes(status);
