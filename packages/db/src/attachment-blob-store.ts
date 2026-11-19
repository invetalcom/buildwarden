import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isAttachmentBlobId } from "@buildwarden/shared";

/** Attachments at or below this many base64 characters stay inline on their step. */
export const INLINE_ATTACHMENT_MAX_BASE64_CHARS = 32 * 1024;

/** Each database keeps its own store, so development and production data never share files. */
export const getAttachmentBlobDirectory = (databaseFilePath: string): string =>
  join(dirname(databaseFilePath), `${basename(databaseFilePath, extname(databaseFilePath))}-attachments`);

export type AttachmentBlobEntry = { blobId: string; byteLength: number; modifiedAtMs: number };

/**
 * Content-addressed attachment files named by their SHA-256. Writes are durable before they
 * return, so a database row is never committed with a reference to a file that was lost.
 */
export class AttachmentBlobStore {
  constructor(readonly directory: string) {}

  /** Stores bytes and returns their blob id; identical content shares one file. */
  put(bytes: Uint8Array): string {
    const blobId = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(blobId);
    if (existsSync(target)) {
      // Refresh the age so collection never removes a file that is about to gain a reference.
      const now = new Date();
      try {
        utimesSync(target, now, now);
        return blobId;
      } catch {
        // Fall through and rewrite a file that vanished concurrently.
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = openSync(temporary, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(handle, bytes, offset, bytes.length - offset);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(target)) throw error;
    }
    return blobId;
  }

  read(blobId: string): Buffer | null {
    if (!isAttachmentBlobId(blobId)) return null;
    try {
      return readFileSync(this.pathFor(blobId));
    } catch {
      return null;
    }
  }

  /** Reads at most `maxBytes` from the start of a stored file. */
  readPrefix(blobId: string, maxBytes: number): Buffer | null {
    if (!isAttachmentBlobId(blobId)) return null;
    let handle: number | undefined;
    try {
      handle = openSync(this.pathFor(blobId), "r");
      const buffer = Buffer.alloc(maxBytes);
      let offset = 0;
      while (offset < maxBytes) {
        const count = readSync(handle, buffer, offset, maxBytes - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    } catch {
      return null;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  list(): AttachmentBlobEntry[] {
    if (!existsSync(this.directory)) return [];
    const entries: AttachmentBlobEntry[] = [];
    for (const shard of readdirSync(this.directory, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      for (const file of readdirSync(join(this.directory, shard.name), { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const path = join(this.directory, shard.name, file.name);
        try {
          const stats = statSync(path);
          if (isAttachmentBlobId(file.name) && file.name.startsWith(shard.name)) {
            entries.push({ blobId: file.name, byteLength: stats.size, modifiedAtMs: stats.mtimeMs });
          } else if (file.name.endsWith(".tmp")) {
            // An interrupted write; report it so collection can remove it once it is old.
            entries.push({ blobId: `${shard.name}/${file.name}`, byteLength: stats.size, modifiedAtMs: stats.mtimeMs });
          }
        } catch {
          // Removed while listing.
        }
      }
    }
    return entries;
  }

  remove(blobId: string): void {
    const path = isAttachmentBlobId(blobId) ? this.pathFor(blobId) : this.temporaryPathFor(blobId);
    if (!path) return;
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }

  removeAll(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }

  private pathFor(blobId: string): string {
    return join(this.directory, blobId.slice(0, 2), blobId);
  }

  private temporaryPathFor(entryId: string): string | null {
    const match = /^([a-f0-9]{2})\/([a-f0-9]{64}\.[a-f0-9]{12}\.tmp)$/.exec(entryId);
    return match ? join(this.directory, match[1]!, match[2]!) : null;
  }
}

type AttachmentRecord = Record<string, unknown>;

/**
 * Moves large inline attachment data into the store. Returns the same object when nothing changed,
 * so callers can skip re-serializing ordinary metadata.
 */
export const externalizeAttachmentMetadata = (
  metadata: Record<string, unknown>,
  store: AttachmentBlobStore,
): Record<string, unknown> => {
  if (!Array.isArray(metadata.attachments)) return metadata;
  let changed = false;
  const attachments = metadata.attachments.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const attachment = value as AttachmentRecord;
    const data = attachment.dataBase64;
    if (typeof data !== "string" || data.length <= INLINE_ATTACHMENT_MAX_BASE64_CHARS) return value;
    const bytes = Buffer.from(data, "base64");
    const { dataBase64: _inline, ...rest } = attachment;
    changed = true;
    return { ...rest, blobId: store.put(bytes), byteLength: bytes.length };
  });
  return changed ? { ...metadata, attachments } : metadata;
};

/** Quick text check that avoids parsing the metadata of ordinary steps. */
export const metadataJsonMayHaveInlineAttachment = (metadataJson: string): boolean =>
  metadataJson.length > INLINE_ATTACHMENT_MAX_BASE64_CHARS && metadataJson.includes("\"dataBase64\"");

export const collectAttachmentBlobIds = (metadataJson: string, into: Set<string>): void => {
  if (!metadataJson.includes("\"blobId\"")) return;
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    return;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const attachments = (metadata as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const blobId = (attachment as AttachmentRecord).blobId;
    if (isAttachmentBlobId(blobId)) into.add(blobId);
  }
};
