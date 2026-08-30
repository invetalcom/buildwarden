import { useEffect, useMemo, useRef, useState } from "react";
import { RUN_CHAT_CONTEXT_SOURCE, type ChatStepRecord } from "@buildwarden/shared";
import { Bookmark, BookmarkCheck, MoreHorizontal, Trash2 } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAction } from "../data/use-action";
import { useChatDetail } from "../data/use-chat-detail";
import { firstLine } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { Composer } from "../components/Composer";
import { RichText } from "../components/RichText";
import { ActionSheet, ConfirmSheet } from "../components/Sheet";
import { ChatStatusPill } from "../components/StatusPill";
import { CenteredSpinner, IconButton, InlineError } from "../components/primitives";

const parseMetadata = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Drops the hidden run-context seed step the desktop transcript also hides. */
const visibleSteps = (steps: readonly ChatStepRecord[]) =>
  steps.filter((step) => parseMetadata(step.metadataJson).source !== RUN_CHAT_CONTEXT_SOURCE);

const ChatBubble = ({ step }: { step: ChatStepRecord }) => {
  const metadata = parseMetadata(step.metadataJson);
  const isUser = metadata.source === "user";
  const isError = step.eventType === "error";
  const isReasoning = step.eventType === "output" && metadata.assistantKind === "reasoning";

  if (isError) {
    return (
      <div className="mx-3 my-1.5 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-[var(--ec-danger)]">
        <p className="text-xs font-semibold">{step.title}</p>
        {step.content ? <RichText className="mt-1">{step.content}</RichText> : null}
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[86%] rounded-2xl rounded-br-md border border-[var(--ec-user-input-ring)] bg-[var(--ec-user-input-soft)] px-3 py-2">
          <RichText>{step.content || step.title}</RichText>
        </div>
      </div>
    );
  }

  if (isReasoning) {
    return (
      <details className="mx-3 my-1.5 rounded-md border border-[var(--ec-reasoning-ring)] bg-[var(--ec-reasoning-soft)] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ec-reasoning)]">Reasoning</summary>
        <RichText className="mt-2 text-[var(--ec-muted)]">{step.content}</RichText>
      </details>
    );
  }

  if (step.eventType === "status") {
    return <p className="px-4 py-1 text-[11px] text-[var(--ec-faint)]">{step.title}</p>;
  }

  return (
    <div className="px-4 py-1.5">
      <RichText>{step.content}</RichText>
    </div>
  );
};

export const ChatDetailScreen = ({ chatId }: { chatId: string }) => {
  const { client, snapshot, snapshotStore, router } = useMobileApp();
  const { detail, loading, error, reload } = useChatDetail(client, chatId);
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const steps = useMemo(() => (detail ? visibleSteps(detail.steps) : []), [detail]);
  const bookmarked = snapshot.chatBookmarks.some((bookmark) => bookmark.originalChatId === chatId);
  const active = detail ? ["queued", "preparing", "running"].includes(detail.chat.status) : false;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [steps.length]);

  const send = async (prompt: string) => {
    await action.run(() => client.followUpChat(chatId, prompt), "The follow-up did not send.");
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
        <div className="m-scroll m-screen-enter flex-1 py-2">
          {steps.map((step) => (
            <ChatBubble key={step.id} step={step} />
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
