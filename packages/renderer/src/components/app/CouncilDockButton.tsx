import { useState, type ReactNode } from "react";
import { canReviewRunChanges, type CouncilRound, type RunRecord } from "@buildwarden/shared";
import { Loader2, ShieldCheck } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { requestCouncilPanel, useCouncilRounds } from "./use-council";

const countLabel = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const activeLabel = (round: CouncilRound): string => {
  if (round.status === "assessing") return "Assessing findings";
  if (round.status === "applying") return round.kind === "code" ? "Fixing" : "Revising";
  const settled = round.reviews.filter((review) => review.status !== "queued" && review.status !== "running").length;
  return `Validating ${String(settled)}/${String(round.reviews.length)}`;
};

/** A finished round stays the answer until the work changes, so a click never pays for the same review twice. */
const hasCurrentResults = (round: CouncilRound | null): round is CouncilRound =>
  Boolean(round && round.status === "ready" && !round.stale);

const DockPill = ({ title, disabled, onClick, children }: Readonly<{ title: string; disabled?: boolean; onClick: () => void; children: ReactNode }>) => (
  <div className="pointer-events-auto h-8 overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[12px] font-medium shadow-lg shadow-black/20 backdrop-blur">
    <button
      type="button"
      className="flex h-full items-center gap-1.5 px-2.5 text-[var(--ec-text)] outline-none transition hover:bg-[var(--ec-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)] disabled:opacity-50"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  </div>
);

/** Sits with the other results of a finished run, above the composer. */
export const CouncilDockButton = ({ run, initialRounds, available, disabled }: Readonly<{
  run: Pick<RunRecord, "id" | "status" | "errorMessage">;
  initialRounds: readonly CouncilRound[] | undefined;
  /** At least one reviewer is configured. */
  available: boolean;
  disabled?: boolean;
}>) => {
  const client = useBuildWardenClient();
  const { latest, active, refresh } = useCouncilRounds(run.id, initialRounds);
  const [starting, setStarting] = useState(false);

  if (active) {
    return (
      <DockPill title="Show validation progress" onClick={() => requestCouncilPanel(run.id)}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />
        {activeLabel(active)}
      </DockPill>
    );
  }

  if (hasCurrentResults(latest)) {
    const count = latest.groups.length;
    return (
      <DockPill title="Show validation results" onClick={() => requestCouncilPanel(run.id)}>
        <ShieldCheck className={`h-3.5 w-3.5 shrink-0 ${count ? "text-[var(--ec-warning)]" : "text-[var(--ec-success)]"}`} aria-hidden />
        {count ? countLabel(count, "finding") : "No findings"}
      </DockPill>
    );
  }

  if (!available || !canReviewRunChanges(run)) return null;
  return (
    <DockPill
      title="Have your reviewers check this result"
      disabled={disabled || starting}
      onClick={() => {
        setStarting(true);
        requestCouncilPanel(run.id);
        void client.startCouncil(run.id)
          .then(refresh)
          .catch((error: unknown) => {
            window.dispatchEvent(new CustomEvent("buildwarden:council-error", { detail: { runId: run.id, message: error instanceof Error ? error.message : String(error) } }));
          })
          .finally(() => setStarting(false));
      }}
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />
      Validate
    </DockPill>
  );
};
