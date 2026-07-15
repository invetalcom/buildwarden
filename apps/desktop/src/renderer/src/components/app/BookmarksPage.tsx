import { useCallback, useEffect, useMemo, useState } from "react";
import type { BookmarkRecord, ChatBookmarkRecord } from "@buildwarden/shared";
import { Bookmark, Search, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export type BookmarkItem = BookmarkRecord | ChatBookmarkRecord;

const isChatBookmark = (b: BookmarkItem): b is ChatBookmarkRecord => "originalChatId" in b;

const bookmarkMatchesSearch = (bookmark: BookmarkItem, query: string): boolean => {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  if (bookmark.prompt.toLowerCase().includes(q)) return true;
  if (!isChatBookmark(bookmark) && bookmark.projectName.toLowerCase().includes(q)) return true;
  return bookmark.steps.some(
    (step) =>
      step.title.toLowerCase().includes(q) ||
      step.content.toLowerCase().includes(q) ||
      step.eventType.toLowerCase().includes(q),
  );
};

interface BookmarksPageProps {
  onSelectBookmark: (bookmark: BookmarkItem) => void;
  onRemoveRunBookmarkById: (bookmarkId: string) => void | Promise<void>;
  onRemoveChatBookmarkById: (bookmarkId: string) => void | Promise<void>;
}

export const BookmarksPage = ({
  onSelectBookmark,
  onRemoveRunBookmarkById,
  onRemoveChatBookmarkById,
}: BookmarksPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const buildwarden = useBuildWardenClient();

  const loadBookmarks = useCallback(async () => {
    if (!buildwarden) return;
    setLoading(true);
    try {
      const [runBookmarks, chatBookmarks] = await Promise.all([
        buildwarden.getBookmarksWithSteps(),
        buildwarden.getChatBookmarksWithSteps(),
      ]);
      const merged = [...runBookmarks, ...chatBookmarks].sort(
        (a, b) => new Date(b.bookmarkedAt).getTime() - new Date(a.bookmarkedAt).getTime(),
      );
      setBookmarks(merged);
    } finally {
      setLoading(false);
    }
  }, [buildwarden]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const filteredBookmarks = useMemo(() => {
    return bookmarks
      .filter((b) => bookmarkMatchesSearch(b, searchQuery))
      .sort((a, b) => new Date(b.bookmarkedAt).getTime() - new Date(a.bookmarkedAt).getTime());
  }, [bookmarks, searchQuery]);

  return (
    <div className="space-y-4">
      <Card className="app-surface-chat-hero overflow-hidden border p-0">
        <div className="flex min-h-[6.5rem] flex-col gap-3 p-4 xl:h-[6.5rem] xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--ec-accent)]">Bookmarks</p>
            <h2 className="mt-1 text-2xl font-semibold text-[var(--ec-text)]">Saved runs</h2>
            <p className="mt-1 text-sm leading-5 text-[var(--ec-muted)]">
              Your bookmarked runs and chats. Bookmarks are stored as copies and persist even if the original is deleted.
            </p>
          </div>
          <div className="min-w-20 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2 text-right">
            <p className="font-mono text-lg font-semibold text-[var(--ec-text)]">{bookmarks.length}</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ec-faint)]">bookmarks</p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            className="pl-10"
            placeholder="Search bookmarks (title, project, or activity log)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="text-sm font-medium text-zinc-100">
            {filteredBookmarks.length} {filteredBookmarks.length === 1 ? "bookmark" : "bookmarks"}
          </p>
        </div>
        <div className="app-scrollbar max-h-[520px] overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <p className="text-sm text-zinc-400">Loading bookmarks…</p>
            </div>
          ) : <>{filteredBookmarks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <Bookmark className="h-12 w-12 text-zinc-600" />
              <p className="text-sm text-zinc-400">
                {bookmarks.length === 0
                  ? "No bookmarks yet. Right-click a run in the sidebar and choose Add to bookmarks."
                  : "No bookmarks match your search."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800">
              {filteredBookmarks.map((bookmark) => (
                <div
                  key={bookmark.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-[var(--ec-hover)]"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectBookmark(bookmark)}
                    title="Open bookmark"
                  >
                    <div className="flex items-center gap-2">
                      <Badge dot tone={bookmark.status}>{bookmark.status}</Badge>
                      <span className="truncate text-xs text-zinc-500">
                        {isChatBookmark(bookmark)
                          ? `Chat • ${new Date(bookmark.bookmarkedAt).toLocaleString()}`
                          : `${bookmark.projectName} • ${new Date(bookmark.bookmarkedAt).toLocaleString()}`}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-zinc-200">{bookmark.prompt}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-zinc-400 hover:text-rose-400"
                      onClick={async () => {
                        if (isChatBookmark(bookmark)) {
                          await onRemoveChatBookmarkById(bookmark.id);
                        } else {
                          await onRemoveRunBookmarkById(bookmark.id);
                        }
                        void loadBookmarks();
                      }}
                      title="Remove from bookmarks"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}</>}
        </div>
      </Card>
    </div>
  );
};
