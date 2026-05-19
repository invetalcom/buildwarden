import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentPayload } from "@easycode/shared";

const readSingleFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      const comma = r.indexOf(",");
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

/** Reads browser `File` objects into payloads suitable for `createChat` / `followUpChat`. */
export async function readFilesAsChatPayloads(files: File[]): Promise<ChatAttachmentPayload[]> {
  if (files.length === 0) {
    return [];
  }
  if (files.length > CHAT_ATTACHMENT_LIMITS.maxFileCount) {
    throw new Error(`At most ${String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files per message.`);
  }

  let total = 0;
  const out: ChatAttachmentPayload[] = [];

  for (const file of files) {
    if (file.size > CHAT_ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new Error(
        `"${file.name}" is too large (max ${String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / (1024 * 1024))} MB per file).`,
      );
    }
    total += file.size;
    if (total > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error(
        `Attachments exceed the total size limit (${String(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024))} MB).`,
      );
    }
    const dataBase64 = await readSingleFileAsBase64(file);
    out.push({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64,
    });
  }

  return out;
}
