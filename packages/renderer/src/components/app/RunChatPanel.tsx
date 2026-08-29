import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  RUN_CHAT_CONTEXT_SOURCE,
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatEvent,
  type KeyboardShortcutId,
  type ModelExecutionProfile,
  type ProviderExecutionOptions,
  type ProviderType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import { ArrowUp, MessagesSquare } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ChatTranscript } from "./ChatTranscript";
import { RunComposer } from "./RunComposer";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { buildRunReasoningInput } from "./app-model";
import { applyLiveChatEventToDetail } from "../../lib/live-state";

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

interface RunChatPanelModelOption {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
  executionProfile?: ModelExecutionProfile;
}

interface RunChatPanelProps {
  runId: string;
  /** Model preselected for the first message; falls back to the first option. */
  defaultModelId: string;
  modelOptions: RunChatPanelModelOption[];
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
}

/**
 * Run-scoped Q&A chat rendered as a secondary panel in the run detail view.
 * Reuses the standalone chat pipeline; the chat is created lazily on first send
 * and seeded with the run's output + diff in a hidden context step.
 */
export const RunChatPanel = ({ runId, defaultModelId, modelOptions, keyboardShortcuts }: RunChatPanelProps) => {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("auto");
  const [selectedAnthropicEffort, setSelectedAnthropicEffort] = useState("auto");
  const [selectedExecutionMode, setSelectedExecutionMode] = useState("auto");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatIdRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const activeLoadRequestRef = useRef<number | null>(null);
  const liveEventRevisionRef = useRef(0);
  const recentLiveEventsRef = useRef<Array<{ revision: number; event: ChatEvent }>>([]);

  const buildwarden = useBuildWardenClient();

  chatIdRef.current = detail?.chat.id ?? null;

  const isChatActive = detail ? ["queued", "preparing", "running"].includes(detail.chat.status) : false;

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, selectedModelId]);

  const loadRunChat = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    activeLoadRequestRef.current = requestId;
    const revisionAtStart = liveEventRevisionRef.current;
    try {
      let next = await buildwarden.getRunChat(runId);
      if (loadRequestRef.current !== requestId) return;
      const sawRunChatCreation = next === null && recentLiveEventsRef.current.some(({ revision, event }) =>
        revision > revisionAtStart && event.chat?.runId === runId);
      if (sawRunChatCreation) {
        // The first response raced creation on another client. Keep the request active so any
        // subsequent events remain buffered, then perform one authoritative follow-up read.
        next = await buildwarden.getRunChat(runId);
        if (loadRequestRef.current !== requestId) return;
      }
      const revisionAtCompletion = liveEventRevisionRef.current;
      const merged = next
        ? recentLiveEventsRef.current
            .filter(({ revision, event }) => revision > revisionAtStart && event.chatId === next.chat.id)
            .reduce((current, { event }) => applyLiveChatEventToDetail(current, event), next)
        : null;
      recentLiveEventsRef.current = recentLiveEventsRef.current.filter(({ revision }) => revision > revisionAtCompletion);
      chatIdRef.current = merged?.chat.id ?? null;
      setDetail(merged);
    } finally {
      if (activeLoadRequestRef.current === requestId) activeLoadRequestRef.current = null;
    }
  }, [buildwarden, runId]);

  useEffect(() => {
    loadRequestRef.current += 1;
    recentLiveEventsRef.current = [];
    liveEventRevisionRef.current = 0;
    chatIdRef.current = null;
    setDetail(null);
    void loadRunChat();
  }, [loadRunChat]);

  useEffect(() => {
    const unsubscribe = buildwarden.onChatEvent((event) => {
      const revision = ++liveEventRevisionRef.current;
      if (activeLoadRequestRef.current !== null) recentLiveEventsRef.current.push({ revision, event });
      const currentChatId = chatIdRef.current;
      if (!currentChatId || event.chatId !== currentChatId) return;
      if (event.step || event.chat) {
        setDetail((current) => current?.chat.id === event.chatId ? applyLiveChatEventToDetail(current, event) : current);
      }
      if (!event.step) void loadRunChat();
    });
    return unsubscribe;
  }, [buildwarden, loadRunChat]);

  const steps = useMemo(() => detail?.steps ?? [], [detail]);

  const latestUserMessageOptions = useMemo(() => {
    const latestUserStep = [...steps].reverse().find((step) => safeParseMetadata(step.metadataJson).source === "user");
    if (!latestUserStep) return null;
    const metadata = safeParseMetadata(latestUserStep.metadataJson);
    const executionOptions = metadata.executionOptions && typeof metadata.executionOptions === "object" && !Array.isArray(metadata.executionOptions)
      ? metadata.executionOptions as ProviderExecutionOptions
      : undefined;
    return {
      reasoningEffort: typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : executionOptions?.reasoningEffort ?? "auto",
      anthropicEffort: typeof metadata.anthropicEffort === "string" ? metadata.anthropicEffort : executionOptions?.anthropicEffort ?? "auto",
      executionMode: executionOptions?.serviceTier ?? executionOptions?.speed ?? executionOptions?.contextMode ?? executionOptions?.workflowMode ?? "auto",
    };
  }, [steps]);
  const latestReasoningEffort = latestUserMessageOptions?.reasoningEffort;
  const latestAnthropicEffort = latestUserMessageOptions?.anthropicEffort;
  const latestExecutionMode = latestUserMessageOptions?.executionMode;

  useEffect(() => {
    if (latestReasoningEffort === undefined || latestAnthropicEffort === undefined || latestExecutionMode === undefined) return;
    setSelectedReasoningEffort(latestReasoningEffort);
    setSelectedAnthropicEffort(latestAnthropicEffort);
    setSelectedExecutionMode(latestExecutionMode);
  }, [latestAnthropicEffort, latestExecutionMode, latestReasoningEffort]);

  const visibleSteps = useMemo(
    () => steps.filter((step) => safeParseMetadata(step.metadataJson).source !== RUN_CHAT_CONTEXT_SOURCE),
    [steps],
  );

  /** True after a non-`reasoning` output for this turn (same notion as ChatDetailPage). */
  const hasMainAssistantOutputAfterLatestUser = useMemo(() => {
    let lastUserIndex = -1;
    for (let i = visibleSteps.length - 1; i >= 0; i--) {
      if (safeParseMetadata(visibleSteps[i]!.metadataJson).source === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) {
      return false;
    }
    for (let j = lastUserIndex + 1; j < visibleSteps.length; j++) {
      const step = visibleSteps[j]!;
      if (step.eventType !== "output" || !step.content.trim()) {
        continue;
      }
      if (safeParseMetadata(step.metadataJson).assistantKind !== "reasoning") {
        return true;
      }
    }
    return false;
  }, [visibleSteps]);

  const showPreResponseLoading = isChatActive && !hasMainAssistantOutputAfterLatestUser;

  const transcriptScrollKey = useMemo(
    () =>
      visibleSteps
        .map((step) => `${step.id}:${step.title}:${step.content.length}:${step.metadataJson.length}`)
        .join("|"),
    [visibleSteps],
  );

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcriptScrollKey, isChatActive, hasMainAssistantOutputAfterLatestUser]);

  const contextHistoryText = useMemo(() => buildVisibleConversationHistory(steps), [steps]);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if ((!trimmed && files.length === 0) || sending || isChatActive) return;
    let attachments: ChatAttachmentPayload[] | undefined;
    try {
      attachments = files.length > 0 ? await readFilesAsChatPayloads(files) : undefined;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not read attachments.");
      return;
    }
    setSending(true);
    try {
      const selectedModel = modelOptions.find((option) => option.id === selectedModelId);
      if (!selectedModel) throw new Error("Select a configured model.");
      const chat = await buildwarden.createRunChat(runId, {
        prompt: trimmed,
        modelId: selectedModelId,
        attachments,
        ...buildRunReasoningInput(
          selectedModel.providerType,
          selectedModel.providerFamily,
          selectedReasoningEffort,
          selectedAnthropicEffort,
          selectedModel.executionProfile,
          selectedExecutionMode,
        ),
      });
      chatIdRef.current = chat.id;
      setPrompt("");
      setFiles([]);
      await loadRunChat();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  };

  const handleCancel = () => {
    const chatId = chatIdRef.current;
    if (!chatId) return;
    void buildwarden
      .cancelChat(chatId)
      .then(() => loadRunChat())
      .catch((e) => {
        window.alert(e instanceof Error ? e.message : "Could not cancel the chat.");
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {visibleSteps.length === 0 && !showPreResponseLoading ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
          <MessagesSquare className="h-8 w-8 text-zinc-700" aria-hidden />
          <p className="text-sm font-medium text-zinc-400">Ask about this run</p>
          <p className="max-w-sm text-xs text-zinc-600">
            Questions about the agent&apos;s output or code changes — the run context and diff are attached
            automatically. This chat stays with the run and has no tools.
          </p>
        </div>
      ) : (
        <ChatTranscript
          ref={transcriptRef}
          endRef={transcriptEndRef}
          className="app-scrollbar min-h-0 flex-1 overflow-auto px-3 py-2"
          items={visibleSteps}
          emptyMessage="No messages yet."
          showLoading={showPreResponseLoading}
        />
      )}
      <div className="shrink-0 border-t border-zinc-800/80 p-2">
        <RunComposer
          variant="chat"
          attachments={
            <ChatAttachmentPicker
              variant="footer"
              files={files}
              onChange={setFiles}
              disabled={sending || isChatActive}
            />
          }
          prompt={prompt}
          onPromptChange={setPrompt}
          selectedMode="ask"
          onModeChange={() => {}}
          selectedModelId={selectedModelId}
          onModelChange={setSelectedModelId}
          modelOptions={modelOptions.map((option) => ({
            value: option.id,
            label: option.label,
            contextModelId: option.modelId,
            providerType: option.providerType,
            providerFamily: option.providerFamily,
            executionProfile: option.executionProfile,
          }))}
          busy={sending}
          isRunActive={isChatActive}
          onCancel={handleCancel}
          onSubmit={() => void handleSubmit()}
          submitLabel="Send"
          submitIcon={<ArrowUp className="ml-1 h-3.5 w-3.5" />}
          placeholder="Ask about the output or changes…"
          submitShortcut={keyboardShortcuts.submitComposer}
          onAddAttachmentFiles={(incoming) => setFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
          submitDisabled={sending || isChatActive || !selectedModelId || (!prompt.trim() && files.length === 0)}
          contextHistoryText={contextHistoryText}
          contextAttachmentFiles={files}
          reasoningEffort={selectedReasoningEffort}
          anthropicEffort={selectedAnthropicEffort}
          onReasoningEffortChange={setSelectedReasoningEffort}
          onAnthropicEffortChange={setSelectedAnthropicEffort}
          executionMode={selectedExecutionMode}
          onExecutionModeChange={setSelectedExecutionMode}
          dropdownSide="top"
          dense
        />
      </div>
    </div>
  );
};
