import { accessSync, constants, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/**
 * The executable a restart's `spawn(program, …, { cwd })` would start: a program with a slash is
 * taken relative to `cwd`, a bare name is searched in `PATH`, where an empty entry (leading,
 * trailing, or `::`) and a relative one mean the working folder, as for execvp. Null when nothing
 * executable is found.
 */
export const resolveLaunchProgram = (program: string, cwd: string, pathEnv = process.env.PATH ?? ""): string | null => {
  const candidates = program.includes("/")
    ? [resolve(cwd, program)]
    : pathEnv.split(delimiter).map((directory) => resolve(cwd, directory, program));
  for (const candidate of candidates) {
    try {
      // A searchable directory passes the X_OK check too; execvp skips it and keeps looking.
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return null;
};

/**
 * Whether `program`, the first live argument of `pid`, starts the executable that is running as
 * `pid` (`/proc/<pid>/exe`). A `process.title` that fills the argument area exactly reads like a
 * real one-argument argv; it names no program, or another one, so it fails this check.
 */
export const isLinuxLaunchProgram = (pid: number, program: string, cwd: string): boolean => {
  let executable: string;
  try {
    executable = readlinkSync(`/proc/${String(pid)}/exe`);
  } catch {
    return false;
  }
  // The binary was replaced or removed since the process started; starting it again would differ.
  if (executable.endsWith(" (deleted)")) return false;
  return resolveLaunchProgram(program, cwd) === executable;
};
