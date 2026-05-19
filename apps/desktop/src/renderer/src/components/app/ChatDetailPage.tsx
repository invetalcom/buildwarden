import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendChatAttachmentFiles,
  extractAttachmentNamesFromMetadata,
  extractAttachmentPayloadsFromMetadata,
  type ChatAttachmentPayload,
  type ChatDetail,
  type KeyboardShortcutId,
} from "@easycode/shared";
import { ArrowUp, Bookmark, BookmarkCheck, Check, Copy, Loader2, MessageSquareText, ShieldCheck } from "lucide-react";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { buildVisibleConversationHistory } from "../../lib/context-window-estimate";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { StoredChatAttachments } from "./StoredChatAttachments";
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
    providerType: import("@easycode/shared").ProviderType;
    providerFamily: import("@easycode/shared").UnifiedProviderFamily | null;
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
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const activityContainerRef = useRef<HTMLDivElement>(null);
  const activityEndRef = useRef<HTMLDivElement>(null);

  const handleCopyOutput = useCallback((text: string, stepId: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedStepId(stepId);
      setTimeout(() => setCopiedStepId(null), 1500);
    });
  }, []);
  const easycode = window.easycode;

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
    if (!easycode) return;
    const d = await easycode.getChatDetail(chat.id);
    setDetail(d);
  }, [easycode, chat.id]);

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
    if (!easycode) return;
    const unsubscribe = easycode.onChatEvent((event) => {
      if (event.chatId !== chat.id) return;
      void loadChatDetail();
    });
    return unsubscribe;
  }, [easycode, chat.id, loadChatDetail]);

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
      <Card className="app-surface-chat-hero overflow-hidden border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="shrink-0 text-[11px] uppercase tracking-[0.28em] text-cyan-400 transition hover:text-cyan-300"
            onClick={onBack}
          >
            ← Back to chats
          </button>
          <Badge tone={chat.status} className="shrink-0">
            {chat.status}
          </Badge>
          <span className="truncate text-xs text-zinc-500">{new Date(chat.updatedAt).toLocaleString()}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 w-8 shrink-0 p-0 text-zinc-400 hover:text-cyan-300"
            onClick={() => void (isBookmarked ? onRemoveBookmark() : onAddBookmark())}
            title={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
            aria-label={isBookmarked ? "Remove from bookmarks" : "Add to bookmarks"}
          >
            {isBookmarked ? (
              <BookmarkCheck className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Bookmark className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </Card>

      <div ref={activityContainerRef} className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-auto px-2 py-1">
          {activityEntries.length === 0 && !showPreResponseLoading ? (
            <p className="text-sm text-zinc-500">No messages yet.</p>
          ) : null}
          {activityEntries.length > 0
            ? activityEntries.map(({ step, metadata }) => {
              const isUserEntry = metadata.source === "user";
              const isAssistantEntry = step.eventType === "output" && metadata.assistantKind !== "reasoning";
              const isStatusEntry = step.eventType === "status";
              const isErrorEntry = step.eventType === "error";
              const isRequestEntry =
                step.eventType === "request" ||
                step.eventType === "user-input-requested" ||
                step.eventType === "approval-requested" ||
                step.eventType === "approval-resolved";
              const isPlanEntry = step.eventType === "plan" || step.eventType === "plan-updated";
              const isDiffEntry = step.eventType === "diff-updated";
              const timestamp = new Date(step.createdAt).toLocaleTimeString();

              if (isUserEntry) {
                const attachments = extractAttachmentPayloadsFromMetadata(metadata);
                const attachmentNames = extractAttachmentNamesFromMetadata(metadata);
                return (
                  <div key={step.id} className="ml-auto max-w-[92%] rounded-2xl border border-fuchsia-500/20 bg-fuchsia-500/5 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <Badge tone="queued" className="bg-fuchsia-500/10 text-fuchsia-300 ring-fuchsia-400/30">
                        {metadata.commandType === "follow-up" ? "follow-up" : "user"}
                      </Badge>
                      <span className="text-xs text-zinc-500">{timestamp}</span>
                    </div>
                    <StoredChatAttachments attachments={attachments} fallbackNames={attachmentNames} />
                    <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-200" />
                  </div>
                );
              }

              if (isRequestEntry) {
                const requestKind =
                  typeof metadata.requestKind === "string"
                    ? metadata.requestKind
                    : step.eventType.startsWith("approval")
                      ? "approval"
                      : "user-input";
                return (
                  <div key={step.id} className="rounded-xl border border-violet-500/25 bg-violet-500/[0.06] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <MessageSquareText className="h-4 w-4 shrink-0 text-violet-300" />
                        <p className="truncate text-sm font-medium text-violet-100">{step.title}</p>
                        <Badge tone="queued" className="bg-violet-500/10 text-violet-200 ring-violet-400/30">
                          {requestKind}
                        </Badge>
                      </div>
                      <span className="text-[11px] text-violet-200/70">{timestamp}</span>
                    </div>
                    <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-200" />
                  </div>
                );
              }

              if (isPlanEntry) {
                return (
                  <div key={step.id} className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.055] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
                        <p className="truncate text-sm font-medium text-emerald-100">{step.title}</p>
                      </div>
                      <span className="text-[11px] text-emerald-200/70">{timestamp}</span>
                    </div>
                    <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-200" />
                  </div>
                );
              }

              if (isDiffEntry) {
                return (
                  <div key={step.id} className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium text-cyan-100">{step.title}</p>
                      <span className="text-[11px] text-cyan-200/70">{timestamp}</span>
                    </div>
                    <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-200" />
                  </div>
                );
              }

              if (isStatusEntry) {
                return (
                  <div key={step.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
                    <p className="truncate text-xs font-medium text-zinc-400">{step.title}</p>
                    <span className="text-[11px] text-zinc-600">{timestamp}</span>
                  </div>
                );
              }

              if (isErrorEntry) {
                return (
                  <div key={step.id} className="rounded-2xl border border-rose-500/25 bg-rose-500/5 p-3">
                    <p className="text-sm font-medium text-rose-200">{step.title}</p>
                    <pre className="app-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">
                      {step.content}
                    </pre>
                  </div>
                );
              }

              if (isAssistantEntry) {
                const copied = copiedStepId === step.id;
                return (
                  <div
                    key={step.id}
                    className="max-w-[92%] rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Badge tone="running">assistant</Badge>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0 text-zinc-400 hover:text-cyan-300"
                          onClick={() => handleCopyOutput(step.content, step.id)}
                          title={copied ? "Copied" : "Copy output"}
                        >
                          {copied ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <span className="text-xs text-zinc-500">{timestamp}</span>
                      </div>
                    </div>
                    <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-200" />
                  </div>
                );
              }

              return (
                <div key={step.id} className="rounded-xl border border-zinc-800/70 bg-zinc-950/45 px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-zinc-200">{step.title}</p>
                  <ActivityMarkdownOrGitDiff content={step.content} className="mt-2 text-zinc-300" />
                </div>
              );
            })
            : null}
          {showPreResponseLoading ? (
            <div className="rounded-lg border border-cyan-500/10 bg-zinc-950/40 px-2 py-2">
              <div className="run-activity-loading-bar mb-2" />
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400/90" aria-hidden />
                <span className="animate-pulse">Model is working…</span>
              </div>
            </div>
          ) : null}
          <div ref={activityEndRef} />
      </div>

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
        placeholder="Send a follow-up… (optional if you attach files)"
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
