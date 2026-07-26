import { useCallback, useEffect, useState } from "react";
import type { BookmarkRecord, ChatBookmarkRecord } from "@buildwarden/shared";
import { bookmarkModelDisplay } from "@buildwarden/renderer/logic";
import { Bookmark } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { errorMessage, firstLine, relativeTime } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { ChatStatusPill } from "../components/StatusPill";
import { CenteredSpinner, EmptyState, InlineError, ListRow, SectionLabel } from "../components/primitives";

/**
 * Bookmarks are snapshots taken at bookmark time, not live runs, so they are fetched with their
 * steps rather than derived from the app snapshot.
 */
export const BookmarksScreen = () => {
  const { client, snapshot, router } = useMobileApp();
  const [runBookmarks, setRunBookmarks] = useState<BookmarkRecord[]>([]);
  const [chatBookmarks, setChatBookmarks] = useState<ChatBookmarkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [runs, chats] = await Promise.all([client.getBookmarksWithSteps(), client.getChatBookmarksWithSteps()]);
      setRunBookmarks(runs);
      setChatBookmarks(chats);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load bookmarks."));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = runBookmarks.length === 0 && chatBookmarks.length === 0;

  return (
    <>
      <AppBar title="Bookmarks" onBack={router.back} />

      <div className="m-scroll m-screen-enter flex-1">
        {error ? <InlineError message={error} onRetry={() => void load()} /> : null}
        {loading ? (
          <CenteredSpinner />
        ) : empty ? (
          <EmptyState icon={<Bookmark className="size-7" />} title="No bookmarks" message="Bookmark a run or chat to keep a snapshot of it." />
        ) : (
          <>
            {runBookmarks.length > 0 ? (
              <>
                <SectionLabel>Runs</SectionLabel>
                {runBookmarks.map((bookmark) => (
                  <ListRow
                    key={bookmark.id}
                    title={firstLine(bookmark.prompt, "Untitled run")}
                    subtitle={`${bookmark.projectName} · ${bookmarkModelDisplay(snapshot.models, bookmark.modelId)}`}
                    trailing={relativeTime(bookmark.bookmarkedAt)}
                    className="border-b border-[var(--ec-border)]"
                    onClick={() => router.push({ name: "run", runId: bookmark.originalRunId, segment: "activity" })}
                  />
                ))}
              </>
            ) : null}

            {chatBookmarks.length > 0 ? (
              <>
                <SectionLabel>Chats</SectionLabel>
                {chatBookmarks.map((bookmark) => (
                  <ListRow
                    key={bookmark.id}
                    title={firstLine(bookmark.prompt, "Untitled chat")}
                    subtitle={bookmarkModelDisplay(snapshot.models, bookmark.modelId)}
                    trailing={<ChatStatusPill status={bookmark.status} />}
                    className="border-b border-[var(--ec-border)]"
                    onClick={() => router.push({ name: "chat", chatId: bookmark.originalChatId })}
                  />
                ))}
              </>
            ) : null}
            <div className="h-6" />
          </>
        )}
      </div>
    </>
  );
};
