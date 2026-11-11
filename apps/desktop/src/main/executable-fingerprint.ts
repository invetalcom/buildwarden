import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The file a command name starts, found the way a shell would: an absolute path as it is, a bare
 * name on PATH (with PATHEXT extensions on Windows). A relative path depends on the working
 * directory the agent starts in, so it is not resolved.
 */
export const resolveExecutable = (
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const extensions = platform === "win32" && !extname(command)
    ? ["", ...(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const candidates = (base: string) => extensions.map((extension) => `${base}${extension}`);
  if (isAbsolute(command)) return candidates(command).find(isFile) ?? null;
  if (/[\\/]/.test(command)) return null;
  const path = env.PATH ?? env.Path ?? "";
  for (const directory of path.split(platform === "win32" ? ";" : delimiter)) {
    if (!directory) continue;
    const found = candidates(join(directory, command)).find(isFile);
    if (found) return found;
  }
  return null;
};

/**
 * Identifies the installed build of a command: its resolved path, size and modification time.
 * Installing another version changes it, so facts learned from the old build can be dropped.
 * Null when the command cannot be found.
 */
export const executableFingerprint = (
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const path = resolveExecutable(command, env, platform);
  if (!path) return null;
  try {
    const stats = statSync(path);
    return `${path}|${String(stats.size)}|${String(Math.trunc(stats.mtimeMs))}`;
  } catch {
    return null;
  }
};
