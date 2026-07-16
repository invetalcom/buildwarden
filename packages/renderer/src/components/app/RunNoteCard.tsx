import type { RunNoteRecord, RunNoteStatus } from "@buildwarden/shared";
import { Check, Loader2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

function RunNoteCard({
  note,
  busy,
  editing,
  editDraft,
  onEditDraftChange,
  onStartEditing,
  onCancelEditing,
  onSave,
  onStatusChange,
  onDelete,
}: Readonly<{
  note: RunNoteRecord;
  busy: boolean;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onStartEditing: (note: RunNoteRecord) => void;
  onCancelEditing: () => void;
  onSave: (note: RunNoteRecord) => void | Promise<void>;
  onStatusChange: (note: RunNoteRecord, status: RunNoteStatus) => void | Promise<void>;
  onDelete: (noteId: string) => void | Promise<void>;
}>) {
  const isClosed = note.status === "closed";
  const trimmedEditDraft = editDraft.trim();
  const createdLabel = new Date(note.createdAt).toLocaleString();
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        isClosed ? "border-zinc-800/60 bg-zinc-950/25" : "border-cyan-500/20 bg-cyan-500/[0.04]",
        isClosed && !editing ? "opacity-75" : "",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge tone={isClosed ? "neutral" : "completed"} className="px-1.5 py-0 text-[9px] uppercase tracking-[0.14em]">
              {note.status}
            </Badge>
            <span className="truncate text-[10px] text-zinc-500">{createdLabel}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-cyan-200 hover:bg-cyan-500/10 hover:text-cyan-100" disabled={busy || !trimmedEditDraft} onClick={() => void onSave(note)}>
                {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : <Check className="mr-1 h-3 w-3" aria-hidden />}
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100" disabled={busy} onClick={onCancelEditing}>
                <X className="mr-1 h-3 w-3" aria-hidden />
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100" disabled={busy} onClick={() => onStartEditing(note)} title="Edit note" aria-label="Edit note">
                <Pencil className="h-3 w-3" aria-hidden />
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-zinc-400 hover:text-zinc-100" disabled={busy} onClick={() => void onStatusChange(note, isClosed ? "open" : "closed")}>
                <Check className="mr-1 h-3 w-3" aria-hidden />
                {isClosed ? "Reopen" : "Close"}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-300/80 hover:bg-red-500/10 hover:text-red-200" disabled={busy} onClick={() => void onDelete(note.id)} title="Delete note">
                <Trash2 className="h-3 w-3" aria-hidden />
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea value={editDraft} onChange={(event) => onEditDraftChange(event.target.value)} className="min-h-24 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm leading-relaxed text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60" autoFocus />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-100">{note.content}</p>
      )}
    </div>
  );
}

export function RunNotesPanel({
  notes,
  openNotes,
  closedNotes,
  draft,
  editDraft,
  busyNoteId,
  editingNoteId,
  onDraftChange,
  onEditDraftChange,
  onAdd,
  onStartEditing,
  onCancelEditing,
  onSave,
  onStatusChange,
  onDelete,
}: Readonly<{
  notes: RunNoteRecord[];
  openNotes: RunNoteRecord[];
  closedNotes: RunNoteRecord[];
  draft: string;
  editDraft: string;
  busyNoteId: string | null;
  editingNoteId: string | null;
  onDraftChange: (value: string) => void;
  onEditDraftChange: (value: string) => void;
  onAdd: (content: string) => void | Promise<void>;
  onStartEditing: (note: RunNoteRecord) => void;
  onCancelEditing: () => void;
  onSave: (note: RunNoteRecord) => void | Promise<void>;
  onStatusChange: (note: RunNoteRecord, status: RunNoteStatus) => void | Promise<void>;
  onDelete: (noteId: string) => void | Promise<void>;
}>) {
  const renderNote = (note: RunNoteRecord) => (
    <RunNoteCard
      key={note.id}
      note={note}
      busy={busyNoteId === note.id}
      editing={editingNoteId === note.id}
      editDraft={editDraft}
      onEditDraftChange={onEditDraftChange}
      onStartEditing={onStartEditing}
      onCancelEditing={onCancelEditing}
      onSave={onSave}
      onStatusChange={onStatusChange}
      onDelete={onDelete}
    />
  );
  return (
    <div className="app-scrollbar flex h-full min-h-0 flex-col overflow-y-auto px-3 py-3">
      <div className="mb-3 rounded-lg border border-zinc-800/80 bg-zinc-950/45 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">Run notes</p>
            <p className="text-[11px] text-zinc-500">{openNotes.length} open, {closedNotes.length} closed</p>
          </div>
          <StickyNote className="h-4 w-4 shrink-0 text-cyan-300/80" aria-hidden />
        </div>
        <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} className="min-h-20 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-cyan-500/60" placeholder="Add a note for this run" />
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={!draft.trim()} onClick={() => void onAdd(draft)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Add note
          </Button>
        </div>
      </div>
      {notes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-800/80 px-4 py-8 text-center text-sm text-zinc-500">
          Select text in the activity log, right-click, and add it to notes.
        </div>
      ) : (
        <div className="space-y-3">
          {openNotes.length > 0 ? <div className="space-y-2">{openNotes.map(renderNote)}</div> : null}
          {closedNotes.length > 0 ? (
            <div className="space-y-2">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-600">Closed</p>
              {closedNotes.map(renderNote)}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
