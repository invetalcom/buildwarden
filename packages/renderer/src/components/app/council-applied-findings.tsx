import type { ReactNode } from "react";
import type { CouncilApplyRecord, CouncilAppliedFinding } from "@buildwarden/shared";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { SEVERITY_STYLES } from "./council-severity";

export const FindingField = ({ label, children }: Readonly<{ label: string; children: ReactNode }>) => (
  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-xs leading-5">
    <span className="text-[var(--ec-faint)]">{label}</span>
    <span className="min-w-0 break-words text-[var(--ec-text)]">{children}</span>
  </div>
);

const shortLocation = (location: string): string => location.split(/[\\/]/).at(-1) ?? location;

const AppliedFinding = ({ finding, open }: Readonly<{ finding: CouncilAppliedFinding; open: boolean }>) => {
  const severity = SEVERITY_STYLES[finding.severity];
  return (
    <details open={open} className="group/finding">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ec-faint)] transition group-open/finding:rotate-90" aria-hidden />
        <span className={cn("h-2 w-2 shrink-0 rounded-full", severity.dot)} title={`${severity.label} severity`} aria-label={`${severity.label} severity`} />
        <span className="min-w-0 flex-1 truncate" title={finding.title}>{finding.title}</span>
        {finding.location ? (
          <span className="hidden max-w-[34%] shrink-[2] truncate font-mono text-[10px] font-normal text-[var(--ec-faint)] sm:inline" title={finding.location}>{shortLocation(finding.location)}</span>
        ) : null}
      </summary>
      <div className="space-y-0.5 pb-1 pl-5 pt-0.5 font-normal">
        {finding.location ? <FindingField label="Where"><span className="break-all font-mono text-[11px]">{finding.location}</span></FindingField> : null}
        {finding.quote ? <FindingField label="Passage"><span className="italic text-[var(--ec-muted)]">{finding.quote}</span></FindingField> : null}
        <FindingField label="Problem">{finding.problem}</FindingField>
        {finding.impact ? <FindingField label="Impact">{finding.impact}</FindingField> : null}
        {finding.suggestion ? <FindingField label="Fix">{finding.suggestion}</FindingField> : null}
        {finding.assessment ? <FindingField label="Assessment">{finding.assessment}</FindingField> : null}
        {finding.raisedBy.length ? <FindingField label="Raised by">{finding.raisedBy.join(", ")}</FindingField> : null}
      </div>
    </details>
  );
};

/** The findings a fix turn was asked to apply, as they appear in the run. */
export const CouncilAppliedFindings = ({ record }: Readonly<{ record: CouncilApplyRecord }>) => (
  <div className="min-w-0">
    <div>{record.label}</div>
    <div className="mt-1 space-y-0.5">
      {record.findings.map((finding, index) => (
        <AppliedFinding key={`${String(index)}:${finding.title}`} finding={finding} open={record.findings.length === 1} />
      ))}
    </div>
  </div>
);
