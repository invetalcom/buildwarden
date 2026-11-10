import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { Button } from "../ui/button";
import { ModalDialog } from "../ui/modal-dialog";

export const CouncilFindingsAttachment = ({ file, title, disabled, onRemove }: {
  file: File; title: string; disabled?: boolean; onRemove: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setContent("Loading findings…");
    void file.text().then(
      (text) => { if (active) setContent(text); },
      () => { if (active) setContent("Could not read this attachment. Remove it and select the findings again."); },
    );
    return () => { active = false; };
  }, [file, open]);
  return <>
    <div className="flex items-center gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1 text-[11px] text-[var(--ec-text)]">
      <button type="button" className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-[var(--ec-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]" onClick={() => setOpen(true)} title="Preview the findings attached to your question">
        <ShieldCheck className="h-3.5 w-3.5 text-[var(--ec-accent)]" aria-hidden />{title}
      </button>
      <button type="button" className="rounded p-0.5 text-[var(--ec-faint)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" disabled={disabled} onClick={onRemove} aria-label={`Remove ${title}`}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
    {open ? <ModalDialog title={title} description="These findings will be sent with your question. Selecting them does not start a fix." onClose={() => setOpen(false)} className="w-[min(40rem,95vw)]">
      <pre className="app-scrollbar max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{content}</pre>
      <div className="mt-3 flex justify-end"><Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Close</Button></div>
    </ModalDialog> : null}
  </>;
};
