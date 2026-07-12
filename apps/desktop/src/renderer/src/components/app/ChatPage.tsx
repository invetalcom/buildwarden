import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendChatAttachmentFiles,
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatRecord,
  type ProviderType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import { MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { RunComposer } from "./RunComposer";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

const chatDetailMatchesSearch = (detail: ChatDetail, query: string): boolean => {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const { chat, steps } = detail;
  if (chat.prompt.toLowerCase().includes(q)) return true;
  return steps.some(
    (step) =>
      step.title.toLowerCase().includes(q) ||
      step.content.toLowerCase().includes(q) ||
      step.eventType.toLowerCase().includes(q),
  );
};

interface ChatPageProps {
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  submitShortcut: string;
  onSelectChat: (chat: ChatRecord) => void;
  onCreateChat: (input: {
    prompt: string;
    modelId: string;
    attachments?: ChatAttachmentPayload[];
    reasoningEffort?: string;
    anthropicEffort?: string;
  }) => void | Promise<void>;
  reasoningEffort: string;
  anthropicEffort: string;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  onDeleteChat: (chatId: string) => void | Promise<void>;
}

export const ChatPage = ({
  modelOptions,
  defaultModelId,
  submitShortcut,
  onSelectChat,
  onCreateChat,
  reasoningEffort,
  anthropicEffort,
  onReasoningEffortChange,
  onAnthropicEffortChange,
  onDeleteChat,
}: ChatPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [chatDetails, setChatDetails] = useState<ChatDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [newChatFiles, setNewChatFiles] = useState<File[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const buildwarden = window.buildwarden;
  const hasChatModels = modelOptions.length > 0;

  const loadChats = useCallback(async () => {
    if (!buildwarden) return;
    setLoading(true);
    try {
      const data = await buildwarden.listChatsWithSteps();
      setChatDetails(data);
    } finally {
      setLoading(false);
    }
  }, [buildwarden]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(defaultModelId || modelOptions[0]?.id || "");
  }, [defaultModelId, modelOptions, selectedModelId]);

  const filteredChats = useMemo(() => {
    return chatDetails
      .filter((d) => chatDetailMatchesSearch(d, searchQuery))
      .sort((a, b) => new Date(b.chat.updatedAt).getTime() - new Date(a.chat.updatedAt).getTime());
  }, [chatDetails, searchQuery]);

  const handleNewChat = async () => {
    const prompt = newChatPrompt.trim();
    if (!prompt && newChatFiles.length === 0) return;
    let attachments: ChatAttachmentPayload[] | undefined;
    try {
      attachments = newChatFiles.length > 0 ? await readFilesAsChatPayloads(newChatFiles) : undefined;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not read attachments.");
      return;
    }
    await onCreateChat({ prompt, modelId: selectedModelId, attachments, reasoningEffort, anthropicEffort });
    setNewChatPrompt("");
    setNewChatFiles([]);
    void loadChats();
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <Card className="overflow-hidden">
        <div className="flex min-h-[6.5rem] flex-col gap-3 p-4 xl:h-[6.5rem] xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--ec-accent)]">Chat</p>
            <h2 className="mt-1 text-2xl font-semibold text-[var(--ec-text)]">Conversation workspace</h2>
            <p className="mt-1 text-sm leading-5 text-[var(--ec-muted)]">
              Chat with the AI without a Git repository. No file tools, no worktrees—pure conversation.
            </p>
            {!hasChatModels ? (
              <p className="mt-3 text-sm text-[var(--ec-warning)]">
                No chat-compatible models are configured. CodexCLI models only work from a real workspace or run.
              </p>
            ) : null}
          </div>
          <div className="min-w-20 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2 text-right">
            <p className="font-mono text-lg font-semibold text-[var(--ec-text)]">{chatDetails.length}</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ec-faint)]">chats</p>
          </div>
        </div>
      </Card>

      <RunComposer
        variant="chat"
        attachments={
          <ChatAttachmentPicker variant="footer" files={newChatFiles} onChange={setNewChatFiles} disabled={loading} />
        }
        prompt={newChatPrompt}
        onPromptChange={setNewChatPrompt}
        selectedMode="ask"
        onModeChange={() => {}}
        selectedModelId={selectedModelId}
        onModelChange={setSelectedModelId}
        modelOptions={modelOptions.map((opt) => ({
          value: opt.id,
          label: opt.label,
          contextModelId: opt.modelId,
          providerType: opt.providerType,
          providerFamily: opt.providerFamily,
        }))}
        busy={loading}
        onSubmit={() => void handleNewChat()}
        submitLabel="New chat"
        submitIcon={<Plus className="ml-2 h-4 w-4" />}
        placeholder="Start a new chat… (optional if you attach files)"
        autoFocus
        dropdownSide="bottom"
        submitShortcut={submitShortcut}
        onAddAttachmentFiles={(incoming) => setNewChatFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
        submitDisabled={(!newChatPrompt.trim() && newChatFiles.length === 0) || loading || !selectedModelId || !hasChatModels}
        sticky={false}
        showContextBadge={false}
        reasoningEffort={reasoningEffort}
        anthropicEffort={anthropicEffort}
        onReasoningEffortChange={onReasoningEffortChange}
        onAnthropicEffortChange={onAnthropicEffortChange}
      />

      <Card className="p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ec-muted)]" />
          <Input
            className="pl-10"
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-[var(--ec-border)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--ec-text)]">
            {filteredChats.length} {filteredChats.length === 1 ? "chat" : "chats"}
          </p>
        </div>
        <div className="app-scrollbar max-h-[520px] overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <p className="text-sm text-zinc-400">Loading chats…</p>
            </div>
          ) : <>{filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <MessageSquare className="size-12 text-[var(--ec-muted)]" />
              <p className="text-sm text-[var(--ec-muted)]">
                {chatDetails.length === 0
                  ? "No chats yet. Start a new chat above."
                  : "No chats match your search."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--ec-border)]">
              {filteredChats.map(({ chat }) => (
                <div
                  key={chat.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-[var(--ec-hover)]"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectChat(chat)}
                    title="Open chat"
                  >
                    <div className="flex items-center gap-2">
                      <Badge dot tone={chat.status}>{chat.status}</Badge>
                      <span className="truncate text-xs text-[var(--ec-muted)]">
                        {new Date(chat.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-[var(--ec-text)]">{chat.prompt}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-zinc-400 hover:text-rose-400"
                      onClick={async () => {
                        await onDeleteChat(chat.id);
                        void loadChats();
                      }}
                      title="Delete chat"
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
