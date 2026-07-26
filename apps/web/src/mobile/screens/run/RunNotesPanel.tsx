import { useState } from "react";
import type { RunDetail } from "@buildwarden/shared";
import { Check, Plus, Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { relativeTime } from "../../lib/format";
import { Button, EmptyState, IconButton, InlineError, Textarea } from "../../components/primitives";
import { cn } from "../../lib/cn";

export const RunNotesPanel = ({ detail, onChanged }: { detail: RunDetail; onChanged: () => Promise<void> }) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const canEdit = client.capabilities.runMutations;

  const add = async () => {
    if (!draft.trim()) return;
    await action.run(() => client.addRunNote(detail.run.id, { content: draft.trim() }), "Could not save the note.");
    setDraft("");
    setComposing(false);
    await onChanged();
  };

  return (
    <div className="m-scroll flex-1">
      {action.error ? <InlineError message={action.error} /> : null}

      {canEdit ? (
        <div className="border-b border-[var(--ec-border)] px-4 py-3">
          {composing ? (
            <div className="flex flex-col gap-2">
              <Textarea autoFocus rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Note for this run…" />
              <div className="flex gap-2">
                <Button tone="neutral" size="sm" className="flex-1" onClick={() => { setComposing(false); setDraft(""); }}>
                  Cancel
                </Button>
                <Button size="sm" className="flex-1" busy={action.busy} disabled={!draft.trim()} onClick={() => void add()}>
                  Save note
                </Button>
              </div>
            </div>
          ) : (
            <Button tone="neutral" block size="sm" onClick={() => setComposing(true)}>
              <Plus className="size-4" />
              Add note
            </Button>
          )}
        </div>
      ) : null}

      {detail.notes.length === 0 ? (
        <EmptyState title="No notes" message="Notes are a scratchpad that travels with the run." />
      ) : (
        detail.notes.map((note) => (
          <div key={note.id} className="flex items-start gap-2 border-b border-[var(--ec-border)] px-4 py-2.5">
            <p
              className={cn(
                "m-wrap-anywhere min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-6",
                note.status === "closed" && "text-[var(--ec-faint)] line-through",
              )}
            >
              {note.content}
            </p>
            <span className="shrink-0 pt-1 text-[11px] text-[var(--ec-faint)]">{relativeTime(note.updatedAt)}</span>
            {canEdit ? (
              <div className="flex shrink-0">
                <IconButton
                  label={note.status === "closed" ? "Reopen note" : "Close note"}
                  onClick={() => {
                    void action
                      .run(() => client.updateRunNote(note.id, { status: note.status === "closed" ? "open" : "closed" }))
                      .then(onChanged);
                  }}
                >
                  <Check className={cn("size-4", note.status === "closed" && "text-[var(--ec-success)]")} />
                </IconButton>
                <IconButton
                  label="Delete note"
                  onClick={() => void action.run(() => client.deleteRunNote(note.id)).then(onChanged)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ) : null}
          </div>
        ))
      )}
      <div className="h-6" />
    </div>
  );
};
