import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { GitService, isSameWorktreePath } from "@buildwarden/git-service";

const temporaryDirectories: string[] = [];

const createRepository = async (): Promise<{ root: string; repoPath: string; git: ReturnType<typeof simpleGit> }> => {
  const root = await mkdtemp(join(tmpdir(), "buildwarden-run-worktree-"));
  temporaryDirectories.push(root);
  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.name", "BuildWarden Test");
  await git.addConfig("user.email", "buildwarden@example.test");
  await writeFile(join(repoPath, "tracked.txt"), "base\n", "utf8");
  await git.add(["tracked.txt"]);
  await git.commit("Base commit");
  await git.branch(["-M", "main"]);
  return { root, repoPath, git };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("isSameWorktreePath", () => {
  it("matches Git's forward-slash worktree paths against platform paths", () => {
    const platformPath = join(tmpdir(), "buildwarden-worktree");
    expect(isSameWorktreePath(platformPath.replace(/\\/g, "/"), platformPath)).toBe(true);
    expect(isSameWorktreePath(`${platformPath}/`, platformPath)).toBe(true);
    expect(isSameWorktreePath(join(tmpdir(), "other"), platformPath)).toBe(false);
  });
});

describe("GitService run worktree lifecycle", () => {
  it("recognizes and fully removes a created run worktree without touching shared dependencies", async () => {
    const { root, repoPath } = await createRepository();
    await mkdir(join(repoPath, "node_modules"));
    await writeFile(join(repoPath, "node_modules", "shared.txt"), "keep\n", "utf8");
    const service = new GitService();

    const workspace = await service.createWorktreeForRun(repoPath, "Project", "run-1", "main", join(root, "worktrees"));

    expect(await service.isWorktreeRegistered(repoPath, workspace.worktreePath)).toBe(true);
    expect(existsSync(join(workspace.worktreePath, "node_modules", "shared.txt"))).toBe(true);

    await service.removeWorktree(repoPath, workspace.worktreePath, workspace.branchName);

    expect(await service.isWorktreeRegistered(repoPath, workspace.worktreePath)).toBe(false);
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(await service.hasLocalBranch(repoPath, workspace.branchName)).toBe(false);
    expect(await readFile(join(repoPath, "node_modules", "shared.txt"), "utf8")).toBe("keep\n");
  });

  it("removes the worktree and branch again when worktree creation fails", async () => {
    const { root, repoPath } = await createRepository();
    const hookPath = join(repoPath, ".git", "hooks", "post-checkout");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    const service = new GitService();

    await expect(service.createWorktreeForRun(repoPath, "Project", "run-1", "main", join(root, "worktrees"))).rejects.toThrow();

    expect(await service.listWorktrees(repoPath)).toHaveLength(1);
    expect(await service.hasLocalBranch(repoPath, "project-run-1")).toBe(false);
    expect(existsSync(join(root, "worktrees", ".buildwarden-worktrees", "repo", "project-run-1"))).toBe(false);
  });

  it("reuses its own worktree but never a leftover folder at the worktree path", async () => {
    const { root, repoPath } = await createRepository();
    const service = new GitService();
    const worktreeRoot = join(root, "worktrees");
    const workspace = await service.createWorktreeForRun(repoPath, "Project", "run-1", "main", worktreeRoot);

    await expect(service.createWorktreeForRun(repoPath, "Project", "run-1", "main", worktreeRoot)).resolves.toEqual(workspace);

    const leftoverPath = join(worktreeRoot, ".buildwarden-worktrees", "repo", "project-run-2");
    await mkdir(leftoverPath, { recursive: true });
    await writeFile(join(leftoverPath, "stale.txt"), "stale\n", "utf8");

    await expect(service.createWorktreeForRun(repoPath, "Project", "run-2", "main", worktreeRoot)).rejects.toThrow("already exists");
    expect(await readFile(join(leftoverPath, "stale.txt"), "utf8")).toBe("stale\n");
  });

  it("never commits the shared dependency link of a run worktree", async () => {
    const { root, repoPath } = await createRepository();
    await mkdir(join(repoPath, "node_modules"));
    await writeFile(join(repoPath, "node_modules", "shared.txt"), "keep\n", "utf8");
    const service = new GitService();
    const workspace = await service.createWorktreeForRun(repoPath, "Project", "run-1", "main", join(root, "worktrees"));
    const worktreeGit = simpleGit(workspace.worktreePath);

    await expect(service.commitAllChanges(workspace.worktreePath, "Only the link")).rejects.toThrow("no changes to commit");

    await writeFile(join(workspace.worktreePath, "tracked.txt"), "changed\n", "utf8");
    await service.commitAllChanges(workspace.worktreePath, "Change tracked file");

    const committedPaths = (await worktreeGit.raw(["show", "--name-only", "--format=", "HEAD"])).trim().split(/\r?\n/);
    expect(committedPaths).toEqual(["tracked.txt"]);
  });

  it("runs remote operations with a non-interactive environment despite guarded ambient variables", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    const service = new GitService();
    const ambientKeys = ["GIT_EDITOR", "EDITOR", "GIT_TERMINAL_PROMPT"] as const;
    const previous = Object.fromEntries(ambientKeys.map((key) => [key, process.env[key]]));
    process.env.GIT_EDITOR = "unused-editor";
    process.env.EDITOR = "unused-editor";
    process.env.GIT_TERMINAL_PROMPT = "1";
    try {
      await git.branch(["remote-only"]);
      await service.publishBranch(repoPath, "remote-only");
      await git.deleteLocalBranch("remote-only", true);
      await service.publishBranch(repoPath, "main");
      await service.fetchProjectBranches(repoPath);
      await expect(service.createPublishBranchFromHead(repoPath, "remote-only")).rejects.toThrow("already exists on origin");
      await expect(service.createPublishBranchFromHead(repoPath, "main-copy")).resolves.toBeUndefined();

      await git.branch(["team/feature"]);
      await service.publishBranch(repoPath, "team/feature");
      await git.deleteLocalBranch("team/feature", true);
      await expect(service.assertPublishBranchAvailable(repoPath, "feature")).resolves.toBe("feature");
      await expect(service.assertPublishBranchAvailable(repoPath, "bad name")).rejects.toThrow("is not a valid Git branch name");
    } finally {
      for (const key of ambientKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }

    expect(await service.hasRemoteBranch(repoPath, "main")).toBe(true);
  });
});

describe("GitService read-only status", () => {
  it("does not rewrite the index while checking for changes", async () => {
    const { repoPath, git } = await createRepository();
    const service = new GitService();
    const indexPath = join(repoPath, ".git", "index");
    const touchTrackedFile = async (seconds: number) => {
      const time = new Date(Date.now() + seconds * 1000);
      await utimes(join(repoPath, "tracked.txt"), time, time);
    };

    await touchTrackedFile(60);
    const indexBefore = (await stat(indexPath)).mtimeMs;
    expect(await service.hasChanges(repoPath)).toBe(false);
    expect((await stat(indexPath)).mtimeMs).toBe(indexBefore);
    await service.getDiffSummary(repoPath);
    expect((await stat(indexPath)).mtimeMs).toBe(indexBefore);

    await expect(service.getDiff(repoPath)).resolves.toBe("");
    expect((await stat(indexPath)).mtimeMs).toBe(indexBefore);

    // A plain status refreshes the changed stat data and saves the index, which needs index.lock.
    await touchTrackedFile(120);
    await git.status();
    expect((await stat(indexPath)).mtimeMs).not.toBe(indexBefore);
  });
});

describe("GitService diffs without commits", () => {
  it("summarizes staged files before the first commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-unborn-"));
    temporaryDirectories.push(root);
    const git = simpleGit(root);
    await git.init();
    await writeFile(join(root, "first.txt"), "one\ntwo\n", "utf8");
    await git.add(["first.txt"]);

    const summary = await new GitService().getDiffSummary(root);

    expect(summary.files).toEqual([{ path: "first.txt", additions: 2, deletions: 0 }]);
  });
});

describe("GitService remote resolution", () => {
  it("pushes to the configured push remote instead of origin", async () => {
    const { root, repoPath, git } = await createRepository();
    for (const name of ["origin", "fork"]) {
      await simpleGit(root).raw(["init", "--bare", join(root, `${name}.git`)]);
      await git.addRemote(name, join(root, `${name}.git`));
    }
    await git.addConfig("remote.pushDefault", "fork");
    const service = new GitService();

    expect(await service.getDefaultRemote(repoPath)).toBe("origin");
    expect(await service.getPushRemote(repoPath, "main")).toBe("fork");
    await expect(service.publishBranch(repoPath, "main")).resolves.toEqual({ branchName: "main", remoteName: "fork" });
    expect(await service.hasRemoteBranch(repoPath, "main", "fork")).toBe(true);
    expect(await service.hasRemoteBranch(repoPath, "main")).toBe(false);
  });

  it("uses the only remote when it is not named origin", async () => {
    const { root, repoPath, git } = await createRepository();
    await simpleGit(root).raw(["init", "--bare", join(root, "upstream.git")]);
    await git.addRemote("upstream", join(root, "upstream.git"));
    const service = new GitService();

    await service.pushProjectBranch(repoPath, "main");

    expect(await service.getDefaultRemote(repoPath)).toBe("upstream");
    expect(await service.hasRemoteBranch(repoPath, "main")).toBe(true);
    expect(await service.listTargetBranches(repoPath)).toEqual(["main"]);
  });
});

describe("GitService fresh base start points", () => {
  it("starts from origin only when the local base is behind it", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    await git.push(["-u", "origin", "main"]);
    const otherClonePath = join(root, "other");
    await simpleGit(root).clone(remotePath, otherClonePath, ["--branch", "main"]);
    const other = simpleGit(otherClonePath);
    await other.addConfig("user.name", "Other");
    await other.addConfig("user.email", "other@example.test");
    await writeFile(join(otherClonePath, "remote.txt"), "remote\n", "utf8");
    await other.add(["remote.txt"]);
    await other.commit("Remote commit");
    await other.push(["origin", "main"]);
    const service = new GitService();

    expect(await service.resolveFreshBaseStartPoint(repoPath, "main")).toBe("refs/remotes/origin/main");
    const workspace = await service.createWorktreeForRun(repoPath, "Project", "run-1", "refs/remotes/origin/main", join(root, "worktrees"));
    expect(existsSync(join(workspace.worktreePath, "remote.txt"))).toBe(true);
    expect((await simpleGit(workspace.worktreePath).raw(["config", "--get", `branch.${workspace.branchName}.merge`])).trim()).toBe("");

    await writeFile(join(repoPath, "local.txt"), "local\n", "utf8");
    await git.add(["local.txt"]);
    await git.commit("Local commit");
    expect(await service.resolveFreshBaseStartPoint(repoPath, "main")).toBe("main");

    await git.removeRemote("origin");
    expect(await service.resolveFreshBaseStartPoint(repoPath, "main")).toBe("main");
  });
});

describe("GitService ref arguments", () => {
  it("never reads a branch name as a file path or an option", async () => {
    const { repoPath } = await createRepository();
    const service = new GitService();
    await writeFile(join(repoPath, "tracked.txt"), "local edit\n", "utf8");

    await expect(service.checkoutProjectBranch(repoPath, "tracked.txt")).rejects.toThrow("was not found");
    await expect(service.checkoutProjectBranch(repoPath, "--orphan")).rejects.toThrow('cannot start with "-"');
    await expect(service.checkoutWorktreeBranch(repoPath, "tracked.txt")).rejects.toThrow();

    expect(await readFile(join(repoPath, "tracked.txt"), "utf8")).toBe("local edit\n");
  });
});

describe("GitService branch merge checks", () => {
  it("reports unmerged branches like git branch -d", async () => {
    const { repoPath, git } = await createRepository();
    const service = new GitService();
    await git.branch(["merged"]);
    await git.checkout(["-b", "unmerged"]);
    await writeFile(join(repoPath, "tracked.txt"), "unmerged\n", "utf8");
    await git.add(["tracked.txt"]);
    await git.commit("Unmerged commit");
    await git.checkout(["main"]);

    expect(await service.isBranchMerged(repoPath, "merged")).toBe(true);
    expect(await service.isBranchMerged(repoPath, "unmerged")).toBe(false);
  });
});

describe("GitService prompt restore points", () => {
  it("saves the discarded changes before restoring the captured state", async () => {
    const { root, repoPath } = await createRepository();
    const service = new GitService();
    await writeFile(join(repoPath, "tracked.txt"), "before prompt\n", "utf8");
    const patch = await service.createPromptRestorePatch(repoPath);
    const headSha = await service.getHeadCommitSha(repoPath);
    await writeFile(join(repoPath, "tracked.txt"), "after prompt\n", "utf8");
    await writeFile(join(repoPath, "new.txt"), "untracked\n", "utf8");
    const safetyPatchPath = join(root, "backups", "restore.patch");

    const result = await service.restorePromptRestorePatch(repoPath, patch, { expectedHeadSha: headSha, safetyPatchPath });

    expect(result.safetyPatchPath).toBe(safetyPatchPath);
    expect((await readFile(join(repoPath, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before prompt\n");
    expect(existsSync(join(repoPath, "new.txt"))).toBe(false);
    const backup = await readFile(safetyPatchPath, "utf8");
    expect(backup).toContain("after prompt");
    expect(backup).toContain("new.txt");
  });

  it("refuses to restore when HEAD moved since the restore point", async () => {
    const { repoPath, git } = await createRepository();
    const service = new GitService();
    const patch = await service.createPromptRestorePatch(repoPath);
    const headSha = await service.getHeadCommitSha(repoPath);
    await writeFile(join(repoPath, "tracked.txt"), "agent commit\n", "utf8");
    await git.add(["tracked.txt"]);
    await git.commit("Agent commit");
    await writeFile(join(repoPath, "open.txt"), "keep\n", "utf8");

    await expect(service.restorePromptRestorePatch(repoPath, patch, { expectedHeadSha: headSha })).rejects.toThrow("new commits");
    expect(await readFile(join(repoPath, "open.txt"), "utf8")).toBe("keep\n");
  });
});
