import { useMemo } from "react";
import { type BookmarkRecord, type ModelRecord } from "@buildwarden/shared";
import { bookmarkModelDisplay } from "../../lib/bookmark-model";
import { RunActivityTimeline } from "./RunActivityTimeline";
import type { RunActivityRun } from "./run-activity-model";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

interface BookmarkDetailPageProps {
  bookmark: BookmarkRecord;
  models: ModelRecord[];
  onBack: () => void;
}

export const BookmarkDetailPage = ({ bookmark, models, onBack }: BookmarkDetailPageProps) => {
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Card className="app-surface-chat-hero shrink-0 overflow-hidden border px-4 py-3">
        <button
          type="button"
          className="text-[11px] uppercase tracking-[0.28em] text-[var(--ec-accent)] transition hover:text-[var(--ec-accent-strong)]"
          onClick={onBack}
        >
          &larr; Back to bookmarks
        </button>
        <div className="mt-2 min-w-0 space-y-1.5">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">Prompt</p>
            <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug text-[var(--ec-text)]">{bookmark.prompt}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--ec-border)] pt-1.5 text-[11px] leading-tight">
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
              <Badge tone={bookmark.status} className="shrink-0 px-1.5 py-0 text-[10px]">
                {bookmark.status}
              </Badge>
              <span className="truncate text-[var(--ec-muted)]">
                {bookmark.projectName}
                <span className="text-[var(--ec-faint)]"> &middot; </span>
                {bookmark.branchName}
              </span>
            </div>
            <span className="hidden text-[var(--ec-faint)] sm:inline" aria-hidden>
              &middot;
            </span>
            <span className="min-w-0 sm:max-w-[min(40%,14rem)]">
              <span className="text-[10px] uppercase tracking-wide text-[var(--ec-faint)]">Model </span>
              <span
                className="font-medium text-[var(--ec-text)]"
                title={bookmark.modelId && modelLabel === "Removed model" ? bookmark.modelId : undefined}
              >
                {modelLabel}
              </span>
            </span>
            <span className="hidden text-[var(--ec-faint)] sm:inline" aria-hidden>
              &middot;
            </span>
            <span className="min-w-0 text-[var(--ec-muted)]">
              <span className="text-[10px] uppercase tracking-wide text-[var(--ec-faint)]">Bookmarked </span>
              {new Date(bookmark.bookmarkedAt).toLocaleString()}
              <span className="text-[var(--ec-faint)]"> &middot; run </span>
              {new Date(bookmark.runCreatedAt).toLocaleString()}
            </span>
          </div>
        </div>
      </Card>

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
