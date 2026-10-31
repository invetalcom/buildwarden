import { constants, enableCompileCache, flushCompileCache } from "node:module";
import { resolve } from "node:path";

let cacheDirectory: string | undefined;

/** Optional acceleration: cache failures must never prevent startup or a run. */
export const enableCompileCacheSafely = (directory: unknown): string | undefined => {
  if (typeof directory !== "string" || !directory.trim() || process.env.NODE_DISABLE_COMPILE_CACHE === "1") return;
  try {
    const absoluteDirectory = resolve(directory);
    // Leave room for Node's version subdirectory and cache filenames. Some Node
    // 24 builds can hang creating cache paths near Windows MAX_PATH.
    if (process.platform === "win32" && absoluteDirectory.length > 180) return;
    const result = enableCompileCache(absoluteDirectory);
    if (result.status === constants.compileCacheStatus.ENABLED || result.status === constants.compileCacheStatus.ALREADY_ENABLED) {
      cacheDirectory = result.directory ?? absoluteDirectory;
    }
  } catch {
    // Read-only directories and unsupported runtimes fall back to normal loading.
  }
  return cacheDirectory;
};

/** Passed explicitly to app workers; do not alter the environment of provider CLIs. */
export const getCompileCacheWorkerData = (): { compileCacheDirectory?: string } =>
  cacheDirectory ? { compileCacheDirectory: cacheDirectory } : {};

export const flushCompileCacheSafely = (): void => {
  if (!cacheDirectory) return;
  try {
    flushCompileCache();
  } catch {
    // A lost cache entry only costs compilation on the next load.
  }
};
