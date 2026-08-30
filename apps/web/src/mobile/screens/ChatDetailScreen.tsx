import { useEffect, useMemo, useRef, useState } from "react";
import { RUN_CHAT_CONTEXT_SOURCE, type ChatAttachmentPayload, type ChatStepRecord } from "@buildwarden/shared";
import { Bookmark, BookmarkCheck, MoreHorizontal, Trash2 } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAction } from "../data/use-action";
import { useChatDetail } from "../data/use-chat-detail";
import { firstLine } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { Composer } from "../components/Composer";
import { MobileChatStep } from "../components/ChatTranscriptStep";
import { parseStepMetadata } from "../lib/chat-steps";
import { ActionSheet, ConfirmSheet } from "../components/Sheet";
import { ChatStatusPill } from "../components/StatusPill";
import { CenteredSpinner, IconButton, InlineError } from "../components/primitives";

/** Drops the hidden run-context seed step the desktop transcript also hides. */
const visibleSteps = (steps: readonly ChatStepRecord[]) =>
  steps.filter((step) => parseStepMetadata(step.metadataJson).source !== RUN_CHAT_CONTEXT_SOURCE);

export const ChatDetailScreen = ({ chatId }: { chatId: string }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const { detail, loading, error, reload, historyLoading, loadEarlierHistory } = useChatDetail(client, chatId);
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const suppressNextAutoScrollRef = useRef(false);

  const steps = useMemo(() => (detail ? visibleSteps(detail.steps) : []), [detail]);
  const bookmarked = snapshot.chatBookmarks.some((bookmark) => bookmark.originalChatId === chatId);
  const active = detail ? ["queued", "preparing", "running"].includes(detail.chat.status) : false;

  useEffect(() => {
    if (historyLoading) return;
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [historyLoading, steps.length]);

  const loadEarlier = async () => {
    const element = transcriptRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    suppressNextAutoScrollRef.current = true;
    await loadEarlierHistory();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (element) element.scrollTop = previousTop + (element.scrollHeight - previousHeight);
  };

  const send = async (prompt: string, attachments: ChatAttachmentPayload[]) => {
    await action.run(
      () => client.followUpChat(chatId, prompt, attachments.length ? { attachments } : undefined),
      "The follow-up did not send.",
    );
    await reload();
  };

  return (
    <>
      <AppBar
        title={detail ? firstLine(detail.chat.prompt, "Chat") : "Chat"}
        subtitle={detail ? undefined : "Loading…"}
        onBack={router.back}
        actions={
          <>
            {detail ? <div className="pr-1"><ChatStatusPill status={detail.chat.status} /></div> : null}
            <IconButton label="Chat actions" onClick={() => setMenuOpen(true)}>
              <MoreHorizontal className="size-5" />
            </IconButton>
          </>
        }
      />

      {error ? <InlineError message={error} onRetry={() => void reload()} /> : null}
      {action.error ? <InlineError message={action.error} /> : null}

      {loading && !detail ? (
        <CenteredSpinner label="Loading chat" />
      ) : (
        <div ref={transcriptRef} className="m-scroll m-screen-enter flex-1 py-2">
          {detail?.historyPage?.hasMore ? (
            <button
              type="button"
              className="m-tap mx-4 mb-2 block rounded-md border border-[var(--ec-border)] text-xs font-medium text-[var(--ec-muted)] disabled:opacity-60"
              onClick={() => void loadEarlier()}
              disabled={historyLoading}
            >
              {historyLoading ? "Loading earlier turns…" : "Load earlier turns"}
            </button>
          ) : null}
          {steps.map((step) => (
            <MobileChatStep key={step.id} step={step} />
          ))}
          <div ref={bottomRef} className="h-2" />
        </div>
      )}

      <Composer
        placeholder="Message"
        busy={action.busy}
        disabled={!client.capabilities.chatMutations}
        disabledReason="This session cannot send chat messages."
        onSubmit={send}
        onCancel={active ? () => void action.run(() => client.cancelChat(chatId), "Could not cancel.") : undefined}
      />

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={[
          {
            label: bookmarked ? "Remove bookmark" : "Bookmark chat",
            icon: bookmarked ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />,
            disabled: !client.capabilities.bookmarkMutations,
            onSelect: () => {
              void action
                .run(() => (bookmarked ? client.removeChatBookmark(chatId) : client.addChatBookmark(chatId)))
                .then(() => snapshotStore.refresh());
            },
          },
          {
            label: "Delete chat",
            icon: <Trash2 className="size-4" />,
            danger: true,
            disabled: !client.capabilities.chatMutations,
            onSelect: () => setConfirmDelete(true),
          },
        ]}
      />

      <ConfirmSheet
        open={confirmDelete}
        title="Delete chat"
        message="This removes the chat and its transcript from the host. It cannot be undone."
        confirmLabel="Delete"
        danger
        busy={action.busy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          void action.ok(() => client.deleteChat(chatId), "Could not delete the chat.").then(async (deleted) => {
            // Stay in the sheet on failure: leaving would hide both the error and the chat it names.
            if (!deleted) return;
            setConfirmDelete(false);
            await snapshotStore.refresh();
            router.back();
          });
        }}
      />
    </>
  );
};
