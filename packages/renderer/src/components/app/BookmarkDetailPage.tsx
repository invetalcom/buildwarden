import { useMemo } from "react";
import { type BookmarkRecord, type ModelRecord } from "@buildwarden/shared";
import { FolderGit2, GitBranch } from "lucide-react";
import { bookmarkModelDisplay } from "../../lib/bookmark-model";
import { DetailHeader, OpenOriginalButton, RelativeTime } from "./DetailHeader";
import { promptTitle } from "./run-summary-format";
import { RunActivityTimeline } from "./RunActivityTimeline";
import type { RunActivityRun } from "./run-activity-model";

interface BookmarkDetailPageProps {
  bookmark: BookmarkRecord;
  models: ModelRecord[];
  onBack: () => void;
  /** Opens the live run this bookmark was copied from; omitted when it was deleted. */
  onOpenOriginal?: () => void;
}

export const BookmarkDetailPage = ({ bookmark, models, onBack, onOpenOriginal }: BookmarkDetailPageProps) => {
  const modelLabel = useMemo(() => bookmarkModelDisplay(models, bookmark.modelId), [models, bookmark.modelId]);
  const runForTimeline = useMemo<RunActivityRun>(
    () => ({
      id: bookmark.originalRunId,
      status: bookmark.status,
      mode: "code",
    }),
    [bookmark.originalRunId, bookmark.status],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DetailHeader
        status={bookmark.status}
        title={promptTitle(bookmark.prompt, "Untitled run")}
        titleTooltip={bookmark.prompt}
        backLabel="Back to bookmarks"
        onBack={onBack}
        meta={[
          <span className="inline-flex min-w-0 shrink items-center gap-1" title={`Project: ${bookmark.projectName}`}>
            <FolderGit2 className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{bookmark.projectName}</span>
          </span>,
          bookmark.branchName ? (
            <span className="inline-flex min-w-0 shrink items-center gap-1" title={`Branch: ${bookmark.branchName}`}>
              <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate font-mono text-[10.5px]">{bookmark.branchName}</span>
            </span>
          ) : null,
          bookmark.modelId ? <span className="truncate" title={modelLabel === "Removed model" ? bookmark.modelId : undefined}>{modelLabel}</span> : null,
          <RelativeTime
            value={bookmark.bookmarkedAt}
            prefix="saved"
            tooltip={`Bookmarked ${new Date(bookmark.bookmarkedAt).toLocaleString()} · run started ${new Date(bookmark.runCreatedAt).toLocaleString()}`}
          />,
        ]}
        actions={<OpenOriginalButton kind="run" onOpen={onOpenOriginal} />}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--ec-border)]">
        <RunActivityTimeline
          steps={bookmark.steps}
          run={runForTimeline}
          readOnly
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 pr-10"
          emptyMessage="No activity recorded."
          virtualized
          showBoundaryControls
          initialScrollPosition="start"
        />
      </div>
    </div>
  );
};
