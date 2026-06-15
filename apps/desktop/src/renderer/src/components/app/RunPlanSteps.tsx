import { Check, Circle, Loader2 } from "lucide-react";
import { parseRunPlanProgressStepsFromMarkdown, type RunPlanStepStatus } from "@buildwarden/shared";
import { cn } from "../../lib/cn";

type ParsedPlanStep = {
  id: string;
  title: string;
  status: RunPlanStepStatus;
};

const parsePlanSteps = (content: string): ParsedPlanStep[] => {
  return parseRunPlanProgressStepsFromMarkdown(content, { inferStatus: true, maxSteps: 12 }).map((step, index) => ({
    id: `${String(index)}:${step.title}`,
    title: step.title,
    status: step.status,
  }));
};

const planStepStatusLabel = (status: RunPlanStepStatus): string => (status === "inProgress" ? "in progress" : status);

export function RunPlanSteps({ content }: { content: string }) {
  const steps = parsePlanSteps(content);
  if (steps.length < 2) {
    return null;
  }

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-panel-muted)]">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--ec-faint)]">Plan steps</p>
        <span className="text-[10px] text-[color:var(--ec-faint)]">
          {steps.filter((step) => step.status === "completed").length}/{steps.length}
        </span>
      </div>
      <div className="grid grid-cols-[2.25rem_5rem_minmax(0,1fr)] border-t border-[color:var(--ec-border)] text-[11px]">
        <div className="border-b border-[color:var(--ec-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--ec-faint)]">#</div>
        <div className="border-b border-[color:var(--ec-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--ec-faint)]">State</div>
        <div className="border-b border-[color:var(--ec-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--ec-faint)]">Step</div>
        {steps.map((step, index) => (
          <div key={step.id} className="contents">
            <div className="border-b border-[color:var(--ec-border)] px-2 py-1.5 tabular-nums text-[color:var(--ec-faint)]">{index + 1}</div>
            <div className="border-b border-[color:var(--ec-border)] px-2 py-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  step.status === "completed"
                    ? "bg-[color:var(--ec-success-soft)] text-[color:var(--ec-success)]"
                    : step.status === "inProgress"
                      ? "bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)]"
                      : "bg-[color:var(--ec-control)] text-[color:var(--ec-muted)]",
                )}
              >
                {step.status === "completed" ? (
                  <Check className="h-2.5 w-2.5" />
                ) : step.status === "inProgress" ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Circle className="h-2 w-2 fill-current" />
                )}
                {planStepStatusLabel(step.status)}
              </span>
            </div>
            <div className="min-w-0 border-b border-[color:var(--ec-border)] px-2 py-1.5 leading-relaxed text-[color:var(--ec-text)]">
              {step.title}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
