import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import type { HostDirectoryBrowseInput, HostDirectoryListing } from "@buildwarden/shared";

const MAX_DIRECTORY_ENTRIES = 500;

const windowsRoots = async (): Promise<string[]> => {
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const roots = await Promise.all(candidates.map(async (candidate) => {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      return null;
    }
  }));
  return roots.filter((root): root is string => root != null);
};

export class HostDirectoryService {
  async list(input?: HostDirectoryBrowseInput): Promise<HostDirectoryListing> {
    const requestedPath = input?.path?.trim();
    if (!requestedPath) {
      const roots = process.platform === "win32" ? await windowsRoots() : ["/"];
      return {
        path: null,
        parentPath: null,
        entries: roots.map((path) => ({ name: path, path })),
      };
    }
    if (!isAbsolute(requestedPath)) throw new Error("Host directory paths must be absolute.");
    const path = resolve(requestedPath);
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) throw new Error("The host path is not a directory.");
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({ name: entry.name, path: resolve(path, entry.name) }));
    const root = parse(path).root;
    return {
      path,
      parentPath: path === root ? null : dirname(path),
      entries,
    };
  }
}
