import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { FOLDER_WORKSPACE_IGNORED_NAMES, MANAGED_WORKSPACE_DIR } from "./folder-workspace-constants";

const sanitizeWorkspaceSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const getManagedFolderWorkspaceRoot = (
  sourcePath: string,
  projectName: string,
  configuredWorkspaceRoot?: string | null,
): string => {
  const rootContainer = configuredWorkspaceRoot?.trim() || dirname(sourcePath);
  const projectSegment = sanitizeWorkspaceSegment(projectName || basename(sourcePath)) || "project";
  return join(rootContainer, MANAGED_WORKSPACE_DIR, projectSegment);
};

const isPathWithin = (candidate: string, parent: string): boolean => {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`);
};

const copyDirectoryContents = async (sourcePath: string, targetPath: string): Promise<void> => {
  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (FOLDER_WORKSPACE_IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const sourceEntryPath = join(sourcePath, entry.name);
    const targetEntryPath = join(targetPath, entry.name);
    const sourceStats = await lstat(sourceEntryPath);
    if (sourceStats.isSymbolicLink()) {
      try {
        const linkTarget = await readlink(sourceEntryPath);
        await symlink(linkTarget, targetEntryPath);
      } catch {
        // Symlink creation can require extra Windows privileges; skipping is safer than following outside the project.
      }
      continue;
    }

    if (sourceStats.isDirectory()) {
      await copyDirectoryContents(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (sourceStats.isFile()) {
      await mkdir(dirname(targetEntryPath), { recursive: true });
      await copyFile(sourceEntryPath, targetEntryPath);
    }
  }
};

export const createFolderWorkspaceCopy = async (input: {
  sourcePath: string;
  projectName: string;
  runId: string;
  configuredWorkspaceRoot?: string | null;
}): Promise<{ branchName: string; worktreePath: string }> => {
  const sourcePath = resolve(input.sourcePath);
  const workspaceRoot = getManagedFolderWorkspaceRoot(sourcePath, input.projectName, input.configuredWorkspaceRoot);
  const branchName = `${sanitizeWorkspaceSegment(input.projectName) || "project"}-${sanitizeWorkspaceSegment(input.runId) || "run"}`;
  const worktreePath = join(workspaceRoot, branchName);

  if (isPathWithin(workspaceRoot, sourcePath)) {
    throw new Error("The managed workspace root cannot be inside the source project folder.");
  }
  if (existsSync(worktreePath)) {
    throw new Error(`A copied workspace already exists at ${worktreePath}.`);
  }

  await mkdir(workspaceRoot, { recursive: true });
  await copyDirectoryContents(sourcePath, worktreePath);
  return { branchName, worktreePath };
};

export const removeFolderWorkspaceCopy = async (worktreePath: string): Promise<void> => {
  const resolvedPath = resolve(worktreePath);
  const segments = resolvedPath.split(/[\\/]+/);
  if (!segments.includes(MANAGED_WORKSPACE_DIR)) {
    throw new Error("Refusing to delete a folder workspace outside BuildWarden's managed workspace directory.");
  }
  await rm(resolvedPath, { recursive: true, force: true, maxRetries: 3 });
};
