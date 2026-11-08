import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { type BuildWardenClient } from "@buildwarden/renderer";
import { normalizeSessionTitle, sessionTitle, SESSION_TITLE_MAX_LENGTH, type SessionTitleFields } from "@buildwarden/shared";
import { useAction } from "../data/use-action";
import { Sheet } from "./Sheet";
import { Button, Input, InlineError } from "./primitives";

type Session = SessionTitleFields & { id: string; prompt: string };
type Kind = "run" | "chat";

export const SessionTitleSheet = ({ kind, session, client, onClose, onSaved }: {
  kind: Kind;
  session: Session;
  client: BuildWardenClient;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const [draft, setDraft] = useState(() => sessionTitle(session).slice(0, SESSION_TITLE_MAX_LENGTH));
  const action = useAction();
  const save = async (regenerate: boolean) => {
    const succeeded = await action.ok(async () => {
      if (kind === "run") {
        if (regenerate) await client.regenerateRunTitle(session.id);
        else await client.renameRunTitle(session.id, normalizeSessionTitle(draft));
      } else {
        if (regenerate) await client.regenerateChatTitle(session.id);
        else await client.renameChatTitle(session.id, normalizeSessionTitle(draft));
      }
      await onSaved();
    }, "Could not update the title.");
    if (succeeded) onClose();
  };
  return <Sheet open title={`Edit ${kind} title`} onClose={onClose}>
    <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); if (!action.busy && draft.trim()) void save(false); }}>
      <label className="flex flex-col gap-1 text-sm">Title
        <Input value={draft} maxLength={SESSION_TITLE_MAX_LENGTH} disabled={action.busy}
          onChange={(event) => setDraft(event.target.value)} />
      </label>
      {action.error ? <InlineError message={action.error} /> : null}
      <div className="flex items-center justify-between gap-2">
        <Button tone="neutral" size="sm" disabled={action.busy || Boolean(session.titleGenerationPending)} onClick={() => void save(true)}>
          <RefreshCw className="size-4" />{session.titleGenerationPending ? "Generating…" : "Regenerate title"}
        </Button>
        <Button type="submit" size="sm" busy={action.busy} disabled={!draft.trim()}>Save</Button>
      </div>
    </form>
  </Sheet>;
};
