import { Download, FileText } from "lucide-react";
import type { DisplayAttachment } from "../../lib/stored-attachment-data";
import { Button } from "../ui/button";
import { ModalDialog } from "../ui/modal-dialog";
import { getAttachmentPresentation } from "./attachment-presentation";
import { getStoredAttachmentText } from "./stored-chat-attachment-utils";

export type AttachmentPreviewKind = "pdf" | "video" | "audio" | "text";

const saveFile = (attachment: DisplayAttachment): void => {
  const link = document.createElement("a");
  link.href = attachment.url;
  link.download = attachment.fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
};

const PreviewBody = ({ attachment, kind }: { attachment: DisplayAttachment; kind: AttachmentPreviewKind }) => {
  if (kind === "video") {
    return <video controls autoPlay src={attachment.url} className="max-h-[72vh] w-full rounded-lg bg-black" aria-label={attachment.fileName} />;
  }
  if (kind === "audio") {
    return <audio controls autoPlay src={attachment.url} className="w-full" aria-label={attachment.fileName} />;
  }
  if (kind === "text") {
    const text = getStoredAttachmentText(attachment);
    return (
      <pre className="app-scrollbar max-h-[72vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--ec-input)] p-3 font-mono text-xs leading-5 text-[var(--ec-text)]">
        {text?.trim() ? text : "Empty file"}
      </pre>
    );
  }
  return (
    <div className="h-[min(72vh,58rem)]">
      <object data={`${attachment.url}#toolbar=1&navpanes=0`} type="application/pdf" className="h-full w-full rounded-lg bg-white" aria-label={`Preview ${attachment.fileName}`}>
        <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
          <FileText className="h-12 w-12" aria-hidden />
          <span className="text-xs font-semibold uppercase leading-none">PDF</span>
        </div>
      </object>
    </div>
  );
};

/**
 * Viewer for a file of a message that is not a picture: a PDF, a video, a recording or a text
 * file. It is a modal dialog, so focus moves into it, stays in it, and returns to the file that
 * opened it. Escape, the close button and a click beside it close it.
 */
export const AttachmentPreviewDialog = ({ attachment, kind, onClose }: {
  attachment: DisplayAttachment;
  kind: AttachmentPreviewKind;
  onClose: () => void;
}) => {
  const { Icon } = getAttachmentPresentation(attachment.fileName, attachment.mimeType);
  return (
    <ModalDialog
      title={<span className="block truncate" title={attachment.fileName}>{attachment.fileName}</span>}
      icon={<Icon className="size-4" />}
      onClose={onClose}
      dismissOnBackdrop
      className={kind === "audio" ? "w-[min(32rem,95vw)]" : "w-[min(72rem,95vw)]"}
      footer={<Button type="button" size="sm" variant="secondary" onClick={() => saveFile(attachment)}><Download className="size-3.5" aria-hidden />Download</Button>}
    >
      <PreviewBody attachment={attachment} kind={kind} />
    </ModalDialog>
  );
};
