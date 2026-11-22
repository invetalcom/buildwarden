import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_RUN_HEADER_ITEMS,
  sessionTitle,
  type DesignRunHeaderItem,
  type DesignRunHeaderStyle,
  type RunDetail,
  type RunListItem,
  type RunTokenUsage,
} from "@buildwarden/shared";
import { Ban, Bot, Check, CircleAlert, Clock3, FolderOpen, GitBranch, Layers, Loader2, X } from "lucide-react";
import { Spinner, StatusDot } from "../ui/motion";
import { StatusBarItem, StatusBarPortal } from "../../lib/status-bar";
import { useHasStatusBar } from "../../lib/status-bar-slots";
import { useTitleBarSlot } from "../../lib/title-bar-slot";
import { cn } from "../../lib/cn";
import { writeClipboardText } from "../../lib/clipboard";
import { deriveLatestRunPlanProgress } from "../../lib/run-plan-progress";
import { deriveRunSubagents } from "./run-activity-model";
import { RUN_DISPLAY_STATUS_LABELS, resolveRunDisplayStatus, runThemeState, type RunThemeState } from "./run-display-status";
import { formatRunDuration } from "./run-summary-format";
import { RunPlanProgressPill } from "./RunPlanProgressPill";
import { RunTokenBadge } from "./RunTokenBadge";
import { RunSubagentMenu } from "./RunSubagentMenu";
import { SessionTitleActions } from "./SessionTitleActions";

const STATE_ICONS: Record<RunThemeState, typeof Check> = {
  running: Loader2,
  preparing: Loader2,
  waiting: CircleAlert,
  completed: Check,
  failed: X,
  cancelled: Ban,
};

/**
 * Left side of the run header: the run's state and a configurable, ordered list of facts.
 *
 * A theme chooses the look (`chips` or `line`) and the items. The row is one line high and clips
 * what does not fit, so items at the end of the list drop off first. Branch, tokens and plan live in
 * the status bar; where there is none they are added here, because they have no other place.
 */
export const RunWorkspaceSummary = ({ run, runDetail, tokenUsage, stackedHeader, splitView, focused, paneLabel, onFocusSubagent, headerStyle = "chips", headerItems, modelLabel }: {
  run: RunListItem;
  runDetail: RunDetail | null;
  tokenUsage: Partial<RunTokenUsage> | null;
  stackedHeader: boolean;
  splitView: boolean;
  focused: boolean;
  paneLabel?: string;
  onFocusSubagent?: (subagentId: string) => void;
  headerStyle?: DesignRunHeaderStyle;
  /** Items to show, in order. Undefined uses the default list. */
  headerItems?: readonly DesignRunHeaderItem[];
  modelLabel?: string;
}) => {
  const isGitRun = run.workspaceVcs === "git";
  let workspaceLabel = run.branchName;
  if (!isGitRun) {
    workspaceLabel = run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  }
  const workspaceCopyValue = isGitRun ? run.branchName : run.worktreePath;
  const [copyFeedback, setCopyFeedback] = useState<{ value: string; copied: boolean } | null>(null);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const copyStatus = copyFeedback !== null && copyFeedback.value === workspaceCopyValue
    ? (copyFeedback.copied ? `${isGitRun ? "Branch name" : "Workspace path"} copied` : "Could not copy. Try again.")
    : "";
  const copyWorkspace = async () => {
    const copied = await writeClipboardText(workspaceCopyValue);
    setCopyFeedback({ value: workspaceCopyValue, copied });
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyFeedback(null), 1600);
  };
  const planProgress = useMemo(
    () => deriveLatestRunPlanProgress(runDetail?.steps ?? [], run.mode, run.status),
    [run.mode, run.status, runDetail?.steps],
  );
  const isRunActive = ["queued", "preparing", "running"].includes(run.status);
  const subagents = useMemo(
    () => deriveRunSubagents(runDetail?.steps ?? [], { runActive: isRunActive }),
    [isRunActive, runDetail?.steps],
  );
  // With a status bar, the focused run reports its workspace, tokens and plan there.
  const reportsToStatusBar = useHasStatusBar() && focused;
  const workspaceTypeLabel = run.workspaceType === "worktree" ? "worktree" : run.workspaceType === "copy" ? "copy" : "local";
  // The window title bar already names the open run, and the rename control sits next to it there.
  // Split panes keep their titles, because the title bar can only name one run.
  const titleBarSlot = useTitleBarSlot();
  const titleInTitleBar = titleBarSlot !== null && !splitView;
  const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  const waitingForInput = run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1;
  const statusLabel = waitingForInput ? "Waiting for input" : RUN_DISPLAY_STATUS_LABELS[displayStatus];
  const state = runThemeState(displayStatus, waitingForInput);
  const StateIcon = STATE_ICONS[state];
  const diff = runDetail?.diffSummary;

  const items = useMemo(() => {
    const list = [...(headerItems ?? DEFAULT_RUN_HEADER_ITEMS)];
    // Without a status bar these three have no other place, so they always show.
    if (!reportsToStatusBar) for (const item of ["branch", "tokens", "plan"] as const) if (!list.includes(item)) list.push(item);
    return list;
  }, [headerItems, reportsToStatusBar]);

  const renderItem = (item: DesignRunHeaderItem): ReactNode => {
    if (item === "status") {
      return headerStyle === "line" ? (
        <span key={item} data-ui="run-state" data-state={state} className="flex h-7 shrink-0 items-baseline gap-2">
          <StatusDot state={state} className="size-1.5 self-center rounded-full bg-[var(--run-state)]" />
          <span className="font-semibold text-[var(--ec-text)]">{statusLabel}</span>
        </span>
      ) : (
        <span key={item} data-ui="run-state" data-state={state} className="flex h-[22px] shrink-0 items-baseline gap-1.5 rounded-full bg-[var(--run-state-soft)] px-2.5 font-semibold leading-[22px] text-[var(--run-state)]">
          <Spinner icon={StateIcon} spinning={state === "running" || state === "preparing"} className="size-3 shrink-0 self-center" aria-hidden />
          {statusLabel}
        </span>
      );
    }
    if (item === "title") {
      if (titleInTitleBar || !run.titleGenerationEnabled) return null;
      return (
        <span key={item} data-ui="run-fact" data-fact="title" className="flex h-7 min-w-[6rem] max-w-[60%] shrink items-baseline gap-1">
          <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--ec-text)]" title={sessionTitle(run)}>{sessionTitle(run)}</span>
          <span className="flex shrink-0 self-center"><SessionTitleActions kind="run" session={run} /></span>
        </span>
      );
    }
    if (item === "duration") {
      return (
        <span key={item} data-ui="run-fact" data-fact="duration" className="flex h-7 shrink-0 items-baseline gap-1.5" title="Duration of the run">
          {headerStyle === "chips" ? <Clock3 className="size-3 shrink-0 self-center" aria-hidden /> : null}
          <span><span className={cn("font-mono text-[11px] leading-none", headerStyle === "chips" && "font-semibold text-[var(--ec-text)]")}>{formatRunDuration(run)}</span></span>
        </span>
      );
    }
    if (item === "model") {
      if (!modelLabel) return null;
      return (
        <span key={item} data-ui="run-fact" data-fact="model" className="flex h-7 shrink-0 items-baseline gap-1.5" title={`Model: ${modelLabel}`}>
          {headerStyle === "chips" ? <Bot className="size-3 shrink-0 self-center" aria-hidden /> : null}
          <span className="max-w-[14rem] truncate">{modelLabel}</span>
        </span>
      );
    }
    if (item === "diff") {
      if (!diff || diff.totalFiles === 0) return null;
      return (
        <span key={item} data-ui="run-fact" data-fact="diff" className="flex h-7 shrink-0 items-baseline gap-1.5" title="Files changed by this run">
          <span><span className="font-semibold text-[var(--ec-text)]">{diff.totalFiles}</span> file{diff.totalFiles === 1 ? "" : "s"}</span>
          <span><span className="font-mono text-[11px] leading-none text-[var(--bw-diff-added,var(--ec-success))]">+{diff.totalAdditions}</span></span>
          <span><span className="font-mono text-[11px] leading-none text-[var(--bw-diff-removed,var(--ec-danger))]">-{diff.totalDeletions}</span></span>
        </span>
      );
    }
    if (item === "branch") {
      if (!runDetail) return null;
      return (
        <button
          key={item}
          type="button"
          data-ui="run-fact"
          data-fact="branch"
          className="flex h-7 min-w-0 max-w-[20rem] shrink items-baseline gap-1.5 transition hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
          onClick={() => void copyWorkspace()}
          title={copyStatus || `Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
          aria-label={`Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
        >
          {copyStatus && copyFeedback?.copied ? (
            <Check className="size-3 shrink-0 self-center text-[var(--ec-success)]" aria-hidden />
          ) : isGitRun ? (
            <GitBranch className="size-3 shrink-0 self-center" />
          ) : (
            <FolderOpen className="size-3 shrink-0 self-center" />
          )}
          <span className="min-w-0 truncate"><span className="font-mono text-[11px] leading-none">{workspaceLabel}</span></span>
          {reportsToStatusBar ? null : <span role="status" className="sr-only">{copyStatus}</span>}
        </button>
      );
    }
    if (item === "tokens") {
      if (!runDetail || run.harnessType === "cursor-acp") return null;
      return (
        <span key={item} data-ui="run-fact" data-fact="tokens" className="flex h-7 shrink-0 items-center gap-1.5 self-center leading-normal">
          <RunTokenBadge inputTokens={runDetail.run.inputTokens} outputTokens={runDetail.run.outputTokens} usage={tokenUsage} />
        </span>
      );
    }
    if (!runDetail || !planProgress) return null;
    return (
      <span key={item} data-ui="run-fact" data-fact="plan" className="flex h-7 shrink-0 items-center gap-1.5 self-center leading-normal">
        <RunPlanProgressPill progress={planProgress} compact />
      </span>
    );
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-3", stackedHeader ? "w-full flex-wrap" : "flex-1")}>
      {splitView && paneLabel ? (
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            focused
              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
              : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
          )}
        >
          {paneLabel}
        </span>
      ) : null}
      {/* One line high and clipped: what does not fit wraps out of sight, last items first.
          Text sits on one shared baseline, because the facts mix two fonts and sizes. */}
      <div data-ui="run-facts" className="flex h-7 min-w-0 flex-1 flex-wrap content-start items-baseline gap-x-2 gap-y-2 overflow-hidden text-[12px] leading-7 text-[var(--ec-muted)]">
        {items.map(renderItem)}
      </div>
      {titleInTitleBar ? createPortal(<SessionTitleActions kind="run" session={run} />, titleBarSlot) : null}
      {runDetail && reportsToStatusBar ? (
        <StatusBarPortal slot="workspace">
          <StatusBarItem icon={<Layers aria-hidden />} title={`Workspace: ${workspaceTypeLabel}`}>{workspaceTypeLabel}</StatusBarItem>
          <StatusBarItem
            icon={copyStatus && copyFeedback?.copied ? <Check aria-hidden /> : isGitRun ? <GitBranch aria-hidden /> : <FolderOpen aria-hidden />}
            tone={copyStatus && copyFeedback?.copied ? "ok" : undefined}
            onClick={() => void copyWorkspace()}
            title={copyStatus || `Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
            aria-label={`Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
            className="max-w-[22rem]"
            data-shrink="true"
          >
            <span className="truncate">{workspaceLabel}</span>
            <span role="status" className="sr-only">{copyStatus}</span>
          </StatusBarItem>
          <RunPlanProgressPill progress={planProgress} statusBar />
        </StatusBarPortal>
      ) : null}
      {runDetail && reportsToStatusBar && run.harnessType !== "cursor-acp" ? (
        <StatusBarPortal slot="session">
          <RunTokenBadge inputTokens={runDetail.run.inputTokens} outputTokens={runDetail.run.outputTokens} usage={tokenUsage} variant="statusbar" />
        </StatusBarPortal>
      ) : null}
      {runDetail ? <RunSubagentMenu subagents={subagents} onFocusSubagent={onFocusSubagent} /> : null}
    </div>
  );
};
