import {
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  isTerminalRunSubagentStatus,
  normalizeRunSubagentInfo,
} from "@buildwarden/shared";
import { Bot, BrainCircuit, Check, ChevronDown, Copy, Loader2, MessageSquareText, ShieldCheck } from "lucide-react";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { StoredChatAttachments } from "./StoredChatAttachments";
import type { ChatTranscriptItem } from "./ChatTranscript";

type EntryKind = "user" | "assistant" | "reasoning" | "subagent" | "request" | "plan" | "diff" | "status" | "error" | "note";

const entryKind = (item: ChatTranscriptItem, metadata: Record<string, unknown>): EntryKind => {
  if (metadata.source === "user") return "user";
  if (item.eventType === "output" && metadata.assistantKind === "reasoning") return "reasoning";
  if (normalizeRunSubagentInfo(metadata.subagent)) return "subagent";
  if (["request", "user-input-requested", "approval-requested", "approval-resolved"].includes(item.eventType)) return "request";
  if (item.eventType === "plan" || item.eventType === "plan-updated") return "plan";
  if (item.eventType === "diff-updated") return "diff";
  if (item.eventType === "status") return "status";
  if (item.eventType === "error") return "error";
  if (item.eventType === "output") return "assistant";
  return "note";
};

const UserEntry = ({ item, metadata, timestamp }: EntryViewProps) => (
  <section className="chat-turn chat-turn--user">
    <div className="chat-turn-stack">
      <div className="chat-bubble chat-bubble--user">
        <div className="chat-bubble-meta"><span>{metadata.commandType === "follow-up" ? "Follow-up" : "You"}</span><span>{timestamp}</span></div>
        <StoredChatAttachments attachments={extractAttachmentPayloadsFromMetadata(metadata)} fallbackNames={extractAttachmentNamesFromMetadata(metadata)} />
        <ActivityMarkdownOrGitDiff content={item.content} className="chat-message-body" />
      </div>
    </div>
    <div className="chat-avatar chat-avatar--user" aria-hidden>You</div>
  </section>
);

const ReasoningEntry = ({ item, timestamp }: EntryViewProps) => (
  <section className="chat-turn chat-turn--assistant chat-turn--reasoning">
    <div className="chat-avatar chat-avatar--assistant" aria-hidden>AI</div>
    <div className="chat-turn-stack chat-turn-stack--reasoning">
      <details className="chat-bubble chat-bubble--assistant chat-bubble--reasoning">
        <summary className="chat-reasoning-summary">
          <span className="flex min-w-0 items-center gap-2"><BrainCircuit className="h-4 w-4 shrink-0 text-[color:var(--ec-warning)]" aria-hidden /><span className="truncate text-sm font-semibold text-[color:var(--ec-text)]">{item.title || "Reasoning"}</span></span>
          <span className="flex shrink-0 items-center gap-2"><span className="chat-message-time">{timestamp}</span><ChevronDown className="chat-reasoning-chevron h-4 w-4 text-[color:var(--ec-faint)]" aria-hidden /></span>
        </summary>
        <ActivityMarkdownOrGitDiff content={item.content} className="chat-reasoning-body" />
      </details>
    </div>
  </section>
);

type EntryViewProps = { item: ChatTranscriptItem; metadata: Record<string, unknown>; timestamp: string };

const AssistantEntry = ({ item, metadata, timestamp, copied, onCopy }: EntryViewProps & { copied: boolean; onCopy: () => void }) => (
  <section className="chat-turn chat-turn--assistant">
    <div className="chat-avatar chat-avatar--assistant" aria-hidden>AI</div>
    <div className="chat-turn-stack">
      <div className="chat-bubble chat-bubble--assistant">
        <button type="button" className="chat-bubble-copy" onClick={onCopy} title={copied ? "Copied" : "Copy output"}>
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <div className="chat-bubble-meta"><span>Assistant</span><span>{timestamp}</span></div>
        <StoredChatAttachments attachments={extractAttachmentPayloadsFromMetadata(metadata)} fallbackNames={extractAttachmentNamesFromMetadata(metadata)} />
        <ActivityMarkdownOrGitDiff content={item.content} className="chat-message-body chat-message-body--assistant" />
      </div>
    </div>
  </section>
);

const SubagentEntry = ({ metadata, timestamp, showLoading }: Omit<EntryViewProps, "item"> & { showLoading: boolean }) => {
  const raw = normalizeRunSubagentInfo(metadata.subagent)!;
  const subagent = !showLoading && !isTerminalRunSubagentStatus(raw.status) ? { ...raw, status: "cancelled" as const } : raw;
  const running = subagent.status === "running" || subagent.status === "pending";
  const heading = subagent.description?.trim() || subagent.prompt?.trim().split("\n")[0] || "Delegated task";
  return (
    <section className="chat-inline-panel chat-inline-panel--note">
      <div className="chat-panel-header">
        <div className="flex min-w-0 items-center gap-2">
          {running ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[color:var(--ec-info)]" /> : <Bot className="h-4 w-4 shrink-0 text-[color:var(--ec-muted)]" />}
          <p className="truncate text-sm font-medium text-[color:var(--ec-text)]">Subagent{subagent.name ? `: ${subagent.name}` : ""}</p>
          <span className="chat-panel-kicker">{subagent.status}</span>
        </div>
        <span className="chat-message-time">{timestamp}</span>
      </div>
      <p className="mt-1 truncate text-xs text-[color:var(--ec-muted)]" title={heading}>{heading}</p>
      {subagent.summary?.trim() && <ActivityMarkdownOrGitDiff content={subagent.summary.trim()} className="chat-panel-body" />}
    </section>
  );
};

const panelClassName = (kind: EntryKind): string => {
  if (kind === "request") return "chat-inline-panel--request";
  if (kind === "plan") return "chat-inline-panel--plan";
  if (kind === "diff") return "chat-inline-panel--diff";
  return "chat-inline-panel--note";
};

const PanelEntry = ({ item, metadata, timestamp, kind }: EntryViewProps & { kind: EntryKind }) => {
  if (kind === "status") return <section className="chat-system-message"><p className="truncate text-xs font-medium text-[color:var(--ec-muted)]">{item.title}</p><span className="chat-message-time">{timestamp}</span></section>;
  if (kind === "error") return <section className="chat-inline-panel chat-inline-panel--error"><div className="chat-panel-header"><p className="text-sm font-medium text-[color:var(--ec-danger)]">{item.title}</p><span className="chat-message-time">{timestamp}</span></div><pre className="chat-pre app-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">{item.content}</pre></section>;
  const panelClass = panelClassName(kind);
  let icon = null;
  if (kind === "request") icon = <MessageSquareText className="h-4 w-4 shrink-0 text-[color:var(--ec-info)]" />;
  if (kind === "plan") icon = <ShieldCheck className="h-4 w-4 shrink-0 text-[color:var(--ec-success)]" />;
  let requestKind = typeof metadata.requestKind === "string" ? metadata.requestKind : "user-input";
  if (kind === "request" && item.eventType.startsWith("approval")) requestKind = "approval";
  return (
    <section className={`chat-inline-panel ${panelClass}`}>
      <div className="chat-panel-header">
        <div className="flex min-w-0 items-center gap-2">{icon}<p className="truncate text-sm font-medium text-[color:var(--ec-text)]">{item.title}</p>{kind === "request" && <span className="chat-panel-kicker">{requestKind}</span>}</div>
        <span className="chat-message-time">{timestamp}</span>
      </div>
      <ActivityMarkdownOrGitDiff content={item.content} className={kind === "note" ? "chat-panel-body text-[color:var(--ec-muted)]" : "chat-panel-body"} />
    </section>
  );
};

export const ChatTranscriptEntryView = ({ item, metadata, showLoading, copied, onCopy }: {
  item: ChatTranscriptItem;
  metadata: Record<string, unknown>;
  showLoading: boolean;
  copied: boolean;
  onCopy: () => void;
}) => {
  const timestamp = new Date(item.createdAt).toLocaleTimeString();
  const props = { item, metadata, timestamp };
  const kind = entryKind(item, metadata);
  switch (kind) {
    case "user": return <UserEntry {...props} />;
    case "reasoning": return <ReasoningEntry {...props} />;
    case "assistant": return <AssistantEntry {...props} copied={copied} onCopy={onCopy} />;
    case "subagent": return <SubagentEntry {...props} showLoading={showLoading} />;
    default: return <PanelEntry {...props} kind={kind} />;
  }
};
