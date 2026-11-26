import {
  ATTACHMENT_BLOB_REFS_MIGRATION,
  ATTACHMENT_STEP_TABLES,
  INLINE_ATTACHMENT_MIGRATION,
  type BuildWardenDatabase,
} from "@buildwarden/db";
import { logInfo, logWarn } from "./logger";

type AttachmentStorageDatabase = Pick<
  BuildWardenDatabase,
  | "backfillAttachmentBlobRefsBatch"
  | "collectUnreferencedAttachmentBlobs"
  | "compact"
  | "getStorageInfo"
  | "isDataMigrationComplete"
  | "markDataMigrationComplete"
  | "migrateInlineAttachmentBatch"
  | "reclaimFreePages"
  | "usesIncrementalVacuum"
>;

/**
 * Records which stored files the steps of earlier versions reference, one batch at a time, so cleanup
 * can read the reference table instead of every step. New steps get their rows from triggers.
 */
export const backfillAttachmentBlobRefs = async (
  db: AttachmentStorageDatabase,
  pause: () => Promise<void> = yieldToEventLoop,
): Promise<{ skipped: boolean }> => {
  if (db.isDataMigrationComplete(ATTACHMENT_BLOB_REFS_MIGRATION)) return { skipped: true };
  for (const table of ATTACHMENT_STEP_TABLES) {
    let afterId = "";
    for (let batch = db.backfillAttachmentBlobRefsBatch(table, afterId); batch; batch = db.backfillAttachmentBlobRefsBatch(table, afterId)) {
      afterId = batch.lastId;
      await pause();
    }
  }
  db.markDataMigrationComplete(ATTACHMENT_BLOB_REFS_MIGRATION);
  return { skipped: false };
};

/** A file with less free space than this is not worth one rewrite. */
export const MIN_COMPACTION_FREE_BYTES = 16 * 1024 * 1024;
/** Share of the file that must be free before the one-time switch rewrites it. */
export const MIN_COMPACTION_FREE_RATIO = 0.2;

/**
 * Files created before incremental auto-vacuum keep their free pages, because only a VACUUM switches
 * the mode. Rewrites such a file once when much of it is free and no agent is working; VACUUM blocks
 * the main thread, so agent events would stall behind it. Afterwards reclaimFreePages keeps it small.
 */
export const switchToIncrementalVacuum = (db: AttachmentStorageDatabase, isIdle: () => boolean): { reclaimedBytes: number } | null => {
  if (db.usesIncrementalVacuum()) return null;
  const { fileBytes, freeBytes } = db.getStorageInfo();
  if (freeBytes < MIN_COMPACTION_FREE_BYTES || freeBytes < fileBytes * MIN_COMPACTION_FREE_RATIO) return null;
  if (!isIdle()) return null;
  return db.compact();
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Moves attachment data that earlier versions kept inline on steps into the attachment store.
 * Works in small batches and yields between them, so IPC stays responsive while it runs.
 */
export const migrateInlineAttachments = async (
  db: AttachmentStorageDatabase,
  pause: () => Promise<void> = yieldToEventLoop,
): Promise<{ moved: number; skipped: boolean }> => {
  if (db.isDataMigrationComplete(INLINE_ATTACHMENT_MIGRATION)) return { moved: 0, skipped: true };
  let moved = 0;
  for (const table of ATTACHMENT_STEP_TABLES) {
    let afterRowId = 0;
    for (let batch = db.migrateInlineAttachmentBatch(table, afterRowId); batch; batch = db.migrateInlineAttachmentBatch(table, afterRowId)) {
      afterRowId = batch.lastRowId;
      moved += batch.moved;
      await pause();
    }
  }
  db.markDataMigrationComplete(INLINE_ATTACHMENT_MIGRATION);
  return { moved, skipped: false };
};

export type AttachmentStorageMaintenanceOptions = {
  initialDelayMs?: number;
  intervalMs?: number;
  /** True while no run or chat is working; the database is only rewritten then. */
  isIdle?: () => boolean;
};

/**
 * Runs the one-time migration, then removes unreferenced files and returns free database pages
 * shortly after startup and periodically. An older file is switched to incremental vacuum once.
 */
export const startAttachmentStorageMaintenance = (
  db: AttachmentStorageDatabase,
  { initialDelayMs = 20_000, intervalMs = 6 * 60 * 60 * 1000, isIdle = () => false }: AttachmentStorageMaintenanceOptions = {},
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void runOnce(), delayMs);
    timer.unref?.();
  };
  const runOnce = async () => {
    try {
      const migration = await migrateInlineAttachments(db);
      if (!migration.skipped) logInfo("Moved stored attachments out of the database.", { steps: migration.moved });
      if (stopped) return;
      const references = await backfillAttachmentBlobRefs(db);
      if (!references.skipped) logInfo("Recorded which steps reference stored attachments.");
      if (stopped) return;
      const collected = db.collectUnreferencedAttachmentBlobs();
      if (collected.removed > 0) logInfo("Removed unreferenced attachment files.", collected);
      // Deleted runs and chats leave free pages behind; return a bounded batch without a full VACUUM.
      const reclaimed = db.reclaimFreePages();
      if (reclaimed.reclaimedBytes > 0) logInfo("Returned free database pages to the filesystem.", reclaimed);
      const switched = switchToIncrementalVacuum(db, isIdle);
      if (switched) logInfo("Compacted the database and switched it to incremental vacuum.", switched);
    } catch (error) {
      logWarn("Attachment storage maintenance failed; it will retry later.", { error });
    }
    schedule(intervalMs);
  };
  schedule(initialDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};
