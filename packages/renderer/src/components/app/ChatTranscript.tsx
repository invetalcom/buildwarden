import { forwardRef, useCallback, useMemo, useRef, useState, type Ref } from "react";
import { ResponseCitationContext } from "../../lib/response-citation-context";
import { revealRenderedResponse, type ResponseCitation } from "../../lib/response-citation";
import {
  normalizeRunSubagentInfo,
  getResponseSourceText,
  type RunEventType,
} from "@buildwarden/shared";
import { ChatWorkingIndicator } from "../ui/chat-working-indicator";
import { isVisibleChatStep } from "../../lib/chat-transcript";
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
    chatId?: string;
    active?: boolean;
    showLoading?: boolean;
    loadingLabel?: string;
    endRef?: Ref<HTMLDivElement>;
    className?: string;
    onCopyOutput?: (text: string, itemId: string) => void | Promise<void>;
    onCiteResponse?: (citation: ResponseCitation) => void;
  }
>(
  (
    {
      items,
      emptyMessage,
      readOnly = false,
      chatId,
      active = false,
      showLoading = false,
      loadingLabel = "Agent is working...",
      endRef,
      className,
      onCopyOutput,
      onCiteResponse,
    },
    ref,
  ) => {
    const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
    const transcriptRef = useRef<HTMLDivElement>(null);
    const setRef = useCallback((node: HTMLDivElement | null) => {
      transcriptRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }, [ref]);
    const revealResponse = useCallback((stepId: string) => revealRenderedResponse(transcriptRef.current, stepId), []);

    const entries = useMemo(
      () =>
        collapseChatSubagentEntries(
          items
            .map((item) => ({ item, metadata: safeParseMetadata(item.metadataJson) }))
            .filter(({ item, metadata }) => isVisibleChatStep(item, metadata)),
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
      <ResponseCitationContext.Provider value={revealResponse}>
      <div ref={setRef} className={`chat-transcript ${readOnly ? "chat-transcript--readonly" : ""} ${className ?? ""}`}>
        {entries.length === 0 && !active && !showLoading ? <p className="text-sm text-[color:var(--ec-muted)]">{emptyMessage}</p> : null}
        {entries.map(({ item, metadata }) => (
          <ChatTranscriptEntryView
            key={item.id}
            item={item}
            metadata={metadata}
            showLoading={active || showLoading}
            chatId={chatId}
            canAnswer={!readOnly && active}
            onCiteResponse={readOnly ? undefined : onCiteResponse}
            copied={copiedItemId === item.id}
            onCopy={() => void copyOutput(getResponseSourceText(item, metadata), item.id)}
          />
        ))}
        {active || showLoading ? <ChatWorkingIndicator label={loadingLabel} /> : null}
        <div ref={endRef} />
      </div>
      </ResponseCitationContext.Provider>
    );
  },
);

ChatTranscript.displayName = "ChatTranscript";
