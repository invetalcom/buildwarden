import type { ChatRecord } from "@buildwarden/shared";
import { Clock3, MessageSquare, Search, Trash2, X } from "lucide-react";
import { formatCompactTokens } from "../../lib/context-window-estimate";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { RUN_DISPLAY_STATUS_LABELS } from "./run-display-status";

interface ChatHistoryProps {
  chats: ChatRecord[];
  totalCount: number;
  loading: boolean;
  readOnly: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  modelNameById: ReadonlyMap<string, string>;
  onSelectChat: (chat: ChatRecord) => void;
  onDeleteChat: (chatId: string) => void | Promise<void>;
}

const ChatHistoryRow = ({ chat, modelName, readOnly, onSelectChat, onDeleteChat }: {
  chat: ChatRecord;
  modelName?: string;
  readOnly: boolean;
  onSelectChat: ChatHistoryProps["onSelectChat"];
  onDeleteChat: ChatHistoryProps["onDeleteChat"];
}) => {
  const title = chat.prompt.trim() || "Chat with attachments";
  const updatedAt = new Date(chat.updatedAt);
  const tokenCount = chat.inputTokens + chat.outputTokens;
  return (
    <div data-chat-history-id={chat.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2.5 py-2.5 transition-colors hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]">
      <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left hover:bg-transparent" onClick={() => onSelectChat(chat)} title="Open chat">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]">
          <MessageSquare className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--ec-text)]" title={title}>{title}</span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-normal text-[var(--ec-muted)]">
            {modelName ? <span className="max-w-48 truncate" title={modelName}>{modelName}</span> : null}
            <time dateTime={chat.updatedAt} title={updatedAt.toLocaleString()} className="tabular-nums">
              {updatedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {" · "}{updatedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </time>
          </span>
        </span>
      </Button>
      <div className="flex min-w-20 shrink-0 flex-col items-end gap-1">
        <Badge dot tone={chat.status}>{RUN_DISPLAY_STATUS_LABELS[chat.status]}</Badge>
        <span className="text-[10px] tabular-nums text-[var(--ec-muted)]" title={`${tokenCount.toLocaleString()} tokens`}>
          {formatCompactTokens(tokenCount)} tokens
        </span>
      </div>
      {!readOnly ? <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-[var(--ec-danger)]" onClick={() => void onDeleteChat(chat.id)} title="Delete chat" aria-label={`Delete chat: ${title}`}>
        <Trash2 className="size-3.5" />
      </Button> : null}
    </div>
  );
};

export const ChatHistory = ({ chats, totalCount, loading, readOnly, searchQuery, onSearchChange, modelNameById, onSelectChat, onDeleteChat }: ChatHistoryProps) => {
  const hasSearch = Boolean(searchQuery.trim());
  return (
    <Card className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl shadow-none">
      <CardHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--ec-border)] px-4 py-3">
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
          <div>
            <CardTitle>Chat History</CardTitle>
            <CardDescription>{loading ? "Loading conversations…" : hasSearch ? `${chats.length} matching of ${totalCount} chats.` : `${totalCount} ${totalCount === 1 ? "conversation" : "conversations"}.`}</CardDescription>
          </div>
        </div>
        <span className="relative block min-w-40 max-w-72 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
          <Input value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="h-8 pr-8 pl-8 text-xs" />
          {searchQuery ? <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2" onClick={() => onSearchChange("")} aria-label="Clear chat search" title="Clear search">
            <X className="size-3.5" />
          </Button> : null}
        </span>
      </CardHeader>
      <CardContent className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-b-xl p-1.5" aria-busy={loading}>
        {loading ? (
          <Empty><p role="status" className="text-sm text-[var(--ec-muted)]">Loading chats…</p></Empty>
        ) : chats.length === 0 ? (
          <Empty><EmptyHeader>
            {hasSearch ? <Search className="size-10 text-[var(--ec-muted)]" aria-hidden /> : <MessageSquare className="size-10 text-[var(--ec-muted)]" aria-hidden />}
            <EmptyTitle>{hasSearch ? "No matching chats" : "No chats yet"}</EmptyTitle>
            <EmptyDescription>{hasSearch ? "Try another search. Messages and replies are included." : readOnly ? "No chats are available on the BuildWarden host." : "Start a conversation above, with a message or an attachment."}</EmptyDescription>
          </EmptyHeader></Empty>
        ) : <div className="space-y-0.5">{chats.map((chat) => <ChatHistoryRow key={chat.id} chat={chat} modelName={modelNameById.get(chat.modelId)} readOnly={readOnly} onSelectChat={onSelectChat} onDeleteChat={onDeleteChat} />)}</div>}
      </CardContent>
    </Card>
  );
};
