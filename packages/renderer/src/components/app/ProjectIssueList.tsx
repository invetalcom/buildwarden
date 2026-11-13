import type { ProjectForgeIssueSummary } from "@buildwarden/shared";
import { Bot, GitPullRequest, ListChecks, Loader2, Lock, MessageSquare, MessagesSquare, PanelLeftClose, Play, Search, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { IssueAvatarStack, IssueLabelChip, IssueStateIcon } from "./project-issue-parts";
import { formatIssueAge, isIssueUnread, type IssueWorkSummary, type SeenIssues } from "./project-issues-model";

const MAX_ROW_LABELS = 3;

export interface ProjectIssueListProps {
  /** Loaded issues after the search box narrowed them. */
  issues: readonly ProjectForgeIssueSummary[];
  loadedCount: number;
  hasMore: boolean;
  busy: boolean;
  search: string;
  selectedNumber: number | null;
  checkedNumbers: ReadonlySet<number>;
  seen: SeenIssues;
  workByIssue: ReadonlyMap<number, IssueWorkSummary>;
  /** Whether runs may be started here; hides the batch controls otherwise. */
  canStartRuns: boolean;
  resizing: boolean;
  /** State switch and filters, shown between the search box and the issues. */
  filterBar?: ReactNode;
  onSearchChange: (value: string) => void;
  onSelect: (issue: ProjectForgeIssueSummary) => void;
  onToggleChecked: (issueNumber: number) => void;
  onClearChecked: () => void;
  onStartCheckedRuns: () => void;
  onLoadMore: () => void;
  onCollapse: () => void;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

const WorkMarkers = ({ work }: Readonly<{ work: IssueWorkSummary | undefined }>) => {
  if (!work) return null;
  const request = work.runs.map(({ run }) => run?.forgeRequest).find((entry) => entry != null);
  return (
    <>
      {work.runs.length > 0 ? (
        <span
          className={cn("inline-flex items-center gap-0.5", work.activeRun ? "text-[var(--ec-accent)]" : "text-[var(--ec-muted)]")}
          title={work.activeRun ? "An agent run is working on this issue" : `${String(work.runs.length)} agent run${work.runs.length === 1 ? "" : "s"} for this issue`}
        >
          {work.activeRun ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Bot className="h-3 w-3" aria-hidden />}
          {work.runs.length > 1 ? String(work.runs.length) : null}
        </span>
      ) : null}
      {request ? (
        <span className="inline-flex items-center gap-0.5 text-[var(--ec-accent)]" title={`${request.state === "merged" ? "Merged" : "Open"} request #${String(request.number)} from a run for this issue`}>
          <GitPullRequest className="h-3 w-3" aria-hidden />
          {String(request.number)}
        </span>
      ) : null}
      {work.chats.length > 0 ? (
        <span className="inline-flex items-center text-[var(--ec-muted)]" title="A chat was started about this issue">
          <MessagesSquare className="h-3 w-3" aria-hidden />
        </span>
      ) : null}
      {work.tasks.length > 0 ? (
        <span className="inline-flex items-center text-[var(--ec-muted)]" title="On the Task Board">
          <ListChecks className="h-3 w-3" aria-hidden />
        </span>
      ) : null}
    </>
  );
};

export const ProjectIssueList = ({
  issues,
  loadedCount,
  hasMore,
  busy,
  search,
  selectedNumber,
  checkedNumbers,
  seen,
  workByIssue,
  canStartRuns,
  resizing,
  filterBar,
  onSearchChange,
  onSelect,
  onToggleChecked,
  onClearChecked,
  onStartCheckedRuns,
  onLoadMore,
  onCollapse,
  onResizeStart,
}: ProjectIssueListProps) => {
  const now = Date.now();
  const checkedCount = checkedNumbers.size;
  return (
    <Card className="relative flex min-h-0 flex-col overflow-hidden border-[var(--ec-border)] bg-[var(--ec-panel)] p-0">
      <div className="flex items-center gap-1.5 border-b border-[var(--ec-border)] px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search # or title"
            aria-label="Search loaded issues"
            className="h-7 pl-6 pr-6 text-[11px]"
          />
          {search ? (
            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--ec-faint)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[9px] text-[var(--ec-muted)]" title={`${String(issues.length)} of ${String(loadedCount)} loaded issues shown`}>
          {issues.length === loadedCount ? String(loadedCount) : `${String(issues.length)}/${String(loadedCount)}`}
          {hasMore ? "+" : ""}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]"
          onClick={onCollapse}
          title="Hide issue list"
          aria-label="Hide issue list"
        >
          <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {filterBar}

      {checkedCount > 0 ? (
        <div className="flex items-center gap-1.5 border-b border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-[var(--ec-text)]">{String(checkedCount)} selected</span>
          <Button type="button" size="xs" className="h-6 px-2 text-[10px]" onClick={onStartCheckedRuns} title="Start one agent run per selected issue, each in its own worktree">
            <Play className="mr-1 h-3 w-3" aria-hidden />
            Start runs
          </Button>
          <Button type="button" size="xs" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={onClearChecked}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="app-scrollbar max-h-72 min-h-0 flex-1 overflow-y-auto lg:max-h-none">
        {issues.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-[var(--ec-faint)]">
            {busy ? "Loading issues…" : search.trim() && loadedCount > 0 ? "No loaded issue matches this search." : "No issues match these filters."}
          </p>
        ) : null}
        {issues.map((issue) => {
          const selected = selectedNumber === issue.number;
          const checked = checkedNumbers.has(issue.number);
          const unread = !selected && isIssueUnread(issue, seen);
          const hiddenLabels = issue.labels.length - MAX_ROW_LABELS;
          return (
            <div
              key={issue.number}
              className={cn(
                "group relative flex w-full min-w-0 items-start gap-1.5 border-b border-[var(--ec-border)] py-2 pl-2 pr-2.5 transition-colors last:border-b-0",
                selected
                  ? "bg-[var(--ec-accent-soft)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--ec-accent)]"
                  : "hover:bg-[var(--ec-hover)]",
              )}
            >
              {canStartRuns ? (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleChecked(issue.number)}
                  className={cn(
                    "mt-0.5 h-3 w-3 shrink-0 cursor-pointer accent-[var(--ec-accent)] transition-opacity",
                    checked || checkedCount > 0 ? "opacity-100" : "opacity-40 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                  aria-label={`Select issue #${String(issue.number)} for a batch run`}
                />
              ) : null}
              <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => onSelect(issue)} aria-current={selected ? "true" : undefined}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <IssueStateIcon issue={issue} className="h-3 w-3 shrink-0" />
                  <span className="font-mono text-[9px] text-[var(--ec-muted)]">#{String(issue.number)}</span>
                  {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ec-accent)]" title="Updated since you last opened it" /> : null}
                  {issue.locked ? <Lock className="h-2.5 w-2.5 shrink-0 text-[var(--ec-faint)]" aria-label="Conversation locked" /> : null}
                  {issue.confidential ? <span className="text-[8px] font-semibold uppercase text-[var(--ec-warning)]">confidential</span> : null}
                  <span className="ml-auto shrink-0 text-[9px] text-[var(--ec-faint)]" title={issue.updatedAt ?? undefined}>{formatIssueAge(issue.updatedAt, now)}</span>
                </span>
                <span className={cn("mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--ec-text)]", unread ? "font-semibold" : "font-medium")}>{issue.title}</span>
                {issue.labels.length > 0 ? (
                  <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                    {issue.labels.slice(0, MAX_ROW_LABELS).map((label) => (
                      <IssueLabelChip key={label.name} label={label} />
                    ))}
                    {hiddenLabels > 0 ? <span className="text-[9px] text-[var(--ec-faint)]">+{String(hiddenLabels)}</span> : null}
                  </span>
                ) : null}
                <span className="mt-1 flex min-w-0 items-center gap-2 text-[9px] text-[var(--ec-faint)]">
                  <span className="min-w-0 truncate">{issue.author ?? "unknown"}</span>
                  {issue.commentCount > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[var(--ec-muted)]" title={`${String(issue.commentCount)} comment${issue.commentCount === 1 ? "" : "s"}`}>
                      <MessageSquare className="h-3 w-3" aria-hidden />
                      {String(issue.commentCount)}
                    </span>
                  ) : null}
                  {issue.taskProgress ? (
                    <span className="shrink-0 font-mono" title="Sub-issues or checklist items done">
                      {String(issue.taskProgress.completed)}/{String(issue.taskProgress.total)}
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <WorkMarkers work={workByIssue.get(issue.number)} />
                    <IssueAvatarStack users={issue.assignees} />
                  </span>
                </span>
              </button>
            </div>
          );
        })}
        {hasMore ? (
          <div className="p-2">
            <Button type="button" size="xs" variant="secondary" className="h-7 w-full text-[10px]" onClick={onLoadMore} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "absolute right-0 top-0 hidden h-full w-1.5 cursor-col-resize transition lg:block",
          resizing ? "bg-[var(--ec-accent-soft)]" : "bg-transparent hover:bg-[var(--ec-accent-soft)]",
        )}
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize issue list"
        title="Resize issue list"
      />
    </Card>
  );
};
