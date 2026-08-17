import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentPayload } from "@buildwarden/shared";

const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const value = String(reader.result ?? "");
    const comma = value.indexOf(",");
    resolve(comma >= 0 ? value.slice(comma + 1) : value);
  };
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

export const readMobileAttachmentFiles = async (files: readonly File[]): Promise<ChatAttachmentPayload[]> => {
  if (files.length > CHAT_ATTACHMENT_LIMITS.maxFileCount) {
    throw new Error(`At most ${String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files can be attached.`);
  }
  let totalBytes = 0;
  const attachments: ChatAttachmentPayload[] = [];
  for (const file of files) {
    if (file.size > CHAT_ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new Error(`“${file.name}” exceeds the ${String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / 1024 / 1024)} MB file limit.`);
    }
    totalBytes += file.size;
    if (totalBytes > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error(`Attachments exceed the ${String(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / 1024 / 1024)} MB total limit.`);
    }
    attachments.push({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64: await readFileAsBase64(file),
    });
  }
  return attachments;
};
