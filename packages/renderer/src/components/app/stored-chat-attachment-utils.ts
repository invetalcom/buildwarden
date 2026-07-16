import type { ChatAttachmentPayload } from "@buildwarden/shared";

export type StoredAttachmentKind =
  | "archive"
  | "audio"
  | "code"
  | "document"
  | "file"
  | "image"
  | "json"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "video";

export type StoredAttachmentRenderMode = "icon" | "image" | "pdf" | "text";

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const TEXT_EXTENSIONS = new Set([
  "css",
  "env",
  "gitignore",
  "htm",
  "html",
  "ini",
  "less",
  "log",
  "md",
  "mdx",
  "sass",
  "scss",
  "sql",
  "svg",
  "toml",
  "txt",
  "vue",
  "svelte",
  "xml",
  "yaml",
  "yml",
]);
const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "go",
  "java",
  "js",
  "jsx",
  "kt",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
]);
const TEXT_SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv"]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "numbers", "ods", "tsv", "xls", "xlsb", "xlsm", "xlsx"]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "br", "bz2", "dmg", "gz", "jar", "rar", "tar", "tgz", "war", "xz", "zip"]);
const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "epub", "odt", "pages", "rtf"]);
const PRESENTATION_EXTENSIONS = new Set(["key", "odp", "ppt", "pptx"]);
const TEXT_PREVIEW_LIMIT = 420;
const TEXT_PREVIEW_BASE64_LIMIT = 650_000;
const BINARY_DETECTION_SAMPLE_LIMIT = 1024;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  "7z": "application/x-7z-compressed",
  aac: "audio/aac",
  aiff: "audio/aiff",
  apng: "image/apng",
  avif: "image/avif",
  avi: "video/x-msvideo",
  br: "application/x-brotli",
  bmp: "image/bmp",
  bz2: "application/x-bzip2",
  css: "text/css",
  csv: "text/csv",
  dmg: "application/x-apple-diskimage",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  heic: "image/heic",
  heif: "image/heif",
  html: "text/html",
  htm: "text/html",
  ico: "image/x-icon",
  jar: "application/java-archive",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  key: "application/vnd.apple.keynote",
  m4a: "audio/mp4",
  m4v: "video/x-m4v",
  md: "text/markdown",
  mdx: "text/markdown",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  numbers: "application/vnd.apple.numbers",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  opus: "audio/opus",
  pages: "application/vnd.apple.pages",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/vnd.rar",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tgz: "application/gzip",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "text/typescript",
  tsx: "text/typescript",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  war: "application/java-archive",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
  webp: "image/webp",
  wmv: "video/x-ms-wmv",
  xls: "application/vnd.ms-excel",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  xz: "application/x-xz",
  zip: "application/zip",
};

const getFileExtension = (fileName: string): string => {
  const normalizedName = fileName.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const dotIndex = normalizedName.lastIndexOf(".");
  return dotIndex >= 0 ? normalizedName.slice(dotIndex + 1) : "";
};

export const inferStoredAttachmentKind = (fileName: string, mimeType = ""): StoredAttachmentKind => {
  const mime = mimeType.toLowerCase();
  const extension = getFileExtension(fileName);

  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (mime === "application/pdf" || extension === "pdf") {
    return "pdf";
  }
  if (mime === "application/json" || extension === "json") {
    return "json";
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || SPREADSHEET_EXTENSIONS.has(extension)) {
    return "spreadsheet";
  }
  if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (mime.includes("presentation") || PRESENTATION_EXTENSIONS.has(extension)) {
    return "presentation";
  }
  if (mime.includes("wordprocessingml") || mime.includes("opendocument.text") || DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }
  if (mime.includes("zip") || mime.includes("tar") || ARCHIVE_EXTENSIONS.has(extension)) {
    return "archive";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "code";
  }
  if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  return "file";
};

export const getStoredAttachmentDownloadMimeType = (attachment: ChatAttachmentPayload): string => {
  const kind = inferStoredAttachmentKind(attachment.fileName, attachment.mimeType);
  const extension = getFileExtension(attachment.fileName);
  const mime = (attachment.mimeType || "").toLowerCase();
  const extensionMime = EXTENSION_MIME_TYPES[extension];

  if (kind === "image") {
    return mime.startsWith("image/") ? attachment.mimeType : extensionMime || "image/png";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  if (extensionMime && kind !== "text" && kind !== "code" && kind !== "json") {
    return extensionMime;
  }
  return attachment.mimeType || extensionMime || "application/octet-stream";
};

const canPreviewAsText = (attachment: ChatAttachmentPayload): boolean => {
  const kind = inferStoredAttachmentKind(attachment.fileName, attachment.mimeType);
  const extension = getFileExtension(attachment.fileName);
  const mime = (attachment.mimeType || "").toLowerCase();

  if (kind === "spreadsheet") {
    return TEXT_SPREADSHEET_EXTENSIONS.has(extension);
  }

  if (kind === "archive" || kind === "audio" || kind === "document" || kind === "presentation" || kind === "video") {
    return false;
  }

  return kind === "code" || kind === "json" || kind === "text" || mime.startsWith("text/");
};

const isProbablyBinary = (bytes: Uint8Array): boolean => {
  const sampleLength = Math.min(bytes.length, BINARY_DETECTION_SAMPLE_LIMIT);
  if (sampleLength === 0) {
    return false;
  }

  let controlByteCount = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) {
      return true;
    }
    const isAllowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedControl) {
      controlByteCount += 1;
    }
  }

  return controlByteCount / sampleLength > 0.05;
};

export const getStoredAttachmentTextPreview = (attachment: ChatAttachmentPayload): string | null => {
  if (!canPreviewAsText(attachment) || attachment.dataBase64.length > TEXT_PREVIEW_BASE64_LIMIT) {
    return null;
  }

  try {
    const binary = window.atob(attachment.dataBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (isProbablyBinary(bytes)) {
      return null;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n").trim();
    if (decoded.length === 0) {
      return "Empty file";
    }
    return decoded.length > TEXT_PREVIEW_LIMIT ? `${decoded.slice(0, TEXT_PREVIEW_LIMIT).trimEnd()}...` : decoded;
  } catch {
    return null;
  }
};

export const getStoredAttachmentRenderMode = (attachment: ChatAttachmentPayload): StoredAttachmentRenderMode => {
  const kind = inferStoredAttachmentKind(attachment.fileName, attachment.mimeType);

  if (kind === "image") {
    return "image";
  }

  if (kind === "pdf") {
    return "pdf";
  }

  if (canPreviewAsText(attachment)) {
    return "text";
  }

  return "icon";
};
