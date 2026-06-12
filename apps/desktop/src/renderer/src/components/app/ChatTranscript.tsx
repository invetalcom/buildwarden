import { forwardRef, useCallback, useMemo, useState, type Ref } from "react";
import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  type RunEventType,
} from "@buildwarden/shared";
import { BrainCircuit, Check, ChevronDown, Copy, Loader2, MessageSquareText, ShieldCheck } from "lucide-react";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { StoredChatAttachments } from "./StoredChatAttachments";

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
        items
          .map((item) => ({ item, metadata: safeParseMetadata(item.metadataJson) }))
          .filter(({ item }) => {
            const isEmpty = !item.content?.trim();
            const isAgentOutputTitle = item.title === "Agent output";
            if (isEmpty && (item.eventType === "output" || isAgentOutputTitle)) return false;
            if (isAgentOutputTitle && item.eventType === "status") return false;
            return true;
          }),
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
        {entries.map(({ item, metadata }) => {
          const isUserEntry = metadata.source === "user";
          const isAssistantEntry = item.eventType === "output" && metadata.assistantKind !== "reasoning";
          const isReasoningEntry = item.eventType === "output" && metadata.assistantKind === "reasoning";
          const isStatusEntry = item.eventType === "status";
          const isErrorEntry = item.eventType === "error";
          const isRequestEntry =
            item.eventType === "request" ||
            item.eventType === "user-input-requested" ||
            item.eventType === "approval-requested" ||
            item.eventType === "approval-resolved";
          const isPlanEntry = item.eventType === "plan" || item.eventType === "plan-updated";
          const isDiffEntry = item.eventType === "diff-updated";
          const timestamp = new Date(item.createdAt).toLocaleTimeString();

          if (isUserEntry) {
            const attachments = extractAttachmentPayloadsFromMetadata(metadata);
            const attachmentNames = extractAttachmentNamesFromMetadata(metadata);
            return (
              <section key={item.id} className="chat-turn chat-turn--user">
                <div className="chat-turn-stack">
                  <div className="chat-bubble chat-bubble--user">
                    <div className="chat-bubble-meta">
                      <span>{metadata.commandType === "follow-up" ? "Follow-up" : "You"}</span>
                      <span>{timestamp}</span>
                    </div>
                    <StoredChatAttachments attachments={attachments} fallbackNames={attachmentNames} />
                    <ActivityMarkdownOrGitDiff content={item.content} className="chat-message-body" />
                  </div>
                </div>
                <div className="chat-avatar chat-avatar--user" aria-hidden>
                  You
                </div>
              </section>
            );
          }

          if (isReasoningEntry) {
            return (
              <section key={item.id} className="chat-turn chat-turn--assistant chat-turn--reasoning">
                <div className="chat-avatar chat-avatar--assistant" aria-hidden>
                  AI
                </div>
                <div className="chat-turn-stack chat-turn-stack--reasoning">
                  <details className="chat-bubble chat-bubble--assistant chat-bubble--reasoning">
                    <summary className="chat-reasoning-summary">
                      <span className="flex min-w-0 items-center gap-2">
                        <BrainCircuit className="h-4 w-4 shrink-0 text-[color:var(--ec-warning)]" aria-hidden />
                        <span className="truncate text-sm font-semibold text-[color:var(--ec-text)]">
                          {item.title || "Reasoning"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="chat-message-time">{timestamp}</span>
                        <ChevronDown className="chat-reasoning-chevron h-4 w-4 text-[color:var(--ec-faint)]" aria-hidden />
                      </span>
                    </summary>
                    <ActivityMarkdownOrGitDiff content={item.content} className="chat-reasoning-body" />
                  </details>
                </div>
              </section>
            );
          }

          if (isRequestEntry) {
            const requestKind =
              typeof metadata.requestKind === "string"
                ? metadata.requestKind
                : item.eventType.startsWith("approval")
                  ? "approval"
                  : "user-input";
            return (
              <section key={item.id} className="chat-inline-panel chat-inline-panel--request">
                <div className="chat-panel-header">
                  <div className="flex min-w-0 items-center gap-2">
                    <MessageSquareText className="h-4 w-4 shrink-0 text-[color:var(--ec-info)]" />
                    <p className="truncate text-sm font-medium text-[color:var(--ec-text)]">{item.title}</p>
                    <span className="chat-panel-kicker">{requestKind}</span>
                  </div>
                  <span className="chat-message-time">{timestamp}</span>
                </div>
                <ActivityMarkdownOrGitDiff content={item.content} className="chat-panel-body" />
              </section>
            );
          }

          if (isPlanEntry) {
            return (
              <section key={item.id} className="chat-inline-panel chat-inline-panel--plan">
                <div className="chat-panel-header">
                  <div className="flex min-w-0 items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-[color:var(--ec-success)]" />
                    <p className="truncate text-sm font-medium text-[color:var(--ec-text)]">{item.title}</p>
                  </div>
                  <span className="chat-message-time">{timestamp}</span>
                </div>
                <ActivityMarkdownOrGitDiff content={item.content} className="chat-panel-body" />
              </section>
            );
          }

          if (isDiffEntry) {
            return (
              <section key={item.id} className="chat-inline-panel chat-inline-panel--diff">
                <div className="chat-panel-header">
                  <p className="truncate text-sm font-medium text-[color:var(--ec-text)]">{item.title}</p>
                  <span className="chat-message-time">{timestamp}</span>
                </div>
                <ActivityMarkdownOrGitDiff content={item.content} className="chat-panel-body" />
              </section>
            );
          }

          if (isStatusEntry) {
            return (
              <section key={item.id} className="chat-system-message">
                <p className="truncate text-xs font-medium text-[color:var(--ec-muted)]">{item.title}</p>
                <span className="chat-message-time">{timestamp}</span>
              </section>
            );
          }

          if (isErrorEntry) {
            return (
              <section key={item.id} className="chat-inline-panel chat-inline-panel--error">
                <div className="chat-panel-header">
                  <p className="text-sm font-medium text-[color:var(--ec-danger)]">{item.title}</p>
                  <span className="chat-message-time">{timestamp}</span>
                </div>
                <pre className="chat-pre app-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {item.content}
                </pre>
              </section>
            );
          }

          if (isAssistantEntry) {
            const copied = copiedItemId === item.id;
            return (
              <section key={item.id} className="chat-turn chat-turn--assistant">
                <div className="chat-avatar chat-avatar--assistant" aria-hidden>
                  AI
                </div>
                <div className="chat-turn-stack">
                  <div className="chat-bubble chat-bubble--assistant">
                    <button
                      type="button"
                      className="chat-bubble-copy"
                      onClick={() => void copyOutput(item.content, item.id)}
                      title={copied ? "Copied" : "Copy output"}
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <div className="chat-bubble-meta">
                      <span>Assistant</span>
                      <span>{timestamp}</span>
                    </div>
                    <ActivityMarkdownOrGitDiff content={item.content} className="chat-message-body chat-message-body--assistant" />
                  </div>
                </div>
              </section>
            );
          }

          return (
            <section key={item.id} className="chat-inline-panel chat-inline-panel--note">
              <div className="chat-panel-header">
                <p className="truncate text-sm font-medium text-[color:var(--ec-text)]">{item.title}</p>
                <span className="chat-message-time">{timestamp}</span>
              </div>
              <ActivityMarkdownOrGitDiff content={item.content} className="chat-panel-body text-[color:var(--ec-muted)]" />
            </section>
          );
        })}
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
