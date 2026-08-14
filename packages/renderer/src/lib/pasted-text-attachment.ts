import { DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD } from "@buildwarden/shared";

const PASTED_TEXT_ATTACHMENT_MARKER = "__buildwardenPastedTextAttachment";

type MarkedPastedTextFile = File & {
  readonly [PASTED_TEXT_ATTACHMENT_MARKER]: true;
};

const normalizePastedTextTitle = (value: string): string => {
  const firstContentLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "Pasted text";
  const withoutControlCharacters = [...firstContentLine]
    .map((character) => character.charCodeAt(0) < 32 ? " " : character)
    .join("");
  const fileSafeTitle = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 64)
    .trim();
  return fileSafeTitle || "Pasted text";
};

export const shouldAttachPastedText = (
  value: string,
  threshold = DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
): boolean => {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.length >= threshold;
};

export const createPastedTextAttachmentFile = (value: string): File => {
  const title = normalizePastedTextTitle(value);
  const file = new File([value], `${title}.txt`, {
    type: "text/plain;charset=utf-8",
    lastModified: Date.now(),
  });
  Object.defineProperty(file, PASTED_TEXT_ATTACHMENT_MARKER, { value: true });
  return file;
};

export const isPastedTextAttachmentFile = (file: File): file is MarkedPastedTextFile =>
  (file as Partial<MarkedPastedTextFile>)[PASTED_TEXT_ATTACHMENT_MARKER] === true;

export const getPastedTextAttachmentTitle = (file: File): string =>
  file.name.replace(/\.txt$/i, "") || "Pasted text";
