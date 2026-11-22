import type { RunListItem, RunStatus } from "@buildwarden/shared";
import { StatusDot } from "@buildwarden/renderer";
import { RUN_DISPLAY_STATUS_LABELS, resolveRunDisplayStatus, runThemeState, type RunDisplayStatus } from "@buildwarden/renderer/logic";
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

export const RunStatusPill = ({ run }: { run: Pick<RunListItem, "status" | "orchestrationStatus"> }) => {
  const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus ?? null);
  return (
    <Badge tone={runStatusTone(status)}>
      {/* The desktop layout shows a run's state as a dot. Here the pill names it, and the dot only
          appears once a theme picks a look for run status dots (see .m-status-dot). */}
      <StatusDot state={runThemeState(status)} className="m-status-dot size-1.5 shrink-0 rounded-full bg-current" />
      {RUN_DISPLAY_STATUS_LABELS[status]}
    </Badge>
  );
};

export const ChatStatusPill = ({ status }: { status: RunStatus }) => (
  <Badge tone={runStatusTone(status)}>{RUN_DISPLAY_STATUS_LABELS[status]}</Badge>
);
