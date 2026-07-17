import { describe, expect, it } from "vitest";
import { buildProjectActivityInsight, parseProjectActivityLog } from "./project-activity";

const sampleLog = [
  "__BW_ACTIVITY_COMMIT__c3\tAlice Example\talice@example.com\t2026-07-17T09:00:00+02:00\tc2 p2\tShip activity insights",
  "",
  "10\t2\tapps/desktop/src/main/index.ts",
  "1\t0\tREADME.md",
  "__BW_ACTIVITY_COMMIT__c2\tBob Example\tbob@example.com\t2026-07-16T11:00:00+02:00\tc1\tPolish charts",
  "",
  "5\t5\tpackages/renderer/src/chart.tsx",
  "-\t-\tpackages/renderer/src/chart.png",
  "__BW_ACTIVITY_COMMIT__c1\tAlice Example\talice@example.com\t2026-07-15T08:00:00+02:00\t\tStart project",
  "",
  "20\t5\tpackages/renderer/src/App.tsx",
  "3\t0\tapps/desktop/src/main/app.ts",
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
    });
  });

  it("builds contributor, cadence, module, and repository-level statistics", () => {
    const activity = buildProjectActivityInsight(parseProjectActivityLog(sampleLog));

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
    expect(activity.monthlyActivity).toEqual([{ month: "2026-07", commits: 3, linesChanged: 51, contributorCount: 2 }]);
    expect(activity.recentCommits[0]?.sha).toBe("c3");
  });

  it("returns a stable empty report for repositories without commits", () => {
    const activity = buildProjectActivityInsight(parseProjectActivityLog(""));

    expect(activity.summaryStats.totalCommits).toBe(0);
    expect(activity.contributors).toEqual([]);
    expect(activity.weekdays).toHaveLength(7);
    expect(activity.modules).toEqual([]);
  });
});

