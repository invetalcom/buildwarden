import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "@buildwarden/git-service";

const tempDirs: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const createRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-project-base-"));
  tempDirs.push(root);
  const repoPath = join(root, "repo");
  mkdirSync(repoPath);
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.name", "BuildWarden Test");
  git(repoPath, "config", "user.email", "buildwarden@example.invalid");
  writeFileSync(join(repoPath, "README.md"), "# test\n");
  git(repoPath, "add", "README.md");
  git(repoPath, "commit", "-m", "Initial commit");
  return repoPath;
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("project base branch detection", () => {
  it("uses origin/HEAD instead of the currently checked-out feature branch", async () => {
    const repoPath = createRepository();
    git(repoPath, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(repoPath, "checkout", "-b", "feature/active-work");

    const validation = await new GitService().validateProject(repoPath);

    expect(validation.baseBranch).toBe("main");
    expect(await new GitService().getCurrentBranch(repoPath)).toBe("feature/active-work");
  });

  it("prefers a conventional local base when origin/HEAD is unavailable", async () => {
    const repoPath = createRepository();
    git(repoPath, "checkout", "-b", "feature/active-work");

    const validation = await new GitService().validateProject(repoPath);

    expect(validation.baseBranch).toBe("main");
  });
});
