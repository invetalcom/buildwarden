import { useMemo } from "react";
import type { RunDetail, RunRecord, RunTokenUsage } from "@buildwarden/shared";
import { FolderOpen, GitBranch } from "lucide-react";
import { cn } from "../../lib/cn";
import { deriveLatestRunPlanProgress } from "../../lib/run-plan-progress";
import { deriveRunSubagents } from "./run-activity-model";
import { RunPlanProgressPill } from "./RunPlanProgressPill";
import { RunTokenBadge } from "./RunTokenBadge";
import { RunSubagentMenu } from "./RunSubagentMenu";

export const RunWorkspaceSummary = ({ run, runDetail, tokenUsage, stackedHeader, splitView, focused, paneLabel, onFocusSubagent }: {
  run: RunRecord;
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
    <div className={cn("flex min-w-0 items-center gap-2.5", stackedHeader ? "w-full flex-wrap" : "flex-1")}>
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
      {runDetail ? (
        <>
          <button
            type="button"
            className={cn(
              "inline-flex min-w-0 items-center gap-2 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-1 text-[11px] text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)]",
              stackedHeader ? "max-w-full flex-1 basis-44" : "max-w-[24rem]",
            )}
            onClick={() => void navigator.clipboard.writeText(workspaceCopyValue)}
            title={workspaceCopyValue}
          >
            {isGitRun ? (
              <GitBranch className="size-3.5 shrink-0 text-[var(--ec-success)]" />
            ) : (
              <FolderOpen className="size-3.5 shrink-0 text-[var(--ec-success)]" />
            )}
            <span className="truncate font-mono text-[11px] text-[var(--ec-text)]">{workspaceLabel}</span>
          </button>
          {run.harnessType !== "cursor-acp" ? (
            <RunTokenBadge
              inputTokens={runDetail.run.inputTokens}
              outputTokens={runDetail.run.outputTokens}
              usage={tokenUsage}
            />
          ) : null}
          <RunPlanProgressPill progress={planProgress} />
          <RunSubagentMenu subagents={subagents} onFocusSubagent={onFocusSubagent} />
        </>
      ) : null}
    </div>
  );
};
