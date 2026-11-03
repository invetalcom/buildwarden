import type { ComposerDraft } from "../../lib/use-composer-draft";

export function ComposerDraftStatus({ draft }: { draft: ComposerDraft }) {
  if (!draft.readOnly && !draft.loading && !draft.saving && !draft.error && draft.missing.length === 0) return null;
  return <div className="px-3 py-1 text-xs text-[var(--ec-muted)]" role={draft.error || draft.missing.length ? "alert" : "status"}>
    {draft.readOnly && !draft.error ? <span>{draft.acquiringLock ? "Opening draft… " : "This draft is open in another window. Close that composer to edit here. "}</span> : null}
    {draft.loading ? "Restoring draft attachments…" : draft.saving ? "Saving draft attachments…" : null}
    {draft.error ? <span>{draft.error}</span> : null}
    {draft.missing.map((ref) => <div key={ref.id}>
      Could not restore {ref.name}. <button type="button" disabled={draft.readOnly} className="underline" onClick={() => draft.removeMissing(ref.id)}>Remove its reference</button>, then reattach the file if needed before sending.
    </div>)}
  </div>;
}
