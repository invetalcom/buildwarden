import { sessionTitle } from "@buildwarden/shared";
import { SessionTitleActions } from "./SessionTitleActions";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunListItem, RunTokenUsage } from "@buildwarden/shared";
import { Check, FolderOpen, GitBranch } from "lucide-react";
import { cn } from "../../lib/cn";
import { writeClipboardText } from "../../lib/clipboard";
import { deriveLatestRunPlanProgress } from "../../lib/run-plan-progress";
import { deriveRunSubagents } from "./run-activity-model";
import { RunPlanProgressPill } from "./RunPlanProgressPill";
import { RunTokenBadge } from "./RunTokenBadge";
import { RunSubagentMenu } from "./RunSubagentMenu";

export const RunWorkspaceSummary = ({ run, runDetail, tokenUsage, stackedHeader, splitView, focused, paneLabel, onFocusSubagent }: {
  run: RunListItem;
  runDetail: RunDetail | null;
  tokenUsage: Partial<RunTokenUsage> | null;
  stackedHeader: boolean;
  splitView: boolean;
  focused: boolean;
  paneLabel?: string;
  onFocusSubagent?: (subagentId: string) => void;
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
  const copyStatus = copyFeedback?.value === workspaceCopyValue
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

  return (
    <div className={cn("flex min-w-0 items-center gap-3", stackedHeader ? "w-full flex-wrap" : "flex-1")}>
      {splitView && paneLabel ? (
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            focused
              ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
              : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
          )}
        >
          {paneLabel}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {run.titleGenerationEnabled ? (
          <div className={cn("flex min-w-0 items-center gap-1", runDetail && "max-w-[60%]")}>
            <span className="min-w-0 truncate text-[13px] font-semibold leading-5" title={sessionTitle(run)}>{sessionTitle(run)}</span>
            <SessionTitleActions kind="run" session={run} />
          </div>
        ) : null}
        {runDetail ? (
          <button
            type="button"
            className={cn("inline-flex h-7 min-w-0 max-w-[24rem] flex-1 items-center gap-1.5 text-[11px] leading-4 text-[var(--ec-muted)] transition hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
              run.titleGenerationEnabled && "border-l border-[var(--ec-border)] pl-3")}
            onClick={() => void copyWorkspace()}
            title={copyStatus || `Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
            aria-label={`Copy ${isGitRun ? "branch name" : "workspace path"}: ${workspaceCopyValue}`}
          >
            {copyStatus && copyFeedback?.copied ? (
              <Check className="size-3 shrink-0 text-[var(--ec-success)]" aria-hidden />
            ) : isGitRun ? (
              <GitBranch className="size-3 shrink-0" />
            ) : (
              <FolderOpen className="size-3 shrink-0" />
            )}
            <span className="truncate font-mono">{workspaceLabel}</span>
            <span role="status" className="sr-only">{copyStatus}</span>
          </button>
        ) : null}
      </div>
      {runDetail ? (
        <div className="flex shrink-0 items-center gap-2">
          {run.harnessType !== "cursor-acp" ? (
            <RunTokenBadge
              inputTokens={runDetail.run.inputTokens}
              outputTokens={runDetail.run.outputTokens}
              usage={tokenUsage}
            />
          ) : null}
          <RunPlanProgressPill progress={planProgress} compact />
          <RunSubagentMenu subagents={subagents} onFocusSubagent={onFocusSubagent} />
        </div>
      ) : null}
    </div>
  );
};
