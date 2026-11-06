import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RunWorkspaceVcs } from "@buildwarden/shared";
import { FOLDER_WORKSPACE_IGNORED_NAMES } from "./folder-workspace-constants";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = "manifest.json";
const FILES_DIR = "files";

interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

interface WorkspaceLink {
  path: string;
  target: string;
}

interface WorkspaceManifest {
  version: 1;
  sourcePath: string;
  workspaceVcs: RunWorkspaceVcs;
  createdAt: string;
  entries: ManifestEntry[];
  unsupportedPaths: string[];
  /** Missing from baselines captured before link targets were recorded. */
  links?: WorkspaceLink[];
}

interface DeltaEntry {
  path: string;
  kind: "add" | "modify" | "delete";
  baselineHash: string | null;
  adoptedHash: string | null;
}

interface AdoptionBackup {
  version: 1;
  targetPath: string;
  createdAt: string;
  delta: DeltaEntry[];
}

const toPosix = (value: string): string => value.replace(/\\/g, "/");
const splitPath = (value: string): string[] => toPosix(value).split("/").filter(Boolean);
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const artifactFile = (root: string, relativePath: string): string => join(root, FILES_DIR, ...splitPath(relativePath));

const assertSafeRelativePath = (value: string): string => {
  const normalized = toPosix(value).replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe orchestration path: ${value}`);
  }
  const segments = splitPath(normalized);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe orchestration path: ${value}`);
  }
  return segments.join("/");
};

const resolveWithin = (root: string, relativePath: string): string => {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, ...splitPath(assertSafeRelativePath(relativePath)));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes its orchestration workspace: ${relativePath}`);
  }
  return resolved;
};

const listFolderFiles = async (
  root: string,
  current = root,
  files: string[] = [],
  unsupported: string[] = [],
): Promise<{ files: string[]; unsupported: string[] }> => {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (FOLDER_WORKSPACE_IGNORED_NAMES.has(entry.name)) continue;
    const absolutePath = join(current, entry.name);
    const relativePath = assertSafeRelativePath(relative(root, absolutePath));
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      unsupported.push(relativePath);
    } else if (stats.isDirectory()) {
      await listFolderFiles(root, absolutePath, files, unsupported);
    } else if (stats.isFile()) {
      files.push(relativePath);
    }
  }
  return { files, unsupported };
};

const listGitFiles = async (root: string): Promise<{ files: string[]; unsupported: string[] }> => {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "core.longpaths=true", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const files: string[] = [];
  const unsupported: string[] = [];
  for (const rawPath of Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean)) {
    const relativePath = assertSafeRelativePath(rawPath);
    // `--cached` still lists a tracked path that was deleted without being staged.
    const stats = await lstat(resolveWithin(root, relativePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (stats?.isSymbolicLink()) unsupported.push(relativePath);
    else if (stats?.isFile()) files.push(relativePath);
  }
  return { files, unsupported };
};

const listWorkspaceFiles = (root: string, workspaceVcs: RunWorkspaceVcs) =>
  workspaceVcs === "git" ? listGitFiles(root) : listFolderFiles(root);

const buildEntries = async (root: string, paths: string[]): Promise<ManifestEntry[]> => {
  const entries: ManifestEntry[] = [];
  for (const path of paths.toSorted((left, right) => left.localeCompare(right))) {
    const bytes = await readFile(resolveWithin(root, path));
    entries.push({ path, hash: hashBytes(bytes), size: bytes.byteLength });
  }
  return entries;
};

/** Absolute targets inside the workspace are stored relative, so separate checkouts compare equal. */
const normalizeLinkTarget = (root: string, target: string): string => {
  if (!isAbsolute(target)) return toPosix(target);
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return toPosix(resolvedTarget.startsWith(`${resolvedRoot}${sep}`) ? relative(resolvedRoot, resolvedTarget) : resolvedTarget);
};

const readLinks = async (root: string, paths: string[]): Promise<WorkspaceLink[]> => {
  const links: WorkspaceLink[] = [];
  for (const path of paths) {
    links.push({ path, target: normalizeLinkTarget(root, await readlink(resolveWithin(root, path))) });
  }
  return links;
};

/** Links cannot be adopted, so only the ones a child added, removed, or retargeted block it. */
const findChangedLinks = (manifest: WorkspaceManifest, childLinks: WorkspaceLink[]): string[] => {
  const baseline = new Map<string, string | null>(
    manifest.links?.map((link) => [link.path, link.target]) ?? manifest.unsupportedPaths.map((path) => [path, null]),
  );
  const child = new Map(childLinks.map((link) => [link.path, link.target]));
  return [...new Set([...baseline.keys(), ...child.keys()])]
    .filter((path) => {
      if (!baseline.has(path) || !child.has(path)) return true;
      const expected = baseline.get(path);
      return expected !== null && expected !== child.get(path);
    })
    .sort((left, right) => left.localeCompare(right));
};

const readManifest = async (baselinePath: string): Promise<WorkspaceManifest> => {
  const parsed = JSON.parse(await readFile(join(baselinePath, MANIFEST_NAME), "utf8")) as WorkspaceManifest;
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("The orchestration wave baseline is invalid.");
  }
  return parsed;
};

export const getOrchestrationArtifactRoot = (dbFilePath: string): string =>
  join(dirname(dbFilePath), "orchestrations");

export const captureOrchestrationBaseline = async (input: {
  workspacePath: string;
  workspaceVcs: RunWorkspaceVcs;
  artifactRoot: string;
  orchestrationId: string;
  waveId: string;
}): Promise<string> => {
  const workspacePath = resolve(input.workspacePath);
  const baselinePath = join(input.artifactRoot, input.orchestrationId, "waves", input.waveId, "baseline");
  await rm(baselinePath, { recursive: true, force: true });
  await mkdir(join(baselinePath, FILES_DIR), { recursive: true });
  const listed = await listWorkspaceFiles(workspacePath, input.workspaceVcs);
  const entries = await buildEntries(workspacePath, listed.files);
  for (const entry of entries) {
    const target = artifactFile(baselinePath, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolveWithin(workspacePath, entry.path), target);
  }
  const manifest: WorkspaceManifest = {
    version: 1,
    sourcePath: workspacePath,
    workspaceVcs: input.workspaceVcs,
    createdAt: new Date().toISOString(),
    entries,
    unsupportedPaths: listed.unsupported,
    links: await readLinks(workspacePath, listed.unsupported),
  };
  await writeFile(join(baselinePath, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");
  return baselinePath;
};

const calculateDelta = async (
  baselinePath: string,
  childPath: string,
): Promise<{ delta: DeltaEntry[]; unsupportedPaths: string[] }> => {
  const manifest = await readManifest(baselinePath);
  const listed = await listWorkspaceFiles(childPath, manifest.workspaceVcs);
  const childEntries = await buildEntries(childPath, listed.files);
  const baselineByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const childByPath = new Map(childEntries.map((entry) => [entry.path, entry]));
  const paths = new Set([...baselineByPath.keys(), ...childByPath.keys()]);
  const delta: DeltaEntry[] = [];
  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    const baseline = baselineByPath.get(path);
    const child = childByPath.get(path);
    if (baseline?.hash === child?.hash) continue;
    let kind: DeltaEntry["kind"] = "modify";
    if (!baseline) kind = "add";
    else if (!child) kind = "delete";
    delta.push({
      path,
      kind,
      baselineHash: baseline?.hash ?? null,
      adoptedHash: child?.hash ?? null,
    });
  }
  return {
    delta,
    unsupportedPaths: findChangedLinks(manifest, await readLinks(childPath, listed.unsupported)),
  };
};

const hashPath = async (path: string): Promise<string | null> => {
  if (!existsSync(path)) return null;
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) return "__unsupported__";
  return hashBytes(await readFile(path));
};

const findConflicts = async (
  targetPath: string,
  delta: DeltaEntry[],
): Promise<string[]> => {
  const conflicts: string[] = [];
  for (const entry of delta) {
    const currentHash = await hashPath(resolveWithin(targetPath, entry.path));
    if (currentHash !== entry.baselineHash) conflicts.push(entry.path);
  }
  return conflicts;
};

export const previewOrchestrationDelta = async (input: {
  baselinePath: string;
  childPath: string;
  targetPath: string;
}): Promise<{ changedFiles: string[]; conflicts: string[]; unsupportedPaths: string[] }> => {
  const { delta, unsupportedPaths } = await calculateDelta(input.baselinePath, input.childPath);
  return {
    changedFiles: delta.map((entry) => entry.path),
    conflicts: await findConflicts(input.targetPath, delta),
    unsupportedPaths,
  };
};

/**
 * Brings a freshly provisioned child workspace back to its wave's baseline. Children are cloned
 * from the live coordinator workspace, which may have moved on since the wave was delegated (for
 * example a sibling was adopted while this task was queued). Without this, those unrelated
 * changes would count as the child's own work and show up as adoption conflicts.
 */
export const restoreOrchestrationBaseline = async (input: {
  baselinePath: string;
  workspacePath: string;
}): Promise<void> => {
  const { delta } = await calculateDelta(input.baselinePath, input.workspacePath);
  for (const entry of delta) {
    const target = resolveWithin(input.workspacePath, entry.path);
    if (entry.kind === "add") {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(artifactFile(input.baselinePath, entry.path), target);
    }
  }
};

const restoreBackup = async (backupPath: string, targetPath: string, backup: AdoptionBackup): Promise<void> => {
  for (const entry of backup.delta) {
    const target = resolveWithin(targetPath, entry.path);
    if (entry.baselineHash === null) {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(artifactFile(backupPath, entry.path), target);
    }
  }
};

export const applyOrchestrationDelta = async (input: {
  baselinePath: string;
  childPath: string;
  targetPath: string;
  backupPath: string;
}): Promise<void> => {
  const { delta, unsupportedPaths } = await calculateDelta(input.baselinePath, input.childPath);
  if (unsupportedPaths.length > 0) {
    throw new Error(`Symlink adoption is unsupported: ${unsupportedPaths.join(", ")}`);
  }
  const conflicts = await findConflicts(input.targetPath, delta);
  if (conflicts.length > 0) {
    throw new Error(`The coordinator workspace changed since delegation: ${conflicts.join(", ")}`);
  }

  await rm(input.backupPath, { recursive: true, force: true });
  await mkdir(join(input.backupPath, FILES_DIR), { recursive: true });
  const backup: AdoptionBackup = {
    version: 1,
    targetPath: resolve(input.targetPath),
    createdAt: new Date().toISOString(),
    delta,
  };
  for (const entry of delta) {
    if (entry.baselineHash === null) continue;
    const destination = artifactFile(input.backupPath, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveWithin(input.targetPath, entry.path), destination);
  }
  await writeFile(join(input.backupPath, MANIFEST_NAME), JSON.stringify(backup, null, 2), "utf8");

  try {
    for (const entry of delta) {
      const target = resolveWithin(input.targetPath, entry.path);
      if (entry.kind === "delete") {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(resolveWithin(input.childPath, entry.path), target);
      }
    }
  } catch (error) {
    await restoreBackup(input.backupPath, input.targetPath, backup).catch(() => undefined);
    throw error;
  }
};

export const undoOrchestrationDelta = async (input: {
  backupPath: string;
  targetPath: string;
}): Promise<void> => {
  const backup = JSON.parse(await readFile(join(input.backupPath, MANIFEST_NAME), "utf8")) as AdoptionBackup;
  if (backup?.version !== 1 || !Array.isArray(backup.delta)) {
    throw new Error("The orchestration adoption backup is invalid.");
  }
  const changedAfterAdoption: string[] = [];
  for (const entry of backup.delta) {
    const currentHash = await hashPath(resolveWithin(input.targetPath, entry.path));
    if (currentHash !== entry.adoptedHash) changedAfterAdoption.push(entry.path);
  }
  if (changedAfterAdoption.length > 0) {
    throw new Error(`Adopted files changed after adoption: ${changedAfterAdoption.join(", ")}`);
  }
  await restoreBackup(input.backupPath, input.targetPath, backup);
};

export const removeOwnedOrchestrationArtifact = async (
  artifactRoot: string,
  ownedPath: string,
): Promise<void> => {
  const root = resolve(artifactRoot);
  const target = resolve(ownedPath);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to delete an unowned orchestration artifact path: ${ownedPath}`);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
};
