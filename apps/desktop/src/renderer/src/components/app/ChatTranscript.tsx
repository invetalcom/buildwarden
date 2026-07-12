import { forwardRef, useCallback, useMemo, useState, type Ref } from "react";
import {
  normalizeRunSubagentInfo,
  type RunEventType,
} from "@buildwarden/shared";
import { Loader2 } from "lucide-react";
import { ChatTranscriptEntryView } from "./chat-transcript-entry";

export type ChatTranscriptItem = {
  id: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

type ChatTranscriptEntry = { item: ChatTranscriptItem; metadata: Record<string, unknown> };

// The chat pipeline appends a new step for every subagent lifecycle chunk
// (only "message" chunks replace in place), so a subagent would otherwise
// render one panel per update. Keep a single panel anchored where the
// subagent first appeared, showing its latest state.
// Exported for focused transcript shaping tests.
// eslint-disable-next-line react-refresh/only-export-components
export const collapseChatSubagentEntries = (entries: ChatTranscriptEntry[]): ChatTranscriptEntry[] => {
  const anchorIndexBySubagentId = new Map<string, number>();
  const out: ChatTranscriptEntry[] = [];
  for (const entry of entries) {
    const info = normalizeRunSubagentInfo(entry.metadata.subagent);
    if (!info) {
      out.push(entry);
      continue;
    }
    const anchorIndex = anchorIndexBySubagentId.get(info.id);
    if (anchorIndex === undefined) {
      anchorIndexBySubagentId.set(info.id, out.length);
      out.push(entry);
      continue;
    }
    out[anchorIndex] = entry;
  }
  return out;
};

export const ChatTranscript = forwardRef<
  HTMLDivElement,
  {
    items: ChatTranscriptItem[];
    emptyMessage: string;
    readOnly?: boolean;
    showLoading?: boolean;
    loadingLabel?: string;
    endRef?: Ref<HTMLDivElement>;
    className?: string;
    onCopyOutput?: (text: string, itemId: string) => void | Promise<void>;
  }
>(
  (
    {
      items,
      emptyMessage,
      readOnly = false,
      showLoading = false,
      loadingLabel = "Model is working...",
      endRef,
      className,
      onCopyOutput,
    },
    ref,
  ) => {
    const [copiedItemId, setCopiedItemId] = useState<string | null>(null);

    const entries = useMemo(
      () =>
        collapseChatSubagentEntries(
          items
            .map((item) => ({ item, metadata: safeParseMetadata(item.metadataJson) }))
            .filter(({ item, metadata }) => {
              // Subagent-internal activity stays inside the subagent summary line.
              if (typeof metadata.subagentId === "string" && metadata.subagentId) return false;
              const isEmpty = !item.content?.trim();
              const isAgentOutputTitle = item.title === "Agent output";
              if (isEmpty && (item.eventType === "output" || isAgentOutputTitle)) return false;
              if (isAgentOutputTitle && item.eventType === "status") return false;
              return true;
            }),
        ),
      [items],
    );

    const copyOutput = useCallback(
      async (text: string, itemId: string) => {
        if (onCopyOutput) {
          await onCopyOutput(text, itemId);
        } else {
          await navigator.clipboard.writeText(text);
        }
        setCopiedItemId(itemId);
        window.setTimeout(() => {
          setCopiedItemId((current) => (current === itemId ? null : current));
        }, 1500);
      },
      [onCopyOutput],
    );

    return (
      <div ref={ref} className={`chat-transcript ${readOnly ? "chat-transcript--readonly" : ""} ${className ?? ""}`}>
        {entries.length === 0 && !showLoading ? <p className="text-sm text-[color:var(--ec-muted)]">{emptyMessage}</p> : null}
        {entries.map(({ item, metadata }) => (
          <ChatTranscriptEntryView
            key={item.id}
            item={item}
            metadata={metadata}
            showLoading={showLoading}
            copied={copiedItemId === item.id}
            onCopy={() => void copyOutput(item.content, item.id)}
          />
        ))}
        {showLoading ? (
          <div className="chat-loading">
            <div className="run-activity-loading-bar mb-2" />
            <div className="flex items-center gap-2 text-[11px] text-[color:var(--ec-muted)]">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--ec-accent)]" aria-hidden />
              <span className="animate-pulse">{loadingLabel}</span>
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
    );
  },
);

ChatTranscript.displayName = "ChatTranscript";
