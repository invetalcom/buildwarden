import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { GitService } from "@buildwarden/git-service";

const temporaryDirectories: string[] = [];

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "buildwarden-branches-"));
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

const commitFile = async (git: ReturnType<typeof simpleGit>, repoPath: string, file: string, content: string, message: string) => {
  await writeFile(join(repoPath, file), content, "utf8");
  await git.add([file]);
  await git.commit(message);
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("refuses combined deletion when only the upstream contains the work", async () => {
  const { root, repoPath, git } = await createRepository();
  const remote = join(root, "remote.git");
  await simpleGit(root).raw(["init", "--bare", remote]);
  await git.addRemote("origin", remote);
  await git.push(["-u", "origin", "main"]);
  await git.checkoutLocalBranch("feature");
  await commitFile(git, repoPath, "feature.txt", "work\n", "Work");
  await git.push(["-u", "origin", "feature"]);
  await git.checkout("main");
  const service = new GitService();
  expect(await service.isBranchMerged(repoPath, "feature", "main")).toBe(true);
  await expect(service.assertCombinedBranchDeletionSafe(repoPath, "feature", "main")).rejects.toThrow("not merged");
  expect(await service.hasLocalBranch(repoPath, "feature")).toBe(true);
});

it("reports merge autostash conflicts after the merge finishes", async () => {
  const { repoPath, git } = await createRepository();
  await git.checkoutLocalBranch("feature");
  await commitFile(git, repoPath, "tracked.txt", "feature\n", "Feature");
  await git.checkout("main");
  await git.addConfig("merge.autostash", "true");
  await writeFile(join(repoPath, "tracked.txt"), "local edits\n");
  const service = new GitService();
  await expect(service.mergeIntoCurrentBranch(repoPath, "feature")).rejects.toThrow("restoring uncommitted changes");
  const overview = await service.getProjectBranchOverview(repoPath, "main");
  expect(overview.operation).toBeNull();
  expect(overview.conflictedFiles).toEqual(["tracked.txt"]);
});

describe("GitService branch management", () => {
  it("reports base divergence, merged branches, authors, and uncommitted files", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Add feature");
    await git.checkout("main");
    await git.branch(["merged-already"]);
    await commitFile(git, repoPath, "main.txt", "main\n", "Advance main");
    await writeFile(join(repoPath, "untracked.txt"), "draft\n", "utf8");

    const overview = await new GitService().getProjectBranchOverview(repoPath, "main");
    const feature = overview.branches.find((branch) => branch.name === "feature");
    const merged = overview.branches.find((branch) => branch.name === "merged-already");
    const main = overview.branches.find((branch) => branch.name === "main");

    expect(overview.baseCompareRef).toBe("main");
    expect(overview.changedFileCount).toBe(1);
    expect(overview.operation).toBeNull();
    expect(feature).toMatchObject({ baseAhead: 1, baseBehind: 1, mergedIntoBase: false, authorName: "BuildWarden Test", subject: "Add feature" });
    expect(merged).toMatchObject({ baseAhead: 0, baseBehind: 1, mergedIntoBase: true });
    expect(main).toMatchObject({ isBase: true, mergedIntoBase: false, baseAhead: null });
  });

  it("merges a branch into the checked-out branch", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Add feature");
    await git.checkout("main");
    await commitFile(git, repoPath, "main.txt", "main\n", "Advance main");

    await new GitService().mergeIntoCurrentBranch(repoPath, "feature", "no-ff");

    expect((await git.log(["-1"])).latest?.message).toContain("Merge branch 'refs/heads/feature'");
    expect((await git.status()).isClean()).toBe(true);
  });

  it("aborts a conflicting merge and leaves the branch unchanged", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "tracked.txt", "feature\n", "Feature edit");
    await git.checkout("main");
    await commitFile(git, repoPath, "tracked.txt", "main\n", "Main edit");
    const before = (await git.revparse(["HEAD"])).trim();
    const service = new GitService();

    await expect(service.mergeIntoCurrentBranch(repoPath, "feature")).rejects.toThrow(/conflicts in tracked\.txt.*aborted/);

    expect((await git.revparse(["HEAD"])).trim()).toBe(before);
    expect(await service.getInProgressOperation(repoPath)).toBeNull();
    expect((await git.status()).isClean()).toBe(true);
  });

  it("aborts a conflicting rebase and keeps the original commits", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "tracked.txt", "feature\n", "Feature edit");
    const before = (await git.revparse(["HEAD"])).trim();
    await git.checkout("main");
    await commitFile(git, repoPath, "tracked.txt", "main\n", "Main edit");
    await git.checkout("feature");
    const service = new GitService();

    await expect(service.rebaseCurrentBranch(repoPath, "main")).rejects.toThrow(/Rebasing "feature" onto "main" stopped on conflicts/);

    expect((await git.revparse(["HEAD"])).trim()).toBe(before);
    expect(await service.getInProgressOperation(repoPath)).toBeNull();
  });

  it("reports conflicts when restoring the autostash after a rebase", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Add feature");
    await git.checkout("main");
    await commitFile(git, repoPath, "tracked.txt", "main\n", "Main edit");
    await git.checkout("feature");
    await writeFile(join(repoPath, "tracked.txt"), "local\n", "utf8");

    await expect(new GitService().rebaseCurrentBranch(repoPath, "main")).rejects.toThrow(/conflicts in tracked\.txt.*still saved in the stash/);

    expect((await git.raw(["stash", "list"])).trim()).not.toBe("");
  });

  it("detects and aborts a merge left in progress outside BuildWarden", async () => {
    const { repoPath, git } = await createRepository();
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "tracked.txt", "feature\n", "Feature edit");
    await git.checkout("main");
    await commitFile(git, repoPath, "tracked.txt", "main\n", "Main edit");
    await git.raw(["merge", "feature"]).catch(() => undefined);
    const service = new GitService();

    const overview = await service.getProjectBranchOverview(repoPath, "main");
    expect(overview.operation).toBe("merge");
    expect(overview.conflictedFiles).toEqual(["tracked.txt"]);

    await service.abortInProgressOperation(repoPath);
    expect(await service.getInProgressOperation(repoPath)).toBeNull();
  });

  it("treats a branch merged into the remote base as merged after its upstream was pruned", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    await git.push(["-u", "origin", "main"]);
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Feature commit");
    await git.push(["-u", "origin", "feature"]);
    // The PR merges on the forge, which deletes its branch; local main stays behind origin/main.
    await git.push(["origin", "feature:main"]);
    await git.push(["origin", "--delete", "feature"]);
    await git.fetch(["--prune"]);
    await git.checkout("main");
    const service = new GitService();

    const overview = await service.getProjectBranchOverview(repoPath, "main");
    expect(overview.branches.find((branch) => branch.name === "feature")?.mergedIntoBase).toBe(true);
    expect(await service.isBranchMerged(repoPath, "feature")).toBe(false);
    expect(await service.isBranchMerged(repoPath, "feature", "main")).toBe(true);
  });

  it("fast-forwards a branch that is not checked out from its upstream", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    await git.push(["-u", "origin", "main"]);
    await git.checkoutLocalBranch("feature");
    await git.push(["-u", "origin", "feature"]);
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Feature commit");
    await git.push(["origin", "feature"]);
    await git.raw(["reset", "--hard", "HEAD~1"]);
    await git.checkout("main");
    const service = new GitService();

    await service.fastForwardBranchFromUpstream(repoPath, "feature");

    expect((await git.raw(["log", "-1", "--format=%s", "feature"])).trim()).toBe("Feature commit");

    await service.deleteRemoteBranch(repoPath, "feature");
    expect(await service.hasRemoteBranch(repoPath, "feature", "origin")).toBe(false);
    expect(await service.hasLocalBranch(repoPath, "feature")).toBe(true);
  });

  it("refuses to delete a remote branch that is the last reference to its commits unless forced", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    await git.push(["-u", "origin", "main"]);
    await git.checkoutLocalBranch("feature");
    await commitFile(git, repoPath, "feature.txt", "feature\n", "Feature commit");
    await git.push(["origin", "feature"]);
    await git.checkout("main");
    await git.deleteLocalBranch("feature", true);
    const service = new GitService();

    await expect(service.deleteRemoteBranch(repoPath, "feature", { baseBranch: "main" })).rejects.toThrow("not in the base branch or any local branch");
    expect(await service.hasRemoteBranch(repoPath, "feature", "origin")).toBe(true);

    await service.deleteRemoteBranch(repoPath, "feature", { baseBranch: "main", force: true });
    expect(await service.hasRemoteBranch(repoPath, "feature", "origin")).toBe(false);
  });

  it("refuses to delete a remote branch that moved since the last fetch", async () => {
    const { root, repoPath, git } = await createRepository();
    const remotePath = join(root, "remote.git");
    await simpleGit(root).raw(["init", "--bare", remotePath]);
    await git.addRemote("origin", remotePath);
    await git.push(["-u", "origin", "main"]);
    await git.push(["origin", "main:feature"]);
    await git.fetch();
    const otherPath = join(root, "other");
    await simpleGit(root).clone(remotePath, otherPath);
    const other = simpleGit(otherPath);
    await other.addConfig("user.name", "Colleague");
    await other.addConfig("user.email", "colleague@example.test");
    await other.checkout("feature");
    await commitFile(other, otherPath, "colleague.txt", "colleague\n", "Colleague commit");
    await other.push(["origin", "feature"]);
    const service = new GitService();

    await expect(service.deleteRemoteBranch(repoPath, "feature", { baseBranch: "main", force: true })).rejects.toThrow("changed on the remote since the last fetch");
    expect((await git.raw(["ls-remote", "origin", "refs/heads/feature"])).trim()).not.toBe("");
  });
});

it("merges the branch rather than a same-named tag", async () => {
  const { repoPath, git } = await createRepository();
  await git.raw(["tag", "feature"]);
  await git.checkoutLocalBranch("feature");
  await commitFile(git, repoPath, "feature.txt", "feature\n", "Feature work");
  const tip = await git.revparse(["HEAD"]);
  await git.checkout("main");
  await new GitService().mergeIntoCurrentBranch(repoPath, "feature");
  expect(await git.revparse(["HEAD"])).toBe(tip);
});
