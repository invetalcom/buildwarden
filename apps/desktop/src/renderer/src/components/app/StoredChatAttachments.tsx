import { useState } from "react";
import { createPortal } from "react-dom";
import type { ChatAttachmentPayload } from "@buildwarden/shared";
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";
import {
  getStoredAttachmentDownloadMimeType,
  getStoredAttachmentRenderMode,
  getStoredAttachmentTextPreview,
  inferStoredAttachmentKind,
  type StoredAttachmentKind,
} from "./stored-chat-attachment-utils";

type AttachmentPresentation = {
  label: string;
  Icon: typeof FileText;
  accentClassName: string;
};

const ATTACHMENT_PRESENTATIONS: Record<StoredAttachmentKind, AttachmentPresentation> = {
  archive: {
    label: "Archive",
    Icon: FileArchive,
    accentClassName: "border-orange-400/20 bg-orange-500/10 text-orange-200",
  },
  audio: {
    label: "Audio",
    Icon: FileAudio,
    accentClassName: "border-violet-400/20 bg-violet-500/10 text-violet-200",
  },
  code: {
    label: "Code",
    Icon: FileCode,
    accentClassName: "border-amber-400/20 bg-amber-500/10 text-amber-200",
  },
  document: {
    label: "Doc",
    Icon: FileText,
    accentClassName: "border-sky-400/20 bg-sky-500/10 text-sky-200",
  },
  file: {
    label: "File",
    Icon: File,
    accentClassName: "border-zinc-500/30 bg-zinc-800/65 text-zinc-200",
  },
  image: {
    label: "Image",
    Icon: FileImage,
    accentClassName: "border-cyan-400/20 bg-cyan-500/10 text-cyan-200",
  },
  json: {
    label: "JSON",
    Icon: FileJson,
    accentClassName: "border-yellow-400/20 bg-yellow-500/10 text-yellow-100",
  },
  pdf: {
    label: "PDF",
    Icon: FileText,
    accentClassName: "border-red-400/20 bg-red-500/10 text-red-200",
  },
  presentation: {
    label: "Slides",
    Icon: Presentation,
    accentClassName: "border-amber-400/20 bg-amber-500/10 text-amber-100",
  },
  spreadsheet: {
    label: "Sheet",
    Icon: FileSpreadsheet,
    accentClassName: "border-emerald-400/20 bg-emerald-500/10 text-emerald-200",
  },
  text: {
    label: "Text",
    Icon: FileText,
    accentClassName: "border-blue-400/20 bg-blue-500/10 text-blue-100",
  },
  video: {
    label: "Video",
    Icon: FileVideo,
    accentClassName: "border-rose-400/20 bg-rose-500/10 text-rose-200",
  },
};

const toDataUrl = (attachment: ChatAttachmentPayload): string =>
  `data:${getStoredAttachmentDownloadMimeType(attachment)};base64,${attachment.dataBase64}`;

const getPresentation = (fileName: string, mimeType = ""): AttachmentPresentation =>
  ATTACHMENT_PRESENTATIONS[inferStoredAttachmentKind(fileName, mimeType)] ?? {
    label: "File",
    Icon: FileQuestion,
    accentClassName: "border-zinc-500/30 bg-zinc-800/65 text-zinc-200",
  };

const AttachmentFooter = ({ attachment }: { attachment: ChatAttachmentPayload }) => {
  const presentation = getPresentation(attachment.fileName, attachment.mimeType);

  return (
    <div className="flex min-w-0 items-center gap-1.5 border-t border-zinc-700/45 px-2 py-1.5">
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none ${presentation.accentClassName}`}
      >
        {presentation.label}
      </span>
      <a
        href={toDataUrl(attachment)}
        download={attachment.fileName}
        className="min-w-0 flex-1 truncate text-[11px] leading-4 text-zinc-300 transition hover:text-zinc-100"
        title={`Download ${attachment.fileName}`}
      >
        {attachment.fileName}
      </a>
      <a
        href={toDataUrl(attachment)}
        download={attachment.fileName}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
        title={`Download ${attachment.fileName}`}
        aria-label={`Download ${attachment.fileName}`}
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
      </a>
    </div>
  );
};

const NameOnlyAttachmentCard = ({ compact, name }: { compact: boolean; name: string }) => {
  const presentation = getPresentation(name);
  const { Icon } = presentation;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-950/55 shadow-sm ${
        compact ? "w-32" : "w-36"
      }`}
      title={name}
    >
      <div className={`flex flex-col items-center justify-center gap-2 ${compact ? "h-20" : "h-24"} px-3`}>
        <div className={`rounded-lg border p-2.5 ${presentation.accentClassName}`}>
          <Icon className="h-6 w-6" aria-hidden />
        </div>
        <span className="max-w-full truncate text-[10px] font-semibold uppercase leading-none text-zinc-500">
          {presentation.label}
        </span>
      </div>
      <div className="truncate border-t border-zinc-700/45 px-2 py-1.5 text-[11px] leading-4 text-zinc-400">{name}</div>
    </div>
  );
};

const IconAttachmentCard = ({ attachment, compact }: { attachment: ChatAttachmentPayload; compact: boolean }) => {
  const presentation = getPresentation(attachment.fileName, attachment.mimeType);
  const { Icon } = presentation;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-950/55 shadow-sm ${
        compact ? "w-32" : "w-36"
      }`}
      title={attachment.fileName}
    >
      <div className={`flex flex-col items-center justify-center gap-2 ${compact ? "h-24" : "h-28"} px-3`}>
        <div className={`rounded-lg border p-3.5 ${presentation.accentClassName}`}>
          <Icon className="h-9 w-9" aria-hidden />
        </div>
        <span className="max-w-full truncate text-[10px] font-semibold uppercase leading-none text-zinc-500">
          {presentation.label}
        </span>
      </div>
      <AttachmentFooter attachment={attachment} />
    </div>
  );
};

const ImageAttachmentCard = ({
  attachment,
  compact,
  onOpen,
}: {
  attachment: ChatAttachmentPayload;
  compact: boolean;
  onOpen: () => void;
}) => (
  <div
    className={`group overflow-hidden rounded-lg border border-cyan-400/20 bg-zinc-950/60 shadow-sm transition hover:border-cyan-300/35 ${
      compact ? "w-32" : "w-40"
    }`}
  >
    <button type="button" className="block w-full bg-black/40 text-left" title={`Open ${attachment.fileName}`} onClick={onOpen}>
      <img
        src={toDataUrl(attachment)}
        alt={attachment.fileName}
        className={`${compact ? "h-24" : "h-28"} w-full object-cover transition group-hover:scale-[1.02]`}
      />
    </button>
    <AttachmentFooter attachment={attachment} />
  </div>
);

const PdfAttachmentCard = ({ attachment, compact }: { attachment: ChatAttachmentPayload; compact: boolean }) => {
  const dataUrl = toDataUrl(attachment);

  return (
    <div
      className={`overflow-hidden rounded-lg border border-red-400/20 bg-zinc-950/60 shadow-sm ${
        compact ? "w-36" : "w-44"
      }`}
      title={attachment.fileName}
    >
      <div className={`${compact ? "h-24" : "h-28"} overflow-hidden bg-zinc-900`}>
        <object
          data={`${dataUrl}#toolbar=0&navpanes=0&scrollbar=0`}
          type="application/pdf"
          className="h-full w-full bg-white"
          aria-label={`Preview ${attachment.fileName}`}
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-red-500/10 text-red-200">
            <FileText className="h-8 w-8" aria-hidden />
            <span className="text-[10px] font-semibold uppercase leading-none">PDF</span>
          </div>
        </object>
      </div>
      <AttachmentFooter attachment={attachment} />
    </div>
  );
};

const TextAttachmentCard = ({
  attachment,
  compact,
  preview,
}: {
  attachment: ChatAttachmentPayload;
  compact: boolean;
  preview: string;
}) => {
  const presentation = getPresentation(attachment.fileName, attachment.mimeType);
  const { Icon } = presentation;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-950/60 shadow-sm ${
        compact ? "w-44" : "w-52"
      }`}
      title={attachment.fileName}
    >
      <div className={`${compact ? "h-24" : "h-28"} overflow-hidden bg-zinc-950/80 p-2`}>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase leading-none text-zinc-500">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span>{presentation.label}</span>
        </div>
        <pre className="max-h-full whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-zinc-300">
          {preview}
        </pre>
      </div>
      <AttachmentFooter attachment={attachment} />
    </div>
  );
};

interface StoredChatAttachmentsProps {
  attachments: ChatAttachmentPayload[];
  fallbackNames?: string[];
  compact?: boolean;
}

export const StoredChatAttachments = ({
  attachments,
  fallbackNames = [],
  compact = false,
}: StoredChatAttachmentsProps) => {
  const [expandedImage, setExpandedImage] = useState<ChatAttachmentPayload | null>(null);

  if (attachments.length === 0 && fallbackNames.length === 0) {
    return null;
  }

  const usedNames = new Set(attachments.map((attachment) => attachment.fileName));
  const namesOnly = fallbackNames.filter((name) => !usedNames.has(name));
  const expandedImageUrl = expandedImage ? toDataUrl(expandedImage) : "";

  return (
    <>
      <div className={compact ? "mt-1.5 space-y-2" : "mt-2 space-y-2"}>
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => {
            const renderMode = getStoredAttachmentRenderMode(attachment);
            const textPreview = renderMode === "text" ? getStoredAttachmentTextPreview(attachment) : null;
            const key = `${attachment.fileName}-${String(index)}`;

            if (renderMode === "image") {
              return (
                <ImageAttachmentCard
                  key={key}
                  attachment={attachment}
                  compact={compact}
                  onOpen={() => setExpandedImage(attachment)}
                />
              );
            }

            if (renderMode === "pdf") {
              return <PdfAttachmentCard key={key} attachment={attachment} compact={compact} />;
            }

            if (textPreview) {
              return <TextAttachmentCard key={key} attachment={attachment} compact={compact} preview={textPreview} />;
            }

            return <IconAttachmentCard key={key} attachment={attachment} compact={compact} />;
          })}
          {namesOnly.map((name, index) => (
            <NameOnlyAttachmentCard key={`${name}-${String(index)}`} name={name} compact={compact} />
          ))}
        </div>
      </div>

      {expandedImage
        ? createPortal(
            <div
              className="fixed inset-0 z-[30000] flex items-center justify-center bg-black/80 p-4"
              onClick={() => setExpandedImage(null)}
              role="dialog"
              aria-modal="true"
              aria-label={expandedImage.fileName}
            >
              <div
                className="max-h-full max-w-6xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                  <p className="truncate text-sm text-zinc-200">{expandedImage.fileName}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <a
                      href={expandedImageUrl}
                      download={expandedImage.fileName}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                      title={`Download ${expandedImage.fileName}`}
                      aria-label={`Download ${expandedImage.fileName}`}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                    </a>
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                      onClick={() => setExpandedImage(null)}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="flex max-h-[85vh] items-center justify-center bg-black p-3">
                  <img
                    src={expandedImageUrl}
                    alt={expandedImage.fileName}
                    className="max-h-[80vh] max-w-full object-contain"
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
