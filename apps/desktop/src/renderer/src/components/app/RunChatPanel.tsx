import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  RUN_CHAT_CONTEXT_SOURCE,
  type ChatAttachmentPayload,
  type ChatDetail,
  type KeyboardShortcutId,
  type ProviderType,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import { ArrowUp, MessagesSquare } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ChatTranscript } from "./ChatTranscript";
import { RunComposer } from "./RunComposer";

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
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("medium");
  const [selectedAnthropicEffort, setSelectedAnthropicEffort] = useState("medium");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatIdRef = useRef<string | null>(null);

  const buildwarden = window.buildwarden;

  chatIdRef.current = detail?.chat.id ?? null;

  const isChatActive = detail ? ["queued", "preparing", "running"].includes(detail.chat.status) : false;

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, selectedModelId]);

  const loadRunChat = useCallback(async () => {
    const next = await buildwarden.getRunChat(runId);
    setDetail(next);
  }, [buildwarden, runId]);

  useEffect(() => {
    setDetail(null);
    void loadRunChat();
  }, [loadRunChat]);

  useEffect(() => {
    const unsubscribe = buildwarden.onChatEvent((event) => {
      if (event.chatId !== chatIdRef.current) return;
      void loadRunChat();
    });
    return unsubscribe;
  }, [buildwarden, loadRunChat]);

  const steps = useMemo(() => detail?.steps ?? [], [detail]);

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
      const chat = await buildwarden.createRunChat(runId, {
        prompt: trimmed,
        modelId: selectedModelId,
        attachments,
        reasoningEffort: selectedReasoningEffort,
        anthropicEffort: selectedAnthropicEffort,
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
          contextHistoryText={contextHistoryText}
          contextAttachmentFiles={files}
          reasoningEffort={selectedReasoningEffort}
          anthropicEffort={selectedAnthropicEffort}
          onReasoningEffortChange={setSelectedReasoningEffort}
          onAnthropicEffortChange={setSelectedAnthropicEffort}
          dropdownSide="top"
          dense
        />
      </div>
    </div>
  );
};
