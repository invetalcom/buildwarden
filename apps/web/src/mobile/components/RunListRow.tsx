import { GitBranch, MessageCircleQuestion } from "lucide-react";
import type { RunListItem } from "../data/selectors";
import { needsAttention } from "../data/selectors";
import { relativeTime, runTitle } from "../lib/format";
import { RunStatusPill } from "./StatusPill";

export const RunListRow = ({
  item,
  showProject = true,
  onOpen,
}: {
  item: RunListItem;
  showProject?: boolean;
  onOpen: (runId: string) => void;
}) => {
  const { run, project } = item;
  const attention = needsAttention(run);

  return (
    <button
      type="button"
      onClick={() => onOpen(run.id)}
      className="m-tap flex w-full flex-col gap-1 border-b border-[var(--ec-border)] px-4 py-2.5 text-left transition active:bg-[var(--ec-hover)]"
    >
      <div className="flex items-start gap-2">
        <span className="m-wrap-anywhere line-clamp-2 min-w-0 flex-1 text-[13.5px] font-medium leading-5">
          {runTitle(run)}
        </span>
        <span className="shrink-0 pt-0.5 text-[11px] text-[var(--ec-faint)]">
          {relativeTime(run.lastUserInputAt ?? run.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RunStatusPill run={run} />
        {attention ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ec-warning)]">
            <MessageCircleQuestion className="size-3" />
            Needs you
          </span>
        ) : null}
        {showProject ? <span className="truncate text-[11px] text-[var(--ec-muted)]">{project.project.name}</span> : null}
        {run.branchName ? (
          <span className="m-mono inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--ec-faint)]">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{run.branchName}</span>
          </span>
        ) : null}
      </div>
    </button>
  );
};
