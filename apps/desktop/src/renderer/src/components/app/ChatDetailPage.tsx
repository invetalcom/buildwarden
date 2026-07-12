import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  type ChatAttachmentPayload,
  type ChatDetail,
  type KeyboardShortcutId,
} from "@buildwarden/shared";
import { ArrowUp, Bookmark, BookmarkCheck } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ChatTranscript } from "./ChatTranscript";
import { RunComposer } from "./RunComposer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const getLatestUserMessageOptions = (steps: ChatDetail["steps"]) => {
  const latestUserStep = [...steps].reverse().find((step) => safeParseMetadata(step.metadataJson).source === "user");
  const metadata = latestUserStep ? safeParseMetadata(latestUserStep.metadataJson) : {};
  return {
    reasoningEffort: typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : "medium",
    anthropicEffort: typeof metadata.anthropicEffort === "string" ? metadata.anthropicEffort : "medium",
  };
};

interface ChatDetailPageProps {
  chatDetail: ChatDetail;
  modelOptions: Array<{
    id: string;
    label: string;
    modelId: string;
    providerType: import("@buildwarden/shared").ProviderType;
    providerFamily: import("@buildwarden/shared").UnifiedProviderFamily | null;
  }>;
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
  busy: boolean;
  isBookmarked: boolean;
  onBack: () => void;
  onFollowUp: (input: {
    prompt: string;
    modelId?: string;
    attachments?: ChatAttachmentPayload[];
    reasoningEffort?: string;
    anthropicEffort?: string;
  }) => void | Promise<void>;
  onCancel: () => void;
  onAddBookmark: () => void | Promise<void>;
  onRemoveBookmark: () => void | Promise<void>;
}

const ChatDetailHeader = ({
  chat,
  isBookmarked,
  onBack,
  onAddBookmark,
  onRemoveBookmark,
}: Pick<ChatDetailPageProps, "isBookmarked" | "onBack" | "onAddBookmark" | "onRemoveBookmark"> & { chat: ChatDetail["chat"] }) => (
  <Card className="app-surface-chat-hero overflow-hidden border px-4 py-3">
    <div className="flex min-w-0 items-center gap-3">
      <button type="button" className="shrink-0 text-[11px] uppercase tracking-[0.28em] text-cyan-400 transition hover:text-cyan-300" onClick={onBack}>
        &larr; Back to chats
      </button>
      <Badge dot tone={chat.status} className="shrink-0">{chat.status}</Badge>
      <span className="truncate text-xs text-zinc-500">{new Date(chat.updatedAt).toLocaleString()}</span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-8 w-8 shrink-0 p-0 text-zinc-400 hover:text-cyan-300"
        onClick={() => void (isBookmarked ? onRemoveBookmark() : onAddBookmark())}
        title={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
        aria-label={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
      >
        {isBookmarked ? <BookmarkCheck className="h-3.5 w-3.5 fill-current" /> : <Bookmark className="h-3.5 w-3.5" />}
      </Button>
    </div>
  </Card>
);

export const ChatDetailPage = ({
  chatDetail,
  modelOptions,
  keyboardShortcuts,
  busy,
  isBookmarked,
  onBack,
  onFollowUp,
  onCancel,
  onAddBookmark,
  onRemoveBookmark,
}: ChatDetailPageProps) => {
  const [detail, setDetail] = useState<ChatDetail>(chatDetail);
  const { chat, steps } = detail;
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpFiles, setFollowUpFiles] = useState<File[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(chat.modelId);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("medium");
  const [selectedAnthropicEffort, setSelectedAnthropicEffort] = useState("medium");
  const activityContainerRef = useRef<HTMLDivElement>(null);
  const activityEndRef = useRef<HTMLDivElement>(null);

  const buildwarden = window.buildwarden;

  const isChatActive = ["queued", "preparing", "running"].includes(chat.status);

  /** True after a non-`reasoning` output for this turn (same notion as the green assistant messages below). */
  const hasMainAssistantOutputAfterLatestUser = useMemo(() => {
    let lastUserIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (safeParseMetadata(steps[i]!.metadataJson).source === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) {
      return false;
    }
    for (let j = lastUserIndex + 1; j < steps.length; j++) {
      const step = steps[j]!;
      if (step.eventType !== "output" || !step.content.trim()) {
        continue;
      }
      const meta = safeParseMetadata(step.metadataJson);
      if (meta.assistantKind !== "reasoning") {
        return true;
      }
    }
    return false;
  }, [steps]);

  const showPreResponseLoading = isChatActive && !hasMainAssistantOutputAfterLatestUser;

  const loadChatDetail = useCallback(async () => {
    if (!buildwarden) return;
    const d = await buildwarden.getChatDetail(chat.id);
    setDetail(d);
  }, [buildwarden, chat.id]);

  useEffect(() => {
    setDetail(chatDetail);
  }, [chatDetail]);

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, selectedModelId]);

  useEffect(() => {
    if (!buildwarden) return;
    const unsubscribe = buildwarden.onChatEvent((event) => {
      if (event.chatId !== chat.id) return;
      void loadChatDetail();
    });
    return unsubscribe;
  }, [buildwarden, chat.id, loadChatDetail]);

  useEffect(() => {
    void loadChatDetail();
  }, [loadChatDetail]);

  const activityEntries = useMemo(() => {
    return steps
      .map((step) => ({
        step,
        metadata: safeParseMetadata(step.metadataJson),
      }))
      .filter(({ step }) => {
        const isEmpty = !step.content?.trim();
        const isAgentOutputTitle = step.title === "Agent output";
        if (isEmpty && (step.eventType === "output" || isAgentOutputTitle)) return false;
        if (isAgentOutputTitle && step.eventType === "status") return false;
        return true;
      });
  }, [steps]);
  const activityScrollKey = useMemo(
    () =>
      activityEntries
        .map(({ step }) => `${step.id}:${step.title}:${step.content.length}:${step.metadataJson.length}`)
        .join("|"),
    [activityEntries],
  );
  const latestUserMessageOptions = useMemo(() => getLatestUserMessageOptions(steps), [steps]);
  const contextHistoryText = useMemo(() => buildVisibleConversationHistory(steps), [steps]);

  useEffect(() => {
    const container = activityContainerRef.current;
    const end = activityEndRef.current;
    if (!container || !end) {
      return;
    }
    end.scrollIntoView({ block: "end" });
  }, [activityScrollKey, isChatActive, hasMainAssistantOutputAfterLatestUser]);

  useEffect(() => {
    setSelectedReasoningEffort(latestUserMessageOptions.reasoningEffort);
    setSelectedAnthropicEffort(latestUserMessageOptions.anthropicEffort);
  }, [latestUserMessageOptions.anthropicEffort, latestUserMessageOptions.reasoningEffort]);

  const handleSubmit = async () => {
    const prompt = followUpPrompt.trim();
    if ((!prompt && followUpFiles.length === 0) || busy || isChatActive) return;
    let attachments: ChatAttachmentPayload[] | undefined;
    try {
      attachments = followUpFiles.length > 0 ? await readFilesAsChatPayloads(followUpFiles) : undefined;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not read attachments.");
      return;
    }
    void onFollowUp({
      prompt,
      modelId: selectedModelId !== chat.modelId ? selectedModelId : undefined,
      attachments,
      reasoningEffort: selectedReasoningEffort,
      anthropicEffort: selectedAnthropicEffort,
    });
    setFollowUpPrompt("");
    setFollowUpFiles([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <ChatDetailHeader
        chat={chat}
        isBookmarked={isBookmarked}
        onBack={onBack}
        onAddBookmark={onAddBookmark}
        onRemoveBookmark={onRemoveBookmark}
      />

      <ChatTranscript
        ref={activityContainerRef}
        endRef={activityEndRef}
        className="app-scrollbar min-h-0 flex-1 overflow-auto px-0 py-1"
        items={activityEntries.map(({ step }) => step)}
        emptyMessage="No messages yet."
        showLoading={showPreResponseLoading}
      />
      <RunComposer
        variant="chat"
        attachments={
          <ChatAttachmentPicker
            variant="footer"
            files={followUpFiles}
            onChange={setFollowUpFiles}
            disabled={busy || isChatActive}
          />
        }
        prompt={followUpPrompt}
        onPromptChange={setFollowUpPrompt}
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
        busy={busy}
        isRunActive={isChatActive}
        onCancel={onCancel}
        onSubmit={() => void handleSubmit()}
        submitLabel="Send"
        submitIcon={<ArrowUp className="ml-1 h-3.5 w-3.5" />}
        placeholder="Send a follow-up... (optional if you attach files)"
        submitShortcut={keyboardShortcuts.submitComposer}
        onAddAttachmentFiles={(incoming) => setFollowUpFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
        contextHistoryText={contextHistoryText}
        contextAttachmentFiles={followUpFiles}
        reasoningEffort={selectedReasoningEffort}
        anthropicEffort={selectedAnthropicEffort}
        onReasoningEffortChange={setSelectedReasoningEffort}
        onAnthropicEffortChange={setSelectedAnthropicEffort}
        dense
      />
    </div>
  );
};
