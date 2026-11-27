import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, FileText } from "lucide-react";
import type { DisplayAttachment } from "../../lib/stored-attachment-data";
import { getStoredAttachmentText } from "./stored-chat-attachment-utils";

export type AttachmentPreviewKind = "pdf" | "video" | "audio" | "text";

const PreviewBody = ({ attachment, kind }: { attachment: DisplayAttachment; kind: AttachmentPreviewKind }) => {
  if (kind === "video") {
    return <video controls autoPlay src={attachment.url} className="max-h-[80vh] w-full rounded-lg bg-black" aria-label={attachment.fileName} />;
  }
  if (kind === "audio") {
    return <audio controls autoPlay src={attachment.url} className="w-full" aria-label={attachment.fileName} />;
  }
  if (kind === "text") {
    return (
      <pre className="app-scrollbar max-h-[80vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--ec-input)] p-3 font-mono text-xs leading-5 text-[var(--ec-text)]">
        {getStoredAttachmentText(attachment) || "Empty file"}
      </pre>
    );
  }
  return (
    <div className="h-[min(82vh,58rem)]">
      <object data={`${attachment.url}#toolbar=1&navpanes=0`} type="application/pdf" className="h-full w-full rounded-lg bg-white" aria-label={`Preview ${attachment.fileName}`}>
        <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
          <FileText className="h-12 w-12" aria-hidden />
          <span className="text-xs font-semibold uppercase leading-none">PDF</span>
          <a href={attachment.url} download={attachment.fileName} className="rounded-md border border-[var(--ec-danger-ring)] px-3 py-1.5 text-xs text-[var(--ec-danger)] transition hover:bg-[var(--ec-danger-soft)]">
            Download
          </a>
        </div>
      </object>
    </div>
  );
};

/**
 * Full-window viewer for a file of a message that is not a picture: a PDF, a video, a recording
 * or a text file. Closes on backdrop click, the Close button, or Escape.
 */
export const AttachmentPreviewDialog = ({ attachment, kind, onClose }: {
  attachment: DisplayAttachment;
  kind: AttachmentPreviewKind;
  onClose: () => void;
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Keep window-level Escape shortcuts from firing as well.
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[30000] flex items-center justify-center bg-black/80 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={attachment.fileName}>
      <div
        className={`flex max-h-full flex-col overflow-hidden rounded-2xl border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl ${kind === "audio" ? "w-[min(92vw,32rem)]" : "w-[min(92vw,72rem)]"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] px-4 py-3">
          <p className="truncate text-sm text-[var(--ec-text)]">{attachment.fileName}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <a
              href={attachment.url}
              download={attachment.fileName}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              title={`Download ${attachment.fileName}`}
              aria-label={`Download ${attachment.fileName}`}
            >
              <Download className="h-4 w-4" aria-hidden />
            </a>
            <button type="button" className="rounded-md px-2 py-1 text-xs text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="bg-[var(--ec-panel)] p-3">
          <PreviewBody attachment={attachment} kind={kind} />
        </div>
      </div>
    </div>,
    document.body,
  );
};
