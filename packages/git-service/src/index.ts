import { existsSync, mkdirSync } from "node:fs";
import { access, copyFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { promisify } from "node:util";
import {
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  type GitProjectValidation,
  type ProjectGitBranchInfo,
  type ProjectGitBranchOverview,
  type WorktreeInfo,
} from "@buildwarden/shared";
import { parseGitRemoteToWebBase, type ParsedGitRemote } from "./remote-parse.js";

const sanitizeSegment = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const execFileAsync = promisify(execFile);
const LONG_PATHS_CONFIG_KEY = "core.longpaths";
const LONG_PATHS_CONFIG_VALUE = "true";

const withLongPathSupport = (args: string[]): string[] =>
  process.platform === "win32" ? ["-c", `${LONG_PATHS_CONFIG_KEY}=${LONG_PATHS_CONFIG_VALUE}`, ...args] : args;

const runGitRaw = (git: SimpleGit, args: string[]): Promise<string> => git.raw(withLongPathSupport(args));

const detectProjectBaseBranch = async (git: SimpleGit, currentBranch: string): Promise<string> => {
  try {
    const symbolicRef = (await git.raw(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])).trim();
    const match = /^refs\/remotes\/origin\/(.+)$/.exec(symbolicRef);
    if (match?.[1]) {
      await git.raw(["show-ref", "--verify", `refs/remotes/origin/${match[1]}`]);
      return match[1];
    }
  } catch {
    // Repositories without a valid origin/HEAD still get deterministic fallbacks below.
  }

  for (const candidate of ["main", "master", "develop"]) {
    try {
      await git.raw(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
      return candidate;
    } catch {
      // Try the next conventional remote branch.
    }
  }

  const localBranches = await git.branchLocal().catch(() => null);
  for (const candidate of ["main", "master", "develop"]) {
    if (localBranches?.all.includes(candidate)) {
      return candidate;
    }
  }

  return currentBranch || localBranches?.current || localBranches?.all[0] || "main";
};

export const readRecentCommitLog = async (repoPath: string, limit: number): Promise<string> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return runGitRaw(simpleGit(repoPath), [
    "log",
    `-n${String(normalizedLimit)}`,
    "--date=short",
    "--pretty=format:__EC__%H%x09%an%x09%ad%x09%s",
    "--name-only",
    "--no-merges",
  ]);
};

export const readProjectActivityLog = async (repoPath: string): Promise<string> =>
  runGitRaw(simpleGit(repoPath), [
    "log",
    "--all",
    "--date-order",
    "--date=iso-strict",
    "--pretty=format:__BW_ACTIVITY_COMMIT__%H%x09%aN%x09%aE%x09%aI%x09%P%x09%s",
    "--numstat",
    "--summary",
    "--no-renames",
    "--use-mailmap",
  ]);

export const readTrackedProjectFiles = async (repoPath: string): Promise<string[]> => {
  const output = await runGitRaw(simpleGit(repoPath), ["ls-files", "-z"]);
  return output
    .split("\0")
    .map((filePath) => filePath.replace(/\\/g, "/").trim())
    .filter(Boolean);
};

export interface GitProjectReleaseStat {
  name: string;
  date: string;
  commitsSincePrevious: number;
  linesChanged: number;
  filesChanged: number;
}

export interface GitProjectReleaseHistory {
  totalReleases: number;
  releases: GitProjectReleaseStat[];
}

type GitProjectTag = {
  ref: string;
  name: string;
  date: string;
};

const parseProjectTags = (output: string): GitProjectTag[] =>
  output
    .split(/\r?\n/)
    .map((line) => {
      const [ref = "", name = "", date = ""] = line.split("\t");
      return { ref: ref.trim(), name: name.trim(), date: date.trim() };
    })
    .filter((tag) => tag.ref.startsWith("refs/tags/") && Boolean(tag.name) && Number.isFinite(Date.parse(tag.date)))
    .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));

const parseReleaseRangeStats = (output: string): Pick<GitProjectReleaseStat, "commitsSincePrevious" | "linesChanged" | "filesChanged"> => {
  let commitsSincePrevious = 0;
  let linesChanged = 0;
  let filesChanged = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("__BW_RELEASE_COMMIT__")) {
      commitsSincePrevious += 1;
      continue;
    }
    const [added = "", deleted = "", ...pathParts] = line.split("\t");
    if (!pathParts.length || (!/^\d+$/.test(added) && added !== "-") || (!/^\d+$/.test(deleted) && deleted !== "-")) continue;
    filesChanged += 1;
    linesChanged += (added === "-" ? 0 : Number.parseInt(added, 10)) + (deleted === "-" ? 0 : Number.parseInt(deleted, 10));
  }
  return { commitsSincePrevious, linesChanged, filesChanged };
};

export const readProjectReleaseHistory = async (repoPath: string, limit = 12): Promise<GitProjectReleaseHistory> => {
  const git = simpleGit(repoPath);
  const tagOutput = await runGitRaw(git, [
    "for-each-ref",
    "--sort=creatordate",
    "--format=%(refname)%09%(refname:short)%09%(creatordate:iso-strict)",
    "refs/tags",
  ]);
  const tags = parseProjectTags(tagOutput);
  const normalizedLimit = Math.max(1, Math.min(24, Math.floor(limit)));
  const startIndex = Math.max(0, tags.length - normalizedLimit);
  const releases: GitProjectReleaseStat[] = [];

  for (let index = startIndex; index < tags.length; index += 1) {
    const tag = tags[index]!;
    const previousTag = index > 0 ? tags[index - 1] : null;
    const range = previousTag ? `${previousTag.ref}..${tag.ref}` : tag.ref;
    try {
      const rangeOutput = await runGitRaw(git, [
        "log",
        "--pretty=format:__BW_RELEASE_COMMIT__",
        "--numstat",
        "--no-renames",
        range,
      ]);
      releases.push({ name: tag.name, date: tag.date, ...parseReleaseRangeStats(rangeOutput) });
    } catch {
      // Tags can legally point to blobs or trees; keep the rest of the release history usable.
    }
  }

  return { totalReleases: tags.length, releases };
};

const ensureGitLongPathSupport = async (git: SimpleGit): Promise<void> => {
  if (process.platform !== "win32") {
    return;
  }

  await git.raw(["config", "--local", LONG_PATHS_CONFIG_KEY, LONG_PATHS_CONFIG_VALUE]);
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const removeEmptyDirectoryIfPossible = async (dirPath: string): Promise<boolean> => {
  if (!(await pathExists(dirPath))) {
    return false;
  }

  const entries = await readdir(dirPath);
  if (entries.length > 0) {
    return false;
  }

  await rm(dirPath, { recursive: true, force: true });
  return true;
};

const ensureWorktreeDependencyLinks = async (repoPath: string, worktreePath: string): Promise<void> => {
  const sharedDirNames = ["node_modules"];

  for (const dirName of sharedDirNames) {
    const sourcePath = join(repoPath, dirName);
    const targetPath = join(worktreePath, dirName);

    if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
      continue;
    }

    await symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
  }
};

type PublishMode = "created" | "browser-draft";
type PublishRequestKind = "pull-request" | "merge-request";

type ParsedRemote = ParsedGitRemote;

const parseAheadBehind = (track: string): { ahead: number; behind: number } => {
  const ahead = Number.parseInt(/ahead\s+(\d+)/i.exec(track)?.[1] ?? "0", 10);
  const behind = Number.parseInt(/behind\s+(\d+)/i.exec(track)?.[1] ?? "0", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
};

const normalizeGitDate = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
};

const isCommandMissingError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return "code" in error
    ? (error as NodeJS.ErrnoException).code === "ENOENT"
    : /not recognized|not found/i.test(error.message);
};

const extractCommandOutput = (error: unknown): string => {
  if (typeof error === "object" && error) {
    const stdout = "stdout" in error ? String((error as { stdout?: string }).stdout ?? "").trim() : "";
    if (stdout) {
      return stdout;
    }

    const stderr = "stderr" in error ? String((error as { stderr?: string }).stderr ?? "").trim() : "";
    if (stderr) {
      return stderr;
    }
  }

  return error instanceof Error ? error.message : String(error);
};

/** Human-readable status lines when a patch cannot be built (used by `computeWorktreeDiff`). */
async function formatGitStatusSummary(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath);
  const status = await git.status();
  const lines = [
    `branch: ${status.current}`,
    `modified: ${status.modified.join(", ") || "-"}`,
    `created: ${status.created.join(", ") || "-"}`,
    `deleted: ${status.deleted.join(", ") || "-"}`,
    `not_added: ${status.not_added.join(", ") || "-"}`,
  ];

  return lines.join("\n");
}

/**
 * Full unified diff text for a worktree (staged + unstaged + untracked).
 * CPU/git-heavy — safe to run in a worker thread; exported for the desktop git-diff worker.
 */
export async function computeWorktreeDiff(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath);
  const status = await git.status();
  const sections: string[] = [];

  const unstaged = (await git.diff()).trim();
  if (unstaged) {
    sections.push(unstaged);
  }

  const staged = (await git.diff(["--cached"])).trim();
  if (staged) {
    sections.push(staged);
  }

  for (const filePath of status.not_added) {
    try {
      const untrackedPatch = (await git.raw(["diff", "--no-index", "--", "/dev/null", filePath])).trim();
      if (untrackedPatch) {
        sections.push(untrackedPatch);
      }
    } catch (error) {
      const output = extractCommandOutput(error);
      if (output.includes("diff --git")) {
        sections.push(output);
        continue;
      }

      sections.push(`Unable to render patch for untracked file ${filePath}:\n${output}`);
    }
  }

  if (sections.length === 0 && !status.isClean()) {
    sections.push(await formatGitStatusSummary(worktreePath));
  }

  return sections.join("\n\n");
}

async function computeWorktreeRestorePatch(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath);
  const status = await git.status();
  const sections: string[] = [];
  const appendPatchSection = (patchText: string) => {
    if (!patchText) {
      return;
    }

    sections.push(patchText.endsWith("\n") ? patchText : `${patchText}\n`);
  };

  const unstaged = await git.diff(["--binary"]);
  if (unstaged) {
    appendPatchSection(unstaged);
  }

  const staged = await git.diff(["--cached", "--binary"]);
  if (staged) {
    appendPatchSection(staged);
  }

  for (const filePath of status.not_added) {
    try {
      const untrackedPatch = await git.raw(["diff", "--no-index", "--binary", "--", "/dev/null", filePath]);
      if (untrackedPatch) {
        appendPatchSection(untrackedPatch);
      }
    } catch (error) {
      const output = extractCommandOutput(error);
      if (output.includes("diff --git")) {
        appendPatchSection(output);
      }
    }
  }

  return sections.join("");
}

async function applyWorktreePatch(worktreePath: string, patchText: string, options?: { threeWayFallback?: boolean }): Promise<void> {
  if (!patchText.trim()) {
    return;
  }
  const tempPatchPath = join(tmpdir(), `buildwarden-restore-${crypto.randomUUID()}.patch`);
  await writeFile(tempPatchPath, patchText, "utf8");
  try {
    try {
      await execFileAsync("git", withLongPathSupport(["apply", "--binary", "--whitespace=nowarn", tempPatchPath]), {
        cwd: worktreePath,
      });
    } catch (error) {
      if (options?.threeWayFallback !== true) {
        throw error;
      }
      const threeWayArgs = ["apply", "--3way", "--binary", "--whitespace=nowarn", tempPatchPath];
      await execFileAsync("git", withLongPathSupport(["apply", "--check", "--3way", "--binary", "--whitespace=nowarn", tempPatchPath]), {
        cwd: worktreePath,
      });
      await execFileAsync("git", withLongPathSupport(threeWayArgs), { cwd: worktreePath });
    }
  } finally {
    await unlink(tempPatchPath).catch(() => {});
  }
}

async function copyPathFromWorktree(sourceRoot: string, targetRoot: string, relativePath: string): Promise<void> {
  const sourcePath = join(sourceRoot, relativePath);
  const targetPath = join(targetRoot, relativePath);
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) {
      await copyPathFromWorktree(sourceRoot, targetRoot, join(relativePath, entry));
    }
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function syncChangedFilesFromWorktree(sourceWorktreePath: string, targetWorktreePath: string): Promise<void> {
  const git = simpleGit(sourceWorktreePath);
  const status = await git.status();
  const changedPaths = new Set<string>();

  for (const file of status.files) {
    changedPaths.add(file.path);
  }
  for (const filePath of status.not_added) {
    changedPaths.add(filePath);
  }

  for (const filePath of changedPaths) {
    const sourcePath = join(sourceWorktreePath, filePath);
    const targetPath = join(targetWorktreePath, filePath);
    if (await pathExists(sourcePath)) {
      await copyPathFromWorktree(sourceWorktreePath, targetWorktreePath, filePath);
    } else {
      await rm(targetPath, { recursive: true, force: true });
    }
  }
}

export class GitService {
  async getCurrentBranch(repoPath: string): Promise<string> {
    const git = simpleGit(repoPath);
    const branchName = (await git.branch(["--show-current"])).current?.trim();

    if (!branchName) {
      throw new Error(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE);
    }

    return branchName;
  }

  async checkoutProjectBranch(repoPath: string, branchName: string): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Select a branch.");
    }

    if (await this.hasLocalBranch(repoPath, trimmedBranchName)) {
      await git.checkout(trimmedBranchName);
      return;
    }

    if (await this.hasRemoteBranch(repoPath, trimmedBranchName)) {
      await runGitRaw(git, ["checkout", "--track", "-b", trimmedBranchName, `origin/${trimmedBranchName}`]);
      return;
    }

    await git.checkout(trimmedBranchName);
  }

  async getProjectBranchOverview(repoPath: string, baseBranch: string): Promise<ProjectGitBranchOverview> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);

    let currentBranch = "";
    try {
      currentBranch = await this.getCurrentBranch(repoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE)) {
        throw error;
      }
    }

    let provider: ProjectGitBranchOverview["provider"] = "unknown";
    let webBaseUrl: string | null = null;
    try {
      const remoteOutput = await git.remote(["get-url", "origin"]);
      const remote = parseGitRemoteToWebBase(String(remoteOutput ?? ""));
      provider = remote?.provider ?? "unknown";
      webBaseUrl = remote?.webBaseUrl ?? null;
    } catch {
      // Repositories without origin still support local branch management.
    }

    const branches = new Map<string, ProjectGitBranchInfo>();
    const ensureBranch = (name: string): ProjectGitBranchInfo => {
      const existing = branches.get(name);
      if (existing) {
        return existing;
      }
      const created: ProjectGitBranchInfo = {
        name,
        isCurrent: name === currentBranch,
        isBase: name === baseBranch,
        hasLocal: false,
        hasRemote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        commitSha: null,
        updatedAt: null,
        subject: null,
      };
      branches.set(name, created);
      return created;
    };

    const localRefs = await runGitRaw(git, [
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(subject)%09%(upstream:track,nobracket)",
      "refs/heads",
    ]);
    for (const line of localRefs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const [name = "", upstream = "", commitSha = "", updatedAt = "", subject = "", track = ""] = line.split("\t");
      if (!name) {
        continue;
      }
      const branch = ensureBranch(name);
      const tracking = parseAheadBehind(track);
      branch.hasLocal = true;
      branch.upstream = upstream || null;
      branch.hasRemote = branch.hasRemote || upstream.startsWith("origin/");
      branch.ahead = tracking.ahead;
      branch.behind = tracking.behind;
      branch.commitSha = commitSha || branch.commitSha;
      branch.updatedAt = normalizeGitDate(updatedAt) ?? branch.updatedAt;
      branch.subject = subject || branch.subject;
    }

    try {
      const remoteRefs = await runGitRaw(git, [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(subject)",
        "refs/remotes/origin",
      ]);
      for (const line of remoteRefs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
        const [remoteName = "", commitSha = "", updatedAt = "", subject = ""] = line.split("\t");
        if (!remoteName || remoteName === "origin/HEAD") {
          continue;
        }
        const name = remoteName.replace(/^origin\//, "");
        const branch = ensureBranch(name);
        branch.hasRemote = true;
        branch.commitSha = branch.commitSha ?? commitSha ?? null;
        branch.updatedAt = branch.updatedAt ?? normalizeGitDate(updatedAt);
        branch.subject = branch.subject ?? subject ?? null;
      }
    } catch {
      // Remote refs are optional; local-only repositories are valid.
    }

    return {
      repoPath,
      baseBranch,
      currentBranch,
      provider,
      webBaseUrl,
      branches: [...branches.values()].sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
        if (left.isBase !== right.isBase) return left.isBase ? -1 : 1;
        if (left.hasLocal !== right.hasLocal) return left.hasLocal ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      }),
    };
  }

  async validateProject(repoPath: string): Promise<GitProjectValidation> {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return {
        repoPath,
        repoName: basename(repoPath),
        baseBranch: "main",
        isGitRepo: false,
        isWorktree: false,
        isDirty: false,
      };
    }

    const branchSummary = await git.branch(["--show-current"]);
    const status = await git.status();
    const revParse = await git.raw(["rev-parse", "--git-common-dir"]);
    const gitDir = revParse.trim();

    const baseBranch = await detectProjectBaseBranch(git, branchSummary.current);

    return {
      repoPath,
      repoName: basename(repoPath),
      baseBranch,
      isGitRepo: true,
      isWorktree: gitDir !== ".git",
      isDirty: !status.isClean(),
    };
  }

  async createWorktreeForRun(
    repoPath: string,
    projectName: string,
    runId: string,
    baseBranch: string,
    configuredWorktreeRoot?: string | null,
  ): Promise<{ branchName: string; worktreePath: string }> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const worktreeRoot = this.getWorktreeRoot(repoPath, configuredWorktreeRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    const branchName = `${sanitizeSegment(projectName)}-${sanitizeSegment(runId)}`;
    const worktreePath = join(worktreeRoot, branchName);

    if (!existsSync(worktreePath)) {
      await runGitRaw(git, ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
    }

    await ensureWorktreeDependencyLinks(repoPath, worktreePath);

    return {
      branchName,
      worktreePath,
    };
  }

  async createWorktreeForContinuation(
    repoPath: string,
    projectName: string,
    runId: string,
    sourceBranch: string,
    configuredWorktreeRoot?: string | null,
  ): Promise<{ branchName: string; worktreePath: string }> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const worktreeRoot = this.getWorktreeRoot(repoPath, configuredWorktreeRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    const branchName = `${sanitizeSegment(projectName)}-${sanitizeSegment(runId)}`;
    const worktreePath = join(worktreeRoot, branchName);

    if (!existsSync(worktreePath)) {
      await runGitRaw(git, ["worktree", "add", "-b", branchName, worktreePath, sourceBranch]);
    }

    await ensureWorktreeDependencyLinks(repoPath, worktreePath);

    return {
      branchName,
      worktreePath,
    };
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const git = simpleGit(repoPath);
    const raw = await git.raw(["worktree", "list", "--porcelain"]);
    const chunks = raw
      .trim()
      .split("\n\n")
      .filter(Boolean);

    return chunks.map((chunk) => {
      const lines = chunk.split("\n");
      const worktreePath = lines[0]?.replace(/^worktree /, "") ?? repoPath;
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const branchName = branchLine?.replace("branch refs/heads/", "") ?? "detached-head";
      const headLine = lines.find((line) => line.startsWith("HEAD "));
      const lockedLine = lines.find((line) => line.startsWith("locked"));

      return {
        worktreePath,
        branchName,
        headSha: headLine?.replace("HEAD ", "") ?? null,
        isLocked: Boolean(lockedLine),
      };
    });
  }

  async releaseWorktreeBranch(worktreePath: string, branchName: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await ensureGitLongPathSupport(git);
    const currentBranch = (await git.branch(["--show-current"])).current;

    if (!currentBranch || currentBranch !== branchName) {
      return;
    }

    await runGitRaw(git, ["checkout", "--detach"]);
  }

  async checkoutWorktreeBranch(worktreePath: string, branchName: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await ensureGitLongPathSupport(git);
    const currentBranch = (await git.branch(["--show-current"])).current;

    if (currentBranch === branchName) {
      return;
    }

    await runGitRaw(git, ["checkout", branchName]);
  }

  async hasWorktreeGitMetadata(worktreePath: string): Promise<boolean> {
    return pathExists(join(worktreePath, ".git"));
  }

  async isWorktreeRegistered(repoPath: string, worktreePath: string): Promise<boolean> {
    const registeredWorktrees = await this.listWorktrees(repoPath);
    return registeredWorktrees.some((entry) => entry.worktreePath === worktreePath);
  }

  async hasLocalBranch(repoPath: string, branchName: string): Promise<boolean> {
    const git = simpleGit(repoPath);
    const branches = await git.branchLocal();
    return branches.all.includes(branchName);
  }

  async hasRemoteBranch(repoPath: string, branchName: string): Promise<boolean> {
    const git = simpleGit(repoPath);
    try {
      await runGitRaw(git, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  async fetchProjectBranches(repoPath: string): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    await runGitRaw(git, ["fetch", "--all", "--prune"]);
  }

  async createProjectBranch(repoPath: string, branchName: string, startPoint: string, checkout = true): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const trimmedBranchName = branchName.trim();
    const trimmedStartPoint = startPoint.trim();
    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }
    if (!trimmedStartPoint) {
      throw new Error("Select a source branch.");
    }
    await this.validateBranchName(repoPath, trimmedBranchName);
    if (await this.hasLocalBranch(repoPath, trimmedBranchName)) {
      throw new Error(`A local branch named "${trimmedBranchName}" already exists.`);
    }
    if (checkout) {
      await runGitRaw(git, ["checkout", "-b", trimmedBranchName, trimmedStartPoint]);
    } else {
      await runGitRaw(git, ["branch", trimmedBranchName, trimmedStartPoint]);
    }
  }

  async renameProjectBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const trimmedOldName = oldName.trim();
    const trimmedNewName = newName.trim();
    if (!trimmedOldName || !trimmedNewName) {
      throw new Error("Enter both the current and new branch names.");
    }
    if (!(await this.hasLocalBranch(repoPath, trimmedOldName))) {
      throw new Error(`Local branch "${trimmedOldName}" was not found.`);
    }
    await this.validateBranchName(repoPath, trimmedNewName);
    if (await this.hasLocalBranch(repoPath, trimmedNewName)) {
      throw new Error(`A local branch named "${trimmedNewName}" already exists.`);
    }
    await runGitRaw(git, ["branch", "-m", trimmedOldName, trimmedNewName]);
  }

  async deleteProjectBranch(repoPath: string, branchName: string, force = false): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Select a branch.");
    }
    const currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");
    if (trimmedBranchName === currentBranch) {
      throw new Error("You cannot delete the currently checked out branch.");
    }
    if (!(await this.hasLocalBranch(repoPath, trimmedBranchName))) {
      throw new Error(`Local branch "${trimmedBranchName}" was not found.`);
    }
    await runGitRaw(git, ["branch", force ? "-D" : "-d", trimmedBranchName]);
  }

  async pullProjectBranch(repoPath: string): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    await runGitRaw(git, ["pull", "--ff-only"]);
  }

  async pushProjectBranch(repoPath: string, branchName: string, setUpstream = true): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Select a branch.");
    }
    if (!(await this.hasLocalBranch(repoPath, trimmedBranchName))) {
      throw new Error(`Local branch "${trimmedBranchName}" was not found.`);
    }
    await runGitRaw(git, setUpstream ? ["push", "-u", "origin", trimmedBranchName] : ["push", "origin", trimmedBranchName]);
  }

  private async validateBranchName(repoPath: string, branchName: string): Promise<void> {
    const git = simpleGit(repoPath);
    try {
      await runGitRaw(git, ["check-ref-format", "--branch", branchName]);
    } catch (error) {
      throw new Error(`"${branchName}" is not a valid Git branch name: ${extractCommandOutput(error)}`);
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string, branchName?: string): Promise<void> {
    const git = simpleGit(repoPath);
    await ensureGitLongPathSupport(git);
    const cleanupErrors: string[] = [];
    const registeredWorktrees = await this.listWorktrees(repoPath);
    const isRegisteredWorktree = registeredWorktrees.some((entry) => entry.worktreePath === worktreePath);

    if (isRegisteredWorktree) {
      try {
        await runGitRaw(git, ["worktree", "remove", "--force", worktreePath]);
      } catch (error) {
        cleanupErrors.push(`git worktree remove failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (await pathExists(worktreePath)) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`filesystem removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await runGitRaw(git, ["worktree", "prune"]);
    } catch (error) {
      cleanupErrors.push(`git worktree prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (branchName) {
      try {
        const branches = await git.branchLocal();
        if (branches.all.includes(branchName)) {
          await runGitRaw(git, ["branch", "-D", branchName]);
        }
      } catch (error) {
        cleanupErrors.push(`branch deletion failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const remainingWorktrees = await this.listWorktrees(repoPath);
    if (remainingWorktrees.some((entry) => entry.worktreePath === worktreePath)) {
      cleanupErrors.push("worktree is still registered in git after cleanup");
    }

    if (await pathExists(worktreePath)) {
      cleanupErrors.push("worktree directory still exists after cleanup");
    }

    const currentWorktreeRoot = this.getWorktreeRoot(repoPath);
    const managedRoots = new Set<string>([currentWorktreeRoot, this.getLegacyWorktreeRoot(repoPath), dirname(worktreePath)]);
    for (const rootPath of managedRoots) {
      try {
        const removed = await removeEmptyDirectoryIfPossible(rootPath);
        if (!removed) {
          continue;
        }

        if (rootPath === currentWorktreeRoot) {
          await removeEmptyDirectoryIfPossible(dirname(rootPath));
        }
      } catch (error) {
        cleanupErrors.push(`empty worktree root removal failed for ${rootPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join("\n"));
    }
  }

  async getDiff(worktreePath: string): Promise<string> {
    return computeWorktreeDiff(worktreePath);
  }

  async getStatusSummary(worktreePath: string): Promise<string> {
    return formatGitStatusSummary(worktreePath);
  }

  async hasChanges(worktreePath: string): Promise<boolean> {
    const git = simpleGit(worktreePath);
    const status = await git.status();
    return !status.isClean();
  }

  async createPromptRestorePatch(worktreePath: string): Promise<string> {
    return computeWorktreeRestorePatch(worktreePath);
  }

  async cloneWorkspaceChanges(sourceWorktreePath: string, targetWorktreePath: string): Promise<void> {
    const patch = await computeWorktreeRestorePatch(sourceWorktreePath);
    try {
      await applyWorktreePatch(targetWorktreePath, patch, { threeWayFallback: true });
    } catch {
      await syncChangedFilesFromWorktree(sourceWorktreePath, targetWorktreePath);
    }
  }

  async restorePromptRestorePatch(worktreePath: string, targetPatch: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await ensureGitLongPathSupport(git);
    const safetyPatch = await computeWorktreeRestorePatch(worktreePath);

    await runGitRaw(git, ["reset", "--hard", "HEAD"]);
    await runGitRaw(git, ["clean", "-fd"]);

    try {
      await applyWorktreePatch(worktreePath, targetPatch);
    } catch (error) {
      try {
        await applyWorktreePatch(worktreePath, safetyPatch);
      } catch {
        /* best effort rollback only */
      }
      throw error;
    }
  }

  async commitAllChanges(worktreePath: string, message: string): Promise<{ commitHash: string }> {
    const git = simpleGit(worktreePath);
    await ensureGitLongPathSupport(git);
    const status = await git.status();

    if (status.isClean()) {
      throw new Error("There are no changes to commit in this run worktree.");
    }

    await git.add(["-A"]);
    const result = await git.commit(message);

    return {
      commitHash: result.commit,
    };
  }

  async publishBranch(worktreePath: string, branchName: string): Promise<{ branchName: string; remoteName: string }> {
    const git = simpleGit(worktreePath);
    await git.push("origin", branchName, { "-u": null });

    return {
      branchName,
      remoteName: "origin",
    };
  }

  async listTargetBranches(worktreePath: string): Promise<string[]> {
    const git = simpleGit(worktreePath);
    const branches = new Set<string>();

    try {
      const remoteRefs = await git.raw(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
      for (const line of remoteRefs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
        if (line === "origin/HEAD") {
          continue;
        }

        branches.add(line.replace(/^origin\//, ""));
      }
    } catch {
      // Fall back to local branches below.
    }

    const local = await git.branchLocal();
    for (const branch of local.all) {
      branches.add(branch);
    }

    return [...branches].sort((left, right) => left.localeCompare(right));
  }

  async getLatestCommitMessage(worktreePath: string, branchName: string): Promise<string> {
    const git = simpleGit(worktreePath);
    return (await git.raw(["log", "-1", "--format=%s", branchName])).trim();
  }

  async createPublishBranchFromHead(worktreePath: string, branchName: string): Promise<void> {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Enter a source branch name.");
    }

    const git = simpleGit(worktreePath);
    await ensureGitLongPathSupport(git);
    const localBranches = await git.branchLocal();
    if (localBranches.all.includes(trimmedBranchName)) {
      throw new Error(`A local branch named "${trimmedBranchName}" already exists.`);
    }

    const remoteHeads = (await git.raw(["ls-remote", "--heads", "origin", trimmedBranchName])).trim();
    if (remoteHeads) {
      throw new Error(`A remote branch named "${trimmedBranchName}" already exists on origin.`);
    }

    await runGitRaw(git, ["checkout", "-b", trimmedBranchName, "HEAD"]);
  }

  async createPullRequest(
    worktreePath: string,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): Promise<{ url: string; mode: PublishMode; requestKind: PublishRequestKind }> {
    const git = simpleGit(worktreePath);
    const remote = await this.getParsedOriginRemote(worktreePath);
    await git.push("origin", branchName, { "-u": null });

    if (remote?.provider === "gitlab") {
      try {
        const { stdout } = await execFileAsync(
          "glab",
          ["mr", "create", "--source-branch", branchName, "--target-branch", targetBranch, "--title", title, "--description", body],
          {
            cwd: worktreePath,
            maxBuffer: 1024 * 1024,
          },
        );

        return {
          url: stdout.trim(),
          mode: "created",
          requestKind: "merge-request",
        };
      } catch (error) {
        const mergeRequestUrl = this.buildGitlabMergeRequestUrl(remote, branchName, targetBranch, title, body);
        if (mergeRequestUrl) {
          return {
            url: mergeRequestUrl,
            mode: "browser-draft",
            requestKind: "merge-request",
          };
        }

          let message = error instanceof Error ? error.message : String(error);
          if (typeof error === "object" && error && "stderr" in error) {
            message = String((error as { stderr?: string }).stderr ?? "").trim();
          }
        throw new Error(message || "Failed to create merge request for this GitLab repository.");
      }
    }

    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "create", "--base", targetBranch, "--head", branchName, "--title", title, "--body", body],
        {
          cwd: worktreePath,
          maxBuffer: 1024 * 1024,
        },
      );

      return {
        url: stdout.trim(),
        mode: "created",
        requestKind: "pull-request",
      };
    } catch (error) {
      if (isCommandMissingError(error)) {
        const compareUrl = this.buildGithubCompareUrl(remote, branchName, targetBranch, title, body);
        if (compareUrl) {
          return {
            url: compareUrl,
            mode: "browser-draft",
            requestKind: "pull-request",
          };
        }
      }

      let message = error instanceof Error ? error.message : String(error);
      if (typeof error === "object" && error && "stderr" in error) {
        message = String((error as { stderr?: string }).stderr ?? "").trim();
      }
      throw new Error(message || "Failed to create pull request with GitHub CLI.");
    }
  }

  async ensureRepoReady(repoPath: string): Promise<void> {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      throw new Error(`Path is not a Git repository: ${repoPath}`);
    }
  }

  createGitClient(repoPath: string): SimpleGit {
    return simpleGit(repoPath);
  }

  private buildGithubCompareUrl(
    remote: ParsedRemote | null,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): string | null {
    if (!remote || remote.provider !== "github") {
      return null;
    }

    const params = new URLSearchParams({
      expand: "1",
      title,
      body,
    });

    return `${remote.webBaseUrl}/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(branchName)}?${params.toString()}`;
  }

  private buildGitlabMergeRequestUrl(
    remote: ParsedRemote | null,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): string | null {
    if (!remote || remote.provider !== "gitlab") {
      return null;
    }

    const params = new URLSearchParams({
      "merge_request[source_branch]": branchName,
      "merge_request[target_branch]": targetBranch,
      "merge_request[title]": title,
      "merge_request[description]": body,
    });

    return `${remote.webBaseUrl}/-/merge_requests/new?${params.toString()}`;
  }

  private async getParsedOriginRemote(worktreePath: string): Promise<ParsedRemote | null> {
    const git = simpleGit(worktreePath);
    const remoteOutput = await git.remote(["get-url", "origin"]);
    return parseGitRemoteToWebBase(String(remoteOutput ?? ""));
  }

  private getLegacyWorktreeRoot(repoPath: string): string {
    return join(repoPath, ".buildwarden-worktrees");
  }

  private getWorktreeRoot(repoPath: string, configuredWorktreeRoot?: string | null): string {
    const repoContainer = configuredWorktreeRoot?.trim() || dirname(repoPath);
    const repoName = sanitizeSegment(basename(repoPath)) || "repo";
    return join(repoContainer, ".buildwarden-worktrees", repoName);
  }
}

export { computePrMrDiffViaFetch, parsePrMrBrowserUrl, type ComputePrMrDiffResult, type ParsedPrMrLink } from "./pr-mr-fetch.js";
export { parseGitRemoteToWebBase, type ParsedGitRemote } from "./remote-parse.js";
