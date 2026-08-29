import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RunForgeMergeMethod,
  RunForgeRequestDetailsResult,
  RunForgeRequestSummary,
  RunRecord,
} from "@buildwarden/shared";
import {
  AlertTriangle,
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
import { Textarea } from "../ui/textarea";
import { GitDiffPreview } from "./git-diff-preview";
import { ForgeRequestActionBar } from "./ForgeRequestActionBar";
import { ForgeChecksView } from "./ForgeChecksView";
import {
  buildRunForgeAgentPrompt,
  runForgeReadinessColor,
  runForgeReadinessCssColor,
  runForgeReadinessLabel,
  type RunForgeAgentAction,
} from "./run-forge-ui";

type PanelTab = "summary" | "checks" | "feedback" | "changes";

const formatTimestamp = (value: string | null) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Unknown";

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
    className="flex h-8 max-w-[19rem] items-center gap-1.5 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2.5 text-[12px] font-medium text-[var(--ec-text)] shadow-lg shadow-black/20 backdrop-blur transition hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]"
    title={`${summary.title} · refreshed ${formatTimestamp(summary.lastSyncedAt)}`}
  >
    <RunForgeStatusGlyph summary={summary} />
    <span className="shrink-0">{summary.provider === "github" ? "PR" : "MR"} #{summary.number}</span>
    <span className="text-[var(--ec-faint)]">·</span>
    <span className="truncate text-[var(--ec-muted)]">
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
  const detailsRequestIdRef = useRef(0);
  const canWriteForge = buildwarden.capabilities.gitMutations;
  const canRunAgent = buildwarden.capabilities.runMutations
    && !["queued", "preparing", "running"].includes(run.status);

  const loadDetails = async (refresh = false) => {
    const requestId = ++detailsRequestIdRef.current;
    setPending(true);
    setError(null);
    try {
      const next = await buildwarden.getRunForgeRequestDetails(run.id, { refresh });
      if (requestId === detailsRequestIdRef.current && next) {
        setDetails(next);
        setSummary(next.summary);
        onSummaryChange?.(next.summary);
      }
    } catch (caught) {
      if (requestId === detailsRequestIdRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not load request details.");
      }
    } finally {
      if (requestId === detailsRequestIdRef.current) {
        setPending(false);
      }
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
  const updateSummary = (next: RunForgeRequestSummary) => {
    setSummary(next);
    setDetails((current) => current ? { ...current, summary: next } : current);
    onSummaryChange?.(next);
  };

  const runWriteAction = async (action: "mark-draft" | "mark-ready" | "close" | "reopen") => {
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
    if (!summary.headSha) return;
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
    <div className="flex h-full min-h-0 flex-col bg-[var(--ec-panel)] text-[var(--ec-text)]">
      <div className="relative z-30 shrink-0 border-b border-[var(--ec-border)] px-3 pb-2.5 pt-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border bg-[var(--ec-panel)] shadow-sm"
            style={{
              color: runForgeReadinessCssColor[summary.readiness],
              borderColor: `color-mix(in srgb, ${runForgeReadinessCssColor[summary.readiness]} 28%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${runForgeReadinessCssColor[summary.readiness]} 7%, transparent)`,
            }}
          >
            <GitPullRequest className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
              <span className="font-medium uppercase tracking-[0.08em]">{summary.provider === "github" ? "Pull request" : "Merge request"} #{summary.number}</span>
              <span
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium"
                style={{
                  color: runForgeReadinessCssColor[summary.readiness],
                  borderColor: `color-mix(in srgb, ${runForgeReadinessCssColor[summary.readiness]} 24%, transparent)`,
                  backgroundColor: `color-mix(in srgb, ${runForgeReadinessCssColor[summary.readiness]} 8%, transparent)`,
                }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {runForgeReadinessLabel[summary.readiness]}
              </span>
              {summary.stale ? <span className="rounded-full border border-[var(--ec-border)] px-1.5 py-0.5 text-[var(--ec-muted)]">Cached</span> : null}
            </div>
            <h2 className="mt-1 line-clamp-2 text-[13px] font-semibold leading-[1.35rem] text-[var(--ec-text)]">{summary.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-0.5 shadow-sm">
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md p-0" onClick={() => void loadDetails(true)} disabled={pending} title="Refresh status" aria-label="Refresh status">
              <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md p-0" onClick={() => void navigator.clipboard.writeText(summary.url)} title="Copy link" aria-label="Copy link">
              <Clipboard className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md p-0" onClick={() => void buildwarden.openExternalUrl(summary.url)} title="Open externally" aria-label="Open externally">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <ForgeRequestActionBar
          request={summary}
          canWrite={canWriteForge}
          busy={pending}
          className="mt-3 border-t border-[var(--ec-border)] pt-2.5"
          onUpdate={runWriteAction}
          onMerge={merge}
        />
      </div>

      <div className="app-scrollbar shrink-0 overflow-x-auto border-b border-[var(--ec-border)] px-3 py-1.5">
        <div className="flex min-w-max items-center gap-0.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-0.5">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn("flex h-7 items-center rounded-md px-2.5 text-[11px] transition-colors", tab === item.id ? "bg-[var(--ec-control)] text-[var(--ec-text)] shadow-sm" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]")}>
              {item.label}{item.count != null && item.count > 0 ? <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[9px] leading-none", tab === item.id ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "bg-[var(--ec-panel)] text-[var(--ec-faint)]")}>{item.count}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error || summary.syncError ? (
          <div className="m-3 flex gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2.5 text-xs text-[var(--ec-muted)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ec-muted)]" />
            <span>{error ?? summary.syncError} Cached request data remains available. Check the project forge token in Settings and refresh.</span>
          </div>
        ) : null}
        {!details && pending ? <div className="grid min-h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--ec-muted)]" /></div> : null}

        {details && tab === "summary" ? (
          <div className="divide-y divide-[var(--ec-border)]">
            <div className="px-3 py-3">
              <p className="whitespace-pre-wrap text-xs leading-5 text-[var(--ec-text)]">{details.request.description || "No description."}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {details.request.labels.map((label) => <span key={label} className="rounded-full border border-[var(--ec-border)] px-2 py-0.5 text-[10px] text-[var(--ec-muted)]">{label}</span>)}
              </div>
            </div>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 text-[11px]">
              <dt className="text-[var(--ec-faint)]">Author</dt><dd>{summary.author ?? "Unknown"}</dd>
              <dt className="text-[var(--ec-faint)]">Branches</dt><dd className="truncate font-mono">{summary.sourceBranch} → {summary.targetBranch}</dd>
              <dt className="text-[var(--ec-faint)]">Mergeability</dt><dd className="capitalize">{summary.mergeability}</dd>
              <dt className="text-[var(--ec-faint)]">Review</dt><dd className="capitalize">{summary.reviewDecision.replace(/-/g, " ")}</dd>
              <dt className="text-[var(--ec-faint)]">Commits</dt><dd>{details.commits.length}</dd>
              <dt className="text-[var(--ec-faint)]">Diff</dt><dd><span className="text-[var(--ec-success)]">+{details.request.additions ?? "?"}</span> <span className="text-[var(--ec-danger)]">−{details.request.deletions ?? "?"}</span> across {details.request.changedFiles ?? details.files.length} files</dd>
              <dt className="text-[var(--ec-faint)]">Updated</dt><dd>{formatTimestamp(summary.updatedAt)}</dd>
              <dt className="text-[var(--ec-faint)]">Refreshed</dt><dd>{formatTimestamp(summary.lastSyncedAt)}</dd>
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
          <ForgeChecksView
            progress={summary.checks}
            checks={details.checks}
            readiness={summary.readiness}
            onOpenExternal={(url) => buildwarden.openExternalUrl(url)}
          />
        ) : null}

        {details && tab === "feedback" ? (
          <div className="divide-y divide-[var(--ec-border)]">
            {[...details.reviewThreads].sort((a, b) => Number(a.resolved === true) - Number(b.resolved === true)).map((thread) => (
              <div key={thread.id} className="px-3 py-3">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--ec-muted)]">{thread.path}{thread.newLineNumber ?? thread.oldLineNumber ? `:${String(thread.newLineNumber ?? thread.oldLineNumber)}` : ""}</span><span className="text-[10px] text-[var(--ec-faint)]">{thread.resolved ? "Resolved" : "Unresolved"}</span></div>
                <div className="mt-2 space-y-2">{thread.comments.map((comment) => <div key={comment.id}><p className="text-[10px] text-[var(--ec-muted)]">{comment.author?.username ?? "Reviewer"} · {formatTimestamp(comment.createdAt)}</p><p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-[var(--ec-text)]">{comment.body}</p></div>)}</div>
                {canWriteForge && thread.resolved != null ? <Button variant="ghost" size="sm" className="mt-2 h-7 px-0 text-[11px] text-[var(--ec-muted)]" disabled={pending} onClick={() => void resolveThread(thread.providerThreadId, !thread.resolved)}>{thread.resolved ? "Reopen thread" : "Resolve thread"}</Button> : null}
              </div>
            ))}
            {details.reviewThreads.length === 0 ? <p className="px-3 py-8 text-center text-xs text-[var(--ec-faint)]">No review threads.</p> : null}
            {details.activity.filter((item) => item.kind === "comment" || item.kind === "review").map((item) => (
              <div key={item.id} className="px-3 py-3"><p className="text-[10px] text-[var(--ec-muted)]">{item.author?.username ?? item.title} · {formatTimestamp(item.createdAt)}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--ec-text)]">{item.body ?? item.title}</p></div>
            ))}
          </div>
        ) : null}

        {tab === "changes" ? (
          <div className="px-2 py-2">{diff == null && pending ? <div className="grid min-h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--ec-muted)]" /></div> : <GitDiffPreview diffText={diff ?? ""} emptyMessage="No hosted diff is available." defaultCollapsedFileSections />}</div>
        ) : null}
      </div>

      {promptAction ? (
        <div className="shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-panel)] p-2.5">
          <div className="mb-1.5 flex items-center justify-between"><p className="text-[11px] font-medium text-[var(--ec-text)]">Agent prompt · editable</p><button type="button" className="text-[var(--ec-faint)] hover:text-[var(--ec-text)]" onClick={() => setPromptAction(null)}><X className="h-3.5 w-3.5" /></button></div>
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} className="app-scrollbar min-h-28 resize-y px-2.5 text-xs leading-5" />
          <div className="mt-2 flex justify-end"><Button size="sm" className="h-8 gap-1.5 text-xs" disabled={pending || !prompt.trim()} onClick={() => void submitPrompt()}><Send className="h-3.5 w-3.5" />Send to agent</Button></div>
        </div>
      ) : null}
    </div>
  );
};
