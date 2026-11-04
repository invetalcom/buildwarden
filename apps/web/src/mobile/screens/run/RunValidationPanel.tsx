import { useEffect, useState, type ReactNode } from "react";
import {
  COUNCIL_FAILURE_LABELS,
  canApplyCouncilRound,
  canReviewRunChanges,
  councilActiveLabel,
  councilApplyActionLabel,
  councilDefaultSelection,
  councilFindingLocation,
  councilGroupFindings,
  councilGroupReviewers,
  councilGroupsByDecision,
  councilHasCurrentResults,
  councilIsPartial,
  councilRoundSummary,
  councilShortLocation,
  councilWorthRepeating,
  isCouncilRoundActive,
  type CouncilFindingGroup,
  type CouncilReview,
  type CouncilRound,
  type CouncilSeverity,
  type RunRecord,
} from "@buildwarden/shared";
import { AlertTriangle, Check, ChevronRight, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { cn } from "../../lib/cn";
import { Sheet } from "../../components/Sheet";
import { Button, FilterChip, InlineError, SectionAction, SectionLabel } from "../../components/primitives";

export interface CouncilRoundsState {
  rounds: CouncilRound[];
  latest: CouncilRound | null;
  active: CouncilRound | null;
  refresh: () => Promise<void>;
}

const SEVERITY: Record<CouncilSeverity, { label: string; dot: string }> = {
  high: { label: "High", dot: "bg-[var(--ec-danger)]" },
  medium: { label: "Medium", dot: "bg-[var(--ec-warning)]" },
  low: { label: "Low", dot: "bg-[var(--ec-muted)]" },
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="py-1">
    <div className="text-[11px] text-[var(--ec-faint)]">{label}</div>
    <div className="m-wrap-anywhere text-[13px] leading-5 text-[var(--ec-text)]">{children}</div>
  </div>
);

const Notice = ({ tone, children }: { tone: "warning" | "danger"; children: ReactNode }) => (
  <div className={cn(
    "mx-3 mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5 text-[var(--ec-text)]",
    tone === "warning" ? "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)]" : "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)]",
  )}>
    <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" ? "text-[var(--ec-warning)]" : "text-[var(--ec-danger)]")} aria-hidden />
    <span className="m-wrap-anywhere min-w-0">{children}</span>
  </div>
);

const ReviewerChip = ({ review }: { review: CouncilReview }) => {
  const running = review.status === "running" || review.status === "queued";
  const ok = review.status === "completed";
  let detail = "";
  if (ok) detail = `${String(review.findingCount)} found`;
  else if (review.failureKind) detail = COUNCIL_FAILURE_LABELS[review.failureKind];
  else if (review.status === "cancelled") detail = "Cancelled";
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1 text-[11px] text-[var(--ec-muted)]">
      {running ? <Loader2 className="size-3 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden /> : null}
      {ok ? <Check className="size-3 shrink-0 text-[var(--ec-success)]" aria-hidden /> : null}
      {!running && !ok ? <TriangleAlert className="size-3 shrink-0 text-[var(--ec-warning)]" aria-hidden /> : null}
      <span className="truncate text-[var(--ec-text)]">{review.modelLabel}</span>
      {detail ? <span className="shrink-0">{detail}</span> : null}
    </span>
  );
};

const FindingRow = ({ round, group, selectable, selected, onToggle, onOpen }: {
  round: CouncilRound;
  group: CouncilFindingGroup;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) => {
  const lead = councilGroupFindings(round, group)[0];
  const location = lead ? councilFindingLocation(lead) : null;
  const models = councilGroupReviewers(round, group).length;
  const severity = SEVERITY[group.severity];
  return (
    <li className="flex items-stretch border-b border-[var(--ec-border)] last:border-b-0">
      {selectable ? (
        <button type="button" role="checkbox" aria-checked={selected} aria-label={`Include ${group.title}`} onClick={onToggle} className="flex w-11 shrink-0 items-center justify-center active:bg-[var(--ec-hover)]">
          <span className={cn(
            "flex size-5 items-center justify-center rounded border",
            selected ? "border-[var(--ec-accent)] bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]" : "border-[var(--ec-border-strong)]",
          )}>
            {selected ? <Check className="size-3.5" /> : null}
          </span>
        </button>
      ) : null}
      <button type="button" onClick={onOpen} className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pr-3 text-left active:bg-[var(--ec-hover)]", !selectable && "pl-4")}>
        <span className="min-w-0 flex-1">
          <span className="m-wrap-anywhere line-clamp-2 text-[13px] font-medium leading-5 text-[var(--ec-text)]">{group.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">
            <span className={cn("size-2 shrink-0 rounded-full", severity.dot)} aria-hidden />
            <span className="shrink-0">{severity.label}</span>
            {location ? <span className="min-w-0 truncate font-mono text-[10px] text-[var(--ec-faint)]">{councilShortLocation(location)}</span> : null}
            {models > 1 ? <span className="ml-auto shrink-0 rounded-full bg-[var(--ec-accent-soft)] px-1.5 text-[10px] font-medium text-[var(--ec-accent)]">{models} models</span> : null}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-[var(--ec-faint)]" aria-hidden />
      </button>
    </li>
  );
};

const FindingSheet = ({ round, group, onClose }: { round: CouncilRound; group: CouncilFindingGroup | null; onClose: () => void }) => (
  <Sheet open={group !== null} onClose={onClose} title="Finding">
    {group ? (
      <div className="px-4 pb-4 pt-3">
        <h3 className="m-wrap-anywhere text-sm font-semibold leading-5 text-[var(--ec-text)]">{group.title}</h3>
        <div className="mt-1 flex items-center gap-1.5 pb-1 text-[11px] text-[var(--ec-muted)]">
          <span className={cn("size-2 shrink-0 rounded-full", SEVERITY[group.severity].dot)} aria-hidden />
          {SEVERITY[group.severity].label} severity
        </div>
        {group.reason ? <Field label={group.decision === "rejected" ? "Why it was rejected" : "Assessment"}>{group.reason}</Field> : null}
        {councilGroupFindings(round, group).map((finding) => {
          const location = councilFindingLocation(finding);
          return (
            <section key={finding.id} className="mt-2 border-t border-[var(--ec-border)] pt-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ec-faint)]">
                {round.reviews.find((review) => review.id === finding.reviewId)?.modelLabel ?? "Reviewer"}
              </h3>
              {location ? <Field label="Where"><span className="font-mono text-xs">{location}</span></Field> : null}
              {finding.quote ? <Field label="Passage"><span className="italic text-[var(--ec-muted)]">{finding.quote}</span></Field> : null}
              <Field label="Problem">{finding.problem}</Field>
              {finding.impact ? <Field label="Impact">{finding.impact}</Field> : null}
              {finding.suggestion ? <Field label="Fix">{finding.suggestion}</Field> : null}
            </section>
          );
        })}
      </div>
    ) : null}
  </Sheet>
);

/** Results of a run's validation. Details open in a sheet, so the list stays scannable on a phone. */
export const RunValidationPanel = ({ run, council, available }: {
  run: Pick<RunRecord, "id" | "status" | "errorMessage">;
  council: CouncilRoundsState;
  /** At least one reviewer is configured, so new rounds can start. */
  available: boolean;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const { rounds, latest, refresh } = council;
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const round = rounds.find((entry) => entry.id === selectedRoundId) ?? latest;
  const [selection, setSelection] = useState<Set<string>>(() => new Set(round ? councilDefaultSelection(round) : []));

  const listKey = round ? `${round.id}:${round.groups.map((group) => group.id).join(",")}` : "";
  useEffect(() => {
    setSelection(new Set(round ? councilDefaultSelection(round) : []));
    // Reselect only when the list itself changes, never because of an unrelated refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  const canMutate = client.capabilities.runMutations;
  const canStart = available && canMutate && canReviewRunChanges(run) && !rounds.some(isCouncilRoundActive);
  const start = () => void action.run(() => client.startCouncil(run.id), "Could not start the validation.").then(() => { setSelectedRoundId(null); return refresh(); });

  if (!round) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <ShieldCheck className="size-7 text-[var(--ec-accent)]" aria-hidden />
        <p className="text-[13px] leading-5 text-[var(--ec-muted)]">Have other models independently check this result. Nothing changes until you choose what to fix.</p>
        {action.error ? <InlineError message={action.error} /> : null}
        <Button busy={action.busy} disabled={!canStart} onClick={start}>Validate</Button>
      </div>
    );
  }

  const active = isCouncilRoundActive(round);
  const selectable = canMutate && canApplyCouncilRound(round) && round.id === latest?.id;
  const recommended = councilGroupsByDecision(round.groups, "recommended");
  const unassessed = councilGroupsByDecision(round.groups, "unassessed");
  const rejected = councilGroupsByDecision(round.groups, "rejected");
  const selectedIds = round.groups.filter((group) => selection.has(group.id)).map((group) => group.id);
  const allFinished = !councilIsPartial(round);
  const renderRows = (groups: CouncilFindingGroup[]) => (
    <ul className="border-y border-[var(--ec-border)]">
      {groups.map((group) => (
        <FindingRow
          key={group.id}
          round={round}
          group={group}
          selectable={selectable}
          selected={selection.has(group.id)}
          onOpen={() => setOpenGroupId(group.id)}
          onToggle={() => setSelection((current) => {
            const next = new Set(current);
            if (!next.delete(group.id)) next.add(group.id);
            return next;
          })}
        />
      ))}
    </ul>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="m-scroll flex-1 pb-3">
        <div className="px-4 pt-3 text-[13px] font-medium text-[var(--ec-text)]">{councilRoundSummary(round)}</div>
        {rounds.length > 1 ? (
          <div className="m-scroll-x flex gap-1.5 px-3 pt-2">
            {rounds.map((entry, index) => ({ entry, index })).reverse().map(({ entry, index }) => (
              <FilterChip key={entry.id} active={entry.id === round.id} onClick={() => setSelectedRoundId(entry.id)}>Round {index + 1}</FilterChip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
          {round.reviews.map((review) => <ReviewerChip key={review.id} review={review} />)}
        </div>
        {action.error ? <InlineError message={action.error} /> : null}
        {round.error ? <Notice tone="danger">{round.error}</Notice> : null}
        {round.stale ? <Notice tone="warning">The work changed after this review. Findings may be out of date.</Notice> : null}
        {round.assessmentError ? <Notice tone="warning">{round.authorModelLabel} could not assess these findings, so they are shown as reported.</Notice> : null}
        {round.summary ? <p className="px-4 pt-2 text-xs leading-5 text-[var(--ec-muted)]">{round.summary}</p> : null}
        {round.status === "reviewing" ? <p className="px-4 pt-2 text-xs leading-5 text-[var(--ec-muted)]">Each reviewer works on its own copy of the workspace. You can leave this screen; results appear here when they finish.</p> : null}
        {round.status === "assessing" ? <p className="px-4 pt-2 text-xs leading-5 text-[var(--ec-muted)]">{round.authorModelLabel} is grouping duplicates and checking each finding.</p> : null}

        {recommended.length ? <><SectionLabel>Recommended ({recommended.length})</SectionLabel>{renderRows(recommended)}</> : null}
        {unassessed.length ? <><SectionLabel>Not assessed ({unassessed.length})</SectionLabel>{renderRows(unassessed)}</> : null}
        {rejected.length ? (
          <>
            <SectionLabel action={<SectionAction onClick={() => setShowRejected((current) => !current)}>{showRejected ? "Hide" : "Show"}</SectionAction>}>Rejected ({rejected.length})</SectionLabel>
            {showRejected ? renderRows(rejected) : null}
          </>
        ) : null}
        {round.status === "ready" && !round.groups.length ? (
          <p className="px-6 py-8 text-center text-[13px] text-[var(--ec-muted)]">{allFinished ? "The reviewers found nothing worth changing." : "The reviewers that finished found nothing worth changing."}</p>
        ) : null}
      </div>

      {active && round.status !== "applying" && canMutate ? (
        <div className="shrink-0 border-t border-[var(--ec-border)] px-3 pb-[calc(0.5rem+var(--m-safe-bottom))] pt-2">
          <Button tone="neutral" block size="sm" busy={action.busy} onClick={() => void action.run(() => client.cancelCouncil(round.id), "Could not cancel the validation.").then(refresh)}>Cancel validation</Button>
        </div>
      ) : null}
      {selectable ? (
        <div className="shrink-0 border-t border-[var(--ec-border)] px-3 pb-[calc(0.5rem+var(--m-safe-bottom))] pt-2">
          <Button block busy={action.busy} disabled={!selectedIds.length} onClick={() => void action.run(() => client.applyCouncilFindings(round.id, selectedIds), "Could not apply these findings.").then(refresh)}>
            {councilApplyActionLabel(round.kind, selectedIds.length)}
          </Button>
          <p className="mt-1 truncate text-center text-[11px] text-[var(--ec-muted)]">{round.authorModelLabel} applies these in one turn</p>
        </div>
      ) : null}
      {!selectable && !active && canStart && councilWorthRepeating(round) ? (
        <div className="shrink-0 border-t border-[var(--ec-border)] px-3 pb-[calc(0.5rem+var(--m-safe-bottom))] pt-2">
          <Button tone="neutral" block size="sm" busy={action.busy} onClick={start}>Validate again</Button>
        </div>
      ) : null}

      <FindingSheet round={round} group={round.groups.find((group) => group.id === openGroupId) ?? null} onClose={() => setOpenGroupId(null)} />
    </div>
  );
};

/** The way into validation from the activity view, sitting just above the composer. */
export const RunValidationBar = ({ run, council, available, onOpen }: {
  run: Pick<RunRecord, "id" | "status" | "errorMessage">;
  council: CouncilRoundsState;
  available: boolean;
  onOpen: () => void;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const { active, latest, refresh } = council;
  const barClass = "m-tap mx-2 mt-1 flex shrink-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 text-left text-xs font-medium text-[var(--ec-text)] active:bg-[var(--ec-hover)] disabled:opacity-50";

  if (active) {
    return (
      <button type="button" className={barClass} onClick={onOpen}>
        <Loader2 className="size-4 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{councilActiveLabel(active)}</span>
        <ChevronRight className="size-4 shrink-0 text-[var(--ec-faint)]" aria-hidden />
      </button>
    );
  }

  if (latest && councilHasCurrentResults(latest)) {
    const count = latest.groups.length;
    return (
      <button type="button" className={barClass} onClick={onOpen}>
        <ShieldCheck className={cn("size-4 shrink-0", count ? "text-[var(--ec-warning)]" : "text-[var(--ec-success)]")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{count ? `${String(count)} finding${count === 1 ? "" : "s"}` : "No findings"}</span>
        <ChevronRight className="size-4 shrink-0 text-[var(--ec-faint)]" aria-hidden />
      </button>
    );
  }

  if (!available || !client.capabilities.runMutations || !canReviewRunChanges(run)) return null;
  return (
    <>
      {action.error ? <InlineError message={action.error} /> : null}
      <button
        type="button"
        className={barClass}
        disabled={action.busy}
        onClick={() => void action.ok(() => client.startCouncil(run.id), "Could not start the validation.").then((started) => {
          if (!started) return undefined;
          onOpen();
          return refresh();
        })}
      >
        {action.busy ? <Loader2 className="size-4 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden /> : <ShieldCheck className="size-4 shrink-0 text-[var(--ec-accent)]" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">Validate</span>
      </button>
    </>
  );
};
