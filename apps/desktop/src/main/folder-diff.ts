import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { FOLDER_WORKSPACE_IGNORED_NAMES } from "./folder-workspace-constants";

const MAX_TEXT_SNAPSHOT_BYTES = 512 * 1024;
const MANIFEST_FILE = "manifest.json";
const FILES_DIR = "files";

type SnapshotEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  hash?: string;
  textSnapshotPath?: string;
  kind: "text" | "binary" | "large";
};

type FolderSnapshotManifest = {
  rootPath: string;
  createdAt: string;
  entries: SnapshotEntry[];
};

type CurrentFile = {
  absolutePath: string;
  path: string;
  size: number;
  mtimeMs: number;
  hash?: string;
  text?: string;
  kind: "text" | "binary" | "large";
};

const snapshotDir = (snapshotsRoot: string, runId: string): string => join(snapshotsRoot, runId);
const manifestPath = (snapshotsRoot: string, runId: string): string => join(snapshotDir(snapshotsRoot, runId), MANIFEST_FILE);
const toPosix = (value: string): string => value.replace(/\\/g, "/");
const splitRelativePath = (value: string): string[] => toPosix(value).split("/").filter(Boolean);
const snapshotFilePath = (snapshotsRoot: string, runId: string, relativePath: string): string =>
  join(snapshotDir(snapshotsRoot, runId), FILES_DIR, ...splitRelativePath(relativePath));

const looksText = (bytes: Buffer): boolean => !bytes.includes(0);
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const readCurrentFile = async (rootPath: string, absolutePath: string): Promise<CurrentFile> => {
  const stats = await lstat(absolutePath);
  const rel = toPosix(relative(rootPath, absolutePath));
  if (stats.size > MAX_TEXT_SNAPSHOT_BYTES) {
    return {
      absolutePath,
      path: rel,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      kind: "large",
    };
  }

  const bytes = await readFile(absolutePath);
  if (!looksText(bytes)) {
    return {
      absolutePath,
      path: rel,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: hashBytes(bytes),
      kind: "binary",
    };
  }

  return {
    absolutePath,
    path: rel,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    hash: hashBytes(bytes),
    text: bytes.toString("utf8"),
    kind: "text",
  };
};

const scanFiles = async (rootPath: string, currentPath = rootPath, files: CurrentFile[] = []): Promise<CurrentFile[]> => {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (FOLDER_WORKSPACE_IGNORED_NAMES.has(entry.name)) {
      continue;
    }
    const absolutePath = join(currentPath, entry.name);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await scanFiles(rootPath, absolutePath, files);
      continue;
    }
    if (stats.isFile()) {
      files.push(await readCurrentFile(rootPath, absolutePath));
    }
  }
  return files;
};

export const getFolderSnapshotRoot = (dbFilePath: string): string => join(dirname(dbFilePath), "folder-run-snapshots");

export const createFolderSnapshot = async (input: {
  runId: string;
  workspacePath: string;
  snapshotsRoot: string;
}): Promise<void> => {
  const rootPath = resolve(input.workspacePath);
  const runSnapshotDir = snapshotDir(input.snapshotsRoot, input.runId);
  await rm(runSnapshotDir, { recursive: true, force: true });
  await mkdir(join(runSnapshotDir, FILES_DIR), { recursive: true });

  const files = await scanFiles(rootPath);
  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    const textSnapshotPath = file.kind === "text" ? join(FILES_DIR, ...splitRelativePath(file.path)) : undefined;
    if (file.kind === "text") {
      const targetPath = snapshotFilePath(input.snapshotsRoot, input.runId, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(file.absolutePath, targetPath);
    }
    entries.push({
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash: file.hash,
      textSnapshotPath,
      kind: file.kind,
    });
  }

  const manifest: FolderSnapshotManifest = {
    rootPath,
    createdAt: new Date().toISOString(),
    entries,
  };
  await writeFile(manifestPath(input.snapshotsRoot, input.runId), JSON.stringify(manifest, null, 2), "utf8");
};

const readManifest = async (snapshotsRoot: string, runId: string): Promise<FolderSnapshotManifest | null> => {
  const path = manifestPath(snapshotsRoot, runId);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as FolderSnapshotManifest;
  return parsed && Array.isArray(parsed.entries) ? parsed : null;
};

const hasNonTextChange = (entry: SnapshotEntry, current: CurrentFile): boolean => {
  if (entry.kind === "large" || current.kind === "large") {
    return entry.size !== current.size || Math.trunc(entry.mtimeMs) !== Math.trunc(current.mtimeMs);
  }
  return entry.hash !== current.hash || entry.kind !== current.kind;
};

const makePatch = (relativePath: string, oldText: string, newText: string): string => {
  const patch = createTwoFilesPatch(`a/${relativePath}`, `b/${relativePath}`, oldText, newText, "", "", { context: 3 });
  return patch.trim();
};

const diffBaselineEntry = async (entry: SnapshotEntry, current: CurrentFile | undefined, snapshotPath: string): Promise<string | null> => {
  if (!current) {
    if (entry.kind !== "text" || !entry.textSnapshotPath) return `# Deleted ${entry.kind} file: ${entry.path}`;
    const oldText = await readFile(join(snapshotPath, entry.textSnapshotPath), "utf8");
    return makePatch(entry.path, oldText, "") || null;
  }
  if (entry.kind === "text" && current.kind === "text" && entry.textSnapshotPath && entry.hash !== current.hash) {
    const oldText = await readFile(join(snapshotPath, entry.textSnapshotPath), "utf8");
    return makePatch(entry.path, oldText, current.text ?? "") || null;
  }
  return hasNonTextChange(entry, current) ? `# Changed ${current.kind} file: ${entry.path}` : null;
};

const diffCreatedFile = (current: CurrentFile): string => {
  if (current.kind === "text") return makePatch(current.path, "", current.text ?? "");
  return `# Created ${current.kind} file: ${current.path}`;
};

export const diffFolderAgainstSnapshot = async (input: {
  runId: string;
  workspacePath: string;
  snapshotsRoot: string;
}): Promise<{ diff: string; missingSnapshot: boolean }> => {
  const manifest = await readManifest(input.snapshotsRoot, input.runId);
  if (!manifest) {
    return { diff: "", missingSnapshot: true };
  }

  const currentFiles = await scanFiles(resolve(input.workspacePath));
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const baselineByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const chunks: string[] = [];
  const snapshotPath = snapshotDir(input.snapshotsRoot, input.runId);

  for (const entry of manifest.entries) {
    const chunk = await diffBaselineEntry(entry, currentByPath.get(entry.path), snapshotPath);
    if (chunk) chunks.push(chunk);
  }

  for (const current of currentFiles) {
    if (baselineByPath.has(current.path)) {
      continue;
    }
    const chunk = diffCreatedFile(current);
    if (chunk) chunks.push(chunk);
  }

  return { diff: chunks.filter(Boolean).join("\n\n"), missingSnapshot: false };
};

export const deleteFolderSnapshot = async (snapshotsRoot: string, runId: string): Promise<void> => {
  await rm(snapshotDir(snapshotsRoot, runId), { recursive: true, force: true });
};
