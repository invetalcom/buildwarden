import { workerData } from "node:worker_threads";
import { enableCompileCacheSafely, flushCompileCacheSafely } from "./compile-cache";

export const loadCachedWorker = async (load: () => Promise<unknown>): Promise<void> => {
  const data = workerData as { compileCacheDirectory?: unknown } | null;
  enableCompileCacheSafely(data?.compileCacheDirectory);
  try {
    await load();
  } finally {
    // Workers are explicitly terminated by the host, so do not rely on exit.
    flushCompileCacheSafely();
  }
};
