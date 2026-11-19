import { useEffect, useMemo, useReducer } from "react";
import type { ChatAttachmentPayload, DesktopApi, StoredChatAttachment } from "@buildwarden/shared";
import { getStoredAttachmentDownloadMimeType } from "../components/app/stored-chat-attachment-utils";

/**
 * A stored attachment ready to render. `url` is a data URL for small inline files and an object
 * URL for files loaded from the host's attachment store. While a stored file loads, or when the
 * host no longer has it, `dataBase64` and `url` are empty.
 */
export type DisplayAttachment = ChatAttachmentPayload & {
  url: string;
  status: "ready" | "loading" | "missing";
};

export type AttachmentBlobClient = Pick<DesktopApi, "getAttachmentBlob">;

type LoadedBlob = { dataBase64: string; url: string };
type CacheEntry = {
  refs: number;
  settled: boolean;
  value: LoadedBlob | null;
  promise: Promise<void>;
};

/** Released files that stay cached so reopening a recent chat does not load them again. */
const MAX_IDLE_ENTRIES = 24;
const entries = new Map<string, CacheEntry>();
const idleKeys: string[] = [];

const cacheKey = (blobId: string, mimeType: string) => `${blobId}\u0000${mimeType}`;

const toObjectUrl = (dataBase64: string, mimeType: string): string => {
  if (typeof URL.createObjectURL !== "function") return `data:${mimeType};base64,${dataBase64}`;
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
};

const disposeEntry = (key: string) => {
  const entry = entries.get(key);
  entries.delete(key);
  if (entry?.value?.url.startsWith("blob:")) URL.revokeObjectURL(entry.value.url);
};

/**
 * Handles an entry without consumers once its load has settled: a loaded file joins the bounded
 * idle cache, and a failed or missing one is dropped so it is retried the next time it is shown.
 * A pending entry is handled when its load settles.
 */
const retire = (key: string, entry: CacheEntry) => {
  if (!entry.settled) return;
  if (!entry.value) {
    entries.delete(key);
    return;
  }
  if (!idleKeys.includes(key)) idleKeys.push(key);
  while (idleKeys.length > MAX_IDLE_ENTRIES) disposeEntry(idleKeys.shift()!);
};

const acquire = (client: AttachmentBlobClient, blobId: string, mimeType: string, onSettled: () => void): string => {
  const key = cacheKey(blobId, mimeType);
  let entry = entries.get(key);
  if (!entry) {
    const created: CacheEntry = { refs: 0, settled: false, value: null, promise: Promise.resolve() };
    created.promise = client.getAttachmentBlob(blobId)
      .then((result) => {
        created.value = result?.dataBase64 ? { dataBase64: result.dataBase64, url: toObjectUrl(result.dataBase64, mimeType) } : null;
      })
      .catch(() => {
        created.value = null;
      })
      .finally(() => {
        created.settled = true;
        if (entries.get(key) !== created) {
          // The cache was cleared while this load ran; nothing will read or revoke its URL.
          if (created.value?.url.startsWith("blob:")) URL.revokeObjectURL(created.value.url);
          return;
        }
        // Every consumer left before the load finished: keep it within the idle limit.
        if (created.refs === 0) retire(key, created);
      });
    entry = created;
    entries.set(key, entry);
  }
  const idleIndex = idleKeys.indexOf(key);
  if (idleIndex >= 0) idleKeys.splice(idleIndex, 1);
  entry.refs += 1;
  if (!entry.settled) void entry.promise.then(onSettled);
  return key;
};

const release = (key: string) => {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  retire(key, entry);
};

const inlineDataUrl = (attachment: ChatAttachmentPayload) =>
  `data:${getStoredAttachmentDownloadMimeType(attachment)};base64,${attachment.dataBase64}`;

/**
 * Resolves stored attachments for display. Files kept in the host's attachment store load once
 * per mount through `client` and are shared between components that show the same file.
 */
export const useStoredAttachmentPayloads = (
  attachments: readonly StoredChatAttachment[],
  client: AttachmentBlobClient | null | undefined,
): DisplayAttachment[] => {
  const [version, settle] = useReducer((value: number) => value + 1, 0);
  const blobKeys = attachments
    .flatMap((attachment) => attachment.blobId ? [cacheKey(attachment.blobId, getStoredAttachmentDownloadMimeType(attachment))] : [])
    .join("\n");

  useEffect(() => {
    if (!client || !blobKeys) return;
    const acquired = blobKeys.split("\n").map((key) => {
      const [blobId = "", mimeType = ""] = key.split("\u0000");
      return acquire(client, blobId, mimeType, settle);
    });
    return () => acquired.forEach(release);
  }, [blobKeys, client]);

  return useMemo(() => attachments.map((attachment): DisplayAttachment => {
    if (attachment.dataBase64 !== undefined) {
      return { ...attachment, url: inlineDataUrl(attachment), status: "ready" };
    }
    const entry = entries.get(cacheKey(attachment.blobId, getStoredAttachmentDownloadMimeType(attachment)));
    const base: ChatAttachmentPayload = {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      dataBase64: entry?.value?.dataBase64 ?? "",
      ...(attachment.source ? { source: attachment.source } : {}),
      ...(attachment.responseCitation ? { responseCitation: attachment.responseCitation } : {}),
    };
    if (entry?.value) return { ...base, url: entry.value.url, status: "ready" };
    return { ...base, url: "", status: client && (!entry || !entry.settled) ? "loading" : "missing" };
    // `version` re-reads the cache after a load settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [attachments, client, version]);
};

/** Test hook: forget cached files between tests. */
export const resetStoredAttachmentCache = (): void => {
  for (const key of [...entries.keys()]) disposeEntry(key);
  idleKeys.length = 0;
};

/** Test hook: how many files the cache holds, and how many of them have no consumer. */
export const getStoredAttachmentCacheStats = (): { entries: number; idle: number } => ({ entries: entries.size, idle: idleKeys.length });
