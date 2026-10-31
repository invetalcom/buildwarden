import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { access, copyFile, lstat, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { GitPluginError, simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { promisify } from "node:util";
import {
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  type GitProjectValidation,
  type MergeProjectBranchMode,
  type ProjectGitBranchInfo,
  type ProjectGitBranchOverview,
  type ProjectGitOperationKind,
  type RunWorktreeDiffFileStat,
  type RunWorktreeDiffSummary,
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

/** Passed as `-c` on every simple-git command, so BuildWarden needs no long-path setting in the repository. */
const LONG_PATH_GIT_CONFIG: string[] = process.platform === "win32" ? [`${LONG_PATHS_CONFIG_KEY}=${LONG_PATHS_CONFIG_VALUE}`] : [];

/**
 * Local commands run inside the per-project branch lock too, so a Git process that hangs, for example
 * on a hook waiting for input or a stuck file system, must not block the project forever. Timeouts count
 * inactivity (no output), not total duration.
 */
const LOCAL_GIT_INACTIVITY_TIMEOUT_MS = 2 * 60_000;
/** Checkouts and commit hooks can stay silent for a long time without being stuck. */
const LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

const createLocalGit = (baseDir: string, inactivityTimeoutMs = LOCAL_GIT_INACTIVITY_TIMEOUT_MS): SimpleGit =>
  simpleGit({ baseDir, config: LONG_PATH_GIT_CONFIG, timeout: { block: inactivityTimeoutMs } });

const toLocalGitTimeoutError = (error: unknown, args: readonly string[]): unknown =>
  error instanceof GitPluginError && error.plugin === "timeout"
    ? new Error(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} made no progress and was stopped.`)
    : error;

const runGitRaw = (git: SimpleGit, args: string[]): Promise<string> =>
  git.raw(args).catch((error: unknown) => {
    throw toLocalGitTimeoutError(error, args);
  });

/**
 * Remote operations run inside the per-project branch lock, so a stalled network or credential prompt
 * must not block the project forever. The timeout counts inactivity, not total duration.
 */
const NETWORK_COMMAND_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const NETWORK_COMMAND_TIMEOUT_MINUTES = NETWORK_COMMAND_INACTIVITY_TIMEOUT_MS / 60_000;
// simple-git strips these ambient variables and rejects them when passed explicitly; mirror its guard
// so explicit environments only add the allowed Git variables.
const SIMPLE_GIT_GUARDED_ENV_KEYS = new Set(["editor", "pager", "prefix", "ssh_askpass", "visual"]);

const buildGuardSafeEnvironment = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toLowerCase().trim();
    if (value !== undefined && !normalizedKey.startsWith("git_") && !SIMPLE_GIT_GUARDED_ENV_KEYS.has(normalizedKey)) {
      env[key] = value;
    }
  }
  return env;
};

const createNetworkGit = (repoPath: string, inactivityTimeoutMs = NETWORK_COMMAND_INACTIVITY_TIMEOUT_MS): SimpleGit =>
  simpleGit({
    baseDir: repoPath,
    config: LONG_PATH_GIT_CONFIG,
    timeout: { block: inactivityTimeoutMs },
    allowEnvironment: ["GIT_TERMINAL_PROMPT"],
  }).env({ ...buildGuardSafeEnvironment(), GIT_TERMINAL_PROMPT: "0" });

/**
 * For commands that only read the workspace. `git status` and porcelain `git diff` otherwise take
 * `index.lock` to save a refreshed index, so background status and diff polling could make the agent's
 * own `git commit` in the same worktree fail with "index.lock exists".
 */
const createReadOnlyGit = (baseDir: string, inactivityTimeoutMs = LOCAL_GIT_INACTIVITY_TIMEOUT_MS, maxConcurrentProcesses?: number): SimpleGit =>
  simpleGit({
    baseDir,
    config: LONG_PATH_GIT_CONFIG,
    timeout: { block: inactivityTimeoutMs },
    allowEnvironment: ["GIT_OPTIONAL_LOCKS"],
    ...(maxConcurrentProcesses ? { maxConcurrentProcesses } : {}),
  }).env({ ...buildGuardSafeEnvironment(), GIT_OPTIONAL_LOCKS: "0" });

const runNetworkGit = async (repoPath: string, args: string[], inactivityTimeoutMs = NETWORK_COMMAND_INACTIVITY_TIMEOUT_MS): Promise<string> => {
  try {
    return await runGitRaw(createNetworkGit(repoPath, inactivityTimeoutMs), args);
  } catch (error) {
    if (error instanceof GitPluginError && error.plugin === "timeout") {
      const duration =
        inactivityTimeoutMs >= 60_000
          ? `${String(Math.round(inactivityTimeoutMs / 60_000))} minutes`
          : `${String(Math.round(inactivityTimeoutMs / 1000))} seconds`;
      throw new Error(
        `git ${args[0] ?? ""} made no progress for ${duration} and was stopped. Check the network connection and Git credentials, then try again.`,
      );
    }
    throw error;
  }
};

/** Run creation waits for this fetch, so a slow or offline remote falls back to the local base quickly. */
const BASE_BRANCH_REFRESH_TIMEOUT_MS = 20_000;

/** Runs a forge CLI (`gh`, `glab`) without interactive prompts and with a bounded runtime. */
const execForgeCli = (command: string, args: string[], cwd: string) =>
  execFileAsync(command, args, {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: NETWORK_COMMAND_INACTIVITY_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });

/**
 * simple-git resolves when Git exits non-zero without writing to stderr, which is exactly how `--quiet`
 * probes report "no". Probes therefore run Git directly and read the exit code.
 */
const runGitProbe = async (cwd: string, args: string[]): Promise<boolean> => {
  try {
    await execFileAsync("git", withLongPathSupport(args), { cwd, timeout: LOCAL_GIT_INACTIVITY_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number") {
      return false;
    }
    throw error;
  }
};

/**
 * Git reads a leading `-` as an option, so ref names from the UI or the agent must never start with one.
 * Callers also end ref arguments with `--`, so a name that matches a file is never read as a path.
 */
const assertRefArgument = (refName: string, label = "Branch"): string => {
  const trimmed = refName.trim();
  if (!trimmed) {
    throw new Error(`${label} name is required.`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} names cannot start with "-".`);
  }
  return trimmed;
};

const isTimedOutCommandError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "killed" in error && (error as { killed?: boolean }).killed === true;

const readCommandStderr = (error: unknown): string =>
  typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";

/** Forge CLI failures that a browser draft can work around: the CLI is missing or not signed in. */
const isForgeCliUnavailableError = (error: unknown): boolean =>
  isCommandMissingError(error) ||
  /\b(?:auth login|not logged in|authenticat\w*|unauthori[sz]ed|401|no token|token is not valid)\b/i.test(
    `${readCommandStderr(error)}\n${error instanceof Error ? error.message : ""}`,
  );

/**
 * `glab mr create` only accepts the description as an argument, and Windows caps a command line at
 * 32,767 characters, so very long descriptions are shortened for the CLI.
 */
/** Repository owner from a parsed GitHub remote, such as `owner` for `https://github.com/owner/repo`. */
const githubOwnerOf = (remote: ParsedGitRemote | null): string =>
  remote?.provider === "github" ? (new URL(remote.webBaseUrl).pathname.split("/")[1] ?? "") : "";

/**
 * `gh pr list --head <branch>` matches the branch name in every fork, so another contributor's pull
 * request from a same-named branch must not count as ours. Returns the first open pull request whose
 * head repository belongs to `headOwner`.
 */
export const selectOwnOpenPullRequestUrl = (pullRequests: unknown, headOwner: string): string | null => {
  if (!headOwner || !Array.isArray(pullRequests)) {
    return null;
  }
  for (const pullRequest of pullRequests as Array<{ url?: unknown; headRepositoryOwner?: { login?: unknown } | null }>) {
    const owner = pullRequest?.headRepositoryOwner?.login;
    if (typeof owner === "string" && owner.toLowerCase() === headOwner.toLowerCase() && typeof pullRequest.url === "string" && pullRequest.url) {
      return pullRequest.url;
    }
  }
  return null;
};

/**
 * Merge request lists include merge requests from forks. Only a merge request whose source project is
 * the target project counts as ours, which holds when the branch was pushed to the base repository.
 */
export const selectOwnOpenMergeRequestUrl = (mergeRequests: unknown): string | null => {
  if (!Array.isArray(mergeRequests)) {
    return null;
  }
  for (const mergeRequest of mergeRequests as Array<{ web_url?: unknown; source_project_id?: unknown; target_project_id?: unknown }>) {
    if (
      mergeRequest?.source_project_id !== undefined &&
      mergeRequest.source_project_id === mergeRequest.target_project_id &&
      typeof mergeRequest.web_url === "string" &&
      mergeRequest.web_url
    ) {
      return mergeRequest.web_url;
    }
  }
  return null;
};

/**
 * GitHub answers `414 URI Too Long` for compare links far below browser limits, and GitLab's default
 * proxies cap request lines at 8 KiB. Longer drafts leave the description out of the link.
 */
const MAX_BROWSER_DRAFT_URL_CHARS = 8_000;

type BrowserDraft = { url: string; descriptionOmitted: boolean };

const buildBrowserDraft = (buildUrl: (includeDescription: boolean) => string): BrowserDraft => {
  const url = buildUrl(true);
  return url.length <= MAX_BROWSER_DRAFT_URL_CHARS ? { url, descriptionOmitted: false } : { url: buildUrl(false), descriptionOmitted: true };
};

const MAX_FORGE_CLI_DESCRIPTION_CHARS = 16_000;
const fitForgeCliDescription = (body: string): string =>
  body.length <= MAX_FORGE_CLI_DESCRIPTION_CHARS
    ? body
    : `${body.slice(0, MAX_FORGE_CLI_DESCRIPTION_CHARS)}\n\n_(Description shortened to fit the GitLab CLI.)_`;

const detectProjectBaseBranch = async (git: SimpleGit, repoPath: string, currentBranch: string, remoteName: string): Promise<string> => {
  const remoteRefPrefix = `refs/remotes/${remoteName}/`;
  try {
    const symbolicRef = (await git.raw(["symbolic-ref", "-q", `${remoteRefPrefix}HEAD`])).trim();
    const branchName = symbolicRef.startsWith(remoteRefPrefix) ? symbolicRef.slice(remoteRefPrefix.length) : "";
    if (branchName) {
      await git.raw(["show-ref", "--verify", `${remoteRefPrefix}${branchName}`]);
      return branchName;
    }
  } catch {
    // Repositories without a valid <remote>/HEAD still get deterministic fallbacks below.
  }

  for (const candidate of ["main", "master", "develop"]) {
    // A failed `--quiet` probe resolves in simple-git, which used to make every repository detect "main".
    if (await runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", `${remoteRefPrefix}${candidate}`]).catch(() => false)) {
      return candidate;
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
  return runGitRaw(createLocalGit(repoPath), [
    "log",
    `-n${String(normalizedLimit)}`,
    "--date=short",
    "--pretty=format:__EC__%H%x09%an%x09%ad%x09%s",
    "--name-only",
    "--no-merges",
  ]);
};

export const readProjectActivityLog = async (repoPath: string): Promise<string> =>
  runGitRaw(createLocalGit(repoPath), [
    "log",
    "--all",
    "--date-order",
    "--date=iso-strict",
    "--pretty=format:%x00__BW_ACTIVITY_COMMIT__%H%x09%aN%x09%aE%x09%aI%x09%P%x09%s%x00",
    "--raw",
    "--numstat",
    "--no-renames",
    "--use-mailmap",
    "-z",
  ]);

export const readTrackedProjectFiles = async (repoPath: string): Promise<string[]> => {
  const output = await runGitRaw(createLocalGit(repoPath), ["ls-files", "-z"]);
  return output
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .map((filePath) => filePath.replace(/\\/g, "/"));
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
  const changedFiles = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("__BW_RELEASE_COMMIT__")) {
      commitsSincePrevious += 1;
      continue;
    }
    const [added = "", deleted = "", ...pathParts] = line.split("\t");
    if (!pathParts.length || (!/^\d+$/.test(added) && added !== "-") || (!/^\d+$/.test(deleted) && deleted !== "-")) continue;
    changedFiles.add(pathParts.join("\t"));
    linesChanged += (added === "-" ? 0 : Number.parseInt(added, 10)) + (deleted === "-" ? 0 : Number.parseInt(deleted, 10));
  }
  return { commitsSincePrevious, linesChanged, filesChanged: changedFiles.size };
};

export const readProjectReleaseHistory = async (repoPath: string, limit = 12): Promise<GitProjectReleaseHistory> => {
  const git = createLocalGit(repoPath);
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

// Repositories whose long-path setting was already checked this session.
const longPathSupportCheckedPaths = new Set<string>();

/**
 * BuildWarden's own commands pass core.longpaths per command. Agents run their own Git inside run
 * worktrees, whose paths are longer than the project's, so creating one persists the setting, but only
 * when the repository has no value of its own; an explicit user choice is never overridden.
 */
const ensureGitLongPathSupport = async (git: SimpleGit, gitPath: string): Promise<void> => {
  if (process.platform !== "win32") {
    return;
  }

  // Case-preserving: directories can be case-sensitive on Windows, and a
  // duplicate check for a differently cased spelling is harmless.
  const cacheKey = resolve(gitPath);
  if (longPathSupportCheckedPaths.has(cacheKey)) {
    return;
  }
  const configured = (await git.raw(["config", "--local", "--get", LONG_PATHS_CONFIG_KEY]).catch(() => "")).trim();
  if (!configured) {
    await git.raw(["config", "--local", LONG_PATHS_CONFIG_KEY, LONG_PATHS_CONFIG_VALUE]);
  }
  longPathSupportCheckedPaths.add(cacheKey);
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

const SHARED_DEPENDENCY_DIR_NAMES = ["node_modules"] as const;

const ensureWorktreeDependencyLinks = async (repoPath: string, worktreePath: string): Promise<void> => {
  for (const dirName of SHARED_DEPENDENCY_DIR_NAMES) {
    const sourcePath = join(repoPath, dirName);
    const targetPath = join(worktreePath, dirName);

    if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
      continue;
    }

    await symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
  }
};

/** Shared dependency directories that are symlinks/junctions into the project repository. */
const listWorktreeDependencyLinks = async (worktreePath: string): Promise<string[]> => {
  const links: string[] = [];
  for (const dirName of SHARED_DEPENDENCY_DIR_NAMES) {
    try {
      if ((await lstat(join(worktreePath, dirName))).isSymbolicLink()) {
        links.push(dirName);
      }
    } catch {
      // Missing entries are not links.
    }
  }
  return links;
};

/** Unlinks shared dependency links so worktree removal never reaches into the project repository. */
const removeWorktreeDependencyLinks = async (worktreePath: string): Promise<void> => {
  for (const dirName of await listWorktreeDependencyLinks(worktreePath)) {
    await unlink(join(worktreePath, dirName));
  }
};

const toComparablePath = (value: string): string => {
  let resolved = resolve(value);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    try {
      resolved = join(realpathSync.native(dirname(resolved)), basename(resolved));
    } catch {
      // Keep the lexical path when neither the path nor its parent exists.
    }
  }
  const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/**
 * Git reports worktree paths with forward slashes (`C:/repo` on Windows) while Node paths use the
 * platform separator, so worktree paths must never be compared as raw strings.
 */
export const isSameWorktreePath = (left: string, right: string): boolean => toComparablePath(left) === toComparablePath(right);

type PublishMode = "created" | "existing" | "browser-draft";
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

type BaseDivergence = { ahead: number; behind: number };

/** Ref counts above this skip the per-branch fallback, which spawns one Git process per branch. */
const MAX_BASE_DIVERGENCE_FALLBACK_REFS = 150;

/** Marker files Git keeps while a stopped command waits for the user, checked in this order. */
const IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{ marker: string; kind: ProjectGitOperationKind }> = [
  { marker: "rebase-merge", kind: "rebase" },
  { marker: "rebase-apply", kind: "rebase" },
  { marker: "MERGE_HEAD", kind: "merge" },
  { marker: "CHERRY_PICK_HEAD", kind: "cherry-pick" },
  { marker: "REVERT_HEAD", kind: "revert" },
];

const describeConflictedFiles = (files: string[]): string => {
  if (files.length === 0) {
    return "conflicts";
  }
  const listed = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` and ${String(files.length - 3)} more` : "";
  return `conflicts in ${listed}${more}`;
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
  const git = createReadOnlyGit(worktreePath);
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

const mapWithConcurrency = async <T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
};

const WORKTREE_DIFF_GIT_TIMEOUT_MS = 60_000;
const createWorktreeDiffGit = (worktreePath: string): SimpleGit => createReadOnlyGit(worktreePath, WORKTREE_DIFF_GIT_TIMEOUT_MS, 6);

const renderUntrackedDiffSections = async (git: SimpleGit, filePaths: readonly string[]): Promise<string[]> => {
  const sections = await mapWithConcurrency(filePaths, 4, async (filePath) => {
    try {
      const patch = (await git.raw(["diff", "--no-index", "--", "/dev/null", filePath])).trim();
      return patch || null;
    } catch (error) {
      const output = extractCommandOutput(error);
      if (output.includes("diff --git")) {
        return output;
      }

      return `Unable to render patch for untracked file ${filePath}:\n${output}`;
    }
  });
  return sections.filter((section): section is string => Boolean(section));
};

/**
 * Workspace diffs use plumbing: porcelain `git diff` refreshes and rewrites the index even with
 * GIT_OPTIONAL_LOCKS=0. `diff-files` covers unstaged changes and `diff-index --cached` staged ones.
 */
const unstagedDiffArgs = (...options: string[]): string[] => ["diff-files", ...options];
const stagedDiffArgs = async (git: SimpleGit, ...options: string[]): Promise<string[]> => {
  const hasHead = Boolean((await runGitRaw(git, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim());
  // A repository without commits compares the index against the empty tree.
  const base = hasHead ? "HEAD" : (await runGitRaw(git, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  return ["diff-index", "--cached", ...options, base, "--"];
};

const parseNumstatValue = (value: string): number | null => (value === "-" ? null : Number.parseInt(value, 10) || 0);

/** Parses `git diff --numstat -z`, including its three-NUL-field rename form. */
const parseNumstat = (output: string): RunWorktreeDiffFileStat[] => {
  const parts = output.split("\0");
  const files: RunWorktreeDiffFileStat[] = [];
  for (let index = 0; index < parts.length;) {
    const header = parts[index++] ?? "";
    if (!header) continue;
    const fields = header.split("\t");
    if (fields.length < 3) continue;
    const additions = parseNumstatValue(fields[0] ?? "0");
    const deletions = parseNumstatValue(fields[1] ?? "0");
    if (fields[2] === "") {
      const previousPath = parts[index++] || null;
      const path = parts[index++] || previousPath || "";
      if (path) files.push({ path, previousPath, additions, deletions });
      continue;
    }
    const path = fields.slice(2).join("\t");
    if (path) files.push({ path, additions, deletions });
  }
  return files;
};

const mergeNumstatFiles = (groups: readonly RunWorktreeDiffFileStat[][]): RunWorktreeDiffSummary => {
  const byPath = new Map<string, RunWorktreeDiffFileStat>();
  for (const file of groups.flat()) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file });
      continue;
    }
    existing.previousPath ??= file.previousPath;
    existing.additions = existing.additions === null || file.additions === null ? null : existing.additions + file.additions;
    existing.deletions = existing.deletions === null || file.deletions === null ? null : existing.deletions + file.deletions;
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    totalFiles: files.length,
    totalAdditions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    totalDeletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
};

/** Changed-file statistics without constructing a complete unified patch. */
export async function computeWorktreeDiffSummary(worktreePath: string): Promise<RunWorktreeDiffSummary> {
  const git = createWorktreeDiffGit(worktreePath);
  const [status, unstagedOutput, stagedOutput] = await Promise.all([
    git.status(),
    runGitRaw(git, unstagedDiffArgs("--numstat", "-z", "--find-renames")),
    stagedDiffArgs(git, "--numstat", "-z", "--find-renames").then((args) => runGitRaw(git, args)),
  ]);
  const untracked = await mapWithConcurrency(status.not_added, 4, async (filePath) => {
    try {
      return parseNumstat(await runGitRaw(git, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", filePath]));
    } catch (error) {
      return parseNumstat(extractCommandOutput(error));
    }
  });
  return mergeNumstatFiles([parseNumstat(unstagedOutput), parseNumstat(stagedOutput), ...untracked]);
}

/**
 * Full unified diff text for a worktree (staged + unstaged + untracked).
 * CPU/git-heavy — safe to run in a worker thread; exported for the desktop git-diff worker.
 */
export async function computeWorktreeDiff(worktreePath: string): Promise<string> {
  const git = createWorktreeDiffGit(worktreePath);
  const sections: string[] = [];

  const [status, unstagedOutput, stagedOutput] = await Promise.all([
    git.status(),
    runGitRaw(git, unstagedDiffArgs("-p")),
    stagedDiffArgs(git, "-p").then((args) => runGitRaw(git, args)),
  ]);
  const unstaged = unstagedOutput.trim();
  if (unstaged) {
    sections.push(unstaged);
  }

  const staged = stagedOutput.trim();
  if (staged) {
    sections.push(staged);
  }

  sections.push(...await renderUntrackedDiffSections(git, status.not_added));

  if (sections.length === 0 && !status.isClean()) {
    sections.push(await formatGitStatusSummary(worktreePath));
  }

  return sections.join("\n\n");
}

async function computeWorktreeRestorePatch(worktreePath: string): Promise<string> {
  const git = createReadOnlyGit(worktreePath);
  const status = await git.status();
  const sections: string[] = [];
  const appendPatchSection = (patchText: string) => {
    if (!patchText) {
      return;
    }

    sections.push(patchText.endsWith("\n") ? patchText : `${patchText}\n`);
  };

  const unstaged = await runGitRaw(git, unstagedDiffArgs("-p", "--binary"));
  if (unstaged) {
    appendPatchSection(unstaged);
  }

  const staged = await runGitRaw(git, await stagedDiffArgs(git, "-p", "--binary"));
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
        timeout: LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS,
      });
    } catch (error) {
      if (options?.threeWayFallback !== true) {
        throw error;
      }
      const threeWayArgs = ["apply", "--3way", "--binary", "--whitespace=nowarn", tempPatchPath];
      await execFileAsync("git", withLongPathSupport(["apply", "--check", "--3way", "--binary", "--whitespace=nowarn", tempPatchPath]), {
        cwd: worktreePath,
        timeout: LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS,
      });
      await execFileAsync("git", withLongPathSupport(threeWayArgs), { cwd: worktreePath, timeout: LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS });
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

const listChangedPaths = (status: StatusResult): Set<string> => {
  const changedPaths = new Set<string>();
  for (const file of status.files) {
    changedPaths.add(file.path);
    // The old side of a rename no longer exists in the source, so it is removed from the target too.
    if (file.from) changedPaths.add(file.from);
  }
  for (const filePath of status.not_added) {
    changedPaths.add(filePath);
  }
  return changedPaths;
};

/**
 * Copies changed files when the patch does not apply. With `protectTargetChanges`, refuses to touch
 * any file the target has changed itself, so a user's own edits are never overwritten.
 */
async function syncChangedFilesFromWorktree(
  sourceWorktreePath: string,
  targetWorktreePath: string,
  options: { protectTargetChanges?: boolean } = {},
): Promise<void> {
  const changedPaths = listChangedPaths(await createReadOnlyGit(sourceWorktreePath).status());

  if (options.protectTargetChanges === true) {
    const targetChanges = listChangedPaths(await createReadOnlyGit(targetWorktreePath).status());
    const conflicts = [...changedPaths].filter((filePath) => targetChanges.has(filePath));
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, 5).join(", ");
      throw new Error(
        `The target checkout has its own changes to ${shown}${conflicts.length > 5 ? `, and ${String(conflicts.length - 5)} more` : ""}, so they were not overwritten.`,
      );
    }
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

export interface GitPullRequestContext {
  targetRef: string;
  mergeBase: string;
  commits: Array<{ hash: string; subject: string }>;
  hasOpenChanges: boolean;
  diff: string;
}

export class GitService {
  async getHeadCommitSha(repoPath: string): Promise<string> {
    return (await createLocalGit(repoPath).revparse(["HEAD"])).trim();
  }

  async getBranchCommitSha(repoPath: string, branchName: string): Promise<string> {
    const trimmedBranchName = assertRefArgument(branchName);
    return (await createLocalGit(repoPath).revparse(["--verify", `refs/heads/${trimmedBranchName}^{commit}`])).trim();
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    const git = createLocalGit(repoPath);
    const branchName = (await git.branch(["--show-current"])).current?.trim();

    if (!branchName) {
      throw new Error(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE);
    }

    return branchName;
  }

  async checkoutProjectBranch(repoPath: string, branchName: string): Promise<void> {
    const git = createLocalGit(repoPath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    if (!branchName.trim()) {
      throw new Error("Select a branch.");
    }
    const trimmedBranchName = assertRefArgument(branchName);

    if (await this.hasLocalBranch(repoPath, trimmedBranchName)) {
      await runGitRaw(git, ["checkout", trimmedBranchName, "--"]);
      return;
    }

    const remoteName = (await this.getDefaultRemote(repoPath)) ?? "origin";
    if (await this.hasRemoteBranch(repoPath, trimmedBranchName, remoteName)) {
      await runGitRaw(git, ["checkout", "--track", "-b", trimmedBranchName, `${remoteName}/${trimmedBranchName}`, "--"]);
      return;
    }

    // A bare `git checkout <name>` would restore a file with that name and discard its local edits.
    throw new Error(`Branch "${trimmedBranchName}" was not found locally or on ${remoteName}.`);
  }

  async getProjectBranchOverview(repoPath: string, baseBranch: string): Promise<ProjectGitBranchOverview> {
    const git = createLocalGit(repoPath);

    let currentBranch = "";
    try {
      currentBranch = await this.getCurrentBranch(repoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE)) {
        throw error;
      }
    }

    const defaultRemote = await this.getDefaultRemote(repoPath);
    const remoteName = defaultRemote ?? "origin";
    let provider: ProjectGitBranchOverview["provider"] = "unknown";
    let webBaseUrl: string | null = null;
    try {
      const remoteOutput = await git.remote(["get-url", remoteName]);
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
        authorName: null,
        baseAhead: null,
        baseBehind: null,
        mergedIntoBase: false,
        worktreePath: null,
        linkedRunCount: 0,
      };
      branches.set(name, created);
      return created;
    };
    // Full ref per branch for base comparison: the local branch when present, otherwise the remote one.
    const comparisonRefs = new Map<string, string>();

    // The subject comes last because it is the only field that may contain a tab.
    const localRefs = await runGitRaw(git, [
      "for-each-ref",
      "--format=%(refname)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(upstream:track,nobracket)%09%(authorname)%09%(worktreepath)%09%(subject)",
      "refs/heads",
    ]);
    for (const line of localRefs.split(/\r?\n/).filter((entry) => entry.trim())) {
      const [refName = "", upstream = "", commitSha = "", updatedAt = "", track = "", authorName = "", worktreePath = "", ...subjectParts] = line.split("\t");
      const name = refName.startsWith("refs/heads/") ? refName.slice("refs/heads/".length) : "";
      if (!name) {
        continue;
      }
      const branch = ensureBranch(name);
      const tracking = parseAheadBehind(track);
      const subject = subjectParts.join("\t").trim();
      branch.hasLocal = true;
      branch.upstream = upstream || null;
      branch.hasRemote = branch.hasRemote || upstream.startsWith(`${remoteName}/`);
      branch.ahead = tracking.ahead;
      branch.behind = tracking.behind;
      branch.commitSha = commitSha || branch.commitSha;
      branch.updatedAt = normalizeGitDate(updatedAt) ?? branch.updatedAt;
      branch.subject = subject || branch.subject;
      branch.authorName = authorName.trim() || branch.authorName;
      branch.worktreePath = worktreePath.trim() && !isSameWorktreePath(worktreePath.trim(), repoPath) ? worktreePath.trim() : null;
      comparisonRefs.set(name, refName);
    }

    if (defaultRemote) {
      try {
        const remoteRefs = await runGitRaw(git, [
          "for-each-ref",
          "--format=%(refname)%09%(objectname:short)%09%(committerdate:iso8601)%09%(authorname)%09%(subject)",
          `refs/remotes/${remoteName}`,
        ]);
        const remoteRefPrefix = `refs/remotes/${remoteName}/`;
        for (const line of remoteRefs.split(/\r?\n/).filter((entry) => entry.trim())) {
          const [refName = "", commitSha = "", updatedAt = "", authorName = "", ...subjectParts] = line.split("\t");
          const name = refName.startsWith(remoteRefPrefix) ? refName.slice(remoteRefPrefix.length) : "";
          if (!name || name === "HEAD") {
            continue;
          }
          const branch = ensureBranch(name);
          branch.hasRemote = true;
          branch.commitSha = branch.commitSha ?? (commitSha || null);
          branch.updatedAt = branch.updatedAt ?? normalizeGitDate(updatedAt);
          branch.subject = branch.subject ?? (subjectParts.join("\t").trim() || null);
          branch.authorName = branch.authorName ?? (authorName.trim() || null);
          if (!comparisonRefs.has(name)) {
            comparisonRefs.set(name, refName);
          }
        }
      } catch {
        // Remote refs are optional; local-only repositories are valid.
      }
    }

    const baseCompareRef = await this.resolveBaseCompareRef(repoPath, baseBranch, defaultRemote);
    if (baseCompareRef) {
      const candidates = [...comparisonRefs].filter(([name]) => name !== baseBranch);
      const namespaces = defaultRemote ? ["refs/heads", `refs/remotes/${defaultRemote}`] : ["refs/heads"];
      const [divergence, mergedRefs] = await Promise.all([
        this.readBaseDivergence(repoPath, baseCompareRef, namespaces, candidates.map(([, ref]) => ref)).catch(() => new Map<string, BaseDivergence>()),
        runGitRaw(git, ["for-each-ref", "--format=%(refname)", "--merged", baseCompareRef, ...namespaces])
          .then((output) => new Set(output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)))
          .catch(() => new Set<string>()),
      ]);
      for (const [name, ref] of candidates) {
        const branch = branches.get(name);
        const counts = divergence.get(ref);
        if (!branch) {
          continue;
        }
        branch.baseAhead = counts?.ahead ?? null;
        branch.baseBehind = counts?.behind ?? null;
        branch.mergedIntoBase = mergedRefs.has(ref);
      }
    }

    const [changedFileCount, operation] = await Promise.all([
      this.countChangedFiles(repoPath).catch(() => 0),
      this.getInProgressOperation(repoPath).catch(() => null),
    ]);
    const conflictedFiles = await this.listConflictedFiles(repoPath).catch(() => []);

    return {
      repoPath,
      baseBranch,
      currentBranch,
      provider,
      webBaseUrl,
      remoteName: defaultRemote,
      baseCompareRef: baseCompareRef?.replace(/^refs\/(?:heads|remotes)\//, "") ?? null,
      changedFileCount,
      operation,
      conflictedFiles,
      branches: [...branches.values()].sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
        if (left.isBase !== right.isBase) return left.isBase ? -1 : 1;
        if (left.hasLocal !== right.hasLocal) return left.hasLocal ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      }),
    };
  }

  async validateProject(repoPath: string): Promise<GitProjectValidation> {
    const git = createLocalGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return {
        repoPath,
        repoRoot: repoPath,
        repoName: basename(repoPath),
        baseBranch: "main",
        isGitRepo: false,
        isWorktree: false,
        isDirty: false,
      };
    }

    const branchSummary = await git.branch(["--show-current"]);
    const status = await createReadOnlyGit(repoPath).status();
    // `--git-common-dir` alone is relative to the selected folder, so a subfolder looked like a worktree.
    const [topLevel, gitDir, commonDir] = (await git.raw(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]))
      .split(/\r?\n/)
      .map((line) => line.trim());

    const baseBranch = await detectProjectBaseBranch(git, repoPath, branchSummary.current, (await this.getDefaultRemote(repoPath)) ?? "origin");

    return {
      repoPath,
      repoRoot: topLevel ? resolve(topLevel) : repoPath,
      repoName: basename(repoPath),
      baseBranch,
      isGitRepo: true,
      isWorktree: Boolean(gitDir && commonDir) && !isSameWorktreePath(resolve(repoPath, gitDir!), resolve(repoPath, commonDir!)),
      isDirty: !status.isClean(),
    };
  }

  async createWorktreeForRun(
    repoPath: string,
    projectName: string,
    runId: string,
    baseBranch: string,
    configuredWorktreeRoot?: string | null,
    shareDependencies = true,
  ): Promise<{ branchName: string; worktreePath: string }> {
    return this.addRunWorktree(repoPath, projectName, runId, baseBranch, configuredWorktreeRoot, shareDependencies);
  }

  async createWorktreeForContinuation(
    repoPath: string,
    projectName: string,
    runId: string,
    sourceBranch: string,
    configuredWorktreeRoot?: string | null,
    shareDependencies = true,
  ): Promise<{ branchName: string; worktreePath: string }> {
    return this.addRunWorktree(repoPath, projectName, runId, sourceBranch, configuredWorktreeRoot, shareDependencies);
  }

  private async addRunWorktree(
    repoPath: string,
    projectName: string,
    runId: string,
    startPoint: string,
    configuredWorktreeRoot: string | null | undefined,
    shareDependencies: boolean,
  ): Promise<{ branchName: string; worktreePath: string }> {
    const git = createLocalGit(repoPath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    await ensureGitLongPathSupport(git, repoPath);
    const startRef = assertRefArgument(startPoint, "Start point");
    const worktreeRoot = this.getWorktreeRoot(repoPath, configuredWorktreeRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    const branchName = `${sanitizeSegment(projectName)}-${sanitizeSegment(runId)}`;
    const worktreePath = join(worktreeRoot, branchName);

    if (existsSync(worktreePath)) {
      // Reuse only this run's own registered worktree; a leftover folder is not a usable workspace.
      const isOwnWorktree =
        (await this.isWorktreeRegistered(repoPath, worktreePath)) &&
        (await createLocalGit(worktreePath).branch(["--show-current"]).then((summary) => summary.current === branchName, () => false));
      if (!isOwnWorktree) {
        throw new Error(
          `A folder already exists at ${worktreePath} but is not the worktree for branch "${branchName}". Remove the folder and try again.`,
        );
      }
      if (shareDependencies) await ensureWorktreeDependencyLinks(repoPath, worktreePath);
      return { branchName, worktreePath };
    }

    const branchExisted = await this.hasLocalBranch(repoPath, branchName);
    try {
      // `--no-track`: a run branch started from origin/<base> must not adopt the base as its upstream.
      await runGitRaw(git, ["worktree", "add", "--no-track", "-b", branchName, "--", worktreePath, startRef]);
      if (shareDependencies) await ensureWorktreeDependencyLinks(repoPath, worktreePath);
    } catch (error) {
      // A failed checkout can leave a registered worktree and a new branch behind; nothing owns them yet.
      await this.removeWorktree(repoPath, worktreePath, branchExisted ? undefined : branchName, configuredWorktreeRoot).catch(() => {});
      throw error;
    }

    return { branchName, worktreePath };
  }

  /**
   * Fetches the base branch and returns the newest start point that keeps the user's work: origin's
   * branch when the local branch is missing or only behind it, otherwise the local branch. Falls back to
   * the local branch when the fetch fails, for example offline.
   */
  async resolveFreshBaseStartPoint(repoPath: string, baseBranch: string): Promise<string> {
    const base = assertRefArgument(baseBranch, "Base branch");
    const remoteName = await this.getDefaultRemote(repoPath);
    if (!remoteName) {
      return base;
    }
    const remoteRef = `refs/remotes/${remoteName}/${base}`;
    try {
      await runNetworkGit(repoPath, ["fetch", "--quiet", "--no-tags", remoteName, `+refs/heads/${base}:${remoteRef}`], BASE_BRANCH_REFRESH_TIMEOUT_MS);
    } catch {
      return base;
    }
    if (!(await runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", remoteRef]))) {
      return base;
    }
    if (!(await this.hasLocalBranch(repoPath, base))) {
      return remoteRef;
    }
    // A local base with unpushed or diverged commits is kept: the user built on it deliberately.
    return (await runGitProbe(repoPath, ["merge-base", "--is-ancestor", `refs/heads/${base}`, remoteRef])) ? remoteRef : base;
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const git = createLocalGit(repoPath);
    // NUL-separated output survives paths with newlines; Git before 2.36 rejects `-z`.
    let chunks: string[][];
    try {
      chunks = (await runGitRaw(git, ["worktree", "list", "--porcelain", "-z"]))
        .split("\0\0")
        .map((chunk) => chunk.split("\0").filter(Boolean))
        .filter((lines) => lines.length > 0);
    } catch {
      chunks = (await runGitRaw(git, ["worktree", "list", "--porcelain"]))
        .trim()
        .split(/\r?\n\r?\n/)
        .filter(Boolean)
        .map((chunk) => chunk.split(/\r?\n/));
    }

    return chunks.map((lines) => {
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
    const git = createLocalGit(worktreePath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    const currentBranch = (await git.branch(["--show-current"])).current;

    if (!currentBranch || currentBranch !== branchName) {
      return;
    }

    await runGitRaw(git, ["checkout", "--detach"]);
  }

  async checkoutWorktreeBranch(worktreePath: string, branchName: string): Promise<void> {
    const git = createLocalGit(worktreePath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    const trimmedBranchName = assertRefArgument(branchName);
    const currentBranch = (await git.branch(["--show-current"])).current;

    if (currentBranch === trimmedBranchName) {
      return;
    }

    await runGitRaw(git, ["checkout", trimmedBranchName, "--"]);
  }

  async hasWorktreeGitMetadata(worktreePath: string): Promise<boolean> {
    return pathExists(join(worktreePath, ".git"));
  }

  async isWorktreeRegistered(repoPath: string, worktreePath: string): Promise<boolean> {
    const registeredWorktrees = await this.listWorktrees(repoPath);
    return registeredWorktrees.some((entry) => isSameWorktreePath(entry.worktreePath, worktreePath));
  }

  async hasLocalBranch(repoPath: string, branchName: string): Promise<boolean> {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      return false;
    }
    return runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${trimmedBranchName}`]);
  }

  /** Whether `<remote>/<branch>` exists locally; defaults to the repository's default remote. */
  async hasRemoteBranch(repoPath: string, branchName: string, remoteName?: string): Promise<boolean> {
    const remote = remoteName ?? (await this.getDefaultRemote(repoPath));
    return remote ? runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`]) : false;
  }

  /** The remote that hosts base and target branches: `origin` when present, otherwise the first remote. */
  async getDefaultRemote(repoPath: string): Promise<string | null> {
    const remotes = (await runGitRaw(createLocalGit(repoPath), ["remote"]))
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean);
    return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  }

  /**
   * Resolves the remote a branch is pushed to like Git does: `branch.<name>.pushRemote`, then
   * `remote.pushDefault`, then the branch's upstream remote, then the default remote. Fork setups
   * that push to a personal remote therefore stop pushing to `origin`.
   */
  async getPushRemote(repoPath: string, branchName: string): Promise<string> {
    const git = createLocalGit(repoPath);
    for (const key of [`branch.${branchName}.pushRemote`, "remote.pushDefault", `branch.${branchName}.remote`]) {
      const value = (await runGitRaw(git, ["config", "--get", key]).catch(() => "")).trim();
      if (value && value !== ".") {
        return value;
      }
    }
    const defaultRemote = await this.getDefaultRemote(repoPath);
    if (!defaultRemote) {
      throw new Error("This repository has no Git remote to push to.");
    }
    return defaultRemote;
  }

  /**
   * Mirrors `git branch -d`: a branch is merged when its upstream, or HEAD without one, contains it. With a
   * base branch, containment in the ref the branch overview compares against counts too, so branches the
   * overview lists as merged can be deleted after their PR merged on the forge and the local base fell behind.
   */
  async isBranchMerged(repoPath: string, branchName: string, baseBranch?: string): Promise<boolean> {
    const trimmedBranchName = branchName.trim();
    const branchRef = `refs/heads/${trimmedBranchName}`;
    const upstream = (await runGitRaw(createLocalGit(repoPath), ["for-each-ref", "--format=%(upstream)", branchRef])).trim();
    // The upstream stays configured after its remote branch is deleted and pruned, typically after a
    // merged PR; like `git branch -d`, fall back to HEAD when it no longer resolves.
    const upstreamExists = upstream ? await runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", upstream]) : false;
    if (await runGitProbe(repoPath, ["merge-base", "--is-ancestor", branchRef, upstreamExists ? upstream : "HEAD"])) {
      return true;
    }
    const baseCompareRef = baseBranch ? await this.resolveBaseCompareRef(repoPath, baseBranch, await this.getDefaultRemote(repoPath)) : null;
    return baseCompareRef ? runGitProbe(repoPath, ["merge-base", "--is-ancestor", branchRef, baseCompareRef]) : false;
  }

  async assertCombinedBranchDeletionSafe(repoPath: string, branchName: string, baseBranch: string): Promise<void> {
    const name = assertRefArgument(branchName);
    const remote = await this.getDefaultRemote(repoPath);
    const base = await this.resolveBaseCompareRef(repoPath, baseBranch, remote);
    for (const ref of [`refs/heads/${name}`, ...(remote ? [`refs/remotes/${remote}/${name}`] : [])]) {
      if (!(await runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", ref]))) continue;
      if (!base || !(await runGitProbe(repoPath, ["merge-base", "--is-ancestor", ref, base]))) {
        throw new Error(`"${ref}" is not merged into the base branch. Force delete to discard its unmerged commits.`);
      }
    }
  }

  async fetchProjectBranches(repoPath: string): Promise<void> {
    await runNetworkGit(repoPath, ["fetch", "--all", "--prune"]);
  }

  async createProjectBranch(repoPath: string, branchName: string, startPoint: string, checkout = true): Promise<void> {
    const git = createLocalGit(repoPath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    const trimmedBranchName = branchName.trim();
    const trimmedStartPoint = startPoint.trim();
    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }
    if (!trimmedStartPoint) {
      throw new Error("Select a source branch.");
    }
    assertRefArgument(trimmedStartPoint, "Source branch");
    await this.validateBranchName(repoPath, trimmedBranchName);
    if (await this.hasLocalBranch(repoPath, trimmedBranchName)) {
      throw new Error(`A local branch named "${trimmedBranchName}" already exists.`);
    }
    // `--no-track`: a branch started from a remote branch must not adopt it as its upstream, or pulls would
    // fast-forward it onto the source branch; pushing sets the branch's own upstream.
    if (checkout) {
      await runGitRaw(git, ["checkout", "--no-track", "-b", trimmedBranchName, trimmedStartPoint, "--"]);
    } else {
      await runGitRaw(git, ["branch", "--no-track", trimmedBranchName, trimmedStartPoint]);
    }
  }

  async renameProjectBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
    const git = createLocalGit(repoPath);
    const trimmedOldName = oldName.trim();
    const trimmedNewName = newName.trim();
    if (!trimmedOldName || !trimmedNewName) {
      throw new Error("Enter both the current and new branch names.");
    }
    assertRefArgument(trimmedOldName);
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
    const git = createLocalGit(repoPath);
    if (!branchName.trim()) {
      throw new Error("Select a branch.");
    }
    const trimmedBranchName = assertRefArgument(branchName);
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
    await runNetworkGit(repoPath, ["pull", "--ff-only"]);
  }

  async pushProjectBranch(repoPath: string, branchName: string, setUpstream = true): Promise<void> {
    if (!branchName.trim()) {
      throw new Error("Select a branch.");
    }
    const trimmedBranchName = assertRefArgument(branchName);
    if (!(await this.hasLocalBranch(repoPath, trimmedBranchName))) {
      throw new Error(`Local branch "${trimmedBranchName}" was not found.`);
    }
    const remoteName = await this.getPushRemote(repoPath, trimmedBranchName);
    await runNetworkGit(repoPath, setUpstream ? ["push", "-u", remoteName, trimmedBranchName] : ["push", remoteName, trimmedBranchName]);
  }

  /**
   * Fast-forwards a local branch that is not checked out from its upstream. Git refuses non-fast-forward
   * updates and branches checked out in any worktree, so local work is never overwritten.
   */
  async fastForwardBranchFromUpstream(repoPath: string, branchName: string): Promise<void> {
    const trimmedBranchName = assertRefArgument(branchName);
    if (!(await this.hasLocalBranch(repoPath, trimmedBranchName))) {
      throw new Error(`Local branch "${trimmedBranchName}" was not found.`);
    }
    const git = createLocalGit(repoPath);
    const readConfig = async (key: string) => (await runGitRaw(git, ["config", "--get", key]).catch(() => "")).trim();
    const remote = await readConfig(`branch.${trimmedBranchName}.remote`);
    const mergeRef = await readConfig(`branch.${trimmedBranchName}.merge`);
    if (!remote || !mergeRef) {
      throw new Error(`"${trimmedBranchName}" has no upstream branch to pull from. Push it with tracking first.`);
    }
    assertRefArgument(remote, "Remote");
    await runNetworkGit(repoPath, ["fetch", remote, `${mergeRef}:refs/heads/${trimmedBranchName}`]);
  }

  /**
   * Deletes a branch on the default remote; the local branch is left untouched. The push is leased on the
   * fetched tip, so Git refuses it when someone pushed since the last fetch. Without `force`, the tip must also
   * be in the base branch or a local branch, so deleting the remote branch never drops its last reference.
   */
  async deleteRemoteBranch(repoPath: string, branchName: string, options: { force?: boolean; baseBranch?: string } = {}): Promise<void> {
    const trimmedBranchName = assertRefArgument(branchName);
    const remoteName = await this.getDefaultRemote(repoPath);
    if (!remoteName) {
      throw new Error("This repository has no Git remote.");
    }
    const tip = (
      await runGitRaw(createLocalGit(repoPath), ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}/${trimmedBranchName}^{commit}`]).catch(() => "")
    ).trim();
    if (!tip) {
      throw new Error(`Branch "${trimmedBranchName}" was not found on ${remoteName}. Fetch to refresh remote branches.`);
    }
    if (options.force !== true && !(await this.isCommitRetained(repoPath, tip, options.baseBranch, remoteName))) {
      throw new Error(
        `"${remoteName}/${trimmedBranchName}" has commits that are not in the base branch or any local branch. Force delete it to discard them.`,
      );
    }
    try {
      await runNetworkGit(repoPath, ["push", `--force-with-lease=refs/heads/${trimmedBranchName}:${tip}`, remoteName, "--delete", trimmedBranchName]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("stale info")) {
        throw new Error(`"${remoteName}/${trimmedBranchName}" changed on the remote since the last fetch. Fetch and review the new commits before deleting it.`);
      }
      throw error;
    }
  }

  /** Whether a commit stays reachable from the base branch or a local branch. */
  private async isCommitRetained(repoPath: string, commit: string, baseBranch: string | undefined, remoteName: string): Promise<boolean> {
    const baseCompareRef = baseBranch ? await this.resolveBaseCompareRef(repoPath, baseBranch, remoteName) : null;
    if (baseCompareRef && (await runGitProbe(repoPath, ["merge-base", "--is-ancestor", commit, baseCompareRef]))) {
      return true;
    }
    const containing = await runGitRaw(createLocalGit(repoPath), ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", commit, "refs/heads"]);
    return containing.trim().length > 0;
  }

  /**
   * Merges a branch into the checked-out branch. A merge that stops on conflicts is aborted, so the
   * repository is left exactly as before and the caller can resolve conflicts with their own tools.
   */
  async mergeIntoCurrentBranch(repoPath: string, sourceRef: string, mode: MergeProjectBranchMode = "default"): Promise<void> {
    const source = await this.resolveBranchOperationRef(repoPath, sourceRef);
    const currentBranch = await this.getCurrentBranch(repoPath);
    await this.assertNoOperationInProgress(repoPath);
    await this.assertCommitExists(repoPath, source);
    const args = ["merge", "--no-edit"];
    if (mode === "no-ff") args.push("--no-ff");
    if (mode === "ff-only") args.push("--ff-only");
    args.push(source);
    await this.runAbortingOnConflict(repoPath, "merge", args, (conflicts) =>
      `Merging "${sourceRef}" into "${currentBranch}" stopped on ${conflicts}. The merge was aborted and "${currentBranch}" is unchanged; resolve the conflicts in your editor or terminal.`,
    );
  }

  /**
   * Replays the checked-out branch onto another ref. Uncommitted changes are stashed and restored, and a
   * rebase that stops on conflicts is aborted so the branch keeps its original commits.
   */
  async rebaseCurrentBranch(repoPath: string, ontoRef: string): Promise<void> {
    const onto = await this.resolveBranchOperationRef(repoPath, ontoRef);
    const currentBranch = await this.getCurrentBranch(repoPath);
    await this.assertNoOperationInProgress(repoPath);
    await this.assertCommitExists(repoPath, onto);
    await this.runAbortingOnConflict(repoPath, "rebase", ["rebase", "--autostash", onto], (conflicts) =>
      `Rebasing "${currentBranch}" onto "${ontoRef}" stopped on ${conflicts}. The rebase was aborted and "${currentBranch}" is unchanged; resolve the conflicts in your editor or terminal.`,
    );
    // Git still exits 0 when the rebase succeeds but restoring the autostash conflicts.
    const stashConflicts = await this.listConflictedFiles(repoPath);
    if (stashConflicts.length > 0) {
      throw new Error(
        `Rebased "${currentBranch}" onto "${ontoRef}", but restoring your uncommitted changes stopped on ${describeConflictedFiles(stashConflicts)}. The changes are still saved in the stash; resolve the conflicts in your editor or terminal.`,
      );
    }
  }

  async abortInProgressOperation(repoPath: string): Promise<void> {
    const operation = await this.getInProgressOperation(repoPath);
    if (!operation) {
      throw new Error("No merge, rebase, cherry-pick, or revert is in progress.");
    }
    await runGitRaw(createLocalGit(repoPath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS), [operation, "--abort"]);
  }

  async getInProgressOperation(repoPath: string): Promise<ProjectGitOperationKind | null> {
    const args = ["rev-parse", ...IN_PROGRESS_OPERATION_MARKERS.flatMap(({ marker }) => ["--git-path", marker])];
    const paths = (await runGitRaw(createLocalGit(repoPath), args)).split(/\r?\n/).map((entry) => entry.trim());
    const index = IN_PROGRESS_OPERATION_MARKERS.findIndex((_, markerIndex) => {
      const markerPath = paths[markerIndex];
      return Boolean(markerPath) && existsSync(resolve(repoPath, markerPath!));
    });
    return index >= 0 ? IN_PROGRESS_OPERATION_MARKERS[index]!.kind : null;
  }

  private async listConflictedFiles(repoPath: string): Promise<string[]> {
    const output = await runGitRaw(createReadOnlyGit(repoPath), ["diff", "--name-only", "--diff-filter=U"]);
    return output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  }

  private async countChangedFiles(repoPath: string): Promise<number> {
    const output = await runGitRaw(createReadOnlyGit(repoPath), ["status", "--porcelain"]);
    return output.split(/\r?\n/).filter((entry) => entry.trim()).length;
  }

  private async assertNoOperationInProgress(repoPath: string): Promise<void> {
    const operation = await this.getInProgressOperation(repoPath);
    if (operation) {
      throw new Error(`A ${operation} is already in progress in this repository. Finish or abort it first.`);
    }
  }

  private async resolveBranchOperationRef(repoPath: string, value: string): Promise<string> {
    const ref = assertRefArgument(value);
    if (await this.hasLocalBranch(repoPath, ref)) return `refs/heads/${ref}`;
    const remoteRef = `refs/remotes/${ref}`;
    if (await runGitProbe(repoPath, ["show-ref", "--verify", "--quiet", remoteRef])) return remoteRef;
    if (ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/")) return ref;
    throw new Error(`Branch "${ref}" was not found.`);
  }

  private async assertCommitExists(repoPath: string, ref: string): Promise<void> {
    if (!(await runGitProbe(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))) {
      throw new Error(`Branch "${ref}" was not found.`);
    }
  }

  /**
   * simple-git resolves when a conflicted merge reports only on stdout, so the repository state, not the
   * exit code, decides whether the command stopped on conflicts.
   */
  private async runAbortingOnConflict(
    repoPath: string,
    operation: "merge" | "rebase",
    args: string[],
    describeConflict: (conflicts: string) => string,
  ): Promise<void> {
    const git = createLocalGit(repoPath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    let failure: unknown = null;
    try {
      await runGitRaw(git, args);
    } catch (error) {
      failure = error;
    }
    if ((await this.getInProgressOperation(repoPath)) === operation) {
      const conflictedFiles = await this.listConflictedFiles(repoPath).catch(() => []);
      await runGitRaw(git, [operation, "--abort"]);
      throw new Error(describeConflict(describeConflictedFiles(conflictedFiles)));
    }
    if (failure) {
      throw failure;
    }
    if (operation === "merge") {
      const conflicts = await this.listConflictedFiles(repoPath);
      if (conflicts.length > 0) throw new Error(`Merge completed, but restoring uncommitted changes left ${describeConflictedFiles(conflicts)}. Your changes remain saved in the stash; resolve the conflicts in your editor or terminal.`);
    }
  }

  /** Prefers the remote base branch, which reflects merges made on the forge, over the local one. */
  private async resolveBaseCompareRef(repoPath: string, baseBranch: string, remoteName: string | null): Promise<string | null> {
    const base = baseBranch.trim();
    if (!base || base.startsWith("-")) {
      return null;
    }
    if (remoteName && (await this.hasRemoteBranch(repoPath, base, remoteName))) {
      return `refs/remotes/${remoteName}/${base}`;
    }
    return (await this.hasLocalBranch(repoPath, base)) ? `refs/heads/${base}` : null;
  }

  /**
   * Counts commits each ref has beyond the base and lacks from it. Git 2.41+ answers for all refs in one
   * process; older versions fall back to one `rev-list` per ref.
   */
  private async readBaseDivergence(
    repoPath: string,
    baseRef: string,
    namespaces: string[],
    refs: string[],
  ): Promise<Map<string, BaseDivergence>> {
    const result = new Map<string, BaseDivergence>();
    if (refs.length === 0) {
      return result;
    }
    const wanted = new Set(refs);
    const git = createReadOnlyGit(repoPath);
    try {
      // Namespaces instead of single refs keep the command line short in repositories with many branches.
      const output = await runGitRaw(git, ["for-each-ref", `--format=%(refname)%09%(ahead-behind:${baseRef})`, ...namespaces]);
      for (const line of output.split(/\r?\n/).filter((entry) => entry.trim())) {
        const [refName = "", counts = ""] = line.split("\t");
        const [ahead, behind] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (wanted.has(refName) && Number.isFinite(ahead) && Number.isFinite(behind)) {
          result.set(refName, { ahead: ahead!, behind: behind! });
        }
      }
      return result;
    } catch {
      // `ahead-behind` is unknown before Git 2.41.
    }
    await Promise.all(
      refs.slice(0, MAX_BASE_DIVERGENCE_FALLBACK_REFS).map(async (ref) => {
        const output = await runGitRaw(git, ["rev-list", "--left-right", "--count", `${baseRef}...${ref}`]).catch(() => "");
        const [behind, ahead] = output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          result.set(ref, { ahead: ahead!, behind: behind! });
        }
      }),
    );
    return result;
  }

  private async validateBranchName(repoPath: string, branchName: string): Promise<void> {
    assertRefArgument(branchName);
    const git = createLocalGit(repoPath);
    try {
      await runGitRaw(git, ["check-ref-format", "--branch", branchName]);
    } catch (error) {
      throw new Error(`"${branchName}" is not a valid Git branch name: ${extractCommandOutput(error)}`);
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string, branchName?: string, configuredWorktreeRoot?: string | null): Promise<void> {
    const git = createLocalGit(repoPath);
    const cleanupErrors: string[] = [];
    const isRegisteredWorktree = await this.isWorktreeRegistered(repoPath, worktreePath);

    // The recursive removals below must never run while a link into the project repository remains, or
    // a link that is followed would delete the project's shared dependencies.
    try {
      await removeWorktreeDependencyLinks(worktreePath);
    } catch (error) {
      throw new Error(
        `dependency link removal failed, so the worktree was kept to protect the project's shared dependencies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const remainingLinks = await listWorktreeDependencyLinks(worktreePath);
    if (remainingLinks.length > 0) {
      throw new Error(
        `dependency links still exist in the worktree (${remainingLinks.join(", ")}), so it was kept to protect the project's shared dependencies.`,
      );
    }

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

    if (await this.isWorktreeRegistered(repoPath, worktreePath)) {
      cleanupErrors.push("worktree is still registered in git after cleanup");
    }

    if (await pathExists(worktreePath)) {
      cleanupErrors.push("worktree directory still exists after cleanup");
    }

    // Includes the configured root, so a custom worktree location does not keep empty folders behind.
    const currentWorktreeRoots = new Set([this.getWorktreeRoot(repoPath), this.getWorktreeRoot(repoPath, configuredWorktreeRoot)]);
    const managedRoots = new Set<string>([...currentWorktreeRoots, this.getLegacyWorktreeRoot(repoPath), dirname(worktreePath)]);
    for (const rootPath of managedRoots) {
      try {
        const removed = await removeEmptyDirectoryIfPossible(rootPath);
        if (!removed) {
          continue;
        }

        if (currentWorktreeRoots.has(rootPath)) {
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

  async getDiffSummary(worktreePath: string): Promise<RunWorktreeDiffSummary> {
    return computeWorktreeDiffSummary(worktreePath);
  }

  /**
   * Builds the net patch that a PR/MR would contain if the current workspace were committed now.
   * The comparison includes committed, staged, unstaged, and untracked changes relative to the
   * merge base with the selected target branch.
   */
  async getPullRequestContext(worktreePath: string, targetBranch: string): Promise<GitPullRequestContext> {
    const git = createWorktreeDiffGit(worktreePath);
    const trimmedTargetBranch = targetBranch.trim();
    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch.");
    }

    try {
      await runGitRaw(git, ["check-ref-format", "--branch", trimmedTargetBranch]);
    } catch {
      throw new Error(`"${trimmedTargetBranch}" is not a valid target branch name.`);
    }

    try {
      await this.fetchProjectBranches(worktreePath);
    } catch {
      // Keep local-only and temporarily offline repositories usable with their existing refs.
    }

    const remoteName = (await this.getDefaultRemote(worktreePath)) ?? "origin";
    let targetRef = "";
    for (const candidate of [`refs/remotes/${remoteName}/${trimmedTargetBranch}`, `refs/heads/${trimmedTargetBranch}`]) {
      try {
        const resolvedRef = (await runGitRaw(git, ["rev-parse", "--verify", "--quiet", candidate])).trim();
        if (resolvedRef) {
          targetRef = candidate;
          break;
        }
      } catch {
        // Try the local branch after the remote-tracking branch.
      }
    }
    if (!targetRef) {
      throw new Error(`Target branch "${trimmedTargetBranch}" was not found locally or on ${remoteName}.`);
    }

    const mergeBase = (await runGitRaw(git, ["merge-base", targetRef, "HEAD"])).trim();
    if (!mergeBase) {
      throw new Error(`Could not find a merge base between HEAD and "${trimmedTargetBranch}".`);
    }

    const [status, trackedDiff, commitLog] = await Promise.all([
      git.status(),
      runGitRaw(git, ["diff", "--find-renames", mergeBase, "--"]),
      runGitRaw(git, ["log", "--format=%H%x09%s", `${mergeBase}..HEAD`]),
    ]);
    const sections: string[] = [];
    const normalizedTrackedDiff = trackedDiff.trim();
    if (normalizedTrackedDiff) {
      sections.push(normalizedTrackedDiff);
    }
    sections.push(...await renderUntrackedDiffSections(git, status.not_added));

    const commits = commitLog
      .split(/\r?\n/)
      .map((line) => {
        const separatorIndex = line.indexOf("\t");
        if (separatorIndex < 1) return null;
        const hash = line.slice(0, separatorIndex).trim();
        const subject = line.slice(separatorIndex + 1).trim();
        return hash && subject ? { hash, subject } : null;
      })
      .filter((commit): commit is { hash: string; subject: string } => commit !== null);

    return {
      targetRef,
      mergeBase,
      commits,
      hasOpenChanges: !status.isClean(),
      diff: sections.join("\n\n"),
    };
  }

  async getStatusSummary(worktreePath: string): Promise<string> {
    return formatGitStatusSummary(worktreePath);
  }

  async hasChanges(worktreePath: string): Promise<boolean> {
    const git = createReadOnlyGit(worktreePath);
    const status = await git.status();
    return !status.isClean();
  }

  async createPromptRestorePatch(worktreePath: string): Promise<string> {
    return computeWorktreeRestorePatch(worktreePath);
  }

  async cloneWorkspaceChanges(
    sourceWorktreePath: string,
    targetWorktreePath: string,
    options: { protectTargetChanges?: boolean } = {},
  ): Promise<void> {
    const patch = await computeWorktreeRestorePatch(sourceWorktreePath);
    try {
      await applyWorktreePatch(targetWorktreePath, patch, { threeWayFallback: true });
    } catch {
      await syncChangedFilesFromWorktree(sourceWorktreePath, targetWorktreePath, options);
    }
  }

  /**
   * Resets the workspace to HEAD and applies `targetPatch`. Refuses when HEAD moved since the restore
   * point was captured, because the reset would otherwise keep commits made after the prompt. The open
   * changes that the reset discards are written to `safetyPatchPath` first so they stay recoverable.
   */
  async restorePromptRestorePatch(
    worktreePath: string,
    targetPatch: string,
    options: { expectedHeadSha?: string | null; safetyPatchPath?: string } = {},
  ): Promise<{ safetyPatchPath: string | null }> {
    const git = createLocalGit(worktreePath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    if (options.expectedHeadSha && (await this.getHeadCommitSha(worktreePath)) !== options.expectedHeadSha) {
      throw new Error(
        "The workspace has new commits since the last prompt, so its changes cannot be reverted safely. Revert those commits with Git instead.",
      );
    }
    const safetyPatch = await computeWorktreeRestorePatch(worktreePath);
    let safetyPatchPath: string | null = null;
    if (options.safetyPatchPath && safetyPatch.trim()) {
      mkdirSync(dirname(options.safetyPatchPath), { recursive: true });
      await writeFile(options.safetyPatchPath, safetyPatch, "utf8");
      safetyPatchPath = options.safetyPatchPath;
    }

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
    return { safetyPatchPath };
  }

  async commitAllChanges(worktreePath: string, message: string): Promise<{ commitHash: string }> {
    const git = createLocalGit(worktreePath, LONG_LOCAL_GIT_INACTIVITY_TIMEOUT_MS);
    const status = await git.status();

    if (status.isClean()) {
      throw new Error("There are no changes to commit in this run worktree.");
    }

    await git.add(["-A"]);
    // Shared dependency links point into the project repository and must never be committed. A
    // `node_modules/` ignore rule only matches directories, so Git would otherwise stage the link itself.
    const dependencyLinks = await listWorktreeDependencyLinks(worktreePath);
    if (dependencyLinks.length > 0) {
      await runGitRaw(git, ["reset", "-q", "--", ...dependencyLinks]);
      if (!(await runGitRaw(git, ["diff", "--cached", "--name-only"])).trim()) {
        throw new Error("There are no changes to commit in this run worktree.");
      }
    }

    const result = await git.commit(message);

    return {
      commitHash: result.commit,
    };
  }

  async publishBranch(worktreePath: string, branchName: string): Promise<{ branchName: string; remoteName: string }> {
    const trimmedBranchName = assertRefArgument(branchName);
    const remoteName = await this.getPushRemote(worktreePath, trimmedBranchName);
    await runNetworkGit(worktreePath, ["push", "-u", remoteName, trimmedBranchName]);

    return {
      branchName,
      remoteName,
    };
  }

  async listTargetBranches(worktreePath: string): Promise<string[]> {
    const git = createLocalGit(worktreePath);
    const branches = new Set<string>();

    try {
      const remoteName = (await this.getDefaultRemote(worktreePath)) ?? "origin";
      const remoteRefPrefix = `refs/remotes/${remoteName}/`;
      const remoteRefs = await git.raw(["for-each-ref", "--format=%(refname)", `refs/remotes/${remoteName}`]);
      for (const line of remoteRefs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
        const name = line.startsWith(remoteRefPrefix) ? line.slice(remoteRefPrefix.length) : "";
        if (!name || name === "HEAD") {
          continue;
        }

        branches.add(name);
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
    const git = createLocalGit(worktreePath);
    return (await git.raw(["log", "-1", "--format=%s", assertRefArgument(branchName), "--"])).trim();
  }

  /** Throws unless a new publish branch with this name can be created locally and on its push remote. */
  async assertPublishBranchAvailable(worktreePath: string, branchName: string): Promise<string> {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Enter a source branch name.");
    }
    await this.validateBranchName(worktreePath, trimmedBranchName);

    if (await this.hasLocalBranch(worktreePath, trimmedBranchName)) {
      throw new Error(`A local branch named "${trimmedBranchName}" already exists.`);
    }

    // A bare pattern also matches slash-delimited tails, so `feature` would hit `refs/heads/team/feature`.
    const remoteName = await this.getPushRemote(worktreePath, trimmedBranchName);
    const remoteHeads = (
      await runNetworkGit(worktreePath, ["ls-remote", "--heads", remoteName, `refs/heads/${trimmedBranchName}`])
    ).trim();
    if (remoteHeads) {
      throw new Error(`A remote branch named "${trimmedBranchName}" already exists on ${remoteName}.`);
    }

    return trimmedBranchName;
  }

  async createPublishBranchFromHead(worktreePath: string, branchName: string): Promise<void> {
    const trimmedBranchName = await this.assertPublishBranchAvailable(worktreePath, branchName);
    const git = createLocalGit(worktreePath);
    await runGitRaw(git, ["checkout", "-b", trimmedBranchName, "HEAD"]);
  }

  async createPullRequest(
    worktreePath: string,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): Promise<{ url: string; mode: PublishMode; requestKind: PublishRequestKind; descriptionOmitted?: boolean }> {
    assertRefArgument(branchName);
    assertRefArgument(targetBranch, "Target branch");
    const baseRemoteName = await this.getDefaultRemote(worktreePath);
    const pushRemoteName = await this.getPushRemote(worktreePath, branchName);
    const remote = baseRemoteName ? await this.getParsedRemote(worktreePath, baseRemoteName) : null;
    await runNetworkGit(worktreePath, ["push", "-u", pushRemoteName, branchName]);
    const headSelector = await this.getForkHeadSelector(worktreePath, branchName, remote, baseRemoteName, pushRemoteName);

    if (remote?.provider === "gitlab") {
      // A branch pushed to a fork cannot be matched to its merge request reliably, so it is not looked up.
      const existingUrl =
        pushRemoteName === baseRemoteName ? await this.findOpenMergeRequestUrl(worktreePath, branchName, targetBranch) : null;
      if (existingUrl) {
        return { url: existingUrl, mode: "existing", requestKind: "merge-request" };
      }
      try {
        const { stdout } = await execForgeCli(
          "glab",
          [
            "mr",
            "create",
            "--source-branch",
            branchName,
            "--target-branch",
            targetBranch,
            "--title",
            title,
            "--description",
            fitForgeCliDescription(body),
          ],
          worktreePath,
        );

        return {
          url: stdout.trim(),
          mode: "created",
          requestKind: "merge-request",
        };
      } catch (error) {
        const mergeRequestDraft = isForgeCliUnavailableError(error)
          ? this.buildGitlabMergeRequestUrl(remote, branchName, targetBranch, title, body)
          : null;
        if (mergeRequestDraft) {
          return {
            url: mergeRequestDraft.url,
            mode: "browser-draft",
            requestKind: "merge-request",
            ...(mergeRequestDraft.descriptionOmitted ? { descriptionOmitted: true } : {}),
          };
        }
        if (isTimedOutCommandError(error)) {
          throw new Error(
            `GitLab CLI did not finish within ${String(NETWORK_COMMAND_TIMEOUT_MINUTES)} minutes. The branch was pushed; check \`glab auth status\` and create the merge request again.`,
          );
        }
        throw new Error(
          readCommandStderr(error) || (error instanceof Error ? error.message : "") || "Failed to create merge request for this GitLab repository.",
        );
      }
    }

    const headOwner = headSelector.includes(":") ? headSelector.slice(0, headSelector.indexOf(":")) : githubOwnerOf(remote);
    const existingUrl = await this.findOpenPullRequestUrl(worktreePath, branchName, targetBranch, headOwner);
    if (existingUrl) {
      return { url: existingUrl, mode: "existing", requestKind: "pull-request" };
    }

    // The body goes through a file: the command line is capped at 32,767 characters on Windows.
    const bodyFilePath = join(tmpdir(), `buildwarden-pr-body-${crypto.randomUUID()}.md`);
    await writeFile(bodyFilePath, body, "utf8");
    try {
      const { stdout } = await execForgeCli(
        "gh",
        ["pr", "create", "--base", targetBranch, "--head", headSelector, "--title", title, "--body-file", bodyFilePath],
        worktreePath,
      );

      return {
        url: stdout.trim(),
        mode: "created",
        requestKind: "pull-request",
      };
    } catch (error) {
      if (isForgeCliUnavailableError(error)) {
        const compareDraft = this.buildGithubCompareUrl(remote, headSelector, targetBranch, title, body);
        if (compareDraft) {
          return {
            url: compareDraft.url,
            mode: "browser-draft",
            requestKind: "pull-request",
            ...(compareDraft.descriptionOmitted ? { descriptionOmitted: true } : {}),
          };
        }
      }
      if (isTimedOutCommandError(error)) {
        throw new Error(
          `GitHub CLI did not finish within ${String(NETWORK_COMMAND_TIMEOUT_MINUTES)} minutes. The branch was pushed; check \`gh auth status\` and create the pull request again.`,
        );
      }

      throw new Error(readCommandStderr(error) || (error instanceof Error ? error.message : "") || "Failed to create pull request with GitHub CLI.");
    } finally {
      await unlink(bodyFilePath).catch(() => {});
    }
  }

  /** Best effort: the open pull request from `headOwner`'s branch into the base, so publishing again reuses it. */
  private async findOpenPullRequestUrl(
    worktreePath: string,
    branchName: string,
    targetBranch: string,
    headOwner: string,
  ): Promise<string | null> {
    if (!headOwner) {
      return null;
    }
    try {
      const { stdout } = await execForgeCli(
        "gh",
        ["pr", "list", "--head", branchName, "--base", targetBranch, "--state", "open", "--json", "url,headRepositoryOwner", "--limit", "20"],
        worktreePath,
      );
      return selectOwnOpenPullRequestUrl(JSON.parse(stdout), headOwner);
    } catch {
      return null;
    }
  }

  /** Best effort: an open merge request for this source and target, so publishing again reuses it. */
  private async findOpenMergeRequestUrl(worktreePath: string, branchName: string, targetBranch: string): Promise<string | null> {
    try {
      const { stdout } = await execForgeCli(
        "glab",
        ["mr", "list", "--source-branch", branchName, "--target-branch", targetBranch, "--output", "json"],
        worktreePath,
      );
      return selectOwnOpenMergeRequestUrl(JSON.parse(stdout));
    } catch {
      return null;
    }
  }

  async ensureRepoReady(repoPath: string): Promise<void> {
    const git = createLocalGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      throw new Error(`Path is not a Git repository: ${repoPath}`);
    }
  }

  createGitClient(repoPath: string): SimpleGit {
    return createLocalGit(repoPath);
  }

  private buildGithubCompareUrl(
    remote: ParsedRemote | null,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): BrowserDraft | null {
    if (!remote || remote.provider !== "github") {
      return null;
    }

    return buildBrowserDraft((includeDescription) => {
      const params = new URLSearchParams({ expand: "1", title, ...(includeDescription ? { body } : {}) });
      return `${remote.webBaseUrl}/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(branchName)}?${params.toString()}`;
    });
  }

  private buildGitlabMergeRequestUrl(
    remote: ParsedRemote | null,
    branchName: string,
    targetBranch: string,
    title: string,
    body: string,
  ): BrowserDraft | null {
    if (!remote || remote.provider !== "gitlab") {
      return null;
    }

    return buildBrowserDraft((includeDescription) => {
      const params = new URLSearchParams({
        "merge_request[source_branch]": branchName,
        "merge_request[target_branch]": targetBranch,
        "merge_request[title]": title,
        ...(includeDescription ? { "merge_request[description]": body } : {}),
      });
      return `${remote.webBaseUrl}/-/merge_requests/new?${params.toString()}`;
    });
  }

  private async getParsedRemote(worktreePath: string, remoteName: string): Promise<ParsedRemote | null> {
    const git = createLocalGit(worktreePath);
    const remoteOutput = await git.remote(["get-url", remoteName]);
    return parseGitRemoteToWebBase(String(remoteOutput ?? ""));
  }

  /** GitHub needs `owner:branch` when the branch was pushed to a fork rather than the base repository. */
  private async getForkHeadSelector(
    worktreePath: string,
    branchName: string,
    baseRemote: ParsedRemote | null,
    baseRemoteName: string | null,
    pushRemoteName: string,
  ): Promise<string> {
    if (!baseRemote || baseRemote.provider !== "github" || !baseRemoteName || pushRemoteName === baseRemoteName) {
      return branchName;
    }
    const pushRemote = await this.getParsedRemote(worktreePath, pushRemoteName).catch(() => null);
    const pushOwner = githubOwnerOf(pushRemote);
    return pushOwner && pushOwner !== githubOwnerOf(baseRemote) ? `${pushOwner}:${branchName}` : branchName;
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
