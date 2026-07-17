import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectActivityLog, readProjectReleaseHistory, readTrackedProjectFiles } from "@buildwarden/git-service";
import simpleGit from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectActivityLog } from "./project-activity";

const tempDirectories: string[] = [];

const createRepository = async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "buildwarden-activity-"));
  tempDirectories.push(repoPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.name", "Activity Tester");
  await git.addConfig("user.email", "activity@example.com");
  return { repoPath, git };
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project activity Git collection", () => {
  it("collects file status, tracked files, and per-tag release ranges", async () => {
    const { repoPath, git } = await createRepository();
    await writeFile(join(repoPath, "app.ts"), "export const value = 1;\n", "utf8");
    await git.add("app.ts");
    await git.commit("Initial release");
    await git.addTag("v1.0.0");

    await writeFile(join(repoPath, "app.ts"), "export const value = 2;\nexport const next = true;\n", "utf8");
    await writeFile(join(repoPath, "README.md"), "# Activity fixture\n", "utf8");
    await writeFile(join(repoPath, "café.ts"), "export const café = true;\n", "utf8");
    await git.add(["app.ts", "README.md", "café.ts"]);
    await git.commit("Second release");
    await git.addTag("v1.1.0");

    const [activityLog, trackedFiles, releaseHistory] = await Promise.all([
      readProjectActivityLog(repoPath),
      readTrackedProjectFiles(repoPath),
      readProjectReleaseHistory(repoPath),
    ]);
    const commits = parseProjectActivityLog(activityLog);

    expect(commits).toHaveLength(2);
    expect(commits.flatMap((commit) => commit.files).filter((file) => file.changeType === "added").map((file) => file.path)).toEqual(
      expect.arrayContaining(["app.ts", "README.md", "café.ts"]),
    );
    expect(trackedFiles.sort()).toEqual(["README.md", "app.ts", "café.ts"]);
    expect(releaseHistory.totalReleases).toBe(2);
    expect(releaseHistory.releases.map((release) => release.name)).toEqual(["v1.0.0", "v1.1.0"]);
    expect(releaseHistory.releases[1]).toMatchObject({ commitsSincePrevious: 1, filesChanged: 3 });
    expect(releaseHistory.releases[1]?.linesChanged).toBeGreaterThan(0);
  });
});
