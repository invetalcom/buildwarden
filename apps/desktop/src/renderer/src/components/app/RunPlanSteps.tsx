import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

type PlanStepStatus = "pending" | "active" | "completed";

type ParsedPlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
};

const cleanStepTitle = (value: string) =>
  value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

const inferStatus = (value: string): PlanStepStatus => {
  const normalized = value.toLowerCase();
  if (normalized.includes("done") || normalized.includes("complete")) {
    return "completed";
  }
  if (normalized.includes("active") || normalized.includes("current") || normalized.includes("progress")) {
    return "active";
  }
  return "pending";
};

const parsePlanSteps = (content: string): ParsedPlanStep[] => {
  const steps: ParsedPlanStep[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const tableCells = line
      .trim()
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (
      tableCells.length >= 2 &&
      !tableCells.every((cell) => /^:?-{2,}:?$/.test(cell)) &&
      !tableCells.some((cell) => /^step|status|task|description$/i.test(cell))
    ) {
      const numericIndex = tableCells.findIndex((cell) => /^\d+[.)]?$/.test(cell));
      const statusCell = tableCells.find((cell) => /pending|active|current|progress|done|complete/i.test(cell));
      const titleCell = tableCells.find((cell, cellIndex) => cellIndex !== numericIndex && cell !== statusCell);
      if (titleCell) {
        steps.push({
          id: `${String(index)}:${titleCell}`,
          title: cleanStepTitle(titleCell),
          status: statusCell ? inferStatus(statusCell) : "pending",
        });
      }
      continue;
    }

    const checkbox = line.match(/^\s*(?:[-*]|\d+[.)])\s+\[([ xX-])\]\s+(.+)$/);
    if (checkbox) {
      const marker = checkbox[1];
      const title = cleanStepTitle(checkbox[2] ?? "");
      if (title) {
        steps.push({
          id: `${String(index)}:${title}`,
          title,
          status: marker === "x" || marker === "X" ? "completed" : marker === "-" ? "active" : "pending",
        });
      }
      continue;
    }

    const numbered = line.match(/^\s*(?:#{1,6}\s*)?(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      const title = cleanStepTitle(numbered[2] ?? "");
      if (title) {
        steps.push({
          id: `${String(index)}:${title}`,
          title,
          status: "pending",
        });
      }
    }
  }
  return steps.slice(0, 12);
};

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
                    : step.status === "active"
                      ? "bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)]"
                      : "bg-[color:var(--ec-control)] text-[color:var(--ec-muted)]",
                )}
              >
                {step.status === "completed" ? (
                  <Check className="h-2.5 w-2.5" />
                ) : step.status === "active" ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Circle className="h-2 w-2 fill-current" />
                )}
                {step.status}
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
