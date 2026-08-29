import type { RunDiffReviewResult } from "@buildwarden/shared";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { DiffReviewResultDetails } from "./diff-review-result";

export type DiffReviewPanelState = {
  result: RunDiffReviewResult | null;
  busy: boolean;
  error: string | null;
};

const REVIEWER_SIMULATOR_PANEL_COPY = {
  label: "Reviewer simulator",
  empty: "Simulate a demanding teammate and estimate the comments they would likely leave before the PR exists.",
  busy: "Simulating likely reviewer commentsâ€¦",
} as const;

type ReviewPanelHeaderProps = Readonly<{
  state: DiffReviewPanelState;
  expanded: boolean;
  compact: boolean;
  hideRunButton: boolean;
  disabled: boolean;
  scoreTone: string;
  onToggle: () => void;
  onRun: () => void;
}>;

const ReviewExpandButton = ({ expanded, compact, onToggle }: Pick<ReviewPanelHeaderProps, "expanded" | "compact" | "onToggle">) => (
  <button type="button" className={cn("shrink-0 rounded text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]", compact ? "mt-px p-0.5" : "mt-0.5 p-0.5")} onClick={onToggle} aria-expanded={expanded} title={expanded ? "Collapse" : "Expand"} aria-label={expanded ? "Collapse panel" : "Expand panel"}>
    {expanded ? <ChevronDown className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden /> : <ChevronRight className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />}
  </button>
);

const ReviewPanelTitle = ({ state, expanded, compact, scoreTone, onToggle }: Pick<ReviewPanelHeaderProps, "state" | "expanded" | "compact" | "scoreTone" | "onToggle">) => (
  <button type="button" className="min-w-0 flex-1 rounded-md text-left outline-none ring-[var(--ec-accent-ring)] focus-visible:ring-2" onClick={onToggle} aria-expanded={expanded}>
    <div className={cn("flex flex-wrap items-center", compact ? "gap-1.5" : "gap-2")}>
      <p className={cn("font-semibold text-[var(--ec-text)]", compact ? "text-[11px]" : "text-xs")}>{REVIEWER_SIMULATOR_PANEL_COPY.label}</p>
      {state.result ? <span className={cn(`rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] font-medium ${scoreTone}`, compact ? "px-1.5 py-px text-[9px]" : "px-2 py-0.5 text-[10px]")}>{state.result.scoreLabel}: {String(state.result.score)}</span> : null}
    </div>
    {expanded ? <p className={cn("text-[var(--ec-muted)]", compact ? "mt-0.5 text-[10px] leading-snug" : "mt-1 text-[11px] leading-relaxed")}>{state.busy ? REVIEWER_SIMULATOR_PANEL_COPY.busy : state.result?.headline ?? REVIEWER_SIMULATOR_PANEL_COPY.empty}</p> : null}
  </button>
);

const ReviewRunButton = ({ state, compact, hideRunButton, disabled, onRun }: Pick<ReviewPanelHeaderProps, "state" | "compact" | "hideRunButton" | "disabled" | "onRun">) => {
  if (hideRunButton) return null;
  return <Button type="button" size="sm" variant="secondary" className={cn("shrink-0 border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-text)] hover:bg-[var(--ec-hover)]", compact ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-[11px]")} onClick={onRun} disabled={state.busy || disabled}>{state.busy ? <Loader2 className={cn("animate-spin", compact ? "mr-1 h-3 w-3" : "mr-1.5 h-3.5 w-3.5")} aria-hidden /> : null}{state.result ? "Refresh" : "Run"}</Button>;
};

const ReviewPanelHeader = (props: ReviewPanelHeaderProps) => (
  <div className={cn("flex flex-wrap items-start justify-between", props.compact ? "gap-1.5" : "gap-2")}>
    <div className={cn("flex min-w-0 flex-1 items-start", props.compact ? "gap-0.5" : "gap-1")}><ReviewExpandButton {...props} /><ReviewPanelTitle {...props} /></div>
    <ReviewRunButton {...props} />
  </div>
);

const ReviewPanelError = ({ error, compact }: Readonly<{ error: string | null; compact: boolean }>) => {
  if (!error) return null;
  return <p className={cn("rounded-lg border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]", compact ? "mt-1.5 px-1.5 py-1 text-[10px]" : "mt-2 px-2 py-1.5 text-[11px]")}>{error}</p>;
};


export const DiffReviewPanel = ({
  state,
  onRun,
  disabled,
  defaultExpanded = true,
  compact = false,
  hideRunButton = false,
}: {
  state: DiffReviewPanelState;
  onRun: () => void;
  disabled: boolean;
  /** @default true */
  defaultExpanded?: boolean;
  /** Tighter padding and typography (e.g. PR/MR tab). */
  compact?: boolean;
  /** Hide the internal action when the parent surface already owns review execution. */
  hideRunButton?: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  let scoreTone = "text-[var(--ec-danger)]";
  if ((state.result?.score ?? 0) >= 60) scoreTone = "text-[var(--ec-warning)]";
  if ((state.result?.score ?? 0) >= 80) scoreTone = "text-[var(--ec-success)]";

  const toggleExpanded = () => setExpanded((value) => !value);

  return (
    <div
      className={cn(
        "border border-[var(--ec-border)] bg-[var(--ec-panel)]",
        compact ? "rounded-lg p-2" : "rounded-xl p-3",
      )}
    >
      <ReviewPanelHeader state={state} expanded={expanded} compact={compact} hideRunButton={hideRunButton} disabled={disabled} scoreTone={scoreTone} onToggle={toggleExpanded} onRun={onRun} />
      <ReviewPanelError error={state.error} compact={compact} />

      {expanded && state.result ? (
        <div className={cn(compact ? "mt-2 space-y-2" : "mt-3 space-y-3")}>
          <DiffReviewResultDetails result={state.result} compact={compact} />
        </div>
      ) : null}

    </div>
  );
};
