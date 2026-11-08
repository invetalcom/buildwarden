import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComposerDraft } from "../../lib/use-composer-draft";
import { ComposerDraftStatus } from "./ComposerDraftStatus";
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
import { InstanceTargetSelector } from "../../lib/instance-context";
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
  }) => Promise<void>;
  reasoningEffort: string;
  anthropicEffort: string;
  onReasoningEffortChange: (value: string) => void;
  onAnthropicEffortChange: (value: string) => void;
  executionMode?: string;
  onExecutionModeChange?: (value: string) => void;
  onDeleteChat: (chatId: string) => Promise<void>;
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
  const draft = useComposerDraft("new-chat");
  const { prompt: newChatPrompt, setPrompt: setNewChatPrompt, files: newChatFiles, setFiles: setNewChatFiles } = draft;
  const submitting = draft.submitting;
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.chatMutations;
  const hasChatModels = modelOptions.length > 0;
  const modelNameById = useMemo(() => new Map(modelOptions.map((model) => [model.id, model.label])), [modelOptions]);

  const loadSequence = useRef(0);
  const liveChats = useRef(new Map<string, ChatRecord>());
  const invalidateLoads = useCallback(() => {
    ++loadSequence.current;
    liveChats.current.clear();
  }, []);
  const loadChats = useCallback(async () => {
    if (!buildwarden) return;
    const sequence = ++loadSequence.current;
    liveChats.current.clear();
    setLoading(true);
    try {
      const data = await buildwarden.listChatsWithSteps();
      if (sequence !== loadSequence.current) return;
      setChatDetails(data.map((detail) => ({ ...detail, chat: liveChats.current.get(detail.chat.id) ?? detail.chat })));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [buildwarden]);

  useEffect(() => {
    void loadChats();
    const unsubscribe = buildwarden.onChatEvent?.((event) => {
      if (!event.chat) return;
      liveChats.current.set(event.chatId, event.chat);
      setChatDetails((current) => current.map((detail) => detail.chat.id === event.chatId ? { ...detail, chat: event.chat! } : detail));
    });
    const unsubscribeSettings = buildwarden.onAppSettingsChanged?.(() => { void loadChats(); });
    return () => { invalidateLoads(); unsubscribe?.(); unsubscribeSettings?.(); };
  }, [buildwarden, loadChats, invalidateLoads]);

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
    if ((!prompt && newChatFiles.length === 0) || loading || readOnly || draft.blocked) return;
    const selectedModel = modelOptions.find((option) => option.id === selectedModelId);
    if (!selectedModel) return;
    const releaseSubmission = draft.beginSubmission();
    if (!releaseSubmission) return;
    setSubmissionError(null);
    try {
      const attachments = newChatFiles.length > 0 ? await readFilesAsChatPayloads(newChatFiles) : undefined;
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
      draft.clearSubmitted(draft);
      void loadChats();
    } catch (caught) {
      setSubmissionError(caught instanceof Error ? caught.message : "Could not start chat. Your draft has been kept.");
    } finally {
      releaseSubmission();
    }
  };

  return (
    <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-7xl flex-1 flex-col gap-3">
      <InstanceTargetSelector purpose="New chats on" />
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
          <><ComposerDraftStatus draft={draft} />{submissionError ? <p role="alert" className="px-3 text-xs text-[var(--ec-muted)]">{submissionError}</p> : null}
            <ChatAttachmentPicker variant="footer" files={newChatFiles} onChange={setNewChatFiles} disabled={loading || submitting || draft.loading || draft.readOnly} /></>
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
        busy={loading || submitting}
        readOnly={draft.readOnly}
        onSubmit={() => void handleNewChat()}
        submitLabel="Start chat"
        submitIcon={<ArrowUp />}
        placeholder="What would you like to talk about?"
        autoFocus
        dropdownSide="bottom"
        submitShortcut={submitShortcut}
        attachmentInputDisabled={draft.loading}
        onAddAttachmentFiles={(incoming) => setNewChatFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
        submitDisabled={(!newChatPrompt.trim() && newChatFiles.length === 0) || loading || submitting || draft.blocked || !selectedModelId || !hasChatModels}
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
