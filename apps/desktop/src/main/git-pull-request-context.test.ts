import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import simpleGit from "simple-git";
import { GitService } from "@buildwarden/git-service";

const temporaryRepositories: string[] = [];

const createRepository = async (): Promise<{ path: string; git: ReturnType<typeof simpleGit> }> => {
  const path = await mkdtemp(join(tmpdir(), "buildwarden-pr-context-"));
  temporaryRepositories.push(path);
  const git = simpleGit(path);
  await git.init();
  await git.addConfig("user.name", "BuildWarden Test");
  await git.addConfig("user.email", "buildwarden@example.test");
  await writeFile(join(path, "tracked.txt"), "base\n", "utf8");
  await git.add(["tracked.txt"]);
  await git.commit("Base commit");
  await git.branch(["-M", "main"]);
  await git.checkoutLocalBranch("feature/publish-context");
  return { path, git };
};

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GitService pull request context", () => {
  it("describes committed branch changes when the worktree is clean", async () => {
    const { path, git } = await createRepository();
    await writeFile(join(path, "tracked.txt"), "committed feature\n", "utf8");
    await git.add(["tracked.txt"]);
    await git.commit("Implement committed feature");

    const context = await new GitService().getPullRequestContext(path, "main");

    expect(context.hasOpenChanges).toBe(false);
    expect(context.commits.map((commit) => commit.subject)).toEqual(["Implement committed feature"]);
    expect(context.diff).toContain("+committed feature");
  });

  it("builds the prospective final PR patch from committed and open changes", async () => {
    const { path, git } = await createRepository();
    const service = new GitService();
    await writeFile(join(path, "tracked.txt"), "committed feature\n", "utf8");
    await git.add(["tracked.txt"]);
    await git.commit("Implement committed feature");
    await writeFile(join(path, "tracked.txt"), "final open state\n", "utf8");
    await writeFile(join(path, "untracked.txt"), "new untracked file\n", "utf8");

    const prospective = await service.getPullRequestContext(path, "main");

    expect(prospective.hasOpenChanges).toBe(true);
    expect(prospective.diff).toContain("+final open state");
    expect(prospective.diff).toContain("+new untracked file");
    expect(prospective.diff).not.toContain("+committed feature");

    await service.commitAllChanges(path, "Commit remaining changes");
    const committed = await service.getPullRequestContext(path, "main");

    expect(committed.hasOpenChanges).toBe(false);
    expect(committed.diff).toContain("+final open state");
    expect(committed.diff).toContain("+new untracked file");
    expect(committed.commits.map((commit) => commit.subject)).toEqual([
      "Commit remaining changes",
      "Implement committed feature",
    ]);
  });

  it("returns an empty patch when the source has no delta against the target", async () => {
    const { path } = await createRepository();
    const context = await new GitService().getPullRequestContext(path, "main");

    expect(context.hasOpenChanges).toBe(false);
    expect(context.commits).toEqual([]);
    expect(context.diff).toBe("");
  });

  it("refreshes and prefers the remote target branch ref", async () => {
    const { path, git } = await createRepository();
    const remotePath = await mkdtemp(join(tmpdir(), "buildwarden-pr-context-remote-"));
    temporaryRepositories.push(remotePath);
    await simpleGit(remotePath).init(true);
    await git.addRemote("origin", remotePath);
    await git.push("origin", "main");
    const staleTargetSha = (await git.revparse(["main"])).trim();

    await git.checkout("main");
    await writeFile(join(path, "tracked.txt"), "updated target\n", "utf8");
    await git.add(["tracked.txt"]);
    await git.commit("Advance target branch");
    const currentTargetSha = (await git.revparse(["HEAD"])).trim();
    await git.push("origin", "main");
    await git.checkout("feature/publish-context");
    await git.raw(["update-ref", "refs/remotes/origin/main", staleTargetSha]);

    const context = await new GitService().getPullRequestContext(path, "main");

    expect(context.targetRef).toBe("refs/remotes/origin/main");
    expect((await git.revparse(["refs/remotes/origin/main"])).trim()).toBe(currentTargetSha);
  });
});
