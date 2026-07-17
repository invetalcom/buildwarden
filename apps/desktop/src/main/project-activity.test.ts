import { describe, expect, it } from "vitest";
import { buildProjectActivityInsight, parseProjectActivityLog } from "./project-activity";

const sampleLog = [
  "__BW_ACTIVITY_COMMIT__c3\tAlice Example\talice@example.com\t2026-07-17T09:00:00+02:00\tc2 p2\tShip activity insights",
  "",
  "10\t2\tapps/desktop/src/main/index.ts",
  "1\t0\tREADME.md",
  " create mode 100644 apps/desktop/src/main/index.ts",
  "__BW_ACTIVITY_COMMIT__c2\tBob Example\tbob@example.com\t2026-07-16T11:00:00+02:00\tc1\tPolish charts",
  "",
  "5\t5\tpackages/renderer/src/chart.tsx",
  "-\t-\tpackages/renderer/src/chart.png",
  " delete mode 100644 packages/renderer/src/chart.png",
  "__BW_ACTIVITY_COMMIT__c1\tAlice Example\talice@example.com\t2026-07-15T08:00:00+02:00\t\tStart project",
  "",
  "20\t5\tpackages/renderer/src/App.tsx",
  "3\t0\tapps/desktop/src/main/app.ts",
  " create mode 100644 packages/renderer/src/App.tsx",
  " create mode 100644 apps/desktop/src/main/app.ts",
].join("\n");

describe("project activity analysis", () => {
  it("parses commit metadata, text churn, and binary file changes", () => {
    const commits = parseProjectActivityLog(sampleLog);

    expect(commits).toHaveLength(3);
    expect(commits[0]).toMatchObject({
      sha: "c3",
      author: "Alice Example",
      email: "alice@example.com",
      parentCount: 2,
      title: "Ship activity insights",
    });
    expect(commits[1]?.files[1]).toEqual({
      path: "packages/renderer/src/chart.png",
      linesAdded: 0,
      linesDeleted: 0,
      binary: true,
      changeType: "deleted",
    });
  });

  it("builds contributor, cadence, module, and repository-level statistics", () => {
    const activity = buildProjectActivityInsight(parseProjectActivityLog(sampleLog), {
      now: new Date("2026-07-20T12:00:00.000Z"),
      currentFiles: [
        "apps/desktop/src/main/index.ts",
        "apps/desktop/src/main/app.ts",
        "packages/renderer/src/App.tsx",
        "packages/renderer/src/chart.tsx",
        "README.md",
      ],
      totalReleaseCount: 2,
      releases: [
        { name: "v1.0.0", date: "2026-07-15T12:00:00.000Z", commitsSincePrevious: 1, linesChanged: 28, filesChanged: 2 },
        { name: "v1.1.0", date: "2026-07-17T12:00:00.000Z", commitsSincePrevious: 2, linesChanged: 23, filesChanged: 4 },
      ],
    });

    expect(activity.summaryStats).toMatchObject({
      totalCommits: 3,
      contributorCount: 2,
      linesAdded: 39,
      linesDeleted: 12,
      filesChanged: 6,
      activeDays: 3,
      activeWeeks: 1,
      averageCommitsPerWeek: 3,
      mergeCommits: 1,
      busFactor50: 1,
      longestDailyStreak: 3,
    });
    expect(activity.contributors[0]).toMatchObject({
      name: "Alice Example",
      commits: 2,
      linesChanged: 41,
      activeDays: 2,
    });
    expect(activity.weekdays.map(({ label, commits }) => ({ label, commits }))).toEqual([
      { label: "Mon", commits: 0 },
      { label: "Tue", commits: 0 },
      { label: "Wed", commits: 1 },
      { label: "Thu", commits: 1 },
      { label: "Fri", commits: 1 },
      { label: "Sat", commits: 0 },
      { label: "Sun", commits: 0 },
    ]);
    expect(activity.modules.slice(0, 2).map((module) => module.path)).toEqual(["packages/renderer", "apps/desktop"]);
    expect(activity.monthlyActivity).toEqual([{
      month: "2026-07",
      commits: 3,
      linesChanged: 51,
      contributorCount: 2,
      linesAdded: 39,
      linesDeleted: 12,
      netLines: 27,
      cumulativeNetLines: 27,
      filesCreated: 3,
      filesDeleted: 1,
    }]);
    expect(activity.recentCommits[0]?.sha).toBe("c3");
    expect(activity.hotspots?.files[0]?.path).toBe("packages/renderer/src/App.tsx");
    expect(activity.hotspots?.modules[0]?.path).toBe("packages/renderer");
    expect(activity.moduleOwnership?.find((module) => module.path === "apps/desktop")).toMatchObject({
      primaryOwnerName: "Alice Example",
      ownershipShare: 100,
      busFactor50: 1,
      risk: "silo",
    });
    expect(activity.momentum?.find((window) => window.days === 30)).toMatchObject({
      current: { commits: 3, contributors: 2, linesChanged: 51 },
      previous: { commits: 0, contributors: 0, linesChanged: 0 },
    });
    expect(activity.commitSize).toMatchObject({
      medianLinesChanged: 13,
      p90LinesChanged: 28,
      megaCommitCount: 0,
      megaCommitShare: 0,
    });
    expect(activity.commitSize?.largestCommits[0]?.sha).toBe("c1");
    expect(activity.codeGrowth).toEqual({ netLines: 27, filesCreated: 3, filesDeleted: 1 });
    expect(activity.fileAge).toMatchObject({ trackedFileCount: 5, medianAgeDays: 4, medianDaysSinceChange: 4 });
    expect(activity.fileAge?.oldestUntouchedFiles[0]?.path).toBe("apps/desktop/src/main/app.ts");
    expect(activity.releaseCadence).toMatchObject({
      totalReleases: 2,
      averageDaysBetweenReleases: 2,
      medianDaysBetweenReleases: 2,
      averageCommitsPerRelease: 1.5,
      sizeTrend: "insufficient-data",
    });
  });

  it("returns a stable empty report for repositories without commits", () => {
    const activity = buildProjectActivityInsight(parseProjectActivityLog(""), { now: new Date("2026-07-20T12:00:00.000Z") });

    expect(activity.summaryStats.totalCommits).toBe(0);
    expect(activity.contributors).toEqual([]);
    expect(activity.weekdays).toHaveLength(7);
    expect(activity.modules).toEqual([]);
  });
});
