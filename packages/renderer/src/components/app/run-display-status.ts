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
): RunDisplayStatus => {
  // A follow-up can be active after the previous orchestration has finished.
  if (["queued", "preparing", "running"].includes(runStatus) &&
      orchestrationStatus && ["completed", "failed", "cancelled"].includes(orchestrationStatus)) {
    return runStatus;
  }
  return orchestrationStatus ? ORCHESTRATION_DISPLAY_STATUSES[orchestrationStatus] : runStatus;
};

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

/** Color of the small status dot shown next to a run. Only a live run uses the accent color. */
export const runStatusDotClassName = (status: RunDisplayStatus): string => {
  // Each state reads its own theme variable and falls back to the palette color it always had.
  if (status === "completed") return "bg-[var(--bw-state-completed,var(--ec-success))]";
  if (status === "failed" || status === "attention" || status === "deletion-failed") return "bg-[var(--bw-state-failed,var(--ec-danger))]";
  if (status === "cancelled") return "bg-[var(--bw-state-cancelled,var(--ec-faint))]";
  if (status === "preparing" || status === "deleting") return "bg-[var(--bw-state-preparing,var(--ec-info))]";
  if (status === "running") return "bg-[var(--bw-state-running,var(--ec-accent))] shadow-[0_0_0_3px_var(--bw-state-running-soft,var(--ec-accent-soft))]";
  return "bg-[var(--bw-state-waiting,var(--ec-warning))]";
};

/** The six run states a theme can color. Every display status maps to one of them. */
export type RunThemeState = "running" | "preparing" | "waiting" | "completed" | "failed" | "cancelled";

export const runThemeState = (status: RunDisplayStatus, waitingForInput = false): RunThemeState => {
  if (waitingForInput) return "waiting";
  if (status === "completed" || status === "cancelled" || status === "running") return status;
  if (status === "failed" || status === "attention" || status === "deletion-failed") return "failed";
  if (status === "preparing" || status === "deleting") return "preparing";
  return "waiting";
};
