import { useMemo } from "react";
import { extractAttachmentNamesFromMetadata, extractAttachmentPayloadsFromMetadata, type BookmarkRecord, type BookmarkStepRecord, type ModelRecord } from "@easycode/shared";
import { MessageSquareText } from "lucide-react";
import { bookmarkModelDisplay } from "../../lib/bookmark-model";
import { ActivityMarkdownOrGitDiff } from "./activity-message-body";
import { GitDiffPreview } from "./git-diff-preview";
import { looksLikeGitDiff } from "./git-diff-utils";
import { StoredChatAttachments } from "./StoredChatAttachments";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

interface BookmarkDetailPageProps {
  bookmark: BookmarkRecord;
  models: ModelRecord[];
  onBack: () => void;
}

export const BookmarkDetailPage = ({ bookmark, models, onBack }: BookmarkDetailPageProps) => {
  const modelLabel = useMemo(() => bookmarkModelDisplay(models, bookmark.modelId), [models, bookmark.modelId]);

  const activityEntries = useMemo(() => {
    const entries: Array<{ step: BookmarkStepRecord; metadata: Record<string, unknown> }> = [];
    for (const step of bookmark.steps) {
      entries.push({ step, metadata: safeParseMetadata(step.metadataJson) });
    }
    return entries;
  }, [bookmark.steps]);

  return (
    <div className="space-y-4">
      <Card className="app-surface-chat-hero overflow-hidden border px-4 py-3">
        <button
          type="button"
          className="text-[11px] uppercase tracking-[0.28em] text-cyan-400 transition hover:text-cyan-300"
          onClick={onBack}
        >
          ← Back to bookmarks
        </button>
        <div className="mt-2 min-w-0 space-y-1.5">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Prompt</p>
            <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug text-zinc-100">{bookmark.prompt}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 pt-1.5 text-[11px] leading-tight">
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
              <Badge tone={bookmark.status} className="shrink-0 px-1.5 py-0 text-[10px]">
                {bookmark.status}
              </Badge>
              <span className="truncate text-zinc-500">
                {bookmark.projectName}
                <span className="text-zinc-700"> · </span>
                {bookmark.branchName}
              </span>
            </div>
            <span className="hidden text-zinc-700 sm:inline" aria-hidden>
              ·
            </span>
            <span className="min-w-0 sm:max-w-[min(40%,14rem)]">
              <span className="text-[10px] uppercase tracking-wide text-zinc-600">Model </span>
              <span
                className="font-medium text-zinc-200"
                title={bookmark.modelId && modelLabel === "Removed model" ? bookmark.modelId : undefined}
              >
                {modelLabel}
              </span>
            </span>
            <span className="hidden text-zinc-700 sm:inline" aria-hidden>
              ·
            </span>
            <span className="min-w-0 text-zinc-400">
              <span className="text-[10px] uppercase tracking-wide text-zinc-600">Bookmarked </span>
              {new Date(bookmark.bookmarkedAt).toLocaleString()}
              <span className="text-zinc-600"> · run </span>
              {new Date(bookmark.runCreatedAt).toLocaleString()}
            </span>
          </div>
        </div>
      </Card>

      <Card className="flex min-h-[480px] flex-col overflow-hidden p-0">
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-1.5 text-cyan-300">
              <MessageSquareText className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-100">Activity log</p>
              <p className="text-[10px] leading-tight text-zinc-500">Snapshot from bookmark</p>
            </div>
          </div>
        </div>
        <div className="app-scrollbar flex-1 space-y-3 overflow-auto p-4">
          {activityEntries.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity recorded.</p>
          ) : (
            activityEntries.map(({ step, metadata }) => {
              const isUserEntry = metadata.source === "user";
              const isAssistantEntry = step.eventType === "output" || (step.eventType === "log" && !isUserEntry);
              const isStatusEntry = step.eventType === "status";
              const isErrorEntry = step.eventType === "error";
              const isToolEntry = step.eventType === "tool-call" || step.eventType === "tool-result";
              const timestamp = new Date(step.createdAt).toLocaleTimeString();

              if (isUserEntry) {
                const attachmentNames = extractAttachmentNamesFromMetadata(metadata);
                const attachments = extractAttachmentPayloadsFromMetadata(metadata);
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

              if (isStatusEntry) {
                return (
                  <div key={step.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium uppercase tracking-[0.2em] text-zinc-400">{step.title}</p>
                      {step.content ? <p className="mt-1 truncate text-xs text-zinc-500">{step.content}</p> : null}
                    </div>
                    <span className="text-[11px] text-zinc-600">{timestamp}</span>
                  </div>
                );
              }

              if (isErrorEntry) {
                return (
                  <div key={step.id} className="rounded-2xl border border-rose-500/25 bg-rose-500/5 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-rose-200">{step.title}</p>
                      <span className="text-xs text-rose-200/70">{timestamp}</span>
                    </div>
                    <pre className="app-scrollbar mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-rose-500/15 bg-zinc-950/60 p-3 text-xs text-zinc-200">
                      {step.content}
                    </pre>
                  </div>
                );
              }

              if (isToolEntry) {
                const toolName = String(metadata.toolName ?? "tool");
                return (
                  <div key={step.id} className="rounded-xl border border-zinc-800/70 bg-zinc-950/45 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-200">{toolName}</p>
                        {step.title ? <p className="mt-1 truncate text-xs text-zinc-400">{step.title}</p> : null}
                      </div>
                      <span className="text-xs text-zinc-500">{timestamp}</span>
                    </div>
                    {step.content ? (
                      looksLikeGitDiff(step.content) ? (
                        <div className="mt-2">
                          <GitDiffPreview
                            diffText={step.content}
                            emptyMessage="No diff available."
                            compact
                            viewType="unified"
                            activityEmphasis
                          />
                        </div>
                      ) : (
                        <pre className="app-scrollbar mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-300">
                          {step.content}
                        </pre>
                      )
                    ) : null}
                  </div>
                );
              }

              if (isAssistantEntry) {
                return (
                  <div key={step.id} className="space-y-2">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                      <span>assistant</span>
                      <span className="text-zinc-700">/</span>
                      <span>{timestamp}</span>
                    </div>
                    <ActivityMarkdownOrGitDiff content={step.content} className="text-zinc-200" />
                  </div>
                );
              }

              return (
                <div key={step.id} className="rounded-xl border border-zinc-800/70 bg-zinc-950/45 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-200">{step.title}</p>
                    </div>
                    <span className="text-xs text-zinc-500">{timestamp}</span>
                  </div>
                  <div className="mt-2">
                    <ActivityMarkdownOrGitDiff content={step.content} className="text-zinc-300" />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
};
