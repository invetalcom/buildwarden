import { useCallback, useEffect, useMemo, useState } from "react";
import type { BookmarkRecord, ChatBookmarkRecord } from "@buildwarden/shared";
import { Bookmark, Search, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { BookmarkHistoryRow } from "./BookmarkHistoryRow";
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

  const hasSearch = Boolean(searchQuery.trim());
  const chatCount = bookmarks.filter(isChatBookmark).length;
  const runCount = bookmarks.length - chatCount;
  const removeBookmark = async (bookmark: BookmarkItem) => {
    if (isChatBookmark(bookmark)) {
      await onRemoveChatBookmarkById(bookmark.id);
    } else {
      await onRemoveRunBookmarkById(bookmark.id);
    }
    void loadBookmarks();
  };

  return (
    <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-7xl flex-1 flex-col gap-3">
      <CardHeader className="shrink-0 flex-row items-center justify-between gap-3 px-1 py-1">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-accent)]">Bookmarks</p>
          <CardTitle className="mt-0.5 text-xl">Saved runs &amp; chats</CardTitle>
          <CardDescription>Saved copies of your runs and chats, kept even if the originals are deleted.</CardDescription>
        </div>
        <Badge tone="neutral" className="shrink-0">{bookmarks.length} {bookmarks.length === 1 ? "bookmark" : "bookmarks"}</Badge>
      </CardHeader>

      <Card className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl shadow-none">
        <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--ec-border)] px-4 py-3">
          <div className="flex items-start gap-2">
            <Bookmark className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
            <div>
              <CardTitle>Saved items</CardTitle>
              <CardDescription>{loading ? "Loading bookmarks..." : hasSearch
                ? `${filteredBookmarks.length} matching of ${bookmarks.length} bookmarks.`
                : `${runCount} ${runCount === 1 ? "run" : "runs"}, ${chatCount} ${chatCount === 1 ? "chat" : "chats"}.`}</CardDescription>
            </div>
          </div>
          <span className="relative block min-w-40 max-w-72 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" aria-hidden />
            <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search bookmarks" aria-label="Search bookmarks" title="Search titles, projects, and activity logs" className="h-8 pr-8 pl-8 text-xs" />
            {searchQuery ? <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2" onClick={() => setSearchQuery("")} aria-label="Clear bookmark search" title="Clear search">
              <X className="size-3.5" />
            </Button> : null}
          </span>
        </CardHeader>
        <CardContent className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-b-xl p-1.5" aria-busy={loading}>
          {loading ? (
            <Empty><p role="status" className="text-sm text-[var(--ec-muted)]">Loading bookmarks...</p></Empty>
          ) : filteredBookmarks.length === 0 ? (
            <Empty><EmptyHeader>
              {hasSearch ? <Search className="size-10 text-[var(--ec-muted)]" aria-hidden /> : <Bookmark className="size-10 text-[var(--ec-muted)]" aria-hidden />}
              <EmptyTitle>{hasSearch ? "No matching bookmarks" : "No bookmarks yet"}</EmptyTitle>
              <EmptyDescription>{hasSearch ? "Try another search. Titles, projects, and activity logs are included." : "Bookmark a run or chat to keep a saved copy here."}</EmptyDescription>
            </EmptyHeader></Empty>
          ) : <div className="space-y-0.5">{filteredBookmarks.map((bookmark) => <BookmarkHistoryRow
            key={`${isChatBookmark(bookmark) ? "chat" : "run"}:${bookmark.id}`}
            bookmark={bookmark}
            canRemove={isChatBookmark(bookmark) ? buildwarden.capabilities.chatMutations : buildwarden.capabilities.runMutations}
            onSelect={onSelectBookmark}
            onRemove={removeBookmark}
          />)}</div>}
        </CardContent>
      </Card>
    </div>
  );
};
