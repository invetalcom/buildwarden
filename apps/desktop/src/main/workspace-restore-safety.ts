import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve aliases even when the final directory was removed or has not been created yet. */
export const canonicalWorkspacePath = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalWorkspacePath(parent), basename(absolute));
  }
};

export const workspacePathsOverlap = (left: string, right: string): boolean => {
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  const a = canonicalWorkspacePath(left);
  const b = canonicalWorkspacePath(right);
  return contains(a, b) || contains(b, a);
};
