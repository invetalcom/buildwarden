import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { GitService, selectOwnOpenMergeRequestUrl, selectOwnOpenPullRequestUrl } from "@buildwarden/git-service";

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

describe("existing pull and merge request selection", () => {
  it("reuses only a pull request from the expected head owner", () => {
    const pullRequests = [
      { url: "https://github.com/base/repo/pull/1", headRepositoryOwner: { login: "someone-else" } },
      { url: "https://github.com/base/repo/pull/2", headRepositoryOwner: { login: "Me" } },
    ];

    expect(selectOwnOpenPullRequestUrl(pullRequests, "me")).toBe("https://github.com/base/repo/pull/2");
    expect(selectOwnOpenPullRequestUrl(pullRequests.slice(0, 1), "me")).toBeNull();
    expect(selectOwnOpenPullRequestUrl(pullRequests, "")).toBeNull();
  });

  it("reuses only a merge request whose source project is the target project", () => {
    const mergeRequests = [
      { web_url: "https://gitlab.com/base/repo/-/merge_requests/1", source_project_id: 7, target_project_id: 3 },
      { web_url: "https://gitlab.com/base/repo/-/merge_requests/2", source_project_id: 3, target_project_id: 3 },
    ];

    expect(selectOwnOpenMergeRequestUrl(mergeRequests)).toBe("https://gitlab.com/base/repo/-/merge_requests/2");
    expect(selectOwnOpenMergeRequestUrl(mergeRequests.slice(0, 1))).toBeNull();
  });
});

describe("GitService pull request creation", () => {
  it("opens a browser draft without an oversized body when the GitHub CLI is unavailable", async () => {
    const { path, git } = await createRepository();
    const remotePath = await mkdtemp(join(tmpdir(), "buildwarden-pr-remote-"));
    temporaryRepositories.push(remotePath);
    await simpleGit(remotePath).init(true);
    await git.addRemote("origin", "https://github.com/owner/repo.git");
    await git.addConfig("remote.origin.pushurl", remotePath);
    const gitExecPath = (await git.raw(["--exec-path"])).trim();
    const previousPath = process.env.PATH;
    // Only Git's own directory stays on PATH, so `gh` cannot be found.
    process.env.PATH = gitExecPath;
    try {
      const service = new GitService();
      const shortResult = await service.createPullRequest(path, "feature/publish-context", "main", "Title", "Short body");
      const longResult = await service.createPullRequest(path, "feature/publish-context", "main", "Title", "x".repeat(40_000));

      expect(shortResult.mode).toBe("browser-draft");
      expect(shortResult.url).toContain("https://github.com/owner/repo/compare/main...feature%2Fpublish-context");
      expect(new URL(shortResult.url).searchParams.get("body")).toBe("Short body");
      expect(shortResult.descriptionOmitted).toBeUndefined();
      // GitHub answers 414 URI Too Long for such links, so the body stays out of the URL.
      expect(longResult.mode).toBe("browser-draft");
      expect(new URL(longResult.url).searchParams.has("body")).toBe(false);
      expect(new URL(longResult.url).searchParams.get("title")).toBe("Title");
      expect(longResult.descriptionOmitted).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });
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
