import type { RunDiffReviewResult } from "@easycode/shared";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type DiffReviewPanelState = {
  result: RunDiffReviewResult | null;
  busy: boolean;
  error: string | null;
};

const REVIEWER_SIMULATOR_PANEL_COPY = {
  label: "Reviewer simulator",
  empty: "Simulate a demanding teammate and estimate the comments they would likely leave before the PR exists.",
  busy: "Simulating likely reviewer comments…",
} as const;

export const REVIEW_PRIORITY_STYLES = {
  high: "border-rose-500/30 bg-rose-500/[0.08] text-rose-200",
  medium: "border-amber-500/30 bg-amber-500/[0.08] text-amber-200",
  low: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200",
} as const;

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
  const copy = REVIEWER_SIMULATOR_PANEL_COPY;
  const scoreTone =
    (state.result?.score ?? 0) >= 80 ? "text-emerald-300" : (state.result?.score ?? 0) >= 60 ? "text-amber-300" : "text-rose-300";

  const toggleExpanded = () => setExpanded((value) => !value);

  return (
    <div
      className={cn(
        "border border-zinc-800/80 bg-zinc-950/55",
        compact ? "rounded-lg p-2" : "rounded-xl p-3",
      )}
    >
      <div className={cn("flex flex-wrap items-start justify-between", compact ? "gap-1.5" : "gap-2")}>
        <div className={cn("flex min-w-0 flex-1 items-start", compact ? "gap-0.5" : "gap-1")}>
          <button
            type="button"
            className={cn(
              "shrink-0 rounded text-zinc-500 transition hover:bg-zinc-800/80 hover:text-zinc-300",
              compact ? "mt-px p-0.5" : "mt-0.5 p-0.5",
            )}
            onClick={toggleExpanded}
            aria-expanded={expanded}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? "Collapse panel" : "Expand panel"}
          >
            {expanded ? (
              <ChevronDown className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
            ) : (
              <ChevronRight className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
            )}
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 rounded-md text-left outline-none ring-cyan-500/40 focus-visible:ring-2"
            onClick={toggleExpanded}
            aria-expanded={expanded}
          >
            <div className={cn("flex flex-wrap items-center", compact ? "gap-1.5" : "gap-2")}>
              <p className={cn("font-semibold text-zinc-100", compact ? "text-[11px]" : "text-xs")}>{copy.label}</p>
              {state.result ? (
                <span
                  className={cn(
                    `rounded-full border border-zinc-700/80 bg-zinc-900/80 font-medium ${scoreTone}`,
                    compact ? "px-1.5 py-px text-[9px]" : "px-2 py-0.5 text-[10px]",
                  )}
                >
                  {state.result.scoreLabel}: {String(state.result.score)}
                </span>
              ) : null}
            </div>
            {expanded ? (
              <p
                className={cn(
                  "text-zinc-500",
                  compact ? "mt-0.5 text-[10px] leading-snug" : "mt-1 text-[11px] leading-relaxed",
                )}
              >
                {state.busy ? copy.busy : state.result?.headline ?? copy.empty}
              </p>
            ) : null}
          </button>
        </div>
        {hideRunButton ? null : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={cn(
              "shrink-0 border border-zinc-800 bg-zinc-900/80 text-zinc-200 hover:bg-zinc-900",
              compact ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-[11px]",
            )}
            onClick={onRun}
            disabled={state.busy || disabled}
          >
            {state.busy ? (
              <Loader2 className={cn("animate-spin", compact ? "mr-1 h-3 w-3" : "mr-1.5 h-3.5 w-3.5")} aria-hidden />
            ) : null}
            {state.result ? "Refresh" : "Run"}
          </Button>
        )}
      </div>

      {state.error ? (
        <p
          className={cn(
            "rounded-lg border border-rose-500/20 bg-rose-500/[0.06] text-rose-200",
            compact ? "mt-1.5 px-1.5 py-1 text-[10px]" : "mt-2 px-2 py-1.5 text-[11px]",
          )}
        >
          {state.error}
        </p>
      ) : null}

      {expanded && state.result ? (
        <div className={cn(compact ? "mt-2 space-y-2" : "mt-3 space-y-3")}>
          <p className={cn("text-zinc-300", compact ? "text-[10px] leading-snug" : "text-[11px] leading-relaxed")}>{state.result.summary}</p>

          {state.result.strengths.length > 0 ? (
            <div>
              <p
                className={cn(
                  "font-semibold uppercase tracking-[0.16em] text-zinc-500",
                  compact ? "text-[9px] tracking-[0.12em]" : "text-[10px]",
                )}
              >
                Strengths
              </p>
              <div className={cn("flex flex-wrap", compact ? "mt-0.5 gap-1" : "mt-1 gap-1.5")}>
                {state.result.strengths.map((strength, index) => (
                  <span
                    key={`reviewer-sim-strength-${String(index)}`}
                    className={cn(
                      "rounded-full border border-cyan-500/20 bg-cyan-500/[0.07] text-cyan-100",
                      compact ? "px-1.5 py-px text-[9px] leading-tight" : "px-2 py-1 text-[10px]",
                    )}
                  >
                    {strength}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <p
              className={cn(
                "font-semibold uppercase tracking-[0.16em] text-zinc-500",
                compact ? "text-[9px] tracking-[0.12em]" : "text-[10px]",
              )}
            >
              Findings
            </p>
            {state.result.findings.length > 0 ? (
              <div className={cn(compact ? "mt-1 space-y-1.5" : "mt-2 space-y-2")}>
                {state.result.findings.map((finding, index) => (
                  <div
                    key={`reviewer-sim-finding-${String(index)}`}
                    className={cn("rounded-lg border border-zinc-800/80 bg-zinc-900/55", compact ? "p-2" : "p-2.5")}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-wide ${REVIEW_PRIORITY_STYLES[finding.priority]} ${compact ? "text-[8px]" : "text-[9px]"}`}
                      >
                        {finding.priority}
                      </span>
                      <p className={cn("font-medium text-zinc-100", compact ? "text-[10px]" : "text-[11px]")}>{finding.title}</p>
                    </div>
                    {(finding.filePath || finding.lineReference) ? (
                      <p className={cn("text-zinc-500", compact ? "mt-0.5 text-[9px]" : "mt-1 text-[10px]")}>
                        {[finding.filePath, finding.lineReference].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                    <p className={cn("text-zinc-300", compact ? "mt-1 text-[10px] leading-snug" : "mt-1.5 text-[11px] leading-relaxed")}>
                      {finding.detail}
                    </p>
                    {finding.recommendation ? (
                      <p className={cn("text-cyan-100", compact ? "mt-1 text-[10px] leading-snug" : "mt-1.5 text-[11px] leading-relaxed")}>
                        Next: {finding.recommendation}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className={cn("text-zinc-500", compact ? "mt-1 text-[10px]" : "mt-2 text-[11px]")}>
                No concrete findings were returned for this diff.
              </p>
            )}
          </div>

          {state.result.nextSteps.length > 0 ? (
            <div>
              <p
                className={cn(
                  "font-semibold uppercase tracking-[0.16em] text-zinc-500",
                  compact ? "text-[9px] tracking-[0.12em]" : "text-[10px]",
                )}
              >
                Suggested next steps
              </p>
              <div className={cn(compact ? "mt-1 space-y-0.5" : "mt-2 space-y-1")}>
                {state.result.nextSteps.map((step, index) => (
                  <p
                    key={`reviewer-sim-next-${String(index)}`}
                    className={cn("text-zinc-300", compact ? "text-[10px] leading-snug" : "text-[11px] leading-relaxed")}
                  >
                    {index + 1}. {step}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <p className={cn("text-zinc-600", compact ? "text-[9px]" : "text-[10px]")}>
            Generated {new Date(state.result.generatedAt).toLocaleTimeString()}
          </p>
        </div>
      ) : null}
    </div>
  );
};
