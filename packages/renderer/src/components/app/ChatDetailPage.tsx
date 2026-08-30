import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  type ChatAttachmentPayload,
  type ChatDetail,
  type KeyboardShortcutId,
  type ModelExecutionProfile,
  type ProviderExecutionOptions,
} from "@buildwarden/shared";
import { ArrowUp, Bookmark, BookmarkCheck } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { ChatTranscript } from "./ChatTranscript";
import { RunComposer } from "./RunComposer";
import { ScrollBoundaryControls } from "./ScrollBoundaryControls";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { buildRunReasoningInput } from "./app-model";
import { applyLiveChatEventToDetail, mergeOrderedRecords } from "../../lib/live-state";

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
  const executionOptions = metadata.executionOptions && typeof metadata.executionOptions === "object" && !Array.isArray(metadata.executionOptions)
    ? metadata.executionOptions as ProviderExecutionOptions
    : undefined;
  return {
    reasoningEffort: typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : executionOptions?.reasoningEffort ?? "auto",
    anthropicEffort: typeof metadata.anthropicEffort === "string" ? metadata.anthropicEffort : executionOptions?.anthropicEffort ?? "auto",
    executionMode: executionOptions?.serviceTier ?? executionOptions?.speed ?? executionOptions?.contextMode ?? executionOptions?.workflowMode ?? "auto",
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
    executionProfile?: ModelExecutionProfile;
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
    executionOptions?: ProviderExecutionOptions;
  }) => void | Promise<void>;
  onCancel: () => void;
  onAddBookmark: () => void | Promise<void>;
  onRemoveBookmark: () => void | Promise<void>;
}

const ChatDetailHeader = ({
  chat,
  canManageBookmarks,
  isBookmarked,
  onBack,
  onAddBookmark,
  onRemoveBookmark,
}: Pick<ChatDetailPageProps, "isBookmarked" | "onBack" | "onAddBookmark" | "onRemoveBookmark"> & { chat: ChatDetail["chat"]; canManageBookmarks: boolean }) => (
  <Card className="app-surface-chat-hero overflow-hidden border px-4 py-3">
    <div className="flex min-w-0 items-center gap-3">
      <button type="button" className="shrink-0 text-[11px] uppercase tracking-[0.28em] text-[var(--ec-accent)] transition hover:text-[var(--ec-accent-strong)]" onClick={onBack}>
        &larr; Back to chats
      </button>
      <Badge dot tone={chat.status} className="shrink-0">{chat.status}</Badge>
      <span className="truncate text-xs text-[var(--ec-muted)]">{new Date(chat.updatedAt).toLocaleString()}</span>
      {canManageBookmarks ? <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-8 w-8 shrink-0 p-0 text-[var(--ec-muted)] hover:text-[var(--ec-accent-strong)]"
        onClick={() => void (isBookmarked ? onRemoveBookmark() : onAddBookmark())}
        title={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
        aria-label={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
      >
        {isBookmarked ? <BookmarkCheck className="h-3.5 w-3.5 fill-current" /> : <Bookmark className="h-3.5 w-3.5" />}
      </Button> : null}
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
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("auto");
  const [selectedAnthropicEffort, setSelectedAnthropicEffort] = useState("auto");
  const [selectedExecutionMode, setSelectedExecutionMode] = useState("auto");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const activityContainerRef = useRef<HTMLDivElement>(null);
  const activityEndRef = useRef<HTMLDivElement>(null);
  const suppressNextAutoScrollRef = useRef(false);

  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.chatMutations;

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
    setDetail((current) => {
      const currentHistoryPage = current.historyPage;
      const historyWasExpanded = current.chat.id === d.chat.id && Boolean(currentHistoryPage &&
        (currentHistoryPage.beforeCursor !== d.historyPage?.beforeCursor || currentHistoryPage.hasMore === false));
      return historyWasExpanded
        ? { ...d, steps: mergeOrderedRecords(d.steps, current.steps), historyPage: current.historyPage }
        : d;
    });
  }, [buildwarden, chat.id]);

  useEffect(() => {
    setDetail((current) => {
      const currentHistoryPage = current.historyPage;
      const historyWasExpanded = current.chat.id === chatDetail.chat.id && Boolean(currentHistoryPage &&
        (currentHistoryPage.beforeCursor !== chatDetail.historyPage?.beforeCursor || currentHistoryPage.hasMore === false));
      return historyWasExpanded
        ? { ...chatDetail, steps: mergeOrderedRecords(chatDetail.steps, current.steps), historyPage: current.historyPage }
        : chatDetail;
    });
  }, [chatDetail]);

  const loadEarlierHistory = useCallback(async () => {
    const page = detail.historyPage;
    if (!page?.hasMore || !page.beforeCursor || loadingEarlier) return;
    const container = activityContainerRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    const request = { beforeCursor: page.beforeCursor, snapshotRevision: page.snapshotRevision };
    suppressNextAutoScrollRef.current = true;
    setLoadingEarlier(true);
    try {
      const result = await buildwarden.getEarlierChatHistory(chat.id, request);
      if (result.stale) {
        await loadChatDetail();
        return;
      }
      setDetail((current) => current.historyPage?.beforeCursor === request.beforeCursor
        ? { ...current, steps: mergeOrderedRecords(result.steps, current.steps), historyPage: result.page }
        : current);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const currentContainer = activityContainerRef.current;
      if (currentContainer) currentContainer.scrollTop = previousTop + (currentContainer.scrollHeight - previousHeight);
    } finally {
      setLoadingEarlier(false);
    }
  }, [buildwarden, chat.id, detail.historyPage, loadChatDetail, loadingEarlier]);

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
      if (event.step || event.chat) {
        setDetail((current) => applyLiveChatEventToDetail(current, event));
      }
      if (!event.step) void loadChatDetail();
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
    if (loadingEarlier) return;
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    const container = activityContainerRef.current;
    const end = activityEndRef.current;
    if (!container || !end) {
      return;
    }
    end.scrollIntoView({ block: "end" });
  }, [activityScrollKey, isChatActive, hasMainAssistantOutputAfterLatestUser, loadingEarlier]);

  useEffect(() => {
    setSelectedReasoningEffort(latestUserMessageOptions.reasoningEffort);
    setSelectedAnthropicEffort(latestUserMessageOptions.anthropicEffort);
    setSelectedExecutionMode(latestUserMessageOptions.executionMode);
  }, [latestUserMessageOptions.anthropicEffort, latestUserMessageOptions.executionMode, latestUserMessageOptions.reasoningEffort]);

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
    const selectedModel = modelOptions.find((option) => option.id === selectedModelId);
    if (!selectedModel) return;
    void onFollowUp({
      prompt,
      modelId: selectedModelId !== chat.modelId ? selectedModelId : undefined,
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
    setFollowUpPrompt("");
    setFollowUpFiles([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <ChatDetailHeader
        chat={chat}
        canManageBookmarks={buildwarden.capabilities.chatMutations}
        isBookmarked={isBookmarked}
        onBack={onBack}
        onAddBookmark={onAddBookmark}
        onRemoveBookmark={onRemoveBookmark}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        {detail.historyPage?.hasMore && detail.historyPage.beforeCursor ? (
          <div className="flex shrink-0 justify-center border-b border-[var(--ec-border)] py-1">
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => void loadEarlierHistory()} disabled={loadingEarlier}>
              {loadingEarlier ? "Loading earlier turns..." : "Load earlier turns"}
            </Button>
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1">
          <ChatTranscript
            ref={activityContainerRef}
            endRef={activityEndRef}
            className="app-scrollbar h-full min-h-0 overflow-auto py-1 pr-10"
            items={activityEntries.map(({ step }) => step)}
            emptyMessage="No messages yet."
            showLoading={showPreResponseLoading}
          />
          <ScrollBoundaryControls key={chat.id} scrollElementRef={activityContainerRef} />
        </div>
      </div>
      {!readOnly ? <RunComposer
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
          executionProfile: opt.executionProfile,
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
        submitDisabled={busy || isChatActive || !selectedModelId || (!followUpPrompt.trim() && followUpFiles.length === 0)}
        contextHistoryText={contextHistoryText}
        contextAttachmentFiles={followUpFiles}
        reasoningEffort={selectedReasoningEffort}
        anthropicEffort={selectedAnthropicEffort}
        onReasoningEffortChange={setSelectedReasoningEffort}
        onAnthropicEffortChange={setSelectedAnthropicEffort}
        executionMode={selectedExecutionMode}
        onExecutionModeChange={setSelectedExecutionMode}
        dense
      /> : null}
    </div>
  );
};
