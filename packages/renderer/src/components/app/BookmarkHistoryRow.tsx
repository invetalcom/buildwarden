import { Bot, FolderGit2, GitBranch, MessageSquare, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { BookmarkItem } from "./BookmarksPage";
import { RUN_DISPLAY_STATUS_LABELS } from "./run-display-status";

interface BookmarkHistoryRowProps {
  bookmark: BookmarkItem;
  canRemove: boolean;
  onSelect: (bookmark: BookmarkItem) => void;
  onRemove: (bookmark: BookmarkItem) => void | Promise<void>;
}

export const BookmarkHistoryRow = ({ bookmark, canRemove, onSelect, onRemove }: BookmarkHistoryRowProps) => {
  const isChat = "originalChatId" in bookmark;
  const title = bookmark.prompt.trim() || (isChat ? "Chat with attachments" : "Saved run");
  const savedAt = new Date(bookmark.bookmarkedAt);
  const Icon = isChat ? MessageSquare : Bot;

  return (
    <div data-bookmark-id={bookmark.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2.5 py-2.5 transition-colors hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]">
      <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left hover:bg-transparent" onClick={() => onSelect(bookmark)} title="Open bookmark">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--ec-text)]" title={title}>{title}</span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-normal text-[var(--ec-muted)]">
            <span>{isChat ? "Chat" : "Run"}</span>
            {!isChat ? <>
              <span className="inline-flex min-w-0 max-w-40 items-center gap-1 text-[var(--ec-text)]" title={`Project: ${bookmark.projectName}`}>
                <FolderGit2 className="size-3 shrink-0 text-[var(--ec-muted)]" aria-hidden />
                <span className="truncate">{bookmark.projectName}</span>
              </span>
              {bookmark.branchName ? <span className="inline-flex min-w-0 max-w-48 items-center gap-1" title={bookmark.branchName}>
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{bookmark.branchName}</span>
              </span> : null}
            </> : null}
            <time dateTime={bookmark.bookmarkedAt} title={`Saved ${savedAt.toLocaleString()}`} className="tabular-nums">
              {savedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {" · "}{savedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </time>
          </span>
        </span>
      </Button>
      <Badge dot tone={bookmark.status} className="shrink-0">{RUN_DISPLAY_STATUS_LABELS[bookmark.status]}</Badge>
      {canRemove ? <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-[var(--ec-danger-strong)]" onClick={() => void onRemove(bookmark)} title="Remove from bookmarks" aria-label={`Remove bookmark: ${title}`}>
        <Trash2 className="size-3.5" />
      </Button> : null}
    </div>
  );
};
