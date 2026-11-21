import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PR_WATCH_OPTIONS,
  PR_WATCH_STATUS_LABELS,
  PR_WATCH_TRIGGER_LABELS,
  isPrWatchActive,
  prWatchRequestLabel,
  type PrWatchOptions,
  type PrWatchTriggerKind,
  type PrWatchView,
  type RunForgeRequestSummary,
  type RunPrWatchCandidate,
  type RunPrWatchCandidates,
} from "@buildwarden/shared";
import { AlertTriangle, ChevronDown, Eye, GitPullRequest, Loader2 } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { RunForgeRequestBadge } from "./RunForgeRequestPanel";
import { runForgeReadinessColor } from "./run-forge-ui";
import { formatRunRelativeTime } from "./run-summary-format";
import { describeLinkSource, describeWakeBudget, describeWakeResult, prWatchButtonLabel, resolveManualRequestUrl } from "./pr-watch-ui";

const TRIGGERS: PrWatchTriggerKind[] = ["checks", "feedback", "conflicts"];
const TRIGGER_OPTION: Record<PrWatchTriggerKind, keyof PrWatchOptions> = { checks: "checks", feedback: "feedback", conflicts: "conflicts" };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const RequestLine = ({ request, className }: Readonly<{ request: Pick<RunForgeRequestSummary, "sourceBranch" | "targetBranch" | "author">; className?: string }>) => (
  <p className={cn("truncate font-mono text-[11px] text-[var(--ec-faint)]", className)}>
    {request.sourceBranch} → {request.targetBranch}{request.author ? ` · @${request.author}` : ""}
  </p>
);

/** Another request on the run's branch. Choosing one relinks the run at once. */
const CandidateRow = ({ candidate, disabled, onSelect }: Readonly<{
  candidate: RunPrWatchCandidate;
  disabled: boolean;
  onSelect: () => void;
}>) => (
  <label
    className={cn(
      "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--ec-hover)]",
      (!candidate.watchable || disabled) && "cursor-default opacity-60 hover:bg-transparent",
    )}
    title={candidate.reason ?? candidate.request.url}
  >
    <input
      type="radio"
      name="pr-watch-candidate"
      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--ec-accent)]"
      checked={false}
      disabled={!candidate.watchable || disabled}
      onChange={onSelect}
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[var(--ec-text)]">#{candidate.request.number} {candidate.request.title}</span>
      <span className="block truncate text-[11px] text-[var(--ec-faint)]">{candidate.reason ?? `${candidate.request.sourceBranch} → ${candidate.request.targetBranch}`}</span>
    </span>
  </label>
);

/** Confirms which request will be watched before anything starts. */
const PrWatchConfirm = ({ runId, summary, onDone }: Readonly<{ runId: string; summary: RunForgeRequestSummary; onDone: () => void }>) => {
  const client = useBuildWardenClient();
  const label = prWatchRequestLabel(summary.provider);
  const [candidates, setCandidates] = useState<RunPrWatchCandidates | null>(null);
  const [changing, setChanging] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [options, setOptions] = useState<PrWatchOptions>(DEFAULT_PR_WATCH_OPTIONS);
  const [takeOver, setTakeOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCandidates(await client.getRunPrWatchCandidates(runId));
    } catch (loadError) {
      setError(errorText(loadError));
    }
  }, [client, runId]);
  useEffect(() => { void load(); }, [load, summary.url]);

  const current = candidates?.candidates.find((candidate) => candidate.request.url === summary.url) ?? null;
  const blockedReason = current && !current.watchable ? current.reason : null;
  const others = candidates?.candidates.filter((candidate) => candidate.request.url !== summary.url) ?? [];

  const link = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.setRunForgeLink(runId, url);
      setChanging(false);
      setManualUrl("");
      await load();
    } catch (linkError) {
      setError(errorText(linkError));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.startPrWatch(runId, { prUrl: summary.url, options, ...(takeOver ? { takeOver } : {}) });
      onDone();
    } catch (startError) {
      setError(errorText(startError));
      setBusy(false);
    }
  };

  const manualTarget = resolveManualRequestUrl(manualUrl, summary.url);
  const anyTrigger = TRIGGERS.some((trigger) => options[TRIGGER_OPTION[trigger]]);

  return (
    <div className="space-y-2.5 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-[var(--ec-text)]">Watch {label} #{summary.number}</p>
        {candidates ? <span className="shrink-0 text-[11px] text-[var(--ec-faint)]">{describeLinkSource(candidates.linkSource)}</span> : null}
      </div>
      <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <GitPullRequest className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", runForgeReadinessColor[summary.readiness])} aria-hidden />
          <p className="line-clamp-2 min-w-0 font-medium text-[var(--ec-text)]" title={summary.url}>{summary.title}</p>
        </div>
        <RequestLine request={summary} className="mt-1 pl-5" />
        <button
          type="button"
          className="mt-1.5 flex items-center gap-1 pl-5 text-[11px] font-medium text-[var(--ec-accent)] hover:underline disabled:opacity-50"
          disabled={busy}
          aria-expanded={changing}
          onClick={() => setChanging((value) => !value)}
        >
          Change {label}
          <ChevronDown className={cn("h-3 w-3 transition", changing && "rotate-180")} aria-hidden />
        </button>
      </div>

      {changing ? (
        <div className="space-y-1.5">
          {candidates === null ? <p className="flex items-center gap-1.5 text-[var(--ec-muted)]"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />Loading requests…</p> : null}
          {candidates && !candidates.error && !others.length ? (
            <p className="text-[var(--ec-muted)]">No other open request uses {candidates.workspaceBranch ? `"${candidates.workspaceBranch}"` : "this run's branch"}.</p>
          ) : null}
          {others.length ? (
            <div className="max-h-40 overflow-y-auto">
              {others.map((candidate) => (
                <CandidateRow key={candidate.request.url} candidate={candidate} disabled={busy} onSelect={() => void link(candidate.request.url)} />
              ))}
            </div>
          ) : null}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (manualTarget) void link(manualTarget);
            }}
          >
            <Input
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              placeholder={`${label} number or URL`}
              className="h-7 flex-1 font-mono text-[11px]"
              disabled={busy}
              aria-label={`${label} number or URL`}
            />
            <Button type="submit" size="xs" variant="secondary" disabled={busy || !manualTarget}>Link</Button>
          </form>
        </div>
      ) : null}

      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <legend className="mb-1 text-[11px] text-[var(--ec-faint)]">Wake the agent for</legend>
        {TRIGGERS.map((trigger) => (
          <label key={trigger} className="flex items-center gap-1.5 text-[var(--ec-text)]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--ec-accent)]"
              checked={options[TRIGGER_OPTION[trigger]]}
              disabled={busy}
              onChange={(event) => setOptions((value) => ({ ...value, [TRIGGER_OPTION[trigger]]: event.target.checked }))}
            />
            {PR_WATCH_TRIGGER_LABELS[trigger]}
          </label>
        ))}
      </fieldset>

      {current?.watchedByRunId ? (
        <label className="flex items-center gap-1.5 text-[var(--ec-warning)]">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--ec-accent)]" checked={takeOver} disabled={busy} onChange={(event) => setTakeOver(event.target.checked)} />
          Another run watches this {label}. Move the watch here.
        </label>
      ) : null}
      {blockedReason ? <p className="flex items-start gap-1.5 text-[var(--ec-danger)]"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{blockedReason}</p> : null}
      {candidates?.error ? <p className="text-[var(--ec-warning)]">Could not list other requests: {candidates.error}</p> : null}
      {error ? <p className="text-[var(--ec-danger)]">{error}</p> : null}
      <p className="text-[11px] leading-4 text-[var(--ec-faint)]">
        The agent commits its fixes. BuildWarden pushes them together and replies to each comment.
      </p>
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button
          type="button"
          size="xs"
          disabled={busy || !anyTrigger || Boolean(blockedReason) || (Boolean(current?.watchedByRunId) && !takeOver)}
          onClick={() => void start()}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
          Watch
        </Button>
      </div>
    </div>
  );
};

/** What a running or paused watch is doing, with its controls. */
const PrWatchStatus = ({ runId, watch, readOnly }: Readonly<{ runId: string; watch: PrWatchView; readOnly: boolean }>) => {
  const client = useBuildWardenClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = prWatchRequestLabel(watch.provider);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(false);
    }
  };
  const result = watch.lastResult;
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-[var(--ec-text)]">{label} #{watch.prNumber} · {PR_WATCH_STATUS_LABELS[watch.status]}</p>
        {watch.lastCheckedAt ? <span className="shrink-0 text-[11px] text-[var(--ec-faint)]">checked {formatRunRelativeTime(watch.lastCheckedAt)}</span> : null}
      </div>
      {watch.pending ? (
        <p className="text-[var(--ec-muted)]">Working on: {watch.pending.triggers.map((trigger) => PR_WATCH_TRIGGER_LABELS[trigger]).join(", ")}</p>
      ) : null}
      {watch.message ? (
        <p className={cn("leading-5", watch.status === "paused" ? "text-[var(--ec-warning)]" : "text-[var(--ec-muted)]")}>{watch.message}</p>
      ) : null}
      {result ? (
        <div className="space-y-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-2">
          <p className="text-[var(--ec-text)]">Last wake {formatRunRelativeTime(result.finishedAt)}</p>
          <p className="text-[var(--ec-muted)]">{describeWakeResult(result)}</p>
          {result.needsUser.length ? (
            <div>
              <p className="font-medium text-[var(--ec-warning)]">Needs your decision</p>
              <ul className="mt-0.5 space-y-0.5 text-[var(--ec-muted)]">
                {result.needsUser.map((entry) => <li key={entry} className="line-clamp-2">{entry}</li>)}
              </ul>
            </div>
          ) : null}
          {result.replyErrors.length ? (
            <ul className="space-y-0.5 text-[var(--ec-danger)]">{result.replyErrors.map((entry) => <li key={entry} className="line-clamp-2">{entry}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--ec-faint)]">{describeWakeBudget(watch)}</p>
      {error ? <p className="text-[var(--ec-danger)]">{error}</p> : null}
      {readOnly ? null : (
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => client.stopPrWatch(runId))}>Stop watching</Button>
          {watch.status === "paused" ? (
            <Button type="button" size="xs" disabled={busy} onClick={() => void act(() => client.resumePrWatch(runId))}>Resume</Button>
          ) : null}
        </div>
      )}
    </div>
  );
};

/**
 * Sits in the run's result dock: the linked request, and the watch that wakes the agent
 * when its checks fail, reviewers comment, or it conflicts.
 */
export const RunPrWatchControl = ({ runId, summary, watch, showBadge, readOnly, onOpenRequest }: Readonly<{
  runId: string;
  summary: RunForgeRequestSummary;
  watch: PrWatchView | null;
  /** The request badge steps aside while the request's own panel is showing. */
  showBadge: boolean;
  readOnly: boolean;
  onOpenRequest: () => void;
}>) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = isPrWatchActive(watch) || watch?.status === "paused";
  // Read-only clients may look at a watch, but cannot start one.
  const showWatch = active || (!readOnly && summary.state === "open");
  if (!showBadge && !showWatch) return null;
  let icon = <Eye className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />;
  if (watch?.status === "working") icon = <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />;
  else if (watch?.status === "paused") icon = <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--ec-warning)]" aria-hidden />;

  return (
    <div
      ref={anchorRef}
      className="pointer-events-auto flex h-8 max-w-[26rem] items-stretch overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[12px] font-medium shadow-lg shadow-black/20 backdrop-blur"
    >
      {showBadge ? (
        <RunForgeRequestBadge summary={summary} onOpen={onOpenRequest} className="min-w-0 rounded-none border-0 bg-transparent shadow-none backdrop-blur-none" />
      ) : null}
      {showBadge && showWatch ? <span className="my-1.5 w-px shrink-0 bg-[var(--ec-border)]" aria-hidden /> : null}
      {showWatch ? (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 px-2.5 text-[var(--ec-text)] outline-none transition hover:bg-[var(--ec-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]"
          title={active ? "Show the watch" : `Wake the agent when this ${prWatchRequestLabel(summary.provider)} needs it`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {icon}
          {prWatchButtonLabel(watch)}
        </button>
      ) : null}
      <AnchorDropdownPortal
        open={open}
        anchorRef={anchorRef}
        align="end"
        placement="top"
        widthPx={360}
        onClose={() => setOpen(false)}
        className="glass-popover overflow-y-auto"
      >
        <div role="dialog" aria-label="Pull request watch">
          {active && watch
            ? <PrWatchStatus runId={runId} watch={watch} readOnly={readOnly} />
            : <PrWatchConfirm runId={runId} summary={summary} onDone={() => setOpen(false)} />}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};
