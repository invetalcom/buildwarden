import type { RunDiffReviewFinding, RunDiffReviewResult } from "@buildwarden/shared";
import { cn } from "../../lib/cn";

const PRIORITY_STYLES = {
  high: "border-rose-500/30 bg-rose-500/[0.08] text-rose-200",
  medium: "border-amber-500/30 bg-amber-500/[0.08] text-amber-200",
  low: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200",
} as const;

const SectionTitle = ({ children, compact }: Readonly<{ children: string; compact: boolean }>) => (
  <p className={cn("font-semibold uppercase tracking-[0.16em] text-zinc-500", compact ? "text-[9px] tracking-[0.12em]" : "text-[10px]")}>{children}</p>
);

const ReviewStrengths = ({ strengths, compact }: Readonly<{ strengths: string[]; compact: boolean }>) => {
  if (strengths.length === 0) return null;
  return <div><SectionTitle compact={compact}>Strengths</SectionTitle><div className={cn("flex flex-wrap", compact ? "mt-0.5 gap-1" : "mt-1 gap-1.5")}>{strengths.map((strength, index) => <span key={`${String(index)}-${strength}`} className={cn("rounded-full border border-cyan-500/20 bg-cyan-500/[0.07] text-cyan-100", compact ? "px-1.5 py-px text-[9px] leading-tight" : "px-2 py-1 text-[10px]")}>{strength}</span>)}</div></div>;
};

const ReviewFinding = ({ finding, compact }: Readonly<{ finding: RunDiffReviewFinding; compact: boolean }>) => (
  <div className={cn("rounded-lg border border-zinc-800/80 bg-zinc-900/55", compact ? "p-2" : "p-2.5")}>
    <div className="flex flex-wrap items-center gap-1.5"><span className={`rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-wide ${PRIORITY_STYLES[finding.priority]} ${compact ? "text-[8px]" : "text-[9px]"}`}>{finding.priority}</span><p className={cn("font-medium text-zinc-100", compact ? "text-[10px]" : "text-[11px]")}>{finding.title}</p></div>
    {finding.filePath || finding.lineReference ? <p className={cn("text-zinc-500", compact ? "mt-0.5 text-[9px]" : "mt-1 text-[10px]")}>{[finding.filePath, finding.lineReference].filter(Boolean).join(" · ")}</p> : null}
    <p className={cn("text-zinc-300", compact ? "mt-1 text-[10px] leading-snug" : "mt-1.5 text-[11px] leading-relaxed")}>{finding.detail}</p>
    {finding.recommendation ? <p className={cn("text-cyan-100", compact ? "mt-1 text-[10px] leading-snug" : "mt-1.5 text-[11px] leading-relaxed")}>Next: {finding.recommendation}</p> : null}
  </div>
);

const ReviewFindings = ({ findings, compact }: Readonly<{ findings: RunDiffReviewFinding[]; compact: boolean }>) => (
  <div><SectionTitle compact={compact}>Findings</SectionTitle>{findings.length > 0 ? <div className={cn(compact ? "mt-1 space-y-1.5" : "mt-2 space-y-2")}>{findings.map((finding, index) => <ReviewFinding key={`${String(index)}-${finding.title}`} finding={finding} compact={compact} />)}</div> : <p className={cn("text-zinc-500", compact ? "mt-1 text-[10px]" : "mt-2 text-[11px]")}>No concrete findings were returned for this diff.</p>}</div>
);

const ReviewNextSteps = ({ steps, compact }: Readonly<{ steps: string[]; compact: boolean }>) => {
  if (steps.length === 0) return null;
  return <div><SectionTitle compact={compact}>Suggested next steps</SectionTitle><div className={cn(compact ? "mt-1 space-y-0.5" : "mt-2 space-y-1")}>{steps.map((step, index) => <p key={`${String(index)}-${step}`} className={cn("text-zinc-300", compact ? "text-[10px] leading-snug" : "text-[11px] leading-relaxed")}>{index + 1}. {step}</p>)}</div></div>;
};

export const DiffReviewResultDetails = ({ result, compact }: Readonly<{ result: RunDiffReviewResult; compact: boolean }>) => (
  <><p className={cn("text-zinc-300", compact ? "text-[10px] leading-snug" : "text-[11px] leading-relaxed")}>{result.summary}</p><ReviewStrengths strengths={result.strengths} compact={compact} /><ReviewFindings findings={result.findings} compact={compact} /><ReviewNextSteps steps={result.nextSteps} compact={compact} /><p className={cn("text-zinc-600", compact ? "text-[9px]" : "text-[10px]")}>Generated {new Date(result.generatedAt).toLocaleTimeString()}</p></>
);
