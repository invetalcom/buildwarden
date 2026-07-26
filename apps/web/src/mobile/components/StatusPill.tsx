import type { RunRecord, RunStatus } from "@buildwarden/shared";
import { RUN_DISPLAY_STATUS_LABELS, resolveRunDisplayStatus, type RunDisplayStatus } from "@buildwarden/renderer/logic";
import { Badge, type Tone } from "./primitives";

/**
 * Status vocabulary is shared with the desktop UI (`resolveRunDisplayStatus`) so a run never reads
 * as one thing on a laptop and another on a phone. Only the presentation is mobile-specific.
 */

const STATUS_TONES: Record<RunDisplayStatus, Tone> = {
  queued: "neutral",
  preparing: "info",
  running: "accent",
  waiting: "warning",
  paused: "warning",
  attention: "danger",
  deleting: "info",
  "deletion-failed": "danger",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};

const runStatusTone = (status: RunDisplayStatus): Tone => STATUS_TONES[status] ?? "neutral";

export const RunStatusPill = ({ run }: { run: Pick<RunRecord, "status" | "orchestrationStatus"> }) => {
  const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus ?? null);
  return <Badge tone={runStatusTone(status)}>{RUN_DISPLAY_STATUS_LABELS[status]}</Badge>;
};

export const ChatStatusPill = ({ status }: { status: RunStatus }) => (
  <Badge tone={runStatusTone(status)}>{RUN_DISPLAY_STATUS_LABELS[status]}</Badge>
);
