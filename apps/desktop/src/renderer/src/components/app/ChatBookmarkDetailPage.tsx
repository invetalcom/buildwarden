import { useMemo } from "react";
import { type ChatBookmarkRecord, type ModelRecord } from "@buildwarden/shared";
import { bookmarkModelDisplay } from "../../lib/bookmark-model";
import { ChatTranscript } from "./ChatTranscript";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

interface ChatBookmarkDetailPageProps {
  bookmark: ChatBookmarkRecord;
  models: ModelRecord[];
  onBack: () => void;
}

export const ChatBookmarkDetailPage = ({ bookmark, models, onBack }: ChatBookmarkDetailPageProps) => {
  const modelLabel = useMemo(() => bookmarkModelDisplay(models, bookmark.modelId), [models, bookmark.modelId]);

  return (
    <div className="space-y-4">
      <Card className="app-surface-chat-hero overflow-hidden border px-4 py-3">
        <button
          type="button"
          className="text-[11px] uppercase tracking-[0.28em] text-cyan-400 transition hover:text-cyan-300"
          onClick={onBack}
        >
          &larr; Back to bookmarks
        </button>
        <div className="mt-2 min-w-0 space-y-1.5">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Prompt</p>
            <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug text-zinc-100">{bookmark.prompt}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 pt-1.5 text-[11px] leading-tight">
            <div className="flex items-center gap-1.5">
              <Badge tone={bookmark.status} className="shrink-0 px-1.5 py-0 text-[10px]">
                {bookmark.status}
              </Badge>
              <span className="text-zinc-500">Chat</span>
            </div>
            <span className="hidden text-zinc-700 sm:inline" aria-hidden>
              &middot;
            </span>
            <span className="min-w-0 sm:max-w-[min(40%,14rem)]">
              <span className="text-[10px] uppercase tracking-wide text-zinc-600">Model </span>
              <span
                className="font-medium text-zinc-200"
                title={bookmark.modelId && modelLabel === "Removed model" ? bookmark.modelId : undefined}
              >
                {modelLabel}
              </span>
            </span>
            <span className="hidden text-zinc-700 sm:inline" aria-hidden>
              &middot;
            </span>
            <span className="min-w-0 text-zinc-400">
              <span className="text-[10px] uppercase tracking-wide text-zinc-600">Bookmarked </span>
              {new Date(bookmark.bookmarkedAt).toLocaleString()}
              <span className="text-zinc-600"> &middot; chat </span>
              {new Date(bookmark.chatCreatedAt).toLocaleString()}
            </span>
          </div>
        </div>
      </Card>

      <ChatTranscript
        className="app-scrollbar px-0 py-1"
        items={bookmark.steps}
        emptyMessage="No messages recorded."
        readOnly
      />
    </div>
  );
};
