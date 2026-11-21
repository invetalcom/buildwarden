import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RENDERER_BLANK_URL } from "./renderer-protocol";

/**
 * Earlier versions loaded the renderer from file://. Moving it to the renderer scheme gives it a
 * new origin with empty storage, so this copies what the renderer kept there once: localStorage
 * (drafts, layout, list state) and the composer's draft attachments in IndexedDB. Keys that already
 * exist on the new origin win, so running it again never overwrites newer state.
 */

const MARKER_FILE_NAME = "renderer-origin-migrated";
/** Written once localStorage is copied, so a retry for attachments never copies it again. */
const LOCAL_STORAGE_MARKER_FILE_NAME = "renderer-origin-local-storage-migrated";
const EXPORT_PAGE_FILE_NAME = "renderer-storage-export.html";
const STEP_TIMEOUT_MS = 15_000;
const ATTACHMENT_DATABASE = "buildwarden-composer-attachments";

export type ExportedRendererStorage = {
  localStorage: Array<[string, string]>;
  attachments: Array<{ id: string; type: string; base64: string }>;
};

// Plain scripts, not stringified functions: bundling may rewrite function bodies.
const EXPORT_SCRIPT = `(async () => {
  const local = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null) local.push([key, localStorage.getItem(key) ?? ""]);
  }
  const attachments = [];
  const names = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((entry) => entry.name) : [];
  if (names.includes(${JSON.stringify(ATTACHMENT_DATABASE)})) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(ATTACHMENT_DATABASE)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (db.objectStoreNames.contains("attachments")) {
        const entries = await new Promise((resolve, reject) => {
          const transaction = db.transaction("attachments", "readonly");
          const store = transaction.objectStore("attachments");
          const keys = store.getAllKeys();
          const values = store.getAll();
          transaction.oncomplete = () => resolve(keys.result.map((key, index) => [key, values.result[index]]));
          transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
        for (const [id, blob] of entries) {
          if (typeof id !== "string" || !(blob instanceof Blob)) continue;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
          }
          attachments.push({ id, type: blob.type, base64: btoa(binary) });
        }
      }
    } finally {
      db.close();
    }
  }
  return { localStorage: local, attachments };
})()`;

const importLocalStorageScript = (entries: ExportedRendererStorage["localStorage"]): string => `((entries) => {
  let keys = 0;
  let skipped = 0;
  for (const [key, value] of entries) {
    if (localStorage.getItem(key) !== null) continue;
    try { localStorage.setItem(key, value); keys += 1; } catch { skipped += 1; /* Quota: keep what fits. */ }
  }
  return { keys, skipped };
})(${JSON.stringify(entries)})`;

const isLocalStorageImport = (value: unknown): value is { keys: number; skipped: number } => {
  const candidate = value as { keys?: unknown; skipped?: unknown } | null;
  return Boolean(candidate && typeof candidate.keys === "number" && typeof candidate.skipped === "number");
};

// One transaction: either every missing attachment is written or none is.
const importAttachmentsScript = (attachments: ExportedRendererStorage["attachments"]): string => `(async (attachments) => {
  let written = 0;
  const db = await new Promise((resolve, reject) => {
    // Same version and store as the renderer's draft attachment storage.
    const request = indexedDB.open(${JSON.stringify(ATTACHMENT_DATABASE)}, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("attachments");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("attachments", "readwrite");
      const store = transaction.objectStore("attachments");
      for (const attachment of attachments) {
        const existing = store.getKey(attachment.id);
        existing.onsuccess = () => {
          if (existing.result !== undefined) return;
          const binary = atob(attachment.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          store.put(new Blob([bytes], { type: attachment.type }), attachment.id);
          written += 1;
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
  return written;
})(${JSON.stringify(attachments)})`;

type MigrationWindow = {
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  destroy(): void;
  webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    session: { flushStorageData(): void };
  };
};

export type RendererStorageMigrationOptions = {
  userDataPath: string;
  /** A hidden, sandboxed window without a preload. */
  createWindow: () => MigrationWindow;
  log: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
};

const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), STEP_TIMEOUT_MS);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
  );
});

const isExportedStorage = (value: unknown): value is ExportedRendererStorage => {
  const candidate = value as Partial<ExportedRendererStorage> | null;
  return Boolean(candidate && Array.isArray(candidate.localStorage) && Array.isArray(candidate.attachments));
};

/** Resolves once the renderer origin holds the earlier file:// storage, or the attempt failed (it retries next launch). */
export const migrateFileOriginRendererStorage = async (options: RendererStorageMigrationOptions): Promise<void> => {
  const markerPath = join(options.userDataPath, MARKER_FILE_NAME);
  const localStorageMarkerPath = join(options.userDataPath, LOCAL_STORAGE_MARKER_FILE_NAME);
  if (existsSync(markerPath)) return;
  // A profile that never ran a renderer has no storage to move.
  if (!existsSync(join(options.userDataPath, "Local Storage")) && !existsSync(join(options.userDataPath, "IndexedDB"))) {
    writeFileSync(markerPath, "");
    return;
  }
  // Every file:// URL shares one storage origin, so any local page can read it.
  const exportPagePath = join(options.userDataPath, EXPORT_PAGE_FILE_NAME);
  let window: MigrationWindow | null = null;
  try {
    writeFileSync(exportPagePath, "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
    window = options.createWindow();
    await withTimeout(window.loadFile(exportPagePath), "Opening the earlier renderer storage");
    const exported = await withTimeout(window.webContents.executeJavaScript(EXPORT_SCRIPT, true), "Reading the earlier renderer storage");
    if (!isExportedStorage(exported)) throw new Error("The earlier renderer storage could not be read.");
    // After the renderer has run on the new origin, a missing key may be one the user removed
    // (a submitted draft), so localStorage is copied at most once, even if attachments fail.
    const copyLocalStorage = exported.localStorage.length > 0 && !existsSync(localStorageMarkerPath);
    if (copyLocalStorage || exported.attachments.length > 0) {
      await withTimeout(window.loadURL(RENDERER_BLANK_URL), "Opening the renderer origin");
      let keys = 0;
      if (copyLocalStorage) {
        const imported = await withTimeout(window.webContents.executeJavaScript(importLocalStorageScript(exported.localStorage), true), "Writing renderer localStorage");
        if (!isLocalStorageImport(imported)) throw new Error("Renderer localStorage could not be written.");
        keys = imported.keys;
        // Chromium writes storage lazily; persist it before a marker stops later attempts.
        window.webContents.session.flushStorageData();
        writeFileSync(localStorageMarkerPath, "");
        // Not retried: a retry would also restore keys removed since this copy. The entries stay in
        // the file:// storage, which had the same quota, so this needs data already on the new origin.
        if (imported.skipped > 0) {
          options.warn("Some renderer localStorage entries did not fit on the renderer origin and were not copied.", { skipped: imported.skipped });
        }
      }
      let attachments = 0;
      if (exported.attachments.length > 0) {
        attachments = Number(await withTimeout(window.webContents.executeJavaScript(importAttachmentsScript(exported.attachments), true), "Writing renderer attachments"));
        window.webContents.session.flushStorageData();
      }
      options.log("Moved renderer storage to the renderer origin.", { keys, attachments });
    }
    writeFileSync(markerPath, "");
    rmSync(localStorageMarkerPath, { force: true });
  } catch (error) {
    options.warn("Could not move renderer storage to the renderer origin; it will be retried on the next launch.", { error });
  } finally {
    window?.destroy();
    rmSync(exportPagePath, { force: true });
  }
};
