import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { GitService } from "@buildwarden/git-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const configure = async (git: ReturnType<typeof simpleGit>) => {
  await git.addConfig("user.name", "BuildWarden Test");
  await git.addConfig("user.email", "buildwarden@example.test");
  // A developer's global signing setup must not fail the fixture commits.
  await git.addConfig("commit.gpgSign", "false");
  await git.addConfig("tag.gpgSign", "false");
};

const commitFile = async (git: ReturnType<typeof simpleGit>, repoPath: string, file: string, message: string) => {
  await writeFile(join(repoPath, file), `${message}\n`, "utf8");
  await git.add([file]);
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
};

/** A workspace and a second clone that pushes to the same remote, like a reviewer's checkout. */
const createClones = async () => {
  const root = await mkdtemp(join(tmpdir(), "buildwarden-remote-head-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  await simpleGit(root).raw(["init", "--bare", remote]);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const git = simpleGit(workspace);
  await git.init();
  await configure(git);
  await commitFile(git, workspace, "base.txt", "Base");
  await git.branch(["-M", "feat"]);
  await git.addRemote("origin", remote);
  await git.push(["-u", "origin", "feat"]);
  const other = join(root, "other");
  await simpleGit(root).clone(remote, other, ["--branch", "feat"]);
  const otherGit = simpleGit(other);
  await configure(otherGit);
  return { workspace, git, other, otherGit };
};

it("fast-forwards to a remote head pushed elsewhere and keeps local commits on top", async () => {
  const { workspace, git, other, otherGit } = await createClones();
  const service = new GitService();
  const head = (await git.revparse(["HEAD"])).trim();
  expect(await service.syncWithRemoteHead(workspace, "feat", head)).toBe("in-sync");

  const remoteHead = await commitFile(otherGit, other, "review.txt", "Reviewer fix");
  await otherGit.push("origin", "feat");
  expect(await service.syncWithRemoteHead(workspace, "feat", remoteHead)).toBe("fast-forwarded");
  expect((await git.revparse(["HEAD"])).trim()).toBe(remoteHead);

  const local = await commitFile(git, workspace, "agent.txt", "Agent fix");
  expect(await service.syncWithRemoteHead(workspace, "feat", remoteHead)).toBe("ahead");
  expect(await service.resolveCommitInHistory(workspace, local.slice(0, 7))).toBe(local);
  expect(await service.resolveCommitInHistory(workspace, "not-a-sha")).toBeNull();
});

it("resolves a reported commit by its ID, not by a ref with the same name", async () => {
  const { workspace, git } = await createClones();
  const fix = await commitFile(git, workspace, "fix.txt", "Fix");
  const later = await commitFile(git, workspace, "later.txt", "Later");
  // A tag named like the fix's short SHA, pointing at a different commit.
  await git.raw(["tag", fix.slice(0, 7), later]);
  const service = new GitService();
  expect(await service.resolveCommitInHistory(workspace, fix.slice(0, 7))).toBe(fix);
  expect(await service.resolveCommitInHistory(workspace, "HEAD")).toBeNull();
});

it("reports split history instead of merging it", async () => {
  const { workspace, git, other, otherGit } = await createClones();
  const remoteHead = await commitFile(otherGit, other, "theirs.txt", "Theirs");
  await otherGit.push("origin", "feat");
  const local = await commitFile(git, workspace, "ours.txt", "Ours");
  const service = new GitService();
  expect(await service.syncWithRemoteHead(workspace, "feat", remoteHead)).toBe("diverged");
  expect((await git.revparse(["HEAD"])).trim()).toBe(local);
  // A commit that is not on the branch never counts as a fix.
  expect(await service.resolveCommitInHistory(workspace, remoteHead)).toBeNull();
});
