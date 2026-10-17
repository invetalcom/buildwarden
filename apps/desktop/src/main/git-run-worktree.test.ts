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
});
