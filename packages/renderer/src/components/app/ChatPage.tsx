import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendChatAttachmentFiles,
  type ChatAttachmentPayload,
  type ChatSearchDetail,
  type ChatRecord,
  type ModelExecutionProfile,
  type ProviderExecutionOptions,
  type ProviderType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import { ArrowUp } from "lucide-react";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { RunComposer } from "./RunComposer";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { chatDetailMatchesSearch } from "../../lib/chat-search";
import { Badge } from "../ui/badge";
import { CardDescription, CardHeader, CardTitle } from "../ui/card";
import { ChatHistory } from "./ChatHistory";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { buildRunReasoningInput } from "./app-model";


interface ChatPageProps {
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null; executionProfile?: ModelExecutionProfile }>;
  defaultModelId: string;
  submitShortcut: string;
  onSelectChat: (chat: ChatRecord) => void;
  onCreateChat: (input: {
    prompt: string;
    modelId: string;
    attachments?: ChatAttachmentPayload[];
    reasoningEffort?: string;
    anthropicEffort?: string;
    executionOptions?: ProviderExecutionOptions;
  }) => void | Promise<void>;
  reasoningEffort: string;
  anthropicEffort: string;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  executionMode?: string;
  onExecutionModeChange?: (value: string) => void;
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
  executionMode = "auto",
  onExecutionModeChange,
  onDeleteChat,
}: ChatPageProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [chatDetails, setChatDetails] = useState<ChatSearchDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [newChatFiles, setNewChatFiles] = useState<File[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.chatMutations;
  const hasChatModels = modelOptions.length > 0;
  const modelNameById = useMemo(() => new Map(modelOptions.map((model) => [model.id, model.label])), [modelOptions]);

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
    const selectedModel = modelOptions.find((option) => option.id === selectedModelId);
    if (!selectedModel) return;
    await onCreateChat({
      prompt,
      modelId: selectedModelId,
      attachments,
      ...buildRunReasoningInput(
        selectedModel.providerType,
        selectedModel.providerFamily,
        reasoningEffort,
        anthropicEffort,
        selectedModel.executionProfile,
        executionMode,
      ),
    });
    setNewChatPrompt("");
    setNewChatFiles([]);
    void loadChats();
  };

  return (
    <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-7xl flex-1 flex-col gap-3">
      <CardHeader className="shrink-0 flex-row items-center justify-between gap-3 px-1 py-1">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-accent)]">Chat</p>
          <CardTitle className="mt-0.5 text-xl">Conversation workspace</CardTitle>
          <CardDescription>Ask questions, explore ideas, and work with attached files.</CardDescription>
          {!hasChatModels ? (
            <p className="mt-1 text-xs text-[var(--ec-warning)]">
              No chat-compatible models are configured. CodexCLI models only work from a real workspace or run.
            </p>
          ) : null}
        </div>
        <Badge tone="neutral" className="shrink-0">{chatDetails.length} {chatDetails.length === 1 ? "chat" : "chats"}</Badge>
      </CardHeader>

      {!readOnly ? <RunComposer
        variant="chat-launch"
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
          executionProfile: opt.executionProfile,
        }))}
        busy={loading}
        onSubmit={() => void handleNewChat()}
        submitLabel="Start chat"
        submitIcon={<ArrowUp />}
        placeholder="What would you like to talk about?"
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
        executionMode={executionMode}
        onExecutionModeChange={onExecutionModeChange}
      /> : null}

      <ChatHistory
        chats={filteredChats.map(({ chat }) => chat)}
        totalCount={chatDetails.length}
        loading={loading}
        readOnly={readOnly}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        modelNameById={modelNameById}
        onSelectChat={onSelectChat}
        onDeleteChat={async (chatId) => {
          await onDeleteChat(chatId);
          void loadChats();
        }}
      />
    </div>
  );
};
