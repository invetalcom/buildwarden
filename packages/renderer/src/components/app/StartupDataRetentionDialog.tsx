import type { DataRetentionCleanupImpact } from "@buildwarden/shared";
import { Database, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

export type StartupDataRetentionState =
  | { status: "checking" }
  | { status: "review"; impact: DataRetentionCleanupImpact }
  | { status: "deleting"; impact: DataRetentionCleanupImpact }
  | { status: "error"; phase: "checking" | "deleting"; message: string }
  | { status: "ready" };

interface StartupDataRetentionDialogProps {
  state: Exclude<StartupDataRetentionState, { status: "ready" }>;
  onConfirm: () => void;
  onSkip: () => void;
  onRetry: () => void;
}

const impactRows = (impact: DataRetentionCleanupImpact) => [
  { label: "Agent runs", count: impact.runCount },
  { label: "Chats", count: impact.chatCount },
  { label: "Project Lab threads", count: impact.projectLabThreadCount },
  { label: "Project loops", count: impact.projectLoopCount },
];

export const StartupDataRetentionDialog = ({ state, onConfirm, onSkip, onRetry }: StartupDataRetentionDialogProps) => {
  if (state.status === "checking") {
    return (
      <Card className="w-full max-w-lg p-6 shadow-[var(--ec-popover-shadow)]">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]">
            <Database className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-[var(--ec-text)]">Checking saved data</h1>
            <p className="mt-0.5 text-sm text-[var(--ec-muted)]">Reviewing the startup retention policy before opening BuildWarden.</p>
          </div>
          <Loader2 className="ml-auto size-5 animate-spin text-[var(--ec-accent)]" aria-label="Checking old data" />
        </div>
      </Card>
    );
  }

  if (state.status === "error") {
    const deletionFailed = state.phase === "deleting";
    return (
      <Card className="w-full max-w-lg p-6 shadow-[var(--ec-popover-shadow)]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-danger)]">Retention check unavailable</p>
        <h1 className="mt-2 text-xl font-semibold text-[var(--ec-text)]">
          {deletionFailed ? "Cleanup did not finish" : "Old data was not changed"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--ec-muted)]">{state.message}</p>
        {deletionFailed ? (
          <p className="mt-2 text-xs leading-5 text-[var(--ec-muted)]">
            Some items may already have been removed. Retry safely rechecks what remains.
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onSkip}>Continue to app</Button>
          <Button type="button" onClick={onRetry}>Retry check</Button>
        </div>
      </Card>
    );
  }

  const deleting = state.status === "deleting";
  const cutoffLabel = new Date(state.impact.cutoffAt).toLocaleDateString();
  return (
    <Card className="w-full max-w-xl overflow-hidden p-0 shadow-[var(--ec-popover-shadow)]">
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
            <Trash2 className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-danger)]">Startup cleanup review</p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--ec-text)]">Delete data older than {state.impact.dayCount} days?</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--ec-muted)]">
              These items were last updated before {cutoffLabel}. Confirming permanently removes their app-owned workspaces and related history.
            </p>
          </div>
        </div>
      </div>
      <div className="border-y border-[var(--ec-border)] px-6">
        {impactRows(state.impact).map((item) => (
          <div key={item.label} className="flex items-center justify-between border-b border-[var(--ec-border)] py-2.5 last:border-b-0">
            <span className="text-sm text-[var(--ec-muted)]">{item.label}</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-[var(--ec-text)]">{item.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2 px-6 pt-4 text-xs leading-5 text-[var(--ec-muted)]">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
        <p>Bookmarked runs and chats, For later runs, newer data, and original project repositories stay protected.</p>
      </div>
      <div className="flex justify-end gap-2 px-6 py-5">
        <Button type="button" variant="secondary" disabled={deleting} onClick={onSkip}>Not now</Button>
        <Button type="button" variant="danger" disabled={deleting} onClick={onConfirm}>
          {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
          {deleting ? "Deleting old data..." : "Delete old data"}
        </Button>
      </div>
    </Card>
  );
};
