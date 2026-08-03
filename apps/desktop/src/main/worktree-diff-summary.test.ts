import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWorktreeDiff, computeWorktreeDiffSummary } from "@buildwarden/git-service";
import simpleGit from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];

const createRepository = async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "buildwarden-diff-summary-"));
  tempDirectories.push(repoPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.name", "Diff Tester");
  await git.addConfig("user.email", "diff@example.com");
  await writeFile(join(repoPath, "app.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(repoPath, "old.ts"), "export const renamed = true;\n", "utf8");
  await git.add(["app.ts", "old.ts"]);
  await git.commit("Initial files");
  return { repoPath, git };
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("worktree diff summary", () => {
  it("merges staged and unstaged counts and reports untracked binary files", async () => {
    const { repoPath, git } = await createRepository();
    await appendFile(join(repoPath, "app.ts"), "export const staged = true;\n", "utf8");
    await git.add("app.ts");
    await appendFile(join(repoPath, "app.ts"), "export const unstaged = true;\n", "utf8");
    await writeFile(join(repoPath, "new.txt"), "new file\n", "utf8");
    await writeFile(join(repoPath, "image.bin"), Buffer.from([0, 1, 2, 3]));

    const summary = await computeWorktreeDiffSummary(repoPath);
    expect(summary.files.find((file) => file.path === "app.ts")).toMatchObject({ additions: 2, deletions: 0 });
    expect(summary.files.find((file) => file.path === "new.txt")).toMatchObject({ additions: 1, deletions: 0 });
    expect(summary.files.find((file) => file.path === "image.bin")).toMatchObject({ additions: null, deletions: null });
    expect(summary.totalFiles).toBe(3);

    const fullDiff = await computeWorktreeDiff(repoPath);
    expect(fullDiff).toContain("export const staged = true;");
    expect(fullDiff).toContain("export const unstaged = true;");
    expect(fullDiff).toContain("new file");
  });

  it("preserves previous and current paths for staged renames", async () => {
    const { repoPath, git } = await createRepository();
    await git.mv("old.ts", "renamed.ts");

    const summary = await computeWorktreeDiffSummary(repoPath);
    expect(summary.files).toContainEqual({
      path: "renamed.ts",
      previousPath: "old.ts",
      additions: 0,
      deletions: 0,
    });
  });
});
