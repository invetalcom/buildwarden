import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    } finally {
      for (const key of ambientKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }

    expect(await service.hasRemoteBranch(repoPath, "main")).toBe(true);
  });
});
