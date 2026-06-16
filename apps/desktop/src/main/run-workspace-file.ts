import { existsSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseRunWorkspaceFileReference, type RunWorkspaceFileResult } from "@buildwarden/shared";

export const MAX_RUN_WORKSPACE_FILE_PREVIEW_BYTES = 1_000_000;

export const isPathInsideRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const normalizeWorkspaceRelativePath = (root: string, target: string): string =>
  (relative(root, target).replace(/\\/g, "/") || ".").replace(/^\.\//, "");

export const readRunWorkspaceFileForPreview = async ({
  workspacePath,
  requestedPath,
}: {
  workspacePath: string;
  requestedPath: string;
}): Promise<RunWorkspaceFileResult> => {
  const parsed = parseRunWorkspaceFileReference(requestedPath);

  const unavailable = (
    path: string,
    unavailableReason: RunWorkspaceFileResult["unavailableReason"],
    error?: string,
  ): RunWorkspaceFileResult => ({
    path,
    requestedPath,
    workspacePath,
    content: null,
    sizeBytes: null,
    truncated: false,
    line: parsed?.line ?? null,
    column: parsed?.column ?? null,
    unavailableReason,
    ...(error ? { error } : {}),
  });

  if (!parsed) {
    return unavailable("", "empty-path", "Path is empty or unsupported.");
  }

  const workspaceRoot = resolve(workspacePath);
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    return unavailable(parsed.path, "workspace-unavailable", "The run workspace is no longer available.");
  }

  const target = resolve(workspaceRoot, parsed.path || ".");
  if (!isPathInsideRoot(workspaceRoot, target)) {
    return unavailable(parsed.path, "outside-workspace", "Path is outside the run workspace.");
  }

  if (!existsSync(target)) {
    return unavailable(normalizeWorkspaceRelativePath(workspaceRoot, target), "not-found", "File does not exist.");
  }

  const workspaceRootReal = await realpath(workspaceRoot);
  const targetReal = await realpath(target);
  if (!isPathInsideRoot(workspaceRootReal, targetReal)) {
    return unavailable(parsed.path, "outside-workspace", "Path resolves outside the run workspace.");
  }

  const stat = statSync(targetReal);
  const relativePath = normalizeWorkspaceRelativePath(workspaceRootReal, targetReal);
  if (stat.isDirectory()) {
    return unavailable(relativePath, "directory", "Path points to a directory.");
  }
  if (!stat.isFile()) {
    return unavailable(relativePath, "binary", "Path is not a regular text file.");
  }

  const byteLength = Math.min(stat.size, MAX_RUN_WORKSPACE_FILE_PREVIEW_BYTES);
  const buffer = Buffer.alloc(byteLength);
  if (byteLength > 0) {
    const handle = await open(targetReal, "r");
    try {
      await handle.read(buffer, 0, byteLength, 0);
    } finally {
      await handle.close();
    }
  }

  const sniffLength = Math.min(buffer.length, 8_000);
  if (buffer.subarray(0, sniffLength).includes(0)) {
    return unavailable(relativePath, "binary", "Binary files are not shown in the inline viewer.");
  }

  return {
    path: relativePath,
    requestedPath,
    workspacePath,
    content: buffer.toString("utf8"),
    sizeBytes: stat.size,
    truncated: stat.size > byteLength,
    line: parsed.line,
    column: parsed.column,
  };
};
