import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Delete only owned sibling cache directories, never links or the active cache. */
export const pruneCompileCaches = async (root: string, activeName: string): Promise<void> => {
  const absoluteRoot = resolve(root);
  try {
    for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
      if (entry.name.includes("/") || entry.name.includes("\\") || !entry.isDirectory() || entry.isSymbolicLink() || entry.name === activeName) continue;
      if (!/^(app-|dev-|v?\d+\.\d+\.\d+-)/.test(entry.name)) continue;
      const target = resolve(join(absoluteRoot, entry.name));
      if (dirname(target) !== absoluteRoot) continue;
      await rm(target, { recursive: true, force: true });
    }
  } catch {
    // Cleanup is optional, including when another app instance uses a cache.
  }
};
