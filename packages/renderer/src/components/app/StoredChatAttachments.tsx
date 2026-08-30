import { useMemo, useState } from "react";
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
  MousePointer2,
  Presentation,
} from "lucide-react";
import {
  groupStoredAttachments,
  getStoredBrowserElementDisplayInfo,
  getStoredAttachmentDownloadMimeType,
  getStoredAttachmentRenderMode,
  getStoredAttachmentTextPreview,
  inferStoredAttachmentKind,
  type StoredAttachmentDisplayItem,
  type StoredAttachmentKind,
} from "./stored-chat-attachment-utils";
import { ImageLightbox } from "../ui/image-lightbox";

type AttachmentPresentation = {
  label: string;
  Icon: typeof FileText;
  accentClassName: string;
};

const ATTACHMENT_PRESENTATIONS: Record<StoredAttachmentKind, AttachmentPresentation> = {
  archive: {
    label: "Archive",
    Icon: FileArchive,
    accentClassName: "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
  },
  audio: {
    label: "Audio",
    Icon: FileAudio,
    accentClassName: "border-[var(--ec-secondary-ring)] bg-[var(--ec-secondary-soft)] text-[var(--ec-secondary)]",
  },
  code: {
    label: "Code",
    Icon: FileCode,
    accentClassName: "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
  },
  document: {
    label: "Doc",
    Icon: FileText,
    accentClassName: "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
  },
  file: {
    label: "File",
    Icon: File,
    accentClassName: "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-text)]",
  },
  image: {
    label: "Image",
    Icon: FileImage,
    accentClassName: "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
  },
  json: {
    label: "JSON",
    Icon: FileJson,
    accentClassName: "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
  },
  pdf: {
    label: "PDF",
    Icon: FileText,
    accentClassName: "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]",
  },
  presentation: {
    label: "Slides",
    Icon: Presentation,
    accentClassName: "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]",
  },
  spreadsheet: {
    label: "Sheet",
    Icon: FileSpreadsheet,
    accentClassName: "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]",
  },
  text: {
    label: "Text",
    Icon: FileText,
    accentClassName: "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]",
  },
  video: {
    label: "Video",
    Icon: FileVideo,
    accentClassName: "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]",
  },
};

const toDataUrl = (attachment: ChatAttachmentPayload): string =>
  `data:${getStoredAttachmentDownloadMimeType(attachment)};base64,${attachment.dataBase64}`;

const getPresentation = (fileName: string, mimeType = ""): AttachmentPresentation =>
  ATTACHMENT_PRESENTATIONS[inferStoredAttachmentKind(fileName, mimeType)] ?? {
    label: "File",
    Icon: FileQuestion,
    accentClassName: "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-text)]",
  };

const AttachmentFooter = ({ attachment }: { attachment: ChatAttachmentPayload }) => {
  const presentation = getPresentation(attachment.fileName, attachment.mimeType);

  return (
    <div className="flex min-w-0 items-center gap-1.5 border-t border-[var(--ec-border)] px-2 py-1.5">
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none ${presentation.accentClassName}`}
      >
        {presentation.label}
      </span>
      <a
        href={toDataUrl(attachment)}
        download={attachment.fileName}
        className="min-w-0 flex-1 truncate text-[11px] leading-4 text-[var(--ec-text)] transition hover:text-[var(--ec-text)]"
        title={`Download ${attachment.fileName}`}
      >
        {attachment.fileName}
      </a>
      <a
        href={toDataUrl(attachment)}
        download={attachment.fileName}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
      className={`overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-sm ${
        compact ? "w-32" : "w-36"
      }`}
      title={name}
    >
      <div className={`flex flex-col items-center justify-center gap-2 ${compact ? "h-20" : "h-24"} px-3`}>
        <div className={`rounded-lg border p-2.5 ${presentation.accentClassName}`}>
          <Icon className="h-6 w-6" aria-hidden />
        </div>
        <span className="max-w-full truncate text-[10px] font-semibold uppercase leading-none text-[var(--ec-muted)]">
          {presentation.label}
        </span>
      </div>
      <div className="truncate border-t border-[var(--ec-border)] px-2 py-1.5 text-[11px] leading-4 text-[var(--ec-muted)]">{name}</div>
    </div>
  );
};

const IconAttachmentCard = ({ attachment, compact }: { attachment: ChatAttachmentPayload; compact: boolean }) => {
  const presentation = getPresentation(attachment.fileName, attachment.mimeType);
  const { Icon } = presentation;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-sm ${
        compact ? "w-32" : "w-36"
      }`}
      title={attachment.fileName}
    >
      <div className={`flex flex-col items-center justify-center gap-2 ${compact ? "h-24" : "h-28"} px-3`}>
        <div className={`rounded-lg border p-3.5 ${presentation.accentClassName}`}>
          <Icon className="h-9 w-9" aria-hidden />
        </div>
        <span className="max-w-full truncate text-[10px] font-semibold uppercase leading-none text-[var(--ec-muted)]">
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
    className={`group overflow-hidden rounded-lg border border-[var(--ec-accent-ring)] bg-[var(--ec-panel)] shadow-sm transition hover:border-[var(--ec-accent-ring)] ${
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

const AudioAttachmentCard = ({ attachment, compact }: { attachment: ChatAttachmentPayload; compact: boolean }) => (
  <div
    className={`overflow-hidden rounded-lg border border-[var(--ec-secondary-ring)] bg-[var(--ec-panel)] shadow-sm ${compact ? "w-52" : "w-64"}`}
    title={attachment.fileName}
  >
    <div className="flex min-h-16 items-center gap-2 bg-[var(--ec-secondary-soft)] px-2.5 py-2">
      <FileAudio className="h-5 w-5 shrink-0 text-[var(--ec-secondary)]" aria-hidden />
      <audio controls preload="metadata" src={toDataUrl(attachment)} className="h-8 min-w-0 flex-1" aria-label={attachment.fileName} />
    </div>
    <AttachmentFooter attachment={attachment} />
  </div>
);

const VideoAttachmentCard = ({ attachment, compact }: { attachment: ChatAttachmentPayload; compact: boolean }) => (
  <div
    className={`overflow-hidden rounded-lg border border-[var(--ec-danger-ring)] bg-[var(--ec-panel)] shadow-sm ${compact ? "w-52" : "w-72"}`}
    title={attachment.fileName}
  >
    <video
      controls
      preload="metadata"
      src={toDataUrl(attachment)}
      className={`${compact ? "h-28" : "h-36"} w-full bg-black object-contain`}
      aria-label={attachment.fileName}
    />
    <AttachmentFooter attachment={attachment} />
  </div>
);

const BrowserElementAttachmentRow = ({
  compact,
  contextAttachment,
  screenshotAttachment,
  fallbackNumber,
  onOpen,
}: {
  compact: boolean;
  contextAttachment?: ChatAttachmentPayload;
  screenshotAttachment?: ChatAttachmentPayload;
  fallbackNumber: number;
  onOpen: () => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const info = useMemo(
    () => getStoredBrowserElementDisplayInfo(contextAttachment, screenshotAttachment, fallbackNumber),
    [contextAttachment, screenshotAttachment, fallbackNumber],
  );
  const label = info.accessibleName || `<${info.tagName}>`;
  const noteIsLong = info.comment.length > 180 || info.comment.split("\n").length > 3;

  return (
    <div className="group flex min-w-0 items-start gap-2.5 border-t border-[color:var(--ec-border)] px-2 py-2 first:border-t-0">
      {screenshotAttachment ? (
        <button
          type="button"
          className={`relative shrink-0 overflow-hidden rounded-md border border-[var(--ec-accent-ring)] bg-black/50 outline-none transition hover:border-[var(--ec-accent-ring)] focus-visible:ring-2 focus-visible:ring-[var(--ec-accent-ring)] ${compact ? "h-12 w-20" : "h-14 w-24"}`}
          title="Open browser element screenshot"
          onClick={onOpen}
        >
          <img
            src={toDataUrl(screenshotAttachment)}
            alt=""
            className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
          />
          <span className="absolute left-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--ec-accent)] px-1 text-[9px] font-bold leading-none text-white shadow-sm">
            {info.annotationNumber}
          </span>
        </button>
      ) : (
        <div className={`relative flex shrink-0 items-center justify-center rounded-md border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ${compact ? "h-12 w-20" : "h-14 w-24"}`}>
          <MousePointer2 className="h-5 w-5" aria-hidden />
          <span className="absolute left-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--ec-accent)] px-1 text-[9px] font-bold leading-none text-white">
            {info.annotationNumber}
          </span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] font-semibold text-[color:var(--ec-text)]" title={label}>{label}</span>
          {info.accessibleName ? <code className="shrink-0 text-[9px] text-[color:var(--ec-muted)]">&lt;{info.tagName}&gt;</code> : null}
        </div>
        <div className="mt-1 border-l-2 border-[var(--ec-accent-ring)] pl-2">
          <span className="block text-[9px] font-semibold uppercase tracking-wide text-[color:var(--ec-muted)]">Requested change</span>
          <p className={`mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-[color:var(--ec-text)] ${!expanded && noteIsLong ? "line-clamp-3" : ""}`}>
            {info.comment || <span className="italic text-[color:var(--ec-muted)]">No note added</span>}
          </p>
          {noteIsLong ? (
            <button type="button" className="mt-0.5 text-[10px] font-medium text-[var(--ec-accent)] hover:text-[var(--ec-accent-strong)]" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[9px] text-[color:var(--ec-muted)]">
          <code className="min-w-0 flex-1 truncate" title={info.selector}>{info.selector}</code>
          {contextAttachment ? (
            <a href={toDataUrl(contextAttachment)} download={contextAttachment.fileName} className="shrink-0 hover:text-[color:var(--ec-text)]" title="Download DOM context">
              Context
            </a>
          ) : null}
          {screenshotAttachment ? (
            <a href={toDataUrl(screenshotAttachment)} download={screenshotAttachment.fileName} className="shrink-0 hover:text-[color:var(--ec-text)]" title="Download screenshot">
              Image
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const PdfAttachmentCard = ({
  attachment,
  compact,
  onOpen,
}: {
  attachment: ChatAttachmentPayload;
  compact: boolean;
  onOpen: () => void;
}) => {
  const dataUrl = toDataUrl(attachment);

  return (
    <div
      className={`group overflow-hidden rounded-lg border border-[var(--ec-danger-ring)] bg-[var(--ec-panel)] shadow-sm transition hover:border-[var(--ec-danger-ring)] ${
        compact ? "w-36" : "w-44"
      }`}
      title={attachment.fileName}
    >
      <div className={`relative ${compact ? "h-24" : "h-28"} overflow-hidden bg-[var(--ec-panel)]`}>
        <object
          data={`${dataUrl}#toolbar=0&navpanes=0&scrollbar=0`}
          type="application/pdf"
          className="pointer-events-none h-full w-full bg-white"
          aria-label={`Preview ${attachment.fileName}`}
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
            <FileText className="h-8 w-8" aria-hidden />
            <span className="text-[10px] font-semibold uppercase leading-none">PDF</span>
          </div>
        </object>
        <button
          type="button"
          className="absolute inset-0 cursor-zoom-in rounded-t-lg outline-none ring-inset transition focus-visible:ring-2 focus-visible:ring-[var(--ec-danger-ring)]"
          title={`Open ${attachment.fileName}`}
          aria-label={`Open ${attachment.fileName}`}
          onClick={onOpen}
        />
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
      className={`overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-sm ${
        compact ? "w-44" : "w-52"
      }`}
      title={attachment.fileName}
    >
      <div className={`${compact ? "h-24" : "h-28"} overflow-hidden bg-[var(--ec-panel)] p-2`}>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase leading-none text-[var(--ec-muted)]">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span>{presentation.label}</span>
        </div>
        <pre className="max-h-full whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-[var(--ec-text)]">
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
  const [expandedPdf, setExpandedPdf] = useState<ChatAttachmentPayload | null>(null);

  if (attachments.length === 0 && fallbackNames.length === 0) {
    return null;
  }

  const usedNames = new Set(attachments.map((attachment) => attachment.fileName));
  const namesOnly = fallbackNames.filter((name) => !usedNames.has(name));
  const displayItems = groupStoredAttachments(attachments);
  const browserItems = displayItems.filter(
    (item): item is Extract<StoredAttachmentDisplayItem, { kind: "browser-element" }> => item.kind === "browser-element",
  );
  const fileItems = displayItems.filter(
    (item): item is Extract<StoredAttachmentDisplayItem, { kind: "attachment" }> => item.kind === "attachment",
  );
  const expandedImageUrl = expandedImage ? toDataUrl(expandedImage) : "";
  const expandedPdfUrl = expandedPdf ? toDataUrl(expandedPdf) : "";

  return (
    <>
      <div className={compact ? "mt-1.5 space-y-2" : "mt-2 space-y-2"}>
        {browserItems.length > 0 ? (
          <section className="overflow-hidden rounded-lg border border-[var(--ec-accent-ring)] bg-[color:var(--ec-panel-soft)] shadow-sm">
            <div className="flex items-center justify-between border-b border-[color:var(--ec-border)] px-2 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--ec-muted)]">Referenced elements</span>
              <span className="rounded-full bg-[var(--ec-accent-soft)] px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-[var(--ec-accent)]">{browserItems.length}</span>
            </div>
            {browserItems.map((item, index) => (
              <BrowserElementAttachmentRow
                key={`browser-element-${item.groupId}`}
                compact={compact}
                contextAttachment={item.contextAttachment}
                screenshotAttachment={item.screenshotAttachment}
                fallbackNumber={index + 1}
                onOpen={() => item.screenshotAttachment && setExpandedImage(item.screenshotAttachment)}
              />
            ))}
          </section>
        ) : null}
        {fileItems.length > 0 || namesOnly.length > 0 ? <div className="flex flex-wrap gap-2">
          {fileItems.map((item, index) => {
            const { attachment } = item;
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
              return (
                <PdfAttachmentCard
                  key={key}
                  attachment={attachment}
                  compact={compact}
                  onOpen={() => setExpandedPdf(attachment)}
                />
              );
            }

            if (renderMode === "audio") {
              return <AudioAttachmentCard key={key} attachment={attachment} compact={compact} />;
            }

            if (renderMode === "video") {
              return <VideoAttachmentCard key={key} attachment={attachment} compact={compact} />;
            }

            if (textPreview) {
              return <TextAttachmentCard key={key} attachment={attachment} compact={compact} preview={textPreview} />;
            }

            return <IconAttachmentCard key={key} attachment={attachment} compact={compact} />;
          })}
          {namesOnly.map((name, index) => (
            <NameOnlyAttachmentCard key={`${name}-${String(index)}`} name={name} compact={compact} />
          ))}
        </div> : null}
      </div>

      {expandedImage ? (
        <ImageLightbox
          imageUrl={expandedImageUrl}
          title={expandedImage.fileName}
          downloadFileName={expandedImage.fileName}
          onClose={() => setExpandedImage(null)}
        />
      ) : null}

      {expandedPdf
        ? createPortal(
            <div
              className="fixed inset-0 z-[30000] flex items-center justify-center bg-black/80 p-4"
              onClick={() => setExpandedPdf(null)}
              role="dialog"
              aria-modal="true"
              aria-label={expandedPdf.fileName}
            >
              <div
                className="flex max-h-full w-[min(92vw,72rem)] flex-col overflow-hidden rounded-2xl border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ec-border)] px-4 py-3">
                  <p className="truncate text-sm text-[var(--ec-text)]">{expandedPdf.fileName}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <a
                      href={expandedPdfUrl}
                      download={expandedPdf.fileName}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                      title={`Download ${expandedPdf.fileName}`}
                      aria-label={`Download ${expandedPdf.fileName}`}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                    </a>
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                      onClick={() => setExpandedPdf(null)}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="h-[min(82vh,58rem)] bg-[var(--ec-panel)] p-3">
                  <object
                    data={`${expandedPdfUrl}#toolbar=1&navpanes=0`}
                    type="application/pdf"
                    className="h-full w-full rounded-lg bg-white"
                    aria-label={`Preview ${expandedPdf.fileName}`}
                  >
                    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]">
                      <FileText className="h-12 w-12" aria-hidden />
                      <span className="text-xs font-semibold uppercase leading-none">PDF</span>
                      <a
                        href={expandedPdfUrl}
                        download={expandedPdf.fileName}
                        className="rounded-md border border-[var(--ec-danger-ring)] px-3 py-1.5 text-xs text-[var(--ec-danger)] transition hover:bg-[var(--ec-danger-soft)]"
                      >
                        Download
                      </a>
                    </div>
                  </object>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
