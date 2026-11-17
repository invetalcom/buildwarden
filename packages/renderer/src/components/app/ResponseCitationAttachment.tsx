import { useContext, useState } from "react";
import type { ResponseCitationMetadata, ChatAttachmentPayload } from "@buildwarden/shared";
import { Quote, X } from "lucide-react";
import { ModalDialog } from "../ui/modal-dialog";
import { ResponseCitationContext } from "../../lib/response-citation-context";
import { revealRenderedResponse } from "../../lib/response-citation";

export function ResponseCitationAttachment({ citation, file, attachment, onRemove, disabled }: {
  citation: ResponseCitationMetadata; file?: File; attachment?: ChatAttachmentPayload; onRemove?: () => void; disabled?: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const reveal = useContext(ResponseCitationContext);
  const label = citation.kind === "reply" ? "Reply" : "Citation";
  const preview = async () => {
    setMissing(false);
    try {
      setContent(file ? await file.text() : new TextDecoder().decode(Uint8Array.from(atob(attachment!.dataBase64), (c) => c.charCodeAt(0))));
    } catch { setContent("Could not read this attachment."); }
  };
  return <>
    <div className="flex max-w-[18rem] items-center gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1 text-xs">
      <button type="button" className="flex min-w-0 items-center gap-2 p-1.5 text-left" onClick={() => void preview()} title={citation.excerpt}>
        <Quote className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0"><span className="block truncate">{citation.excerpt}</span><span className="text-[10px] text-[var(--ec-muted)]">{label}</span></span>
      </button>
      {onRemove ? <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Remove ${file?.name ?? label}`} className="p-1"><X className="h-3.5 w-3.5" /></button> : null}
    </div>
    {content !== null ? <ModalDialog showCloseButton title={label} onClose={() => { setContent(null); setMissing(false); }} className="w-[min(40rem,95vw)]">
      <button type="button" className="mb-2 text-xs text-[var(--ec-accent)]" onClick={() => {
        const found = reveal ? reveal(citation.stepId) : revealRenderedResponse(document.body, citation.stepId);
        if (found) setContent(null); else setMissing(true);
      }}>Go to source</button>
      {missing ? <p role="status" className="mb-2 text-xs text-[var(--ec-muted)]">Source is not in the loaded history. The saved quote is available below.</p> : null}
      <pre className="app-scrollbar max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{content}</pre>
    </ModalDialog> : null}
  </>;
}
