import { useEffect, useMemo, useState } from "react";
import type {
  RunForgeMergeMethod,
  RunForgeRequestDetailsResult,
  RunForgeRequestSummary,
  RunRecord,
} from "@buildwarden/shared";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { GitDiffPreview } from "./git-diff-preview";
import {
  buildRunForgeAgentPrompt,
  runForgeReadinessColor,
  runForgeReadinessHex,
  runForgeReadinessLabel,
  type RunForgeAgentAction,
} from "./run-forge-ui";

type PanelTab = "summary" | "checks" | "feedback" | "changes";

const formatTimestamp = (value: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Unknown";

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds == null) return null;
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
};

const checkStatusLabel = (status: RunForgeRequestDetailsResult["checks"][number]["status"]) => ({
  queued: "Queued",
  running: "Running",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  neutral: "Neutral",
  skipped: "Skipped",
})[status];

export const RunForgeStatusGlyph = ({ summary, className }: { summary: RunForgeRequestSummary; className?: string }) => (
  <GitPullRequest
    className={cn("h-3.5 w-3.5 shrink-0", runForgeReadinessColor[summary.readiness], className)}
    aria-label={`${summary.provider === "github" ? "Pull request" : "Merge request"} #${String(summary.number)}: ${runForgeReadinessLabel[summary.readiness]}`}
  />
);

export const RunForgeRequestBadge = ({
  summary,
  onOpen,
}: {
  summary: RunForgeRequestSummary;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex h-8 max-w-[19rem] items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-900/95 px-2.5 text-[12px] font-medium text-zinc-200 shadow-lg shadow-black/20 backdrop-blur transition hover:border-zinc-700 hover:bg-zinc-800"
    title={`${summary.title} · refreshed ${formatTimestamp(summary.lastSyncedAt)}`}
  >
    <RunForgeStatusGlyph summary={summary} />
    <span className="shrink-0">{summary.provider === "github" ? "PR" : "MR"} #{summary.number}</span>
    <span className="text-zinc-600">·</span>
    <span className="truncate text-zinc-400">
      {summary.checks.total > 0 ? `${String(summary.checks.completed)}/${String(summary.checks.total)} complete` : runForgeReadinessLabel[summary.readiness]}
    </span>
  </button>
);

export interface RunForgeRequestPanelProps {
  run: RunRecord;
  initialSummary: RunForgeRequestSummary;
  onSummaryChange?: (summary: RunForgeRequestSummary) => void;
  onAgentPrompt: (prompt: string) => Promise<void>;
}

export const RunForgeRequestPanel = ({ run, initialSummary, onSummaryChange, onAgentPrompt }: RunForgeRequestPanelProps) => {
  const buildwarden = useBuildWardenClient();
  const [details, setDetails] = useState<RunForgeRequestDetailsResult | null>(null);
  const [summary, setSummary] = useState(initialSummary);
  const [tab, setTab] = useState<PanelTab>("summary");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [promptAction, setPromptAction] = useState<RunForgeAgentAction | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
  const canWriteForge = buildwarden.capabilities.gitMutations;
  const canRunAgent = buildwarden.capabilities.runMutations && run.status !== "running" && run.status !== "queued";

  const loadDetails = async (refresh = false) => {
    setPending(true);
    setError(null);
    try {
      const next = await buildwarden.getRunForgeRequestDetails(run.id, { refresh });
      if (next) {
        setDetails(next);
        setSummary(next.summary);
        onSummaryChange?.(next.summary);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load request details.");
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    setSummary(initialSummary);
    void loadDetails(false);
    return buildwarden.onRunForgeRequestChanged((payload) => {
      if (payload.runId !== run.id || !payload.forgeRequest) return;
      setSummary(payload.forgeRequest);
      setDetails((current) => current ? { ...current, summary: payload.forgeRequest! } : current);
      onSummaryChange?.(payload.forgeRequest);
    });
    // The run association is durable; reload only when navigating to another run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  useEffect(() => {
    if (tab !== "changes" || diff !== null) return;
    setPending(true);
    void buildwarden.getRunForgeRequestDiff(run.id)
      .then((result) => setDiff(result?.diff ?? ""))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the hosted diff."))
      .finally(() => setPending(false));
  }, [buildwarden, diff, run.id, tab]);

  const unresolvedThreads = useMemo(() => details?.reviewThreads.filter((thread) => thread.resolved !== true) ?? [], [details]);
  const failedChecks = useMemo(() => details?.checks.filter((check) => check.status === "failure" || check.status === "cancelled") ?? [], [details]);
  const progress = summary.checks.total > 0 ? summary.checks.completed / summary.checks.total : summary.readiness === "ready" ? 1 : 0;

  const updateSummary = (next: RunForgeRequestSummary) => {
    setSummary(next);
    setDetails((current) => current ? { ...current, summary: next } : current);
    onSummaryChange?.(next);
  };

  const runWriteAction = async (action: "mark-draft" | "mark-ready" | "close" | "reopen") => {
    if ((action === "close" || action === "reopen") && !window.confirm(`${action === "close" ? "Close" : "Reopen"} this request?`)) return;
    setPending(true);
    setError(null);
    try {
      updateSummary(await buildwarden.updateRunForgeRequest(run.id, { action, expectedHeadSha: summary.headSha ?? undefined }));
      await loadDetails(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the request.");
    } finally {
      setPending(false);
    }
  };

  const merge = async (method: RunForgeMergeMethod) => {
    setMergeMenuOpen(false);
    if (!summary.headSha || !window.confirm(`Merge ${summary.provider === "github" ? "PR" : "MR"} #${String(summary.number)} using ${method}? The source branch will be kept.`)) return;
    setPending(true);
    setError(null);
    try {
      updateSummary(await buildwarden.mergeRunForgeRequest(run.id, { method, expectedHeadSha: summary.headSha }));
      await loadDetails(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not merge the request.");
    } finally {
      setPending(false);
    }
  };

  const openPrompt = (action: RunForgeAgentAction) => {
    if (!details) return;
    setPromptAction(action);
    setPrompt(buildRunForgeAgentPrompt(action, details));
  };

  const submitPrompt = async () => {
    if (!prompt.trim()) return;
    setPending(true);
    try {
      await onAgentPrompt(prompt.trim());
      setPromptAction(null);
      setPrompt("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the follow-up.");
    } finally {
      setPending(false);
    }
  };

  const resolveThread = async (threadId: string, resolved: boolean) => {
    setPending(true);
    try {
      await buildwarden.resolveProjectPrMrReviewThread(run.projectId, { prUrl: summary.url, threadId, resolved });
      await loadDetails(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the review thread.");
    } finally {
      setPending(false);
    }
  };

  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: "summary", label: "Summary" },
    { id: "checks", label: "Checks", count: summary.checks.total },
    { id: "feedback", label: "Feedback", count: summary.unresolvedThreadCount },
    { id: "changes", label: "Changes", count: details?.files.length },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ec-panel)] text-zinc-200">
      <div className="shrink-0 border-b border-zinc-800/80 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <div
            className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-current/20 bg-zinc-950"
            style={{ color: runForgeReadinessHex[summary.readiness] }}
          >
            <GitPullRequest className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span>{summary.provider === "github" ? "Pull request" : "Merge request"} #{summary.number}</span>
              <span>·</span>
              <span className={runForgeReadinessColor[summary.readiness]}>{runForgeReadinessLabel[summary.readiness]}</span>
              {summary.stale ? <span>· cached</span> : null}
            </div>
            <h2 className="mt-0.5 line-clamp-2 text-sm font-semibold leading-5 text-zinc-100">{summary.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void loadDetails(true)} disabled={pending} title="Refresh">
              <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void navigator.clipboard.writeText(summary.url)} title="Copy link">
              <Clipboard className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void buildwarden.openExternalUrl(summary.url)} title="Open externally">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canWriteForge && summary.supportedActions.includes(summary.draft ? "mark-ready" : "mark-draft") ? (
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={pending} onClick={() => void runWriteAction(summary.draft ? "mark-ready" : "mark-draft")}>
              {summary.draft ? "Mark ready" : "Mark draft"}
            </Button>
          ) : null}
          {canWriteForge && summary.readiness === "ready" && summary.state === "open" && !summary.draft ? (
            <div className="relative">
              <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={pending} onClick={() => setMergeMenuOpen((current) => !current)}>
                <GitMerge className="h-3.5 w-3.5" /> Merge <ChevronDown className="h-3 w-3" />
              </Button>
              {mergeMenuOpen ? (
                <div className="absolute left-0 top-full z-40 mt-1 min-w-32 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
                  {summary.supportedMergeMethods.map((method) => (
                    <button key={method} type="button" className="block w-full px-3 py-1.5 text-left text-xs capitalize hover:bg-zinc-800" onClick={() => void merge(method)}>{method}</button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {canWriteForge && summary.supportedActions.includes("close") ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-zinc-500 hover:text-red-300" disabled={pending} onClick={() => void runWriteAction("close")}>Close</Button>
          ) : null}
          {canWriteForge && summary.supportedActions.includes("reopen") ? (
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={pending} onClick={() => void runWriteAction("reopen")}>Reopen</Button>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-zinc-800/80 px-2">
        {tabs.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn("h-8 border-b-2 px-2 text-[11px] transition", tab === item.id ? "border-zinc-200 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300")}>
            {item.label}{item.count != null && item.count > 0 ? <span className="ml-1 text-[10px] text-zinc-600">{item.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error || summary.syncError ? (
          <div className="m-3 flex gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5 text-xs text-zinc-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>{error ?? summary.syncError} Cached request data remains available. Check the project forge token in Settings and refresh.</span>
          </div>
        ) : null}
        {!details && pending ? <div className="grid min-h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div> : null}

        {details && tab === "summary" ? (
          <div className="divide-y divide-zinc-800/70">
            <div className="px-3 py-3">
              <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-300">{details.request.description || "No description."}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {details.request.labels.map((label) => <span key={label} className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">{label}</span>)}
              </div>
            </div>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 text-[11px]">
              <dt className="text-zinc-600">Author</dt><dd>{summary.author ?? "Unknown"}</dd>
              <dt className="text-zinc-600">Branches</dt><dd className="truncate font-mono">{summary.sourceBranch} → {summary.targetBranch}</dd>
              <dt className="text-zinc-600">Mergeability</dt><dd className="capitalize">{summary.mergeability}</dd>
              <dt className="text-zinc-600">Review</dt><dd className="capitalize">{summary.reviewDecision.replace(/-/g, " ")}</dd>
              <dt className="text-zinc-600">Commits</dt><dd>{details.commits.length}</dd>
              <dt className="text-zinc-600">Diff</dt><dd><span className="text-emerald-400/80">+{details.request.additions ?? "?"}</span> <span className="text-red-400/80">−{details.request.deletions ?? "?"}</span> across {details.request.changedFiles ?? details.files.length} files</dd>
              <dt className="text-zinc-600">Updated</dt><dd>{formatTimestamp(summary.updatedAt)}</dd>
              <dt className="text-zinc-600">Refreshed</dt><dd>{formatTimestamp(summary.lastSyncedAt)}</dd>
            </dl>
            {canRunAgent && (unresolvedThreads.length > 0 || failedChecks.length > 0 || summary.mergeability === "conflicting") ? (
              <div className="flex flex-wrap gap-1.5 px-3 py-3">
                {unresolvedThreads.length > 0 ? <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => openPrompt("feedback")}><MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Address feedback</Button> : null}
                {failedChecks.length > 0 ? <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => openPrompt("checks")}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Fix failed checks</Button> : null}
                {summary.mergeability === "conflicting" ? <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => openPrompt("conflicts")}><GitMerge className="mr-1.5 h-3.5 w-3.5" />Resolve conflicts</Button> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {details && tab === "checks" ? (
          <div>
            <div className="flex items-center gap-3 border-b border-zinc-800/70 px-3 py-3">
              <div className="relative h-10 w-10 shrink-0 rounded-full" style={{ background: `conic-gradient(${runForgeReadinessHex[summary.readiness]} ${String(progress * 360)}deg, #27272a 0deg)` }}>
                <div className="absolute inset-[3px] grid place-items-center rounded-full bg-[var(--ec-panel)] text-[10px] font-semibold">{summary.checks.completed}/{summary.checks.total}</div>
              </div>
              <div><p className="text-sm font-medium">{summary.checks.completed} of {summary.checks.total} complete</p><p className="text-[11px] text-zinc-500">{summary.checks.successful} passed · {summary.checks.failed} failed · {summary.checks.running} running</p></div>
            </div>
            <div className="divide-y divide-zinc-800/70">
              {details.checks.map((check) => (
                <div key={check.id} className="flex items-center gap-2.5 px-3 py-2.5">
                  {check.status === "success" || check.status === "neutral" || check.status === "skipped" ? <Check className="h-3.5 w-3.5 text-zinc-500" /> : check.status === "running" || check.status === "queued" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" /> : <X className="h-3.5 w-3.5 text-zinc-500" />}
                  <div className="min-w-0 flex-1"><p className="truncate text-xs text-zinc-200">{check.name}</p><p className="text-[10px] text-zinc-600">{checkStatusLabel(check.status)}{formatDuration(check.durationMs) ? ` · ${formatDuration(check.durationMs)}` : ""}{check.description ? ` · ${check.description}` : ""}</p></div>
                  {check.url ? <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void buildwarden.openExternalUrl(check.url!)}><ExternalLink className="h-3.5 w-3.5" /></Button> : null}
                </div>
              ))}
              {details.checks.length === 0 ? <p className="px-3 py-8 text-center text-xs text-zinc-600">No checks were reported.</p> : null}
            </div>
          </div>
        ) : null}

        {details && tab === "feedback" ? (
          <div className="divide-y divide-zinc-800/70">
            {[...details.reviewThreads].sort((a, b) => Number(a.resolved === true) - Number(b.resolved === true)).map((thread) => (
              <div key={thread.id} className="px-3 py-3">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">{thread.path}{thread.newLineNumber ?? thread.oldLineNumber ? `:${String(thread.newLineNumber ?? thread.oldLineNumber)}` : ""}</span><span className="text-[10px] text-zinc-600">{thread.resolved ? "Resolved" : "Unresolved"}</span></div>
                <div className="mt-2 space-y-2">{thread.comments.map((comment) => <div key={comment.id}><p className="text-[10px] text-zinc-500">{comment.author?.username ?? "Reviewer"} · {formatTimestamp(comment.createdAt)}</p><p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{comment.body}</p></div>)}</div>
                {canWriteForge && thread.resolved != null ? <Button variant="ghost" size="sm" className="mt-2 h-7 px-0 text-[11px] text-zinc-500" disabled={pending} onClick={() => void resolveThread(thread.providerThreadId, !thread.resolved)}>{thread.resolved ? "Reopen thread" : "Resolve thread"}</Button> : null}
              </div>
            ))}
            {details.reviewThreads.length === 0 ? <p className="px-3 py-8 text-center text-xs text-zinc-600">No review threads.</p> : null}
            {details.activity.filter((item) => item.kind === "comment" || item.kind === "review").map((item) => (
              <div key={item.id} className="px-3 py-3"><p className="text-[10px] text-zinc-500">{item.author?.username ?? item.title} · {formatTimestamp(item.createdAt)}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{item.body ?? item.title}</p></div>
            ))}
          </div>
        ) : null}

        {tab === "changes" ? (
          <div className="px-2 py-2">{diff == null && pending ? <div className="grid min-h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div> : <GitDiffPreview diffText={diff ?? ""} emptyMessage="No hosted diff is available." defaultCollapsedFileSections />}</div>
        ) : null}
      </div>

      {promptAction ? (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/80 p-2.5">
          <div className="mb-1.5 flex items-center justify-between"><p className="text-[11px] font-medium text-zinc-300">Agent prompt · editable</p><button type="button" className="text-zinc-600 hover:text-zinc-300" onClick={() => setPromptAction(null)}><X className="h-3.5 w-3.5" /></button></div>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} className="app-scrollbar w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2 text-xs leading-5 text-zinc-200 outline-none focus:border-zinc-600" />
          <div className="mt-2 flex justify-end"><Button size="sm" className="h-8 gap-1.5 text-xs" disabled={pending || !prompt.trim()} onClick={() => void submitPrompt()}><Send className="h-3.5 w-3.5" />Send to agent</Button></div>
        </div>
      ) : null}
    </div>
  );
};
