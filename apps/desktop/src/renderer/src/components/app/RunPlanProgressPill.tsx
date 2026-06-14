import { useMemo, useRef, useState } from "react";
import { Check, Circle, ListTodo, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import type { DerivedRunPlanProgress } from "../../lib/run-plan-progress";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

const statusLabel = (status: string) => (status === "inProgress" ? "in progress" : status);

const StepIcon = ({ status }: { status: string }) => {
  if (status === "completed") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ec-success-soft)] text-[var(--ec-success)]">
        <Check className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ec-info-soft)] text-[var(--ec-info)]">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-faint)]">
      <Circle className="h-2 w-2" aria-hidden />
    </span>
  );
};

export function RunPlanProgressPill({ progress }: { progress: DerivedRunPlanProgress | null }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(() => {
    if (!progress?.steps.length) {
      return null;
    }
    const completed = progress.steps.filter((step) => step.status === "completed").length;
    const active = progress.steps.find((step) => step.status === "inProgress") ?? progress.steps.find((step) => step.status === "pending") ?? progress.steps.at(-1);
    return {
      completed,
      total: progress.steps.length,
      activeTitle: active?.title ?? "Plan",
    };
  }, [progress]);

  if (!progress || !summary) {
    return null;
  }

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn(
          "h-8 max-w-[18rem] shrink-0 gap-2 border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)] px-2 text-xs text-[var(--ec-info)] hover:bg-[var(--ec-hover)]",
          open && "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Plan progress: ${String(summary.completed)}/${String(summary.total)} - ${summary.activeTitle}`}
        onClick={() => setOpen((current) => !current)}
      >
        <ListTodo className="h-4 w-4 shrink-0" aria-hidden />
        <span className="shrink-0 tabular-nums">
          {summary.completed}/{summary.total}
        </span>
        <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-[var(--ec-panel)] sm:flex" aria-hidden>
          {progress.steps.map((step, index) => (
            <span
              key={`${step.status}:${index}:${step.title}`}
              className={cn(
                "min-w-0 flex-1 border-r border-[var(--ec-bg)] last:border-r-0",
                step.status === "completed"
                  ? "bg-[var(--ec-success)]"
                  : step.status === "inProgress"
                    ? "bg-[var(--ec-info)]"
                    : "bg-[var(--ec-border-strong)]",
              )}
            />
          ))}
        </span>
        <span className="hidden max-w-[10rem] truncate text-left text-[11px] text-[var(--ec-text)] md:inline">
          {summary.activeTitle}
        </span>
      </Button>
      <AnchorDropdownPortal
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        align="start"
        widthPx={320}
        className="glass-popover overflow-hidden p-0"
      >
        <div className="max-h-[50vh] min-w-0 overflow-auto p-2">
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">Plan progress</p>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--ec-muted)]">
              {summary.completed}/{summary.total}
            </span>
          </div>
          {progress.explanation ? (
            <p className="mb-1.5 px-1 text-[11px] leading-snug text-[var(--ec-muted)]">{progress.explanation}</p>
          ) : null}
          <div className="space-y-1">
            {progress.steps.map((step, index) => (
              <div
                key={`${step.status}:${index}:${step.title}`}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2 py-1.5",
                  step.status === "inProgress" && "bg-[var(--ec-info-soft)]",
                  step.status === "completed" && "bg-[var(--ec-success-soft)]",
                )}
              >
                <StepIcon status={step.status} />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "break-words text-[12px] leading-snug",
                      step.status === "completed"
                        ? "text-[var(--ec-muted)] line-through decoration-[var(--ec-faint)]"
                        : step.status === "inProgress"
                          ? "text-[var(--ec-text)]"
                          : "text-[var(--ec-muted)]",
                    )}
                  >
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ec-faint)]">
                    {statusLabel(step.status)}
                  </p>
                </div>
              </div>
            ))}
          </div>
          {progress.fallback ? (
            <p className="mt-2 px-1 text-[10px] leading-snug text-[var(--ec-faint)]">
              Waiting for the provider to report live status.
            </p>
          ) : null}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
}
