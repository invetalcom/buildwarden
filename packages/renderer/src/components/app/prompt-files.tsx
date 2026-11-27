import { useEffect, useState, type ReactNode } from "react";
import type { DesignPromptFiles, StoredChatAttachment } from "@buildwarden/shared";
import { Play } from "lucide-react";
import { loadAudioPeaks, type AudioPeaks } from "../../lib/audio-peaks";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";
import { useStoredAttachmentPayloads, type DisplayAttachment } from "../../lib/stored-attachment-data";
import { ImageLightbox } from "../ui/image-lightbox";
import { AttachmentPreviewDialog, type AttachmentPreviewKind } from "./attachment-preview-dialog";
import { getAttachmentPresentation } from "./attachment-presentation";
import {
  getStoredAttachmentExtension,
  getStoredAttachmentRenderMode,
  getStoredAttachmentTextPreview,
  groupStoredAttachments,
} from "./stored-chat-attachment-utils";

/** A file of a prompt. Without `attachment` only its name was kept. */
type PromptFile = { name: string; attachment?: DisplayAttachment };
type OpenFile = { attachment: DisplayAttachment; kind: "image" | AttachmentPreviewKind };

const formatDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
};

const formatSize = (dataBase64: string): string => {
  const bytes = Math.floor((dataBase64.length * 3) / 4);
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const useAudioPeaks = (attachment: DisplayAttachment | null): AudioPeaks | null => {
  const [loaded, setLoaded] = useState<{ url: string; peaks: AudioPeaks | null } | null>(null);
  const url = attachment?.url ?? "";
  const data = attachment?.dataBase64 ?? "";
  useEffect(() => {
    if (!url || !data) return;
    let current = true;
    void loadAudioPeaks(url, data).then((peaks) => {
      if (current) setLoaded({ url, peaks });
    });
    return () => { current = false; };
  }, [url, data]);
  return loaded?.url === url ? loaded.peaks : null;
};

const Waveform = ({ peaks }: { peaks: readonly number[] }) => (
  <svg className="user-prompt-file-wave" viewBox={`0 0 ${String(peaks.length * 4)} 40`} preserveAspectRatio="none" aria-hidden="true">
    {peaks.map((peak, index) => {
      const height = Math.max(2, peak * 36);
      return <rect key={index} x={index * 4 + 0.75} y={(40 - height) / 2} width={2.5} height={height} rx={1.25} />;
    })}
  </svg>
);

/** The clickable or plain box around one file. The three forms share their hook and their look. */
const TileShell = ({ kind, title, href, download, onClick, children }: {
  kind: string;
  title: string;
  href?: string;
  download?: string;
  onClick?: () => void;
  children: ReactNode;
}) => {
  if (href) return <a className="user-prompt-file" data-ui="message-user-file" data-kind={kind} title={title} href={href} download={download}>{children}</a>;
  if (onClick) return <button type="button" className="user-prompt-file" data-ui="message-user-file" data-kind={kind} title={title} aria-label={title} onClick={onClick}>{children}</button>;
  return <span className="user-prompt-file" data-ui="message-user-file" data-kind={kind} title={title}>{children}</span>;
};

const PromptFileTile = ({ file, names, labels, pdfPreview, onOpen }: {
  file: PromptFile;
  names: boolean;
  labels: boolean;
  pdfPreview: boolean;
  onOpen: (open: OpenFile) => void;
}) => {
  const { name, attachment } = file;
  const ready = attachment?.status === "ready" ? attachment : null;
  const { Icon, label } = getAttachmentPresentation(name, attachment?.mimeType);
  const mode = ready ? getStoredAttachmentRenderMode(ready) : "icon";
  const textPreview = ready && mode === "text" ? getStoredAttachmentTextPreview(ready) : null;
  // A text file that turns out to be binary or too large shows like any other file, and so does
  // a PDF where the page cannot embed one.
  const kind = (mode === "text" && textPreview === null) || (mode === "pdf" && !pdfPreview) ? "icon" : mode;
  const peaks = useAudioPeaks(ready && kind === "audio" && !names ? ready : null);
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const seconds = kind === "audio" ? peaks?.duration ?? null : videoSeconds;
  const type = getStoredAttachmentExtension(name).slice(0, 5).toUpperCase() || label.toUpperCase();

  const title = !attachment ? name
    : attachment.status === "missing" ? `${name} is no longer available`
    : attachment.status === "loading" ? `Loading ${name}`
    : kind === "icon" ? `Download ${name}` : `Open ${name}`;
  const shell = ready && kind === "icon"
    ? { href: ready.url, download: name }
    : ready ? { onClick: () => onOpen({ attachment: ready, kind: kind as OpenFile["kind"] }) } : {};

  if (names) {
    return (
      <TileShell kind={kind} title={title} {...shell}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </TileShell>
    );
  }

  const placeholder = (
    <span className="user-prompt-file-icon">
      <Icon className="size-[1.15rem]" aria-hidden />
      <b className="font-mono">{type}</b>
      {ready ? <span>{formatSize(ready.dataBase64)}</span> : attachment ? <span>{attachment.status === "loading" ? "Loading" : "Unavailable"}</span> : null}
    </span>
  );
  return (
    <TileShell kind={kind} title={title} {...shell}>
      {!ready || kind === "icon" ? placeholder : null}
      {ready && kind === "image" ? <img src={ready.url} alt="" loading="lazy" draggable={false} /> : null}
      {ready && kind === "pdf" ? (
        <object data={`${ready.url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`} type="application/pdf" tabIndex={-1} aria-hidden="true">{placeholder}</object>
      ) : null}
      {ready && kind === "video" ? <>
        <video src={ready.url} muted playsInline preload="metadata" tabIndex={-1} onLoadedMetadata={(event) => setVideoSeconds(event.currentTarget.duration)} />
        <span className="user-prompt-file-play"><Play className="size-3" aria-hidden /></span>
      </> : null}
      {ready && kind === "audio" ? (peaks ? <Waveform peaks={peaks.peaks} /> : placeholder) : null}
      {textPreview !== null && kind === "text" ? <pre className="user-prompt-file-text font-mono">{textPreview.slice(0, 600)}</pre> : null}
      {labels && ready && kind !== "icon" && !(kind === "audio" && !peaks) ? <span className="user-prompt-file-tag font-mono">{type}</span> : null}
      {labels && seconds !== null && Number.isFinite(seconds) ? <span className="user-prompt-file-tag user-prompt-file-tag--end font-mono">{formatDuration(seconds)}</span> : null}
    </TileShell>
  );
};

/**
 * The files of a prompt as thumbnails: the picture itself, a frame of a video, the loudness of a
 * recording, the first lines of a text file, the top of a PDF (in a browser; the desktop window
 * cannot embed one), and type and size for the rest.
 * A click opens the file in a viewer; a file without a preview downloads. Referenced page
 * elements and cited answers are not files and stay with the cards of `StoredChatAttachments`.
 */
export const PromptFiles = ({ attachments: stored, fallbackNames, layout, max, labels }: {
  attachments: StoredChatAttachment[];
  /** Names of files whose data was not kept. */
  fallbackNames: readonly string[];
  layout: DesignPromptFiles;
  /** Files that show before the rest collapse into a "+N" tile. */
  max: number;
  labels: boolean;
}) => {
  const client = useOptionalBuildWardenClient();
  const attachments = useStoredAttachmentPayloads(stored, client);
  // The desktop window lets no embedded frame load a document, which a PDF preview would need.
  const pdfPreview = client?.capabilities.platform !== "electron";
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<OpenFile | null>(null);

  const files: PromptFile[] = groupStoredAttachments(attachments)
    .flatMap((item) => (item.kind === "attachment" && !item.attachment.responseCitation ? [{ name: item.attachment.fileName, attachment: item.attachment }] : []));
  const storedNames = new Set(attachments.map((attachment) => attachment.fileName));
  for (const name of fallbackNames) if (!storedNames.has(name)) files.push({ name });
  if (files.length === 0) return null;

  // The "+N" tile takes the place of a file, so a collapsed row never holds more than `max` tiles.
  const shown = expanded || files.length <= max ? files : files.slice(0, Math.max(1, max - 1));
  const hidden = files.length - shown.length;

  return (
    <>
      <div className="user-prompt-files" data-ui="message-user-files" data-layout={layout}>
        {shown.map((file, index) => (
          <PromptFileTile key={`${file.name}-${String(index)}`} file={file} names={layout === "names"} labels={labels} pdfPreview={pdfPreview} onOpen={setOpen} />
        ))}
        {hidden > 0 ? (
          <TileShell kind="more" title={`Show ${String(hidden)} more files`} onClick={() => setExpanded(true)}>+{hidden}</TileShell>
        ) : null}
      </div>
      {open?.kind === "image" ? (
        <ImageLightbox imageUrl={open.attachment.url} title={open.attachment.fileName} downloadFileName={open.attachment.fileName} onClose={() => setOpen(null)} />
      ) : open ? (
        <AttachmentPreviewDialog attachment={open.attachment} kind={open.kind} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
};
