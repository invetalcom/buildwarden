import {
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
import { inferStoredAttachmentKind, type StoredAttachmentKind } from "./stored-chat-attachment-utils";

/** How a kind of file shows where it has no preview: its icon, a short label and a tone. */
export type AttachmentPresentation = {
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

export const getAttachmentPresentation = (fileName: string, mimeType = ""): AttachmentPresentation =>
  ATTACHMENT_PRESENTATIONS[inferStoredAttachmentKind(fileName, mimeType)] ?? {
    label: "File",
    Icon: FileQuestion,
    accentClassName: "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-text)]",
  };
