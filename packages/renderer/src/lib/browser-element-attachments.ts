import {
  CHAT_ATTACHMENT_LIMITS,
  estimateBase64ByteLength,
  type ChatAttachmentPayload,
  type ProviderType,
  type RunBrowserElementCapture,
} from "@buildwarden/shared";

export const browserElementReservedFileSlots = (captures: readonly RunBrowserElementCapture[]): number => captures.length * 2;

export const providerSupportsBrowserElementScreenshot = (providerType: ProviderType | undefined): boolean =>
  providerType !== "claude-code";

export const browserElementPayloadsForProvider = (
  captures: readonly RunBrowserElementCapture[],
  providerType: ProviderType | undefined,
): ChatAttachmentPayload[] => captures.flatMap((capture) => [
  capture.contextAttachment,
  ...(providerSupportsBrowserElementScreenshot(providerType) ? [capture.screenshotAttachment] : []),
]);

const captureBytes = (capture: RunBrowserElementCapture): number =>
  estimateBase64ByteLength(capture.contextAttachment.dataBase64) +
  estimateBase64ByteLength(capture.screenshotAttachment.dataBase64);

export const validateBrowserElementCaptureAddition = (
  files: readonly File[],
  captures: readonly RunBrowserElementCapture[],
  capture: RunBrowserElementCapture,
): string | null => {
  const physicalCount = files.length + browserElementReservedFileSlots(captures) + 2;
  if (physicalCount > CHAT_ATTACHMENT_LIMITS.maxFileCount) {
    return `A browser element uses two attachment slots. Remove files or elements before adding another.`;
  }
  const attachments = [capture.contextAttachment, capture.screenshotAttachment];
  if (attachments.some((attachment) => estimateBase64ByteLength(attachment.dataBase64) > CHAT_ATTACHMENT_LIMITS.maxBytesPerFile)) {
    return "The selected browser element exceeds the per-file attachment limit.";
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0) +
    captures.reduce((total, item) => total + captureBytes(item), 0) + captureBytes(capture);
  if (totalBytes > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
    return "The selected browser element would exceed the total attachment size limit.";
  }
  return null;
};
