import type { ProjectActivityInsightData } from "@buildwarden/shared";

export interface ProjectActivityCommitFile {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  binary: boolean;
}

export interface ProjectActivityCommit {
  sha: string;
  author: string;
  email: string;
  date: string;
  parentCount: number;
  title: string;
  files: ProjectActivityCommitFile[];
}

type ContributorAccumulator = {
  name: string;
  email: string;
  commits: number;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  activeDates: Set<string>;
  firstCommitAt: string;
  latestCommitAt: string;
};

type ModuleAccumulator = {
  path: string;
  commits: number;
  fileTouches: number;
  files: Set<string>;
  linesAdded: number;
  linesDeleted: number;
  contributors: Set<string>;
};

type MonthlyAccumulator = {
  month: string;
  commits: number;
  linesChanged: number;
  contributors: Set<string>;
};

const ACTIVITY_COMMIT_PREFIX = "__BW_ACTIVITY_COMMIT__";
const MODULE_CONTAINER_NAMES = new Set(["apps", "crates", "libs", "modules", "packages", "plugins", "services"]);
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const parseLineCount = (value: string): number => {
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "").trim();

const dateKeyFromIso = (value: string): string => (/^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? "");

const monthKeyFromIso = (value: string): string => (/^\d{4}-\d{2}/.exec(value)?.[0] ?? "");

const timestampFromIso = (value: string): number => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const roundOne = (value: number): number => Math.round(value * 10) / 10;

const modulePathForFile = (filePath: string): string => {
  const segments = normalizePath(filePath).split("/").filter(Boolean);
  if (segments.length <= 1) return "(root)";
  const first = segments[0] ?? "(root)";
  if (MODULE_CONTAINER_NAMES.has(first) && segments[1]) return `${first}/${segments[1]}`;
  if ((first === "src" || first === "lib") && segments.length > 2 && segments[1]) return `${first}/${segments[1]}`;
  return first;
};

const weekdayFromDateKey = (dateKey: string): number => {
  if (!dateKey) return -1;
  return new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
};

const weekKeyFromDateKey = (dateKey: string): string => {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const day = date.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
};

const inclusiveWeekCount = (firstDate: string, latestDate: string): number => {
  if (!firstDate || !latestDate) return 0;
  const firstWeek = Date.parse(`${weekKeyFromDateKey(firstDate)}T12:00:00.000Z`);
  const latestWeek = Date.parse(`${weekKeyFromDateKey(latestDate)}T12:00:00.000Z`);
  return Math.max(1, Math.round((latestWeek - firstWeek) / (7 * 24 * 60 * 60 * 1_000)) + 1);
};

const longestDailyStreak = (dateKeys: Set<string>): number => {
  const days = [...dateKeys]
    .map((dateKey) => Date.parse(`${dateKey}T12:00:00.000Z`))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right);
  let longest = 0;
  let current = 0;
  let previous = Number.NaN;
  for (const day of days) {
    current = day - previous === 24 * 60 * 60 * 1_000 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = day;
  }
  return longest;
};

const createContributor = (commit: ProjectActivityCommit): ContributorAccumulator => ({
  name: commit.author || commit.email || "Unknown author",
  email: commit.email,
  commits: 0,
  linesAdded: 0,
  linesDeleted: 0,
  filesChanged: 0,
  activeDates: new Set<string>(),
  firstCommitAt: commit.date,
  latestCommitAt: commit.date,
});

const createModule = (path: string): ModuleAccumulator => ({
  path,
  commits: 0,
  fileTouches: 0,
  files: new Set<string>(),
  linesAdded: 0,
  linesDeleted: 0,
  contributors: new Set<string>(),
});

const createMonth = (month: string): MonthlyAccumulator => ({
  month,
  commits: 0,
  linesChanged: 0,
  contributors: new Set<string>(),
});

export const parseProjectActivityLog = (output: string): ProjectActivityCommit[] => {
  const commits: ProjectActivityCommit[] = [];
  let current: ProjectActivityCommit | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.startsWith(ACTIVITY_COMMIT_PREFIX)) {
      if (current) commits.push(current);
      const [prefixedSha = "", author = "", email = "", date = "", parents = "", ...titleParts] = rawLine.split("\t");
      current = {
        sha: prefixedSha.slice(ACTIVITY_COMMIT_PREFIX.length),
        author: author.trim(),
        email: email.trim(),
        date: date.trim(),
        parentCount: parents.trim() ? parents.trim().split(/\s+/).length : 0,
        title: titleParts.join("\t").trim(),
        files: [],
      };
      continue;
    }

    if (!current || !rawLine.includes("\t")) continue;
    const [addedRaw = "", deletedRaw = "", ...pathParts] = rawLine.split("\t");
    const path = normalizePath(pathParts.join("\t"));
    if (!path || (!/^\d+$/.test(addedRaw) && addedRaw !== "-") || (!/^\d+$/.test(deletedRaw) && deletedRaw !== "-")) continue;
    current.files.push({
      path,
      linesAdded: parseLineCount(addedRaw),
      linesDeleted: parseLineCount(deletedRaw),
      binary: addedRaw === "-" || deletedRaw === "-",
    });
  }

  if (current) commits.push(current);
  return commits;
};

const contributorKeyForCommit = (commit: ProjectActivityCommit): string =>
  commit.email.trim().toLowerCase() || commit.author.trim().toLowerCase() || "unknown-author";

const updateContributor = (
  contributor: ContributorAccumulator,
  commit: ProjectActivityCommit,
  linesAdded: number,
  linesDeleted: number,
): void => {
  contributor.commits += 1;
  contributor.linesAdded += linesAdded;
  contributor.linesDeleted += linesDeleted;
  contributor.filesChanged += commit.files.length;
  const dateKey = dateKeyFromIso(commit.date);
  if (dateKey) contributor.activeDates.add(dateKey);
  if (timestampFromIso(commit.date) < timestampFromIso(contributor.firstCommitAt)) contributor.firstCommitAt = commit.date;
  if (timestampFromIso(commit.date) > timestampFromIso(contributor.latestCommitAt)) contributor.latestCommitAt = commit.date;
};

const updateModules = (
  modules: Map<string, ModuleAccumulator>,
  commit: ProjectActivityCommit,
  contributorKey: string,
): void => {
  const changedModules = new Set<string>();
  for (const file of commit.files) {
    const modulePath = modulePathForFile(file.path);
    const module = modules.get(modulePath) ?? createModule(modulePath);
    module.fileTouches += 1;
    module.files.add(file.path);
    module.linesAdded += file.linesAdded;
    module.linesDeleted += file.linesDeleted;
    module.contributors.add(contributorKey);
    modules.set(modulePath, module);
    changedModules.add(modulePath);
  }
  for (const modulePath of changedModules) modules.get(modulePath)!.commits += 1;
};

const busFactorForHalfOfCommits = (commitCounts: number[], totalCommits: number): number => {
  if (totalCommits === 0) return 0;
  const target = totalCommits / 2;
  let cumulative = 0;
  for (let index = 0; index < commitCounts.length; index += 1) {
    cumulative += commitCounts[index] ?? 0;
    if (cumulative >= target) return index + 1;
  }
  return commitCounts.length;
};

export const buildProjectActivityInsight = (commits: ProjectActivityCommit[]): ProjectActivityInsightData => {
  const contributors = new Map<string, ContributorAccumulator>();
  const modules = new Map<string, ModuleAccumulator>();
  const months = new Map<string, MonthlyAccumulator>();
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  const activeDates = new Set<string>();
  const activeWeeks = new Set<string>();
  let linesAdded = 0;
  let linesDeleted = 0;
  let filesChanged = 0;
  let mergeCommits = 0;
  let firstCommitAt = "";
  let latestCommitAt = "";

  for (const commit of commits) {
    const commitLinesAdded = commit.files.reduce((sum, file) => sum + file.linesAdded, 0);
    const commitLinesDeleted = commit.files.reduce((sum, file) => sum + file.linesDeleted, 0);
    const contributorKey = contributorKeyForCommit(commit);
    const contributor = contributors.get(contributorKey) ?? createContributor(commit);
    updateContributor(contributor, commit, commitLinesAdded, commitLinesDeleted);
    contributors.set(contributorKey, contributor);
    updateModules(modules, commit, contributorKey);

    linesAdded += commitLinesAdded;
    linesDeleted += commitLinesDeleted;
    filesChanged += commit.files.length;
    if (commit.parentCount > 1) mergeCommits += 1;

    const dateKey = dateKeyFromIso(commit.date);
    if (dateKey) {
      activeDates.add(dateKey);
      activeWeeks.add(weekKeyFromDateKey(dateKey));
      const weekday = weekdayFromDateKey(dateKey);
      if (weekday >= 0) weekdayCounts[weekday] = (weekdayCounts[weekday] ?? 0) + 1;
    }
    const monthKey = monthKeyFromIso(commit.date);
    if (monthKey) {
      const month = months.get(monthKey) ?? createMonth(monthKey);
      month.commits += 1;
      month.linesChanged += commitLinesAdded + commitLinesDeleted;
      month.contributors.add(contributorKey);
      months.set(monthKey, month);
    }

    if (!firstCommitAt || timestampFromIso(commit.date) < timestampFromIso(firstCommitAt)) firstCommitAt = commit.date;
    if (!latestCommitAt || timestampFromIso(commit.date) > timestampFromIso(latestCommitAt)) latestCommitAt = commit.date;
  }

  const totalCommits = commits.length;
  const contributorRows = [...contributors.values()]
    .sort((left, right) => right.commits - left.commits || (right.linesAdded + right.linesDeleted) - (left.linesAdded + left.linesDeleted))
    .map((contributor) => ({
      name: contributor.name,
      email: contributor.email,
      commits: contributor.commits,
      commitShare: totalCommits ? roundOne((contributor.commits / totalCommits) * 100) : 0,
      linesAdded: contributor.linesAdded,
      linesDeleted: contributor.linesDeleted,
      linesChanged: contributor.linesAdded + contributor.linesDeleted,
      filesChanged: contributor.filesChanged,
      activeDays: contributor.activeDates.size,
      firstCommitAt: contributor.firstCommitAt,
      latestCommitAt: contributor.latestCommitAt,
    }));

  const firstDate = dateKeyFromIso(firstCommitAt);
  const latestDate = dateKeyFromIso(latestCommitAt);
  const calendarWeeks = inclusiveWeekCount(firstDate, latestDate);

  return {
    summaryStats: {
      totalCommits,
      contributorCount: contributorRows.length,
      linesAdded,
      linesDeleted,
      filesChanged,
      activeDays: activeDates.size,
      activeWeeks: activeWeeks.size,
      averageCommitsPerWeek: calendarWeeks ? roundOne(totalCommits / calendarWeeks) : 0,
      mergeCommits,
      busFactor50: busFactorForHalfOfCommits(contributorRows.map((contributor) => contributor.commits), totalCommits),
      firstCommitAt: firstCommitAt || null,
      latestCommitAt: latestCommitAt || null,
      longestDailyStreak: longestDailyStreak(activeDates),
    },
    contributors: contributorRows,
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
      weekday,
      label: WEEKDAY_LABELS[weekday] ?? "",
      commits: weekdayCounts[weekday] ?? 0,
      commitShare: totalCommits ? roundOne(((weekdayCounts[weekday] ?? 0) / totalCommits) * 100) : 0,
    })),
    modules: [...modules.values()]
      .sort((left, right) => right.commits - left.commits || (right.linesAdded + right.linesDeleted) - (left.linesAdded + left.linesDeleted))
      .map((module) => ({
        path: module.path,
        commits: module.commits,
        commitShare: totalCommits ? roundOne((module.commits / totalCommits) * 100) : 0,
        fileTouches: module.fileTouches,
        uniqueFiles: module.files.size,
        linesAdded: module.linesAdded,
        linesDeleted: module.linesDeleted,
        linesChanged: module.linesAdded + module.linesDeleted,
        contributorCount: module.contributors.size,
      })),
    monthlyActivity: [...months.values()]
      .sort((left, right) => left.month.localeCompare(right.month))
      .map((month) => ({
        month: month.month,
        commits: month.commits,
        linesChanged: month.linesChanged,
        contributorCount: month.contributors.size,
      })),
    recentCommits: [...commits]
      .sort((left, right) => timestampFromIso(right.date) - timestampFromIso(left.date))
      .slice(0, 12)
      .map((commit) => ({
        sha: commit.sha,
        title: commit.title,
        author: commit.author || commit.email || "Unknown author",
        date: commit.date,
        filesChanged: commit.files.length,
        linesChanged: commit.files.reduce((sum, file) => sum + file.linesAdded + file.linesDeleted, 0),
      })),
  };
};

