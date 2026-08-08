import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RunForgeMergeMethod,
  RunForgeRequestDetailsResult,
  RunForgeRequestSummary,
  RunRecord,
} from "@buildwarden/shared";
import { buildRunForgeAgentPrompt, runForgeReadinessLabel, type RunForgeAgentAction } from "@buildwarden/renderer/logic";
import {
  Check,
  Clipboard,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { errorMessage } from "../../lib/format";
import { mobileForgeColor } from "../../lib/forge";
import { ActionSheet, ConfirmSheet, Sheet } from "../../components/Sheet";
import { Button, EmptyState, IconButton, InlineError, Textarea } from "../../components/primitives";
import { DiffViewer } from "../../components/DiffViewer";
import { RichText } from "../../components/RichText";

type Confirmation = { type: "merge"; method: RunForgeMergeMethod } | { type: "close" } | null;

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString() : "Unknown";

const Disclosure = ({ title, badge, children, open = false, onToggle }: {
  title: string;
  badge?: number;
  children: React.ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) => (
  <details
    open={open}
    className="border-b border-[var(--ec-border)]"
    onToggle={(event) => onToggle?.(event.currentTarget.open)}
  >
    <summary className="m-tap flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
      <span className="min-w-0 flex-1">{title}</span>
      {badge != null && badge > 0 ? <span className="text-xs font-normal text-[var(--ec-faint)]">{badge}</span> : null}
      <span className="text-xs text-[var(--ec-faint)]">⌄</span>
    </summary>
    <div className="border-t border-[var(--ec-border)]">{children}</div>
  </details>
);

export const RunForgePanel = ({ run, initialSummary, onChanged }: {
  run: RunRecord;
  initialSummary: RunForgeRequestSummary;
  onChanged: () => Promise<void>;
}) => {
  const { client, snapshotStore } = useMobileApp();
  const [summary, setSummary] = useState(initialSummary);
  const [details, setDetails] = useState<RunForgeRequestDetailsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [agentAction, setAgentAction] = useState<RunForgeAgentAction | null>(null);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [hostedDiff, setHostedDiff] = useState<string | null>(null);
  const activeRef = useRef(true);
  const runIdRef = useRef(run.id);
  const detailsRequestIdRef = useRef(0);
  const diffRequestIdRef = useRef(0);
  const summaryHeadShaRef = useRef(initialSummary.headSha);
  const hostedDiffHeadShaRef = useRef<string | null>(null);
  const changesOpenRef = useRef(false);
  const canWrite = client.capabilities.gitMutations;
  const canRunAgent = client.capabilities.runMutations && !["queued", "preparing", "running"].includes(run.status);
  runIdRef.current = run.id;
  const isCurrentRun = (expectedRunId: string) => activeRef.current && runIdRef.current === expectedRunId;
  const synchronizeSummaryHead = (headSha: string | null) => {
    const headChanged = summaryHeadShaRef.current !== headSha;
    summaryHeadShaRef.current = headSha;
    if (!headChanged) return;
    hostedDiffHeadShaRef.current = null;
    diffRequestIdRef.current += 1;
    setHostedDiff(null);
    if (changesOpenRef.current) void loadHostedDiff(headSha);
  };

  const load = async (refresh = false, expectedRunId = run.id) => {
    const requestId = ++detailsRequestIdRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await client.getRunForgeRequestDetails(expectedRunId, { refresh });
      if (isCurrentRun(expectedRunId) && requestId === detailsRequestIdRef.current && next) {
        synchronizeSummaryHead(next.summary.headSha);
        setDetails(next);
        setSummary(next.summary);
      }
    } catch (caught) {
      if (isCurrentRun(expectedRunId) && requestId === detailsRequestIdRef.current) {
        setError(errorMessage(caught, "Could not load the request."));
      }
    } finally {
      if (isCurrentRun(expectedRunId) && requestId === detailsRequestIdRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, [run.id]);

  useEffect(() => {
    setSummary(initialSummary);
    setDetails(null);
    setHostedDiff(null);
    setActionsOpen(false);
    setConfirmation(null);
    setAgentAction(null);
    setAgentPrompt("");
    summaryHeadShaRef.current = initialSummary.headSha;
    hostedDiffHeadShaRef.current = null;
    changesOpenRef.current = false;
    diffRequestIdRef.current += 1;
    void load(false);
    return client.onRunForgeRequestChanged((payload) => {
      if (payload.runId !== run.id || !payload.forgeRequest) return;
      synchronizeSummaryHead(payload.forgeRequest.headSha);
      detailsRequestIdRef.current += 1;
      setBusy(false);
      setSummary(payload.forgeRequest);
      setDetails((current) => current ? { ...current, summary: payload.forgeRequest! } : current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, run.id]);

  const unresolved = useMemo(() => details?.reviewThreads.filter((thread) => thread.resolved !== true) ?? [], [details]);
  const failed = useMemo(() => details?.checks.filter((check) => check.status === "failure" || check.status === "cancelled") ?? [], [details]);
  const progress = summary.checks.total > 0 ? summary.checks.completed / summary.checks.total : summary.readiness === "ready" ? 1 : 0;

  const reloadEverything = async (expectedRunId = run.id) => {
    await load(true, expectedRunId);
    if (!isCurrentRun(expectedRunId)) return;
    await snapshotStore.refresh();
    if (!isCurrentRun(expectedRunId)) return;
    await onChanged();
  };

  const updateRequest = async (action: "mark-draft" | "mark-ready" | "close" | "reopen") => {
    const expectedRunId = run.id;
    setBusy(true);
    setError(null);
    try {
      const next = await client.updateRunForgeRequest(expectedRunId, { action, expectedHeadSha: summary.headSha ?? undefined });
      if (!isCurrentRun(expectedRunId)) return;
      setSummary(next);
      await reloadEverything(expectedRunId);
    } catch (caught) {
      if (isCurrentRun(expectedRunId)) setError(errorMessage(caught, "Could not update the request."));
    } finally {
      if (isCurrentRun(expectedRunId)) {
        setConfirmation(null);
        setBusy(false);
      }
    }
  };

  const merge = async (method: RunForgeMergeMethod) => {
    if (!summary.headSha) return;
    const expectedRunId = run.id;
    setBusy(true);
    setError(null);
    try {
      const next = await client.mergeRunForgeRequest(expectedRunId, { method, expectedHeadSha: summary.headSha });
      if (!isCurrentRun(expectedRunId)) return;
      setSummary(next);
      await reloadEverything(expectedRunId);
    } catch (caught) {
      if (isCurrentRun(expectedRunId)) setError(errorMessage(caught, "Could not merge the request."));
    } finally {
      if (isCurrentRun(expectedRunId)) {
        setConfirmation(null);
        setBusy(false);
      }
    }
  };

  const openAgentPrompt = (action: RunForgeAgentAction) => {
    if (!details) return;
    setAgentAction(action);
    setAgentPrompt(buildRunForgeAgentPrompt(action, details));
  };

  const sendAgentPrompt = async () => {
    if (!agentPrompt.trim()) return;
    const expectedRunId = run.id;
    setBusy(true);
    setError(null);
    try {
      await client.followUpRun(expectedRunId, agentPrompt.trim());
      if (!isCurrentRun(expectedRunId)) return;
      setAgentAction(null);
      setAgentPrompt("");
      await onChanged();
    } catch (caught) {
      if (isCurrentRun(expectedRunId)) setError(errorMessage(caught, "Could not send the follow-up."));
    } finally {
      if (isCurrentRun(expectedRunId)) setBusy(false);
    }
  };

  const resolveThread = async (threadId: string, resolved: boolean) => {
    const expectedRunId = run.id;
    setBusy(true);
    try {
      await client.resolveProjectPrMrReviewThread(run.projectId, { prUrl: summary.url, threadId, resolved });
      if (!isCurrentRun(expectedRunId)) return;
      await reloadEverything(expectedRunId);
    } catch (caught) {
      if (isCurrentRun(expectedRunId)) setError(errorMessage(caught, "Could not update the thread."));
    } finally {
      if (isCurrentRun(expectedRunId)) setBusy(false);
    }
  };

  const loadHostedDiff = async (headSha = summaryHeadShaRef.current) => {
    if (hostedDiff != null && hostedDiffHeadShaRef.current === headSha) return;
    const expectedRunId = run.id;
    const requestId = ++diffRequestIdRef.current;
    setBusy(true);
    try {
      const result = await client.getRunForgeRequestDiff(expectedRunId);
      if (
        isCurrentRun(expectedRunId)
        && requestId === diffRequestIdRef.current
        && summaryHeadShaRef.current === headSha
      ) {
        hostedDiffHeadShaRef.current = headSha;
        setHostedDiff(result?.diff ?? "");
      }
    } catch (caught) {
      if (isCurrentRun(expectedRunId) && requestId === diffRequestIdRef.current) {
        setError(errorMessage(caught, "Could not load the hosted diff."));
      }
    } finally {
      if (isCurrentRun(expectedRunId) && requestId === diffRequestIdRef.current) setBusy(false);
    }
  };

  const actions = [
    { label: "Refresh", icon: <RefreshCw className="size-4" />, onSelect: () => void reloadEverything() },
    { label: "Open externally", icon: <ExternalLink className="size-4" />, onSelect: () => void client.openExternalUrl(summary.url) },
    { label: "Copy link", icon: <Clipboard className="size-4" />, onSelect: () => void navigator.clipboard.writeText(summary.url) },
    ...(canWrite && summary.supportedActions.includes(summary.draft ? "mark-ready" : "mark-draft") ? [{
      label: summary.draft ? "Mark ready" : "Mark draft",
      icon: <GitPullRequest className="size-4" />,
      onSelect: () => void updateRequest(summary.draft ? "mark-ready" : "mark-draft"),
    }] : []),
    ...(canWrite && summary.readiness === "ready" && summary.state === "open" && !summary.draft
      ? summary.supportedMergeMethods.map((method) => ({
          label: `Merge using ${method}`,
          icon: <GitMerge className="size-4" />,
          onSelect: () => setConfirmation({ type: "merge" as const, method }),
        }))
      : []),
    ...(canWrite && summary.supportedActions.includes("close") ? [{ label: "Close request", icon: <X className="size-4" />, danger: true, onSelect: () => setConfirmation({ type: "close" as const }) }] : []),
    ...(canWrite && summary.supportedActions.includes("reopen") ? [{ label: "Reopen request", icon: <RefreshCw className="size-4" />, onSelect: () => void updateRequest("reopen") }] : []),
  ];

  return (
    <div className="m-scroll min-h-0 flex-1">
      <div className="border-b border-[var(--ec-border)] px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-full border border-[var(--ec-border)]" style={{ color: mobileForgeColor[summary.readiness] }}>
            <GitPullRequest className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[var(--ec-muted)]">{summary.provider === "github" ? "Pull request" : "Merge request"} #{summary.number} · <span style={{ color: mobileForgeColor[summary.readiness] }}>{runForgeReadinessLabel[summary.readiness]}</span></p>
            <h2 className="m-wrap-anywhere mt-1 text-sm font-semibold leading-5">{summary.title}</h2>
            <p className="m-mono mt-1 truncate text-[11px] text-[var(--ec-faint)]">{summary.sourceBranch} → {summary.targetBranch}</p>
          </div>
          <IconButton label="Request actions" onClick={() => setActionsOpen(true)}><MoreHorizontal className="size-5" /></IconButton>
        </div>
        {summary.stale ? <p className="mt-2 text-xs text-[var(--ec-faint)]">Showing cached data · refreshed {formatDate(summary.lastSyncedAt)}</p> : null}
      </div>

      {error || summary.syncError ? <InlineError message={error ?? `${summary.syncError} Cached data remains readable; re-authenticate in project settings.`} onRetry={() => void reloadEverything()} /> : null}
      {!details && busy ? <div className="grid min-h-48 place-items-center"><Loader2 className="size-5 animate-spin text-[var(--ec-accent)]" /></div> : null}
      {!details && !busy ? <EmptyState title="Request details unavailable" message="Cached status will remain visible while authentication is restored." /> : null}

      {details ? (
        <>
          <Disclosure title="Summary" open>
            <div className="px-4 py-3"><RichText>{details.request.description || "No description."}</RichText></div>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-3 border-t border-[var(--ec-border)] px-4 py-3 text-xs">
              <dt className="text-[var(--ec-faint)]">Author</dt><dd>{summary.author ?? "Unknown"}</dd>
              <dt className="text-[var(--ec-faint)]">Mergeability</dt><dd className="capitalize">{summary.mergeability}</dd>
              <dt className="text-[var(--ec-faint)]">Review</dt><dd className="capitalize">{summary.reviewDecision.replace(/-/g, " ")}</dd>
              <dt className="text-[var(--ec-faint)]">Commits</dt><dd>{details.commits.length}</dd>
              <dt className="text-[var(--ec-faint)]">Changed</dt><dd>{details.request.changedFiles ?? details.files.length} files</dd>
              <dt className="text-[var(--ec-faint)]">Updated</dt><dd>{formatDate(summary.updatedAt)}</dd>
            </dl>
            {canRunAgent ? <div className="flex flex-col gap-2 border-t border-[var(--ec-border)] px-4 py-3">
              {unresolved.length > 0 ? <Button tone="neutral" block onClick={() => openAgentPrompt("feedback")}><MessageSquareText className="size-4" />Address feedback</Button> : null}
              {failed.length > 0 ? <Button tone="neutral" block onClick={() => openAgentPrompt("checks")}><ShieldCheck className="size-4" />Fix failed checks</Button> : null}
              {summary.mergeability === "conflicting" ? <Button tone="neutral" block onClick={() => openAgentPrompt("conflicts")}><GitMerge className="size-4" />Resolve conflicts</Button> : null}
            </div> : null}
          </Disclosure>

          <Disclosure title="Checks" badge={summary.checks.total}>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="relative size-12 shrink-0 rounded-full" style={{ background: `conic-gradient(${mobileForgeColor[summary.readiness]} ${String(progress * 360)}deg, var(--ec-border) 0deg)` }}><div className="absolute inset-1 grid place-items-center rounded-full bg-[var(--ec-bg)] text-[11px] font-semibold">{summary.checks.completed}/{summary.checks.total}</div></div>
              <div><p className="text-sm font-medium">{summary.checks.completed} of {summary.checks.total} complete</p><p className="text-xs text-[var(--ec-muted)]">{summary.checks.successful} passed · {summary.checks.failed} failed</p></div>
            </div>
            <div className="divide-y divide-[var(--ec-border)] border-t border-[var(--ec-border)]">
              {details.checks.map((check) => <button key={check.id} type="button" disabled={!check.url} onClick={() => check.url && void client.openExternalUrl(check.url)} className="m-tap flex w-full items-center gap-3 px-4 py-2.5 text-left disabled:opacity-100">{check.status === "success" || check.status === "neutral" || check.status === "skipped" ? <Check className="size-4 text-[var(--ec-faint)]" /> : check.status === "running" || check.status === "queued" ? <Loader2 className="size-4 animate-spin text-[var(--ec-faint)]" /> : <X className="size-4 text-[var(--ec-faint)]" />}<span className="min-w-0 flex-1"><span className="block truncate text-sm">{check.name}</span><span className="block truncate text-xs capitalize text-[var(--ec-muted)]">{check.status}{check.description ? ` · ${check.description}` : ""}</span></span>{check.url ? <ExternalLink className="size-4 text-[var(--ec-faint)]" /> : null}</button>)}
              {details.checks.length === 0 ? <p className="px-4 py-6 text-center text-xs text-[var(--ec-muted)]">No checks reported.</p> : null}
            </div>
          </Disclosure>

          <Disclosure title="Feedback" badge={summary.unresolvedThreadCount}>
            <div className="divide-y divide-[var(--ec-border)]">
              {[...details.reviewThreads].sort((a, b) => Number(a.resolved === true) - Number(b.resolved === true)).map((thread) => <div key={thread.id} className="px-4 py-3"><div className="flex items-center gap-2"><span className="m-mono min-w-0 flex-1 truncate text-[11px] text-[var(--ec-faint)]">{thread.path}{thread.newLineNumber ?? thread.oldLineNumber ? `:${String(thread.newLineNumber ?? thread.oldLineNumber)}` : ""}</span><span className="text-[11px] text-[var(--ec-muted)]">{thread.resolved ? "Resolved" : "Unresolved"}</span></div>{thread.comments.map((comment) => <div key={comment.id} className="mt-2"><p className="text-xs text-[var(--ec-faint)]">{comment.author?.username ?? "Reviewer"}</p><div className="mt-1"><RichText>{comment.body}</RichText></div></div>)}{canWrite && thread.resolved != null ? <Button tone="ghost" size="sm" className="mt-2 px-0" onClick={() => void resolveThread(thread.providerThreadId, !thread.resolved)}>{thread.resolved ? "Reopen thread" : "Resolve thread"}</Button> : null}</div>)}
              {details.reviewThreads.length === 0 ? <p className="px-4 py-6 text-center text-xs text-[var(--ec-muted)]">No review threads.</p> : null}
            </div>
          </Disclosure>

          <Disclosure title="Changes" badge={details.files.length} onToggle={(open) => {
            changesOpenRef.current = open;
            if (open) void loadHostedDiff();
          }}>
            {hostedDiff == null && busy ? <div className="grid min-h-40 place-items-center"><Loader2 className="size-5 animate-spin" /></div> : <DiffViewer diff={hostedDiff ?? ""} />}
          </Disclosure>
        </>
      ) : null}

      <ActionSheet open={actionsOpen} onClose={() => setActionsOpen(false)} title={`${summary.provider === "github" ? "PR" : "MR"} #${String(summary.number)}`} actions={actions} />
      <ConfirmSheet
        open={confirmation?.type === "close"}
        title="Close request"
        message="Close this request without deleting its source branch?"
        confirmLabel="Close request"
        danger
        busy={busy}
        onClose={() => setConfirmation(null)}
        onConfirm={() => void updateRequest("close")}
      />
      <ConfirmSheet
        open={confirmation?.type === "merge"}
        title="Merge request"
        message={`Merge using ${confirmation?.type === "merge" ? confirmation.method : "merge"}? The expected HEAD SHA will be checked and the source branch will be kept.`}
        confirmLabel="Merge"
        busy={busy}
        onClose={() => setConfirmation(null)}
        onConfirm={() => confirmation?.type === "merge" && void merge(confirmation.method)}
      />
      <Sheet
        open={agentAction !== null}
        onClose={() => setAgentAction(null)}
        title="Agent prompt"
        full
        dismissable={!busy}
        footer={<Button block busy={busy} disabled={!agentPrompt.trim()} onClick={() => void sendAgentPrompt()}><Send className="size-4" />Send to agent</Button>}
      >
        <div className="px-4 py-3"><p className="mb-2 text-xs text-[var(--ec-muted)]">Review and edit the default prompt before continuing this run in the same workspace.</p><Textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} className="min-h-[55dvh] resize-y text-sm leading-6" /></div>
      </Sheet>
    </div>
  );
};
