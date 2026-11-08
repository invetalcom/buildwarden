import { useState } from "react";
import { Pencil, RefreshCw } from "lucide-react";
import { sessionTitle, SESSION_TITLE_MAX_LENGTH, type SessionTitleFields } from "@buildwarden/shared";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";
import { useInstanceContext } from "../../lib/instance-context";
import { ModalDialog } from "../ui/modal-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export const SessionTitleActions = ({ kind, session, menu = false, onClose }: {
  kind: "run" | "chat";
  session: SessionTitleFields & { id: string; prompt: string };
  menu?: boolean;
  onClose?: () => void;
}) => {
  const defaultClient = useOptionalBuildWardenClient();
  const instances = useInstanceContext();
  const client = instances?.clientForEntity(session.id) ?? defaultClient;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session.titleGenerationEnabled || !client || !(kind === "run" ? client.capabilities.runMutations : client.capabilities.chatMutations)) return null;
  const act = async (regenerate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "run") {
        if (regenerate) await client.regenerateRunTitle(session.id);
        else await client.renameRunTitle(session.id, draft);
      } else {
        if (regenerate) await client.regenerateChatTitle(session.id);
        else await client.renameChatTitle(session.id, draft);
      }
      setOpen(false);
      onClose?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" title="Rename or regenerate title" aria-label={`Edit ${kind} title`}
      className={menu ? "flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-[var(--ec-hover)]" : "app-detail-header-action shrink-0"}
      onClick={(event) => { event.stopPropagation(); setDraft(sessionTitle(session).slice(0, SESSION_TITLE_MAX_LENGTH)); setError(null); setOpen(true); }}>
      <Pencil className="size-3.5" aria-hidden />{menu ? "Rename or regenerate title" : null}
    </button>
    {open ? <ModalDialog title={`Edit ${kind} title`} onClose={() => { setOpen(false); onClose?.(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void act(false); }} className="space-y-3">
        <Input aria-label="Title" value={draft} maxLength={SESSION_TITLE_MAX_LENGTH} disabled={busy}
          onChange={(event) => setDraft(event.target.value)} />
        {error ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy || Boolean(session.titleGenerationPending)} onClick={() => void act(true)}>
            <RefreshCw className={`size-3.5 ${busy || session.titleGenerationPending ? "animate-spin" : ""}`} />
            {session.titleGenerationPending ? "Generating…" : "Regenerate title"}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !draft.trim()}>Save</Button>
        </div>
      </form>
    </ModalDialog> : null}
  </>;
};
