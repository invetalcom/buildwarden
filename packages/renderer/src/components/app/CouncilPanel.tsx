import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  COUNCIL_FAILURE_LABELS,
  canApplyCouncilRound,
  canReviewRunChanges,
  councilApplyActionLabel,
  councilDefaultSelection,
  councilFindingLocation,
  councilGroupFindings,
  councilGroupReviewers,
  councilGroupsByDecision,
  councilRoundSummary,
  councilShortLocation,
  councilWorthRepeating,
  isCouncilRoundActive,
  type CouncilFindingGroup,
  type CouncilReview,
  type CouncilRound,
  type RunRecord,
} from "@buildwarden/shared";
import { AlertTriangle, Check, ChevronRight, CircleSlash, Loader2, ShieldCheck, Sparkles, TriangleAlert, X } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { FindingField } from "./council-applied-findings";
import { SEVERITY_STYLES } from "./council-severity";
import { useCouncilRounds } from "./use-council";

const ReviewerChip = ({ review }: Readonly<{ review: CouncilReview }>) => {
  const running = review.status === "running" || review.status === "queued";
  const ok = review.status === "completed";
  let detail = "";
  if (ok) detail = `${String(review.findingCount)} found`;
  else if (review.failureKind) detail = COUNCIL_FAILURE_LABELS[review.failureKind];
  else if (review.status === "cancelled") detail = "Cancelled";
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-1.5 py-0.5 text-[11px] text-[var(--ec-muted)]"
      title={[`${review.modelLabel} · ${review.providerLabel}`, review.failureMessage].filter(Boolean).join("\n")}
    >
      {running ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden /> : null}
      {ok ? <Check className="h-3 w-3 shrink-0 text-[var(--ec-success)]" aria-hidden /> : null}
      {!running && !ok ? <TriangleAlert className="h-3 w-3 shrink-0 text-[var(--ec-warning)]" aria-hidden /> : null}
      <span className="truncate text-[var(--ec-text)]">{review.modelLabel}</span>
      {detail ? <span className="shrink-0">{detail}</span> : null}
    </span>
  );
};

const GroupRow = ({ round, group, selected, selectable, onToggle, onOpenFile }: Readonly<{
  round: CouncilRound;
  group: CouncilFindingGroup;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
}>) => {
  const [expanded, setExpanded] = useState(false);
  const findings = councilGroupFindings(round, group);
  const lead = findings[0];
  const reviewers = councilGroupReviewers(round, group);
  const location = lead ? councilFindingLocation(lead) : null;
  const severity = SEVERITY_STYLES[group.severity];
  return (
    <li className="border-b border-[var(--ec-border)] last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
        {selectable ? (
          <input
            type="checkbox"
            className="h-3.5 w-3.5 shrink-0 accent-[var(--ec-accent)]"
            checked={selected}
            aria-label={`Include ${group.title}`}
            onChange={onToggle}
          />
        ) : null}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-[var(--ec-faint)] transition", expanded && "rotate-90")} aria-hidden />
          <span className={cn("h-2 w-2 shrink-0 rounded-full", severity.dot)} title={`${severity.label} severity`} aria-label={`${severity.label} severity`} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ec-text)]" title={group.title}>{group.title}</span>
        </button>
        {location ? <span className="hidden max-w-[34%] shrink-[2] truncate font-mono text-[10px] text-[var(--ec-faint)] sm:inline" title={location}>{councilShortLocation(location)}</span> : null}
        {reviewers.length > 1 ? (
          <span
            className="shrink-0 rounded-full bg-[var(--ec-accent-soft)] px-1.5 text-[10px] font-medium text-[var(--ec-accent)]"
            title={`Raised by ${reviewers.map((review) => review.modelLabel).join(", ")}`}
          >
            {reviewers.length} models
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="space-y-2 border-t border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2">
          {group.reason ? (
            <FindingField label={group.decision === "rejected" ? "Rejected" : "Assessment"}>{group.reason}</FindingField>
          ) : null}
          {findings.map((finding) => {
            const reviewer = round.reviews.find((review) => review.id === finding.reviewId);
            const findingLocation = councilFindingLocation(finding);
            return (
              <div key={finding.id} className="space-y-0.5 border-t border-[var(--ec-border)] pt-2 first:border-t-0 first:pt-0">
                {findings.length > 1 || reviewer ? (
                  <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">{reviewer?.modelLabel ?? "Reviewer"}</div>
                ) : null}
                {findingLocation ? (
                  <FindingField label="Where">
                    <span className="break-all font-mono text-[11px]">
                      {finding.file && onOpenFile ? (
                        <button type="button" className="break-all text-left text-[var(--ec-accent)] hover:underline" onClick={() => onOpenFile(finding.file!)}>
                          {findingLocation}
                        </button>
                      ) : findingLocation}
                    </span>
                  </FindingField>
                ) : null}
                {finding.quote ? <FindingField label="Passage"><span className="italic text-[var(--ec-muted)]">{finding.quote}</span></FindingField> : null}
                <FindingField label="Problem">{finding.problem}</FindingField>
                {finding.impact ? <FindingField label="Impact">{finding.impact}</FindingField> : null}
                {finding.suggestion ? <FindingField label="Fix">{finding.suggestion}</FindingField> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </li>
  );
};

const GroupSection = ({ title, count, defaultOpen = true, children }: Readonly<{ title: string; count: number; defaultOpen?: boolean; children: ReactNode }>) => {
  const [open, setOpen] = useState(defaultOpen);
  if (!count) return null;
  return (
    <section className="overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)]">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 bg-[var(--ec-panel-soft)] px-3 py-1 text-left uppercase tracking-wide text-[var(--ec-muted)] outline-none hover:text-[var(--ec-text)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition", open && "rotate-90")} aria-hidden />
          {title} ({count})
        </button>
      </h3>
      {open ? <ul className="border-t border-[var(--ec-border)]">{children}</ul> : null}
    </section>
  );
};

const ReviewerReports = ({ round }: Readonly<{ round: CouncilRound }>) => {
  const reviews = [...round.reviews, ...(round.assessment ? [round.assessment] : [])].filter((review) => review.output || review.failureMessage);
  if (!reviews.length) return null;
  return (
    <details className="text-[11px] text-[var(--ec-muted)]">
      <summary className="cursor-pointer select-none hover:text-[var(--ec-text)]">Original reports</summary>
      <div className="mt-1 space-y-1">
        {reviews.map((review) => (
          <details key={review.id} className="rounded border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1">
            <summary className="cursor-pointer select-none">
              {review.id === round.assessment?.id ? `${review.modelLabel} (assessment)` : review.modelLabel}
              <span className="ml-1 text-[var(--ec-faint)]">{(review.inputTokens + review.outputTokens).toLocaleString()} tokens</span>
            </summary>
            <pre className="app-scrollbar mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--ec-text)]">{review.output || review.failureMessage}</pre>
          </details>
        ))}
      </div>
    </details>
  );
};

const Notice = ({ tone, children }: Readonly<{ tone: "warning" | "danger"; children: ReactNode }>) => (
  <div className={cn(
    "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs leading-5",
    tone === "warning"
      ? "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-text)]"
      : "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-text)]",
  )}>
    <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", tone === "warning" ? "text-[var(--ec-warning)]" : "text-[var(--ec-danger)]")} aria-hidden />
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

const RoundIcon = ({ round }: Readonly<{ round: CouncilRound }>) => {
  if (isCouncilRoundActive(round)) return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />;
  if (round.status === "failed" || round.status === "apply-failed") return <TriangleAlert className="h-4 w-4 shrink-0 text-[var(--ec-danger)]" aria-hidden />;
  if (round.status === "cancelled") return <CircleSlash className="h-4 w-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />;
  if (round.status === "applied") return <Sparkles className="h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />;
  return <ShieldCheck className={cn("h-4 w-4 shrink-0", round.groups.length ? "text-[var(--ec-warning)]" : "text-[var(--ec-success)]")} aria-hidden />;
};

const defaultSelection = (round: CouncilRound | null): Set<string> => new Set(round ? councilDefaultSelection(round) : []);

export const CouncilPanel = ({ run, initialRounds, available, readOnly, onOpenFile }: Readonly<{
  run: Pick<RunRecord, "id" | "status" | "errorMessage">;
  initialRounds: readonly CouncilRound[] | undefined;
  /** At least one reviewer is configured, so new rounds can start. */
  available: boolean;
  readOnly?: boolean;
  onOpenFile?: (path: string) => void;
}>) => {
  const client = useBuildWardenClient();
  const { rounds, latest, refresh } = useCouncilRounds(client, run.id, initialRounds);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => defaultSelection(latest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const round = useMemo(() => rounds.find((entry) => entry.id === selectedRoundId) ?? latest, [latest, rounds, selectedRoundId]);
  const assessedKey = round ? `${round.id}:${round.groups.map((group) => group.id).join(",")}` : "";
  useEffect(() => {
    setSelection(defaultSelection(round));
    // Reselect only when the list itself changes, never because of an unrelated refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessedKey]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ runId: string; message: string }>).detail;
      if (detail.runId === run.id) setError(detail.message);
    };
    window.addEventListener("buildwarden:council-error", listener);
    return () => window.removeEventListener("buildwarden:council-error", listener);
  }, [run.id]);

  const perform = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    void action()
      .then(refresh)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };
  const startRound = () => perform(() => client.startCouncil(run.id).then(() => setSelectedRoundId(null)));

  const canStart = available && !readOnly && canReviewRunChanges(run) && !rounds.some(isCouncilRoundActive);

  if (!round) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs">
        <ShieldCheck className="h-6 w-6 text-[var(--ec-accent)]" aria-hidden />
        <p className="max-w-xs leading-5 text-[var(--ec-muted)]">
          Have other models independently check this result. Nothing changes until you choose what to fix.
        </p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button size="sm" disabled={!canStart || busy} onClick={startRound}>Validate</Button>
      </div>
    );
  }

  const selectable = !readOnly && canApplyCouncilRound(round) && round.id === latest?.id;
  const recommended = councilGroupsByDecision(round.groups, "recommended");
  const unassessed = councilGroupsByDecision(round.groups, "unassessed");
  const rejected = councilGroupsByDecision(round.groups, "rejected");
  const selectedIds = round.groups.filter((group) => selection.has(group.id)).map((group) => group.id);
  const usable = round.reviews.filter((review) => review.status === "completed").length;
  const active = isCouncilRoundActive(round);
  const renderGroups = (groups: CouncilFindingGroup[]) => groups.map((group) => (
    <GroupRow
      key={group.id}
      round={round}
      group={group}
      selectable={selectable}
      selected={selection.has(group.id)}
      onOpenFile={onOpenFile}
      onToggle={() => setSelection((current) => {
        const next = new Set(current);
        if (!next.delete(group.id)) next.add(group.id);
        return next;
      })}
    />
  ));
  const applyLabel = councilApplyActionLabel(round.kind, selectedIds.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--ec-border)] px-3 py-2">
        <RoundIcon round={round} />
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ec-text)]" title={councilRoundSummary(round)}>{councilRoundSummary(round)}</div>
        {rounds.length > 1 ? (
          <Select
            className="w-28 shrink-0"
            triggerClassName="h-7 text-xs"
            ariaLabel="Validation round"
            value={round.id}
            options={rounds.map((entry, index) => ({ value: entry.id, label: `Round ${String(index + 1)}` })).reverse()}
            onValueChange={setSelectedRoundId}
          />
        ) : null}
        {active && round.status !== "applying" && !readOnly ? (
          <Button variant="ghost" size="xs" className="shrink-0 gap-1" disabled={busy} onClick={() => perform(() => client.cancelCouncil(round.id))}>
            <X className="h-3 w-3" aria-hidden />Cancel
          </Button>
        ) : null}
        {canStart && councilWorthRepeating(round) ? (
          <Button variant="secondary" size="xs" className="shrink-0" disabled={busy} title="Review the current state again" onClick={startRound}>Validate again</Button>
        ) : null}
      </div>

      <div className="app-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <div className="flex flex-wrap gap-1">
          {round.reviews.map((review) => <ReviewerChip key={review.id} review={review} />)}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {round.error ? <Notice tone="danger">{round.error}</Notice> : null}
        {round.stale ? <Notice tone="warning">The work changed after this review. Findings may be out of date, so validate again or check them first.</Notice> : null}
        {round.assessmentError ? <Notice tone="warning">{round.authorModelLabel} could not assess these findings, so they are shown as reported.</Notice> : null}
        {round.summary ? <p className="leading-5 text-[var(--ec-muted)]">{round.summary}</p> : null}
        {round.status === "reviewing" ? (
          <p className="leading-5 text-[var(--ec-muted)]">Each reviewer works on its own copy of the workspace, so you can keep working. Results appear here when they finish.</p>
        ) : null}
        {round.status === "assessing" ? (
          <p className="leading-5 text-[var(--ec-muted)]">{round.authorModelLabel} is grouping duplicates and checking each finding.</p>
        ) : null}
        <GroupSection title="Recommended" count={recommended.length}>{renderGroups(recommended)}</GroupSection>
        <GroupSection title="Not assessed" count={unassessed.length}>{renderGroups(unassessed)}</GroupSection>
        <GroupSection title="Rejected" count={rejected.length} defaultOpen={false}>{renderGroups(rejected)}</GroupSection>
        {round.status === "ready" && !round.groups.length ? (
          <p className="py-4 text-center text-[var(--ec-muted)]">{usable === round.reviews.length ? "The reviewers found nothing worth changing." : "The reviewers that finished found nothing worth changing."}</p>
        ) : null}
        {active ? null : <ReviewerReports round={round} />}
      </div>

      {selectable ? (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--ec-border)] px-3 py-2">
          <span className="min-w-0 truncate text-[11px] text-[var(--ec-muted)]">{round.authorModelLabel} applies these in one turn</span>
          <Button size="sm" className="shrink-0" disabled={busy || !selectedIds.length} onClick={() => perform(() => client.applyCouncilFindings(round.id, selectedIds))}>
            {applyLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
