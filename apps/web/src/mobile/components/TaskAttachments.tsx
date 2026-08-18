import { useRef } from "react";
import {
  appendChatAttachmentFiles,
  CHAT_ATTACHMENT_LIMITS,
  type ChatAttachmentPayload,
} from "@buildwarden/shared";
import { FileText, Paperclip, X } from "lucide-react";
import { Button, IconButton } from "./primitives";

const attachmentUrl = (attachment: ChatAttachmentPayload) =>
  `data:${attachment.mimeType || "application/octet-stream"};base64,${attachment.dataBase64}`;

export const MobileStoredAttachments = ({
  attachments,
  onRemove,
}: {
  attachments: readonly ChatAttachmentPayload[];
  onRemove?: (index: number) => void;
}) => {
  if (attachments.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment);
        const image = attachment.mimeType.toLowerCase().startsWith("image/");
        const opensInBrowser = image || attachment.mimeType.toLowerCase().startsWith("application/pdf");
        return (
          <div key={`${attachment.fileName}-${String(index)}`} className="relative min-w-0 overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]">
            <a href={url} target="_blank" rel="noreferrer" download={opensInBrowser ? undefined : attachment.fileName} className="block min-w-0">
              {image ? (
                <img src={url} alt={attachment.fileName} className="h-28 w-full object-cover" />
              ) : (
                <span className="flex h-20 items-center justify-center text-[var(--ec-muted)]"><FileText className="size-7" /></span>
              )}
              <span className="block truncate border-t border-[var(--ec-border)] px-2 py-1.5 text-[11px]" title={attachment.fileName}>{attachment.fileName}</span>
            </a>
            {onRemove ? <IconButton label={`Remove ${attachment.fileName}`} className="absolute right-0 top-0 bg-[var(--ec-bg-elevated)]/90" onClick={() => onRemove(index)}><X className="size-4" /></IconButton> : null}
          </div>
        );
      })}
    </div>
  );
};

export const MobileTaskAttachmentField = ({
  stored,
  onStoredChange,
  files,
  onFilesChange,
  disabled = false,
}: {
  stored: readonly ChatAttachmentPayload[];
  onStoredChange: (attachments: ChatAttachmentPayload[]) => void;
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  disabled?: boolean;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const available = CHAT_ATTACHMENT_LIMITS.maxFileCount - stored.length;
  return (
    <div className="space-y-2">
      <MobileStoredAttachments attachments={stored} onRemove={(index) => onStoredChange(stored.filter((_, itemIndex) => itemIndex !== index))} />
      {files.length > 0 ? <div className="flex flex-wrap gap-1.5">{files.map((file, index) => <span key={`${file.name}-${String(index)}`} className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] py-1 pl-2.5 pr-1 text-xs"><span className="max-w-48 truncate">{file.name}</span><IconButton label={`Remove ${file.name}`} className="size-8" onClick={() => onFilesChange(files.filter((_, itemIndex) => itemIndex !== index))}><X className="size-3.5" /></IconButton></span>)}</div> : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,text/*,application/json,.md,.txt,.pdf,.json"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const incoming = Array.from(event.target.files ?? []);
          onFilesChange(appendChatAttachmentFiles(files, incoming).slice(0, Math.max(0, available)));
          event.target.value = "";
        }}
      />
      <Button tone="neutral" size="sm" disabled={disabled || stored.length + files.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount} onClick={() => inputRef.current?.click()}>
        <Paperclip className="size-4" />Attach files
      </Button>
      <p className="text-[11px] text-[var(--ec-faint)]">Up to {CHAT_ATTACHMENT_LIMITS.maxFileCount} files · {CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / 1024 / 1024} MB each</p>
    </div>
  );
};
