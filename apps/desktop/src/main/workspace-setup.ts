import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HarnessRunChunk, WorkspaceSetupProfile } from "@buildwarden/shared";
import { runProjectVerificationCommand } from "./project-verification";

const contained = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
};

/** Explicit file allowlist; never copy through a symlink or overwrite workspace files. */
export const copyWorkspaceEnvironmentFile = async (sourceRoot: string, targetRoot: string, file: string): Promise<void> => {
  if (isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "node_modules")) {
    throw new Error("Environment files must be workspace-relative files outside .git and node_modules.");
  }
  const sourceBase = await realpath(sourceRoot);
  const targetBase = await realpath(targetRoot);
  const namedSource = resolve(sourceBase, file);
  if (!contained(sourceBase, namedSource)) throw new Error("Environment file escapes the workspace.");
  for (let component = namedSource; component !== sourceBase; component = dirname(component)) {
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Environment source must not contain symlinks.");
  }
  const source = await realpath(resolve(sourceBase, file));
  const target = resolve(targetBase, file);
  if (!contained(sourceBase, source) || !contained(targetBase, target) || !(await lstat(source)).isFile()) throw new Error("Environment file escapes the workspace or is not a file.");
  // Check every existing destination ancestor before creating missing directories.
  let parent = dirname(target);
  while (parent !== targetBase) {
    try {
      if (!contained(targetBase, await realpath(parent))) throw new Error("Environment destination escapes the workspace.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    parent = dirname(parent);
  }
  await mkdir(dirname(target), { recursive: true });
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
};

export const runWorkspaceSetup = async (input: {
  profile: WorkspaceSetupProfile;
  sourcePath: string;
  workspacePath: string;
  git: boolean;
  signal: AbortSignal;
  onChunk: (chunk: HarnessRunChunk) => void;
}): Promise<void> => {
  const { profile, signal, onChunk } = input;
  const emit = (status: "running" | "completed" | "failed", title: string, value: string) => onChunk({
    type: "status", title, value, metadata: { workspaceSetup: true, setupStatus: status, profileId: profile.id },
  });
  try {
    signal.throwIfAborted();
    emit("running", `Workspace setup: ${profile.name}`, "Preparing the workspace before starting the agent.");
    for (const file of profile.environmentFiles) {
      signal.throwIfAborted();
      await copyWorkspaceEnvironmentFile(input.sourcePath, input.workspacePath, file);
      emit("running", "Environment file ready", file);
    }
    const commands = [
      ...(input.git && profile.submodules !== "none" ? [`git submodule update --init${profile.submodules === "recursive" ? " --recursive" : ""}`] : []),
      ...profile.commands,
    ];
    for (const [index, command] of commands.entries()) {
      signal.throwIfAborted();
      emit("running", `Setup command ${index + 1}/${commands.length}`, command);
      const result = await runProjectVerificationCommand(input.workspacePath, command, 5 * 60_000, signal);
      // Commands can print credentials; do not persist their output in activity history.
      if (!result.ok) throw new Error(`Setup command ${index + 1} ${result.timedOut ? "timed out" : "failed"} (exit ${result.exitCode ?? "none"}). Check the command in project settings and retry setup.`);
      emit("running", `Setup command ${index + 1} passed`, command);
    }
    signal.throwIfAborted();
    emit("completed", "Workspace setup complete", profile.name);
  } catch (error) {
    emit("failed", signal.aborted ? "Workspace setup cancelled" : "Workspace setup failed", error instanceof Error ? error.message : "Setup failed.");
    throw error;
  }
};
