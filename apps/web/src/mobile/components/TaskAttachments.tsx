import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  appendChatAttachmentFiles,
  CHAT_ATTACHMENT_LIMITS,
  type ChatAttachmentPayload,
} from "@buildwarden/shared";
import {
  getStoredAttachmentDownloadMimeType,
  getStoredAttachmentRenderMode,
  getStoredAttachmentTextPreview,
  inferStoredAttachmentKind,
  type StoredAttachmentKind,
} from "@buildwarden/renderer/logic";
import {
  Archive,
  Download,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  Presentation,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { Button, IconButton } from "./primitives";

const attachmentUrl = (attachment: ChatAttachmentPayload) =>
  `data:${getStoredAttachmentDownloadMimeType(attachment)};base64,${attachment.dataBase64}`;

const iconForKind = (kind: StoredAttachmentKind) => {
  switch (kind) {
    case "archive": return Archive;
    case "audio": return FileAudio;
    case "code": return FileCode;
    case "document":
    case "pdf":
    case "text": return FileText;
    case "image": return FileImage;
    case "json": return FileJson;
    case "presentation": return Presentation;
    case "spreadsheet": return FileSpreadsheet;
    case "video": return FileVideo;
    default: return File;
  }
};

const AttachmentFooter = ({ attachment }: { attachment: ChatAttachmentPayload }) => (
  <div className="flex min-w-0 items-center gap-1.5 border-t border-[var(--ec-border)] px-2 py-1.5">
    <span className="min-w-0 flex-1 truncate text-[11px]" title={attachment.fileName}>{attachment.fileName}</span>
    <a
      href={attachmentUrl(attachment)}
      download={attachment.fileName}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)]"
      aria-label={`Download ${attachment.fileName}`}
    >
      <Download className="size-3.5" />
    </a>
  </div>
);

const StoredAttachment = ({ attachment, onOpenImage }: {
  attachment: ChatAttachmentPayload;
  onOpenImage: (attachment: ChatAttachmentPayload) => void;
}) => {
  const mode = getStoredAttachmentRenderMode(attachment);
  const kind = inferStoredAttachmentKind(attachment.fileName, attachment.mimeType);
  const url = attachmentUrl(attachment);
  const Icon = iconForKind(kind);
  const preview = mode === "text" ? getStoredAttachmentTextPreview(attachment) : null;

  return (
    <div
      data-attachment-kind={kind}
      className="min-w-0 overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]"
    >
      {mode === "image" ? (
        <button type="button" className="block w-full bg-black/30" onClick={() => onOpenImage(attachment)} aria-label={`Open ${attachment.fileName}`}>
          <img src={url} alt={attachment.fileName} className="h-32 w-full object-cover" />
        </button>
      ) : null}
      {mode === "audio" ? (
        <div className="flex min-h-16 items-center gap-2 bg-[var(--ec-panel-soft)] px-2 py-2">
          <FileAudio className="size-5 shrink-0 text-[var(--ec-muted)]" />
          <audio controls preload="metadata" src={url} className="h-10 min-w-0 flex-1" aria-label={attachment.fileName} />
        </div>
      ) : null}
      {mode === "video" ? (
        <video controls playsInline preload="metadata" src={url} className="max-h-64 w-full bg-black object-contain" aria-label={attachment.fileName} />
      ) : null}
      {mode === "pdf" ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex h-28 flex-col items-center justify-center gap-2 bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
          <FileText className="size-8" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">Open PDF</span>
        </a>
      ) : null}
      {mode === "text" && preview ? (
        <pre className="m-scroll-thin max-h-32 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10.5px] leading-4 text-[var(--ec-muted)]">{preview}</pre>
      ) : null}
      {mode === "icon" || (mode === "text" && !preview) ? (
        <a href={url} download={attachment.fileName} className="flex h-24 flex-col items-center justify-center gap-2 text-[var(--ec-muted)]">
          <Icon className="size-8" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em]">{kind}</span>
        </a>
      ) : null}
      <AttachmentFooter attachment={attachment} />
    </div>
  );
};

export const MobileStoredAttachments = ({
  attachments,
  fallbackNames = [],
  onRemove,
}: {
  attachments: readonly ChatAttachmentPayload[];
  fallbackNames?: readonly string[];
  onRemove?: (index: number) => void;
}) => {
  const [expandedImage, setExpandedImage] = useState<ChatAttachmentPayload | null>(null);
  const attachmentNames = new Set(attachments.map((attachment) => attachment.fileName));
  const namesOnly = fallbackNames.filter((name) => !attachmentNames.has(name));
  if (attachments.length === 0 && namesOnly.length === 0) return null;
  return (
    <>
      <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
        {attachments.map((attachment, index) => {
          const mode = getStoredAttachmentRenderMode(attachment);
          return <div key={`${attachment.fileName}-${String(index)}`} className={cn("relative min-w-0", (mode === "audio" || mode === "video") && "col-span-2")}>
            <StoredAttachment attachment={attachment} onOpenImage={setExpandedImage} />
            {onRemove ? (
              <IconButton
                label={`Remove ${attachment.fileName}`}
                className="absolute right-0 top-0 bg-[var(--ec-bg-elevated)]/90"
                onClick={() => onRemove(index)}
              >
                <X className="size-4" />
              </IconButton>
            ) : null}
          </div>;
        })}
        {namesOnly.map((name, index) => {
          const kind = inferStoredAttachmentKind(name);
          const Icon = iconForKind(kind);
          return (
            <div key={`${name}-fallback-${String(index)}`} data-attachment-kind={kind} className="min-w-0 overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]">
              <div className="flex h-24 flex-col items-center justify-center gap-2 text-[var(--ec-muted)]">
                <Icon className="size-8" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em]">{kind}</span>
              </div>
              <p className="truncate border-t border-[var(--ec-border)] px-2 py-2 text-[11px]" title={name}>{name}</p>
            </div>
          );
        })}
      </div>
      {expandedImage ? createPortal(
        <div
          className="fixed inset-0 z-[30000] flex flex-col bg-black/90 p-3"
          role="dialog"
          aria-modal="true"
          aria-label={expandedImage.fileName}
          onClick={() => setExpandedImage(null)}
        >
          <div className="m-safe-top flex justify-end">
            <IconButton label="Close image" className="bg-white/10 text-white" onClick={() => setExpandedImage(null)}><X className="size-5" /></IconButton>
          </div>
          <img src={attachmentUrl(expandedImage)} alt={expandedImage.fileName} className="min-h-0 flex-1 object-contain" />
          <p className="m-safe-bottom truncate py-2 text-center text-xs text-white/80">{expandedImage.fileName}</p>
        </div>,
        document.body,
      ) : null}
    </>
  );
};

export const MobileAttachmentPicker = ({
  files,
  onFilesChange,
  disabled = false,
  maximumFiles = CHAT_ATTACHMENT_LIMITS.maxFileCount,
}: {
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  disabled?: boolean;
  maximumFiles?: number;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <span key={`${file.name}-${String(index)}`} className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] py-1 pl-2.5 pr-1 text-xs">
              <span className="max-w-48 truncate">{file.name}</span>
              <IconButton label={`Remove ${file.name}`} className="size-8" onClick={() => onFilesChange(files.filter((_, itemIndex) => itemIndex !== index))}><X className="size-3.5" /></IconButton>
            </span>
          ))}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const incoming = Array.from(event.target.files ?? []);
          onFilesChange(appendChatAttachmentFiles(files, incoming).slice(0, Math.max(0, maximumFiles)));
          event.target.value = "";
        }}
      />
      <Button tone="neutral" size="sm" disabled={disabled || files.length >= maximumFiles} onClick={() => inputRef.current?.click()}>
        <Paperclip className="size-4" />Attach files
      </Button>
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
  const available = CHAT_ATTACHMENT_LIMITS.maxFileCount - stored.length;
  return (
    <div className="space-y-2">
      <MobileStoredAttachments attachments={stored} onRemove={(index) => onStoredChange(stored.filter((_, itemIndex) => itemIndex !== index))} />
      <MobileAttachmentPicker files={files} onFilesChange={onFilesChange} disabled={disabled} maximumFiles={available} />
      <p className="text-[11px] text-[var(--ec-faint)]">Up to {CHAT_ATTACHMENT_LIMITS.maxFileCount} files · {CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / 1024 / 1024} MB each</p>
    </div>
  );
};
