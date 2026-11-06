import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RunWorkspaceVcs } from "@buildwarden/shared";
import { FOLDER_WORKSPACE_IGNORED_NAMES } from "./folder-workspace-constants";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = "manifest.json";
const FILES_DIR = "files";
const BLOBS_DIR = "blobs";
const MERGE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
  /** Version 1 keeps a copy of every file per wave; version 2 shares one content store per orchestration. */
  version: 1 | 2;
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

/** Waves mostly repeat the same files, so an orchestration stores each distinct content once. */
const blobFile = (orchestrationRoot: string, hash: string): string =>
  join(orchestrationRoot, BLOBS_DIR, hash.slice(0, 2), hash);

/** A baseline lives at `<orchestration>/waves/<wave>/baseline`. */
const orchestrationRootOfBaseline = (baselinePath: string): string => resolve(baselinePath, "..", "..", "..");

const baselineFile = (baselinePath: string, manifest: WorkspaceManifest, entry: ManifestEntry): string =>
  manifest.version === 1
    ? artifactFile(baselinePath, entry.path)
    : blobFile(orchestrationRootOfBaseline(baselinePath), entry.hash);

const storeBlob = async (orchestrationRoot: string, hash: string, bytes: Buffer): Promise<void> => {
  const target = blobFile(orchestrationRoot, hash);
  if (existsSync(target)) return;
  await mkdir(dirname(target), { recursive: true });
  // Written aside first, so a crash cannot leave a partial file under its content hash.
  const partial = `${target}.${randomUUID()}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
};

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

const buildEntries = async (
  root: string,
  paths: string[],
  onFile?: (hash: string, bytes: Buffer) => Promise<void>,
): Promise<ManifestEntry[]> => {
  const entries: ManifestEntry[] = [];
  for (const path of paths.toSorted((left, right) => left.localeCompare(right))) {
    const bytes = await readFile(resolveWithin(root, path));
    const hash = hashBytes(bytes);
    entries.push({ path, hash, size: bytes.byteLength });
    await onFile?.(hash, bytes);
  }
  return entries;
};

/** Absolute targets inside a root are stored relative to it, so separate checkouts compare equal. */
const normalizeLinkTarget = (roots: string[], target: string): string => {
  if (!isAbsolute(target)) return toPosix(target);
  const resolvedTarget = resolve(target);
  const root = roots.map((path) => resolve(path)).find((path) => resolvedTarget.startsWith(`${path}${sep}`));
  return toPosix(root ? relative(root, resolvedTarget) : resolvedTarget);
};

const readLinks = async (root: string, paths: string[], sourceRoot?: string): Promise<WorkspaceLink[]> => {
  const links: WorkspaceLink[] = [];
  for (const path of paths) {
    const roots = sourceRoot ? [root, sourceRoot] : [root];
    links.push({ path, target: normalizeLinkTarget(roots, await readlink(resolveWithin(root, path))) });
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
  if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.entries)) {
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
  const orchestrationRoot = join(input.artifactRoot, input.orchestrationId);
  const baselinePath = join(orchestrationRoot, "waves", input.waveId, "baseline");
  await rm(baselinePath, { recursive: true, force: true });
  await mkdir(baselinePath, { recursive: true });
  const listed = await listWorkspaceFiles(workspacePath, input.workspaceVcs);
  const entries = await buildEntries(workspacePath, listed.files, (hash, bytes) => storeBlob(orchestrationRoot, hash, bytes));
  const manifest: WorkspaceManifest = {
    version: 2,
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
): Promise<{ manifest: WorkspaceManifest; delta: DeltaEntry[]; unsupportedPaths: string[] }> => {
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
    manifest,
    delta,
    // A copied child keeps absolute targets that still point into the coordinator.
    unsupportedPaths: findChangedLinks(manifest, await readLinks(childPath, listed.unsupported, manifest.sourcePath)),
  };
};

const hashPath = async (path: string): Promise<string | null> => {
  if (!existsSync(path)) return null;
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) return "__unsupported__";
  return hashBytes(await readFile(path));
};

/**
 * Three-way merge of one file. Null means the edits overlap, a file is binary, or git is
 * unavailable. `git merge-file` reads the three paths directly and needs no repository.
 */
const mergeFile = async (targetFile: string, baseFile: string, childFile: string): Promise<Buffer | null> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["merge-file", "-p", targetFile, baseFile, childFile],
      { cwd: dirname(targetFile), encoding: "buffer", maxBuffer: MERGE_MAX_BUFFER_BYTES },
    );
    return Buffer.from(stdout);
  } catch {
    return null;
  }
};

interface AdoptionPlan {
  /** What adoption writes, with `baselineHash` as the target's content before it does. */
  writes: Array<DeltaEntry & { merged?: Buffer }>;
  conflicts: string[];
  autoMerged: string[];
}

/**
 * Compares each child change with the coordinator's current file. A file the coordinator left
 * alone takes the child's version, an identical change needs no write, and edits on both sides
 * of a text file merge when they do not overlap.
 */
const planAdoption = async (
  baselinePath: string,
  manifest: WorkspaceManifest,
  childPath: string,
  targetPath: string,
  delta: DeltaEntry[],
): Promise<AdoptionPlan> => {
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const plan: AdoptionPlan = { writes: [], conflicts: [], autoMerged: [] };
  for (const entry of delta) {
    const target = resolveWithin(targetPath, entry.path);
    const currentHash = await hashPath(target);
    if (currentHash === entry.adoptedHash) continue;
    if (currentHash === entry.baselineHash) {
      plan.writes.push(entry);
      continue;
    }
    const baseline = entries.get(entry.path);
    const merged = entry.kind === "modify" && baseline && currentHash !== null && currentHash !== "__unsupported__"
      ? await mergeFile(target, baselineFile(baselinePath, manifest, baseline), resolveWithin(childPath, entry.path))
      : null;
    if (!merged) {
      plan.conflicts.push(entry.path);
      continue;
    }
    plan.autoMerged.push(entry.path);
    plan.writes.push({ ...entry, baselineHash: currentHash, adoptedHash: hashBytes(merged), merged });
  }
  return plan;
};

export const previewOrchestrationDelta = async (input: {
  baselinePath: string;
  childPath: string;
  targetPath: string;
}): Promise<{ changedFiles: string[]; conflicts: string[]; autoMerged: string[]; unsupportedPaths: string[] }> => {
  const { manifest, delta, unsupportedPaths } = await calculateDelta(input.baselinePath, input.childPath);
  const plan = await planAdoption(input.baselinePath, manifest, input.childPath, input.targetPath, delta);
  return {
    changedFiles: delta.map((entry) => entry.path),
    conflicts: plan.conflicts,
    autoMerged: plan.autoMerged,
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
  const { manifest, delta } = await calculateDelta(input.baselinePath, input.workspacePath);
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const entry of delta) {
    const target = resolveWithin(input.workspacePath, entry.path);
    const baseline = entries.get(entry.path);
    if (!baseline) {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(baselineFile(input.baselinePath, manifest, baseline), target);
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
  const { manifest, delta, unsupportedPaths } = await calculateDelta(input.baselinePath, input.childPath);
  if (unsupportedPaths.length > 0) {
    throw new Error(`Symlink adoption is unsupported: ${unsupportedPaths.join(", ")}`);
  }
  const { writes, conflicts } = await planAdoption(input.baselinePath, manifest, input.childPath, input.targetPath, delta);
  if (conflicts.length > 0) {
    throw new Error(`The coordinator workspace changed since delegation: ${conflicts.join(", ")}`);
  }

  await rm(input.backupPath, { recursive: true, force: true });
  await mkdir(join(input.backupPath, FILES_DIR), { recursive: true });
  const backup: AdoptionBackup = {
    version: 1,
    targetPath: resolve(input.targetPath),
    createdAt: new Date().toISOString(),
    // A file that already matched is not this adoption's to undo.
    delta: writes.map(({ path, kind, baselineHash, adoptedHash }) => ({ path, kind, baselineHash, adoptedHash })),
  };
  for (const entry of writes) {
    if (entry.baselineHash === null) continue;
    const destination = artifactFile(input.backupPath, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveWithin(input.targetPath, entry.path), destination);
  }
  await writeFile(join(input.backupPath, MANIFEST_NAME), JSON.stringify(backup, null, 2), "utf8");

  try {
    for (const entry of writes) {
      const target = resolveWithin(input.targetPath, entry.path);
      if (entry.kind === "delete") {
        await rm(target, { force: true });
      } else if (entry.merged) {
        await writeFile(target, entry.merged);
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
