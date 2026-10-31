import { useMemo, useRef } from "react";
import { type ChatBookmarkRecord, type ModelRecord } from "@buildwarden/shared";
import { bookmarkModelDisplay } from "../../lib/bookmark-model";
import { ChatTranscript } from "./ChatTranscript";
import { DetailHeader, RelativeTime } from "./DetailHeader";
import { promptTitle } from "./run-summary-format";
import { ScrollBoundaryControls } from "./ScrollBoundaryControls";

interface ChatBookmarkDetailPageProps {
  bookmark: ChatBookmarkRecord;
  models: ModelRecord[];
  onBack: () => void;
}

export const ChatBookmarkDetailPage = ({ bookmark, models, onBack }: ChatBookmarkDetailPageProps) => {
  const modelLabel = useMemo(() => bookmarkModelDisplay(models, bookmark.modelId), [models, bookmark.modelId]);
  const transcriptRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DetailHeader
        status={bookmark.status}
        title={promptTitle(bookmark.prompt, "Untitled chat")}
        titleTooltip={bookmark.prompt}
        backLabel="Back to bookmarks"
        onBack={onBack}
        meta={[
          bookmark.modelId ? <span className="truncate" title={modelLabel === "Removed model" ? bookmark.modelId : undefined}>{modelLabel}</span> : null,
          <RelativeTime
            value={bookmark.bookmarkedAt}
            prefix="saved"
            tooltip={`Bookmarked ${new Date(bookmark.bookmarkedAt).toLocaleString()} · chat started ${new Date(bookmark.chatCreatedAt).toLocaleString()}`}
          />,
        ]}
      />

      <div className="relative min-h-0 flex-1">
        <ChatTranscript
          ref={transcriptRef}
          className="app-scrollbar h-full min-h-0 overflow-auto py-1 pr-10"
          items={bookmark.steps}
          emptyMessage="No messages recorded."
          readOnly
        />
        <ScrollBoundaryControls key={bookmark.id} scrollElementRef={transcriptRef} />
      </div>
    </div>
  );
};
