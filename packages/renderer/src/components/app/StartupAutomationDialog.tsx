import type { StartupAutomationCatchUpItem } from "@buildwarden/shared";
import { CalendarClock, Loader2, Play, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

export type StartupAutomationState =
  | { status: "checking" }
  | { status: "review"; items: StartupAutomationCatchUpItem[] }
  | { status: "starting"; items: StartupAutomationCatchUpItem[] }
  | { status: "error"; message: string }
  | { status: "ready" };

interface StartupAutomationDialogProps {
  state: Exclude<StartupAutomationState, { status: "ready" }>;
  onConfirm: () => void;
  onSkip: () => void;
  onRetry: () => void;
}

export const StartupAutomationDialog = ({ state, onConfirm, onSkip, onRetry }: StartupAutomationDialogProps) => {
  if (state.status === "checking") {
    return <Card className="flex w-full max-w-lg items-center gap-3 p-6"><CalendarClock className="size-5 text-[var(--ec-accent)]" /><div><h1 className="text-lg font-semibold text-[var(--ec-text)]">Checking scheduled work</h1><p className="mt-0.5 text-sm text-[var(--ec-muted)]">Looking for automation occurrences missed while BuildWarden was closed.</p></div><Loader2 className="ml-auto size-5 animate-spin text-[var(--ec-accent)]" /></Card>;
  }
  if (state.status === "error") {
    return <Card className="w-full max-w-lg p-6"><h1 className="text-lg font-semibold text-[var(--ec-text)]">Scheduled work could not be checked</h1><p className="mt-2 text-sm text-[var(--ec-danger)]">{state.message}</p><div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onSkip}>Continue without starting</Button><Button onClick={onRetry}>Retry</Button></div></Card>;
  }
  const starting = state.status === "starting";
  return (
    <Card className="w-full max-w-xl overflow-hidden p-0 shadow-[var(--ec-popover-shadow)]">
      <div className="p-6 pb-4"><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"><CalendarClock className="size-5" /></span><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ec-accent)]">Missed automations</p><h1 className="mt-1 text-xl font-semibold text-[var(--ec-text)]">Start {state.items.length} overdue {state.items.length === 1 ? "job" : "jobs"}?</h1><p className="mt-2 text-sm leading-6 text-[var(--ec-muted)]">Each automation starts at most once, even if several occurrences were missed.</p></div></div></div>
      <div className="max-h-72 overflow-y-auto border-y border-[var(--ec-border)]">
        {state.items.map((item) => <div key={item.automationId} className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] px-6 py-3 last:border-0"><div className="min-w-0"><p className="truncate text-sm font-medium text-[var(--ec-text)]">{item.automationName}</p><p className="mt-0.5 truncate text-xs text-[var(--ec-muted)]">{item.projectName}</p></div><span className="shrink-0 text-[11px] text-[var(--ec-faint)]">Due {new Date(item.scheduledAt).toLocaleString()}</span></div>)}
      </div>
      <div className="flex items-start gap-2 px-6 pt-4 text-xs leading-5 text-[var(--ec-muted)]"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--ec-success)]" /><p>Skipping advances these schedules without starting a run. Future occurrences remain enabled.</p></div>
      <div className="flex justify-end gap-2 px-6 py-5"><Button variant="secondary" disabled={starting} onClick={onSkip}>Skip missed jobs</Button><Button disabled={starting} onClick={onConfirm}>{starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}{starting ? "Starting…" : "Start jobs"}</Button></div>
    </Card>
  );
};
