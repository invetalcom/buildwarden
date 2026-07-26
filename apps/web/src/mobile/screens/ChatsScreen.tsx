import { useState } from "react";
import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { defaultRunModel } from "../data/selectors";
import { useAction } from "../data/use-action";
import { firstLine, relativeTime } from "../lib/format";
import { AppBar } from "../components/AppBar";
import { Sheet } from "../components/Sheet";
import { ChatStatusPill } from "../components/StatusPill";
import { Button, CenteredSpinner, EmptyState, IconButton, InlineError, ListRow, Textarea } from "../components/primitives";

export const ChatsScreen = () => {
  const { snapshot, snapshotStore, router, client } = useMobileApp();
  const [composeOpen, setComposeOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const action = useAction();
  const model = defaultRunModel(snapshot);
  const canCreate = client.capabilities.chatMutations && Boolean(model);

  const createChat = async () => {
    if (!model || !prompt.trim()) return;
    const chat = await action.run(
      () => client.createChat({ providerAccountId: model.providerAccountId, modelId: model.modelId, prompt: prompt.trim() }),
      "Could not start the chat.",
    );
    if (chat) {
      setPrompt("");
      setComposeOpen(false);
      await snapshotStore.refresh();
      router.push({ name: "chat", chatId: chat.id });
    }
  };

  return (
    <>
      <AppBar
        title="Chats"
        actions={
          canCreate ? (
            <IconButton label="New chat" onClick={() => setComposeOpen(true)}>
              <MessageSquarePlus className="size-5" />
            </IconButton>
          ) : null
        }
      />

      <div className="m-scroll m-screen-enter flex-1">
        {!snapshotStore.loaded ? (
          <CenteredSpinner />
        ) : snapshot.chats.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare className="size-7" />}
            title="No chats yet"
            message={canCreate ? "Ask a question without starting a run." : "Chats started on the desktop app appear here."}
            action={canCreate ? <Button onClick={() => setComposeOpen(true)}>Start a chat</Button> : undefined}
          />
        ) : (
          <>
            {snapshot.chats.map((chat) => (
              <ListRow
                key={chat.id}
                title={firstLine(chat.prompt, "Untitled chat")}
                subtitle={chat.runId ? "Run chat" : undefined}
                trailing={
                  <>
                    <ChatStatusPill status={chat.status} />
                    <span>{relativeTime(chat.createdAt)}</span>
                  </>
                }
                onClick={() => router.push({ name: "chat", chatId: chat.id })}
                className="border-b border-[var(--ec-border)]"
              />
            ))}
            <div className="h-6" />
          </>
        )}
      </div>

      <Sheet
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        title="New chat"
        dismissable={!action.busy}
        footer={
          <Button block busy={action.busy} disabled={!prompt.trim()} onClick={() => void createChat()}>
            Start chat
          </Button>
        }
      >
        <div className="px-4 py-3">
          {action.error ? <InlineError message={action.error} /> : null}
          <Textarea
            autoFocus
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask about the codebase…"
          />
          <p className="mt-2 text-xs text-[var(--ec-muted)]">Model: {model?.label ?? "none configured"}</p>
        </div>
      </Sheet>
    </>
  );
};
