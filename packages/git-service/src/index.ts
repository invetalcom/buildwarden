import { existsSync, mkdirSync } from "node:fs";
import { access, copyFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { promisify } from "node:util";
import { GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE, type GitProjectValidation, type WorktreeInfo } from "@easycode/shared";
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
  const tempPatchPath = join(tmpdir(), `easycode-restore-${crypto.randomUUID()}.patch`);
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
    await git.checkout(branchName);
  }

  async validateProject(repoPath: string): Promise<GitProjectValidation> {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return {
        repoPath,
        repoName: basename(repoPath),
        defaultBranch: "main",
        isGitRepo: false,
        isWorktree: false,
        isDirty: false,
      };
    }

    const branchSummary = await git.branch(["--show-current"]);
    const status = await git.status();
    const revParse = await git.raw(["rev-parse", "--git-common-dir"]);
    const gitDir = revParse.trim();

    return {
      repoPath,
      repoName: basename(repoPath),
      defaultBranch: branchSummary.current || "main",
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

        const message =
          typeof error === "object" && error && "stderr" in error
            ? String((error as { stderr?: string }).stderr ?? "").trim()
            : error instanceof Error
              ? error.message
              : String(error);
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

      const message =
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr?: string }).stderr ?? "").trim()
          : error instanceof Error
            ? error.message
            : String(error);
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
    return join(repoPath, ".easycode-worktrees");
  }

  private getWorktreeRoot(repoPath: string, configuredWorktreeRoot?: string | null): string {
    const repoContainer = configuredWorktreeRoot?.trim() || dirname(repoPath);
    const repoName = sanitizeSegment(basename(repoPath)) || "repo";
    return join(repoContainer, ".easycode-worktrees", repoName);
  }
}

export { computePrMrDiffViaFetch, parsePrMrBrowserUrl, type ComputePrMrDiffResult, type ParsedPrMrLink } from "./pr-mr-fetch.js";
export { parseGitRemoteToWebBase, type ParsedGitRemote } from "./remote-parse.js";
