import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  type ChatAttachmentPayload,
  type ChatDetail,
  type FollowUpDelivery,
  type KeyboardShortcutId,
  type ModelExecutionProfile,
  type ModelRecord,
  type ProviderExecutionOptions,
} from "@buildwarden/shared";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { isVisibleChatStep } from "../../lib/chat-transcript";
import { ChatTranscript } from "./ChatTranscript";
import { DetailHeader, RelativeTime } from "./DetailHeader";
import { promptTitle } from "./run-summary-format";
import { RunComposer } from "./RunComposer";
import { ScrollBoundaryControls } from "./ScrollBoundaryControls";
import { Button } from "../ui/button";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { buildRunReasoningInput } from "./app-model";
import { formatTokenCount } from "./usage-analytics";
import { useComposerDraft } from "../../lib/use-composer-draft";
import { ComposerDraftStatus } from "./ComposerDraftStatus";
import { FollowUpQueuePanel } from "./FollowUpQueuePanel";
import { useChatFollowUpQueue } from "../../lib/use-chat-follow-up-queue";

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
  error?: string | null;
  modelOptions: Array<{
    id: string;
    label: string;
    modelId: string;
    providerType: import("@buildwarden/shared").ProviderType;
    providerFamily: import("@buildwarden/shared").UnifiedProviderFamily | null;
    executionProfile?: ModelExecutionProfile;
  }>;
  /** Full model list, including disabled models that `modelOptions` omits, so existing chats keep their model label. */
  models: ModelRecord[];
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
  }) => Promise<void>;
  onCancel: () => void;
  onAddBookmark: () => void | Promise<void>;
  onRemoveBookmark: () => void | Promise<void>;
  onLoadEarlierHistory: () => Promise<void>;
}

const ChatDetailHeader = ({
  chat,
  modelLabel,
  canManageBookmarks,
  isBookmarked,
  onBack,
  onAddBookmark,
  onRemoveBookmark,
}: Pick<ChatDetailPageProps, "isBookmarked" | "onBack" | "onAddBookmark" | "onRemoveBookmark"> & {
  chat: ChatDetail["chat"];
  modelLabel: string | null;
  canManageBookmarks: boolean;
}) => {
  const totalTokens = chat.inputTokens + chat.outputTokens;
  const bookmarkLabel = isBookmarked ? "Remove from bookmarks" : "Add to bookmarks";
  return (
    <DetailHeader
      status={chat.status}
      active={["queued", "preparing", "running"].includes(chat.status)}
      title={promptTitle(chat.prompt, "Untitled chat")}
      titleTooltip={chat.prompt}
      backLabel="Back to chats"
      onBack={onBack}
      meta={[
        modelLabel ? <span className="truncate">{modelLabel}</span> : null,
        totalTokens > 0 ? <span className="shrink-0 tabular-nums">{formatTokenCount(totalTokens)} tokens</span> : null,
        <RelativeTime value={chat.updatedAt} />,
      ]}
      actions={canManageBookmarks ? (
        <button
          type="button"
          className="app-detail-header-action"
          data-pressed={isBookmarked || undefined}
          aria-pressed={isBookmarked}
          onClick={() => void (isBookmarked ? onRemoveBookmark() : onAddBookmark())}
          title={bookmarkLabel}
          aria-label={bookmarkLabel}
        >
          {isBookmarked ? <BookmarkCheck className="h-4 w-4 fill-current" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
        </button>
      ) : null}
    />
  );
};

export const ChatDetailPage = ({
  chatDetail,
  error,
  modelOptions,
  models,
  keyboardShortcuts,
  busy,
  isBookmarked,
  onBack,
  onFollowUp,
  onCancel,
  onAddBookmark,
  onRemoveBookmark,
  onLoadEarlierHistory,
}: ChatDetailPageProps) => {
  const detail = chatDetail;
  const { chat, steps } = detail;
  const draft = useComposerDraft("chat", chat.id);
  const { prompt: followUpPrompt, setPrompt: setFollowUpPrompt, files: followUpFiles, setFiles: setFollowUpFiles } = draft;
  const [submissionError, setSubmissionError] = useState<string | null>(null);
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
  const followUpQueue = useChatFollowUpQueue({
    chatId: chat.id,
    serverQueue: detail.queuedFollowUps,
    active: isChatActive,
    providerType: modelOptions.find((option) => option.id === chat.modelId)?.providerType,
  });

  const loadEarlierHistory = useCallback(async () => {
    const page = detail.historyPage;
    if (!page?.hasMore || !page.beforeCursor || loadingEarlier) return;
    const container = activityContainerRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    suppressNextAutoScrollRef.current = true;
    setLoadingEarlier(true);
    try {
      await onLoadEarlierHistory();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const currentContainer = activityContainerRef.current;
      if (currentContainer) currentContainer.scrollTop = previousTop + (currentContainer.scrollHeight - previousHeight);
    } finally {
      setLoadingEarlier(false);
    }
  }, [detail.historyPage, loadingEarlier, onLoadEarlierHistory]);

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, selectedModelId]);

  const activityEntries = useMemo(() => {
    return steps
      .map((step) => ({
        step,
        metadata: safeParseMetadata(step.metadataJson),
      }))
      .filter(({ step, metadata }) => isVisibleChatStep(step, metadata));
  }, [steps]);
  const activityScrollKey = useMemo(
    () =>
      activityEntries
        .map(({ step }) => `${step.id}:${step.title}:${step.content.length}:${step.metadataJson.length}`)
        .join("|"),
    [activityEntries],
  );
  const chatModelLabel = modelOptions.find((option) => option.id === chat.modelId)?.label
    ?? models.find((model) => model.id === chat.modelId)?.displayName
    ?? null;
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
  }, [activityScrollKey, isChatActive, loadingEarlier]);

  useEffect(() => {
    setSelectedReasoningEffort(latestUserMessageOptions.reasoningEffort);
    setSelectedAnthropicEffort(latestUserMessageOptions.anthropicEffort);
    setSelectedExecutionMode(latestUserMessageOptions.executionMode);
  }, [latestUserMessageOptions.anthropicEffort, latestUserMessageOptions.executionMode, latestUserMessageOptions.reasoningEffort]);

  const handleSubmit = async (delivery: FollowUpDelivery = followUpQueue.primaryDelivery) => {
    const prompt = followUpPrompt.trim();
    if ((!prompt && followUpFiles.length === 0) || busy || readOnly || draft.blocked || draft.submitting) return;
    const selectedModel = modelOptions.find((option) => option.id === selectedModelId);
    if (!selectedModel) return;
    const submittedFiles = followUpFiles;
    const releaseSubmission = draft.beginSubmission();
    if (!releaseSubmission) return;
    setSubmissionError(null);
    try {
      const attachments = submittedFiles.length > 0 ? await readFilesAsChatPayloads(submittedFiles) : undefined;
      const input = {
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
      };
      if (followUpQueue.queues) {
        const { prompt: queuedPrompt, ...options } = input;
        await followUpQueue.queueFollowUp(queuedPrompt, options, delivery);
      } else {
        await onFollowUp(input);
      }
      draft.clearSubmitted(draft);
    } catch (caught) {
      setSubmissionError(caught instanceof Error ? caught.message : "Could not send message. Your draft has been kept.");
    } finally {
      releaseSubmission();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? <p role="alert" className="text-sm text-[var(--ec-muted)]">{error}</p> : null}
      {submissionError ? <p role="alert" className="text-sm text-[var(--ec-muted)]">{submissionError}</p> : null}
      <ChatDetailHeader
        chat={chat}
        modelLabel={chatModelLabel}
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
            chatId={chat.id}
            active={["queued", "preparing", "running"].includes(chat.status)}
            readOnly={readOnly}
            ref={activityContainerRef}
            endRef={activityEndRef}
            className="app-scrollbar h-full min-h-0 overflow-auto py-1 pr-10"
            items={activityEntries.map(({ step }) => step)}
            emptyMessage="No messages yet."
            showLoading={isChatActive}
          />
          <ScrollBoundaryControls key={chat.id} scrollElementRef={activityContainerRef} />
        </div>
      </div>
      {followUpQueue.queue.length > 0 || followUpQueue.notice ? (
        <FollowUpQueuePanel
          queue={followUpQueue.queue}
          active={isChatActive}
          steeringAvailable={followUpQueue.steeringAvailable}
          readOnly={readOnly}
          busy={busy}
          notice={followUpQueue.notice}
          onDismissNotice={() => followUpQueue.setNotice(null)}
          modelLabel={(modelId) => modelId === chat.modelId ? null : modelOptions.find((option) => option.id === modelId)?.label ?? null}
          onAction={followUpQueue.updateQueue}
        />
      ) : null}
      {!readOnly ? <RunComposer
        variant="chat"
        attachments={
          <><ComposerDraftStatus draft={draft} />
          <ChatAttachmentPicker
            variant="footer"
            files={followUpFiles}
            onChange={setFollowUpFiles}
            disabled={busy || draft.submitting || draft.loading || draft.readOnly}
          />
          </>
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
        busy={busy || draft.submitting}
        readOnly={draft.readOnly}
        isRunActive={isChatActive}
        allowInputWhileActive
        activeDelivery={followUpQueue.primaryDelivery}
        onAlternateSubmit={followUpQueue.steeringAvailable ? () => void handleSubmit(followUpQueue.alternateDelivery) : undefined}
        alternateShortcut={keyboardShortcuts.alternateFollowUpDelivery}
        onCancel={onCancel}
        onSubmit={() => void handleSubmit()}
        submitLabel="Send"
        placeholder="Send a follow-up... (optional if you attach files)"
        submitShortcut={keyboardShortcuts.submitComposer}
        attachmentInputDisabled={draft.loading}
        onAddAttachmentFiles={(incoming) => setFollowUpFiles((prev) => appendChatAttachmentFiles(prev, incoming))}
        submitDisabled={busy || draft.submitting || draft.blocked || !selectedModelId || (!followUpPrompt.trim() && followUpFiles.length === 0)}
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
