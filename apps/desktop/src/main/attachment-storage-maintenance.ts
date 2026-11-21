import { ATTACHMENT_STEP_TABLES, INLINE_ATTACHMENT_MIGRATION, type BuildWardenDatabase } from "@buildwarden/db";
import { logInfo, logWarn } from "./logger";

type AttachmentStorageDatabase = Pick<
  BuildWardenDatabase,
  "collectUnreferencedAttachmentBlobs" | "isDataMigrationComplete" | "markDataMigrationComplete" | "migrateInlineAttachmentBatch" | "reclaimFreePages"
>;

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
};

/**
 * Runs the one-time migration, then removes unreferenced files and returns free database pages
 * shortly after startup and periodically.
 */
export const startAttachmentStorageMaintenance = (
  db: AttachmentStorageDatabase,
  { initialDelayMs = 20_000, intervalMs = 6 * 60 * 60 * 1000 }: AttachmentStorageMaintenanceOptions = {},
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
      const collected = db.collectUnreferencedAttachmentBlobs();
      if (collected.removed > 0) logInfo("Removed unreferenced attachment files.", collected);
      // Deleted runs and chats leave free pages behind; return a bounded batch without a full VACUUM.
      const reclaimed = db.reclaimFreePages();
      if (reclaimed.reclaimedBytes > 0) logInfo("Returned free database pages to the filesystem.", reclaimed);
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
