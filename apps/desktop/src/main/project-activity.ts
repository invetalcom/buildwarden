import type {
  ProjectActivityGroupBy,
  ProjectActivityInsightData,
  ProjectActivityPeriodStats,
  ProjectActivityQueryInput,
  ProjectActivityQueryResult,
} from "@buildwarden/shared";

export interface ProjectActivityCommitFile {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  binary: boolean;
  changeType: "added" | "deleted" | "modified";
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

export interface ProjectActivityReleaseInput {
  name: string;
  date: string;
  commitsSincePrevious: number;
  linesChanged: number;
  filesChanged: number;
}

export interface BuildProjectActivityInsightOptions {
  now?: Date;
  currentFiles?: string[];
  releases?: ProjectActivityReleaseInput[];
  totalReleaseCount?: number;
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
  contributorCommits: Map<string, number>;
  lastChangedAt: string;
};

type MonthlyAccumulator = {
  month: string;
  commits: number;
  linesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  filesCreated: number;
  filesDeleted: number;
  contributors: Set<string>;
};

type FileAccumulator = {
  path: string;
  commits: number;
  linesChanged: number;
  contributors: Set<string>;
  firstSeenAt: string;
  lastChangedAt: string;
  lastChangeType: ProjectActivityCommitFile["changeType"];
};

const ACTIVITY_COMMIT_PREFIX = "__BW_ACTIVITY_COMMIT__";
const MODULE_CONTAINER_NAMES = new Set(["apps", "crates", "libs", "modules", "packages", "plugins", "services"]);
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOTSPOT_RECENCY_HALF_LIFE_DAYS = 180;
const MEGA_COMMIT_THRESHOLD = 500;
const STALE_FILE_THRESHOLD_DAYS = 365;

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
    current = day - previous === DAY_MS ? current + 1 : 1;
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
  contributorCommits: new Map<string, number>(),
  lastChangedAt: "",
});

const createMonth = (month: string): MonthlyAccumulator => ({
  month,
  commits: 0,
  linesChanged: 0,
  linesAdded: 0,
  linesDeleted: 0,
  filesCreated: 0,
  filesDeleted: 0,
  contributors: new Set<string>(),
});

const createFile = (file: ProjectActivityCommitFile, commit: ProjectActivityCommit): FileAccumulator => ({
  path: file.path,
  commits: 0,
  linesChanged: 0,
  contributors: new Set<string>(),
  firstSeenAt: commit.date,
  lastChangedAt: commit.date,
  lastChangeType: file.changeType,
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

    if (!current) continue;
    if (rawLine.includes("\t")) {
      const [addedRaw = "", deletedRaw = "", ...pathParts] = rawLine.split("\t");
      const path = normalizePath(pathParts.join("\t"));
      if (!path || (!/^\d+$/.test(addedRaw) && addedRaw !== "-") || (!/^\d+$/.test(deletedRaw) && deletedRaw !== "-")) continue;
      current.files.push({
        path,
        linesAdded: parseLineCount(addedRaw),
        linesDeleted: parseLineCount(deletedRaw),
        binary: addedRaw === "-" || deletedRaw === "-",
        changeType: "modified",
      });
      continue;
    }

    const summaryMatch = /^(create|delete) mode \d+ (.+)$/.exec(rawLine.trim());
    if (!summaryMatch) continue;
    const path = normalizePath(summaryMatch[2] ?? "");
    const file = current.files.find((candidate) => candidate.path === path);
    if (file) file.changeType = summaryMatch[1] === "create" ? "added" : "deleted";
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
  for (const modulePath of changedModules) {
    const module = modules.get(modulePath)!;
    module.commits += 1;
    module.contributorCommits.set(contributorKey, (module.contributorCommits.get(contributorKey) ?? 0) + 1);
    if (!module.lastChangedAt || timestampFromIso(commit.date) > timestampFromIso(module.lastChangedAt)) module.lastChangedAt = commit.date;
  }
};

const updateFiles = (
  files: Map<string, FileAccumulator>,
  commit: ProjectActivityCommit,
  contributorKey: string,
): void => {
  for (const changedFile of commit.files) {
    const file = files.get(changedFile.path) ?? createFile(changedFile, commit);
    file.commits += 1;
    file.linesChanged += changedFile.linesAdded + changedFile.linesDeleted;
    file.contributors.add(contributorKey);
    if (timestampFromIso(commit.date) < timestampFromIso(file.firstSeenAt)) file.firstSeenAt = commit.date;
    if (timestampFromIso(commit.date) >= timestampFromIso(file.lastChangedAt)) {
      file.lastChangedAt = commit.date;
      file.lastChangeType = changedFile.changeType;
    }
    files.set(changedFile.path, file);
  }
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

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? roundOne(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
};

const percentile = (values: number[], value: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] ?? 0;
};

const average = (values: number[]): number => values.length ? roundOne(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

const daysBetween = (earlier: string, later: Date): number => {
  const timestamp = timestampFromIso(earlier);
  return timestamp ? Math.max(0, Math.floor((later.getTime() - timestamp) / DAY_MS)) : 0;
};

const commitLinesChanged = (commit: ProjectActivityCommit): number =>
  commit.files.reduce((sum, file) => sum + file.linesAdded + file.linesDeleted, 0);

const commitSummary = (commit: ProjectActivityCommit) => ({
  sha: commit.sha,
  title: commit.title,
  author: commit.author || commit.email || "Unknown author",
  date: commit.date,
  filesChanged: commit.files.length,
  linesChanged: commitLinesChanged(commit),
});

type HotspotSource = {
  path: string;
  commits: number;
  linesChanged: number;
  lastChangedAt: string;
  contributorCount: number;
};

const scoreHotspots = (sources: HotspotSource[], now: Date): NonNullable<ProjectActivityInsightData["hotspots"]>["files"] => {
  const maxCommits = Math.max(1, ...sources.map((source) => source.commits));
  const maxChurn = Math.max(1, ...sources.map((source) => source.linesChanged));
  return sources
    .map((source) => {
      const frequencyWeight = source.commits / maxCommits;
      const churnWeight = Math.log1p(Math.max(1, source.linesChanged)) / Math.log1p(maxChurn);
      const ageDays = daysBetween(source.lastChangedAt, now);
      const recencyWeight = 0.2 + (0.8 * Math.exp(-ageDays / HOTSPOT_RECENCY_HALF_LIFE_DAYS));
      return { ...source, score: roundOne(100 * frequencyWeight * churnWeight * recencyWeight) };
    })
    .sort((left, right) => right.score - left.score || right.commits - left.commits);
};

const buildHotspots = (
  files: Map<string, FileAccumulator>,
  modules: Map<string, ModuleAccumulator>,
  now: Date,
): NonNullable<ProjectActivityInsightData["hotspots"]> => ({
  formula: "Normalized commit frequency × logarithmic line churn × 180-day recency weight",
  files: scoreHotspots([...files.values()].map((file) => ({
    path: file.path,
    commits: file.commits,
    linesChanged: file.linesChanged,
    lastChangedAt: file.lastChangedAt,
    contributorCount: file.contributors.size,
  })), now).slice(0, 20),
  modules: scoreHotspots([...modules.values()].map((module) => ({
    path: module.path,
    commits: module.commits,
    linesChanged: module.linesAdded + module.linesDeleted,
    lastChangedAt: module.lastChangedAt,
    contributorCount: module.contributors.size,
  })), now).slice(0, 20),
});

const buildModuleOwnership = (
  modules: Map<string, ModuleAccumulator>,
  contributors: Map<string, ContributorAccumulator>,
): NonNullable<ProjectActivityInsightData["moduleOwnership"]> =>
  [...modules.values()]
    .map((module) => {
      const rankedOwners = [...module.contributorCommits.entries()].sort((left, right) => right[1] - left[1]);
      const [primaryOwnerKey = "", primaryOwnerCommits = 0] = rankedOwners[0] ?? [];
      const owner = contributors.get(primaryOwnerKey);
      const ownershipShare = module.commits ? roundOne((primaryOwnerCommits / module.commits) * 100) : 0;
      return {
        path: module.path,
        primaryOwnerName: owner?.name ?? primaryOwnerKey ?? "Unknown author",
        primaryOwnerEmail: owner?.email ?? "",
        ownershipShare,
        busFactor50: busFactorForHalfOfCommits(rankedOwners.map(([, commits]) => commits), module.commits),
        contributorCount: module.contributors.size,
        commits: module.commits,
        risk: ownershipShare >= 80 ? "silo" as const : ownershipShare >= 65 ? "concentrated" as const : "shared" as const,
      };
    })
    .sort((left, right) => right.ownershipShare - left.ownershipShare || right.commits - left.commits);

const periodStats = (commits: ProjectActivityCommit[], start: number, end: number): ProjectActivityPeriodStats => {
  const selected = commits.filter((commit) => {
    const timestamp = timestampFromIso(commit.date);
    return timestamp >= start && timestamp < end;
  });
  return {
    commits: selected.length,
    contributors: new Set(selected.map(contributorKeyForCommit)).size,
    linesChanged: selected.reduce((sum, commit) => sum + commitLinesChanged(commit), 0),
  };
};

const changePercent = (current: number, previous: number): number | null => {
  if (previous === 0) return current === 0 ? 0 : null;
  return roundOne(((current - previous) / previous) * 100);
};

const buildMomentum = (commits: ProjectActivityCommit[], now: Date): NonNullable<ProjectActivityInsightData["momentum"]> =>
  ([30, 90] as const).map((days) => {
    const current = periodStats(commits, now.getTime() - (days * DAY_MS), now.getTime() + 1);
    const previous = periodStats(commits, now.getTime() - (days * 2 * DAY_MS), now.getTime() - (days * DAY_MS));
    return {
      days,
      current,
      previous,
      changePercent: {
        commits: changePercent(current.commits, previous.commits),
        contributors: changePercent(current.contributors, previous.contributors),
        linesChanged: changePercent(current.linesChanged, previous.linesChanged),
      },
    };
  });

const buildCommitSize = (commits: ProjectActivityCommit[]): NonNullable<ProjectActivityInsightData["commitSize"]> => {
  const sizes = commits.map(commitLinesChanged);
  const megaCommits = sizes.filter((size) => size >= MEGA_COMMIT_THRESHOLD).length;
  return {
    medianLinesChanged: median(sizes),
    p90LinesChanged: percentile(sizes, 0.9),
    megaCommitThreshold: MEGA_COMMIT_THRESHOLD,
    megaCommitCount: megaCommits,
    megaCommitShare: commits.length ? roundOne((megaCommits / commits.length) * 100) : 0,
    largestCommits: [...commits]
      .sort((left, right) => commitLinesChanged(right) - commitLinesChanged(left))
      .slice(0, 5)
      .map(commitSummary),
  };
};

const resolveCurrentFilePaths = (files: Map<string, FileAccumulator>, currentFiles: string[] | undefined): string[] => {
  if (currentFiles) return currentFiles.map(normalizePath).filter((path) => files.has(path));
  return [...files.values()].filter((file) => file.lastChangeType !== "deleted").map((file) => file.path);
};

const buildFileAge = (
  files: Map<string, FileAccumulator>,
  modules: Map<string, ModuleAccumulator>,
  currentFiles: string[] | undefined,
  now: Date,
): NonNullable<ProjectActivityInsightData["fileAge"]> => {
  const currentPaths = resolveCurrentFilePaths(files, currentFiles);
  const currentStats = currentPaths.map((path) => files.get(path)!).filter(Boolean);
  const fileRows = currentStats.map((file) => ({
    path: file.path,
    firstSeenAt: file.firstSeenAt,
    lastChangedAt: file.lastChangedAt,
    ageDays: daysBetween(file.firstSeenAt, now),
    daysSinceChange: daysBetween(file.lastChangedAt, now),
  }));
  const trackedFilesByModule = new Map<string, number>();
  for (const path of currentPaths) {
    const modulePath = modulePathForFile(path);
    trackedFilesByModule.set(modulePath, (trackedFilesByModule.get(modulePath) ?? 0) + 1);
  }
  return {
    trackedFileCount: currentStats.length,
    medianAgeDays: median(fileRows.map((file) => file.ageDays)),
    medianDaysSinceChange: median(fileRows.map((file) => file.daysSinceChange)),
    staleThresholdDays: STALE_FILE_THRESHOLD_DAYS,
    oldestUntouchedFiles: [...fileRows].sort((left, right) => right.daysSinceChange - left.daysSinceChange).slice(0, 10),
    staleModules: [...trackedFilesByModule.entries()]
      .map(([path, trackedFiles]) => {
        const module = modules.get(path);
        return {
          path,
          lastChangedAt: module?.lastChangedAt ?? "",
          daysSinceChange: module?.lastChangedAt ? daysBetween(module.lastChangedAt, now) : 0,
          trackedFiles,
          commits: module?.commits ?? 0,
        };
      })
      .filter((module) => module.daysSinceChange >= STALE_FILE_THRESHOLD_DAYS)
      .sort((left, right) => right.daysSinceChange - left.daysSinceChange),
  };
};

const releaseSizeTrend = (releases: ProjectActivityReleaseInput[]): NonNullable<ProjectActivityInsightData["releaseCadence"]>["sizeTrend"] => {
  if (releases.length < 4) return "insufficient-data";
  const recent = releases.slice(-3).map((release) => release.linesChanged);
  const previous = releases.slice(-6, -3).map((release) => release.linesChanged);
  if (previous.length === 0) return "insufficient-data";
  const previousAverage = average(previous);
  if (previousAverage === 0) return average(recent) > 0 ? "growing" : "stable";
  const change = ((average(recent) - previousAverage) / previousAverage) * 100;
  return change > 15 ? "growing" : change < -15 ? "shrinking" : "stable";
};

const buildReleaseCadence = (
  releases: ProjectActivityReleaseInput[],
  totalReleaseCount: number,
): NonNullable<ProjectActivityInsightData["releaseCadence"]> => {
  const sorted = [...releases].sort((left, right) => timestampFromIso(left.date) - timestampFromIso(right.date));
  const intervals = sorted.slice(1).map((release, index) => roundOne((timestampFromIso(release.date) - timestampFromIso(sorted[index]?.date ?? "")) / DAY_MS));
  return {
    totalReleases: totalReleaseCount,
    averageDaysBetweenReleases: average(intervals),
    medianDaysBetweenReleases: median(intervals),
    averageCommitsPerRelease: average(sorted.map((release) => release.commitsSincePrevious)),
    latestReleaseAt: sorted.at(-1)?.date ?? null,
    sizeTrend: releaseSizeTrend(sorted),
    releases: sorted.map((release, index) => ({
      ...release,
      daysSincePrevious: index === 0 ? null : roundOne((timestampFromIso(release.date) - timestampFromIso(sorted[index - 1]?.date ?? "")) / DAY_MS),
    })),
  };
};

export const buildProjectActivityInsight = (
  commits: ProjectActivityCommit[],
  options: BuildProjectActivityInsightOptions = {},
): ProjectActivityInsightData => {
  const now = options.now ?? new Date();
  const contributors = new Map<string, ContributorAccumulator>();
  const modules = new Map<string, ModuleAccumulator>();
  const files = new Map<string, FileAccumulator>();
  const months = new Map<string, MonthlyAccumulator>();
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  const activeDates = new Set<string>();
  const activeWeeks = new Set<string>();
  let linesAdded = 0;
  let linesDeleted = 0;
  let filesChanged = 0;
  let filesCreated = 0;
  let filesDeleted = 0;
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
    updateFiles(files, commit, contributorKey);

    linesAdded += commitLinesAdded;
    linesDeleted += commitLinesDeleted;
    filesChanged += commit.files.length;
    filesCreated += commit.files.filter((file) => file.changeType === "added").length;
    filesDeleted += commit.files.filter((file) => file.changeType === "deleted").length;
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
      month.linesAdded += commitLinesAdded;
      month.linesDeleted += commitLinesDeleted;
      month.filesCreated += commit.files.filter((file) => file.changeType === "added").length;
      month.filesDeleted += commit.files.filter((file) => file.changeType === "deleted").length;
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
  const moduleRows = [...modules.values()]
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
    }));
  let cumulativeNetLines = 0;
  const monthlyRows = [...months.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((month) => {
      const netLines = month.linesAdded - month.linesDeleted;
      cumulativeNetLines += netLines;
      return {
        month: month.month,
        commits: month.commits,
        linesChanged: month.linesChanged,
        contributorCount: month.contributors.size,
        linesAdded: month.linesAdded,
        linesDeleted: month.linesDeleted,
        netLines,
        cumulativeNetLines,
        filesCreated: month.filesCreated,
        filesDeleted: month.filesDeleted,
      };
    });

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
    modules: moduleRows,
    monthlyActivity: monthlyRows,
    recentCommits: [...commits]
      .sort((left, right) => timestampFromIso(right.date) - timestampFromIso(left.date))
      .slice(0, 12)
      .map(commitSummary),
    hotspots: buildHotspots(files, modules, now),
    moduleOwnership: buildModuleOwnership(modules, contributors),
    momentum: buildMomentum(commits, now),
    commitSize: buildCommitSize(commits),
    codeGrowth: {
      netLines: linesAdded - linesDeleted,
      filesCreated,
      filesDeleted,
    },
    fileAge: buildFileAge(files, modules, options.currentFiles, now),
    releaseCadence: buildReleaseCadence(options.releases ?? [], options.totalReleaseCount ?? options.releases?.length ?? 0),
  };
};

type ProjectActivityQueryGroupAccumulator = {
  key: string;
  label: string;
  commitShas: Set<string>;
  contributors: Set<string>;
  linesChanged: number;
  filesChanged: number;
  drilldown: ProjectActivityQueryResult["groups"][number]["drilldown"];
};

const addDaysToDateKey = (dateKey: string, days: number): string => {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const monthEndDateKey = (monthKey: string): string => {
  const [year = 0, month = 0] = monthKey.split("-").map((value) => Number.parseInt(value, 10));
  return new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
};

const filterProjectActivityCommits = (
  commits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
): ProjectActivityCommit[] => {
  const contributorKey = input.contributorKey?.trim().toLowerCase();
  const modulePath = input.modulePath?.trim();
  return commits.flatMap((commit) => {
    const dateKey = dateKeyFromIso(commit.date);
    if (contributorKey && contributorKeyForCommit(commit) !== contributorKey) return [];
    if (input.dateFrom && dateKey < input.dateFrom) return [];
    if (input.dateTo && dateKey > input.dateTo) return [];
    if (input.weekday !== undefined && weekdayFromDateKey(dateKey) !== input.weekday) return [];
    const files = modulePath ? commit.files.filter((file) => modulePathForFile(file.path) === modulePath) : commit.files;
    if (modulePath && files.length === 0) return [];
    return [{ ...commit, files }];
  });
};

const groupDateDrilldown = (groupBy: ProjectActivityGroupBy, key: string): ProjectActivityQueryResult["groups"][number]["drilldown"] => {
  if (groupBy === "day") return { dateFrom: key, dateTo: key };
  if (groupBy === "week") return { dateFrom: key, dateTo: addDaysToDateKey(key, 6) };
  if (groupBy === "month") return { dateFrom: `${key}-01`, dateTo: monthEndDateKey(key) };
  return {};
};

const groupKeyForCommit = (commit: ProjectActivityCommit, groupBy: Exclude<ProjectActivityGroupBy, "module">): { key: string; label: string } => {
  if (groupBy === "contributor") {
    return { key: contributorKeyForCommit(commit), label: commit.author || commit.email || "Unknown author" };
  }
  const dateKey = dateKeyFromIso(commit.date);
  if (groupBy === "day") return { key: dateKey, label: dateKey };
  if (groupBy === "week") {
    const key = weekKeyFromDateKey(dateKey);
    return { key, label: `Week of ${key}` };
  }
  const key = monthKeyFromIso(commit.date);
  return { key, label: key };
};

const addQueryGroup = (
  groups: Map<string, ProjectActivityQueryGroupAccumulator>,
  input: ProjectActivityQueryInput,
  commit: ProjectActivityCommit,
  key: string,
  label: string,
  files: ProjectActivityCommitFile[],
): void => {
  const existing = groups.get(key) ?? {
    key,
    label,
    commitShas: new Set<string>(),
    contributors: new Set<string>(),
    linesChanged: 0,
    filesChanged: 0,
    drilldown: input.groupBy === "contributor"
      ? { contributorKey: key }
      : input.groupBy === "module"
        ? { modulePath: key }
        : groupDateDrilldown(input.groupBy, key),
  };
  existing.commitShas.add(commit.sha);
  existing.contributors.add(contributorKeyForCommit(commit));
  existing.linesChanged += files.reduce((sum, file) => sum + file.linesAdded + file.linesDeleted, 0);
  existing.filesChanged += files.length;
  groups.set(key, existing);
};

const buildQueryGroups = (
  commits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
): Pick<ProjectActivityQueryResult, "groups" | "totalGroups" | "groupResultLimit"> => {
  const groups = new Map<string, ProjectActivityQueryGroupAccumulator>();
  for (const commit of commits) {
    if (input.groupBy === "module") {
      const filesByModule = new Map<string, ProjectActivityCommitFile[]>();
      for (const file of commit.files) {
        const modulePath = modulePathForFile(file.path);
        filesByModule.set(modulePath, [...(filesByModule.get(modulePath) ?? []), file]);
      }
      for (const [modulePath, files] of filesByModule) addQueryGroup(groups, input, commit, modulePath, modulePath, files);
      continue;
    }
    const { key, label } = groupKeyForCommit(commit, input.groupBy);
    if (key) addQueryGroup(groups, input, commit, key, label, commit.files);
  }
  const chronological = input.groupBy === "day" || input.groupBy === "week" || input.groupBy === "month";
  const allGroups = [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      commits: group.commitShas.size,
      contributors: group.contributors.size,
      linesChanged: group.linesChanged,
      filesChanged: group.filesChanged,
      drilldown: group.drilldown,
    }))
    .sort((left, right) => chronological
      ? left.key.localeCompare(right.key)
      : right.commits - left.commits || right.linesChanged - left.linesChanged);
  const groupResultLimit = 500;
  return {
    groups: chronological ? allGroups.slice(-groupResultLimit) : allGroups.slice(0, groupResultLimit),
    totalGroups: allGroups.length,
    groupResultLimit,
  };
};

const buildQueryContributors = (commits: ProjectActivityCommit[]): ProjectActivityQueryResult["contributors"] => {
  const contributors = new Map<string, ProjectActivityQueryResult["contributors"][number]>();
  for (const commit of commits) {
    const key = contributorKeyForCommit(commit);
    const existing = contributors.get(key) ?? {
      key,
      name: commit.author || commit.email || "Unknown author",
      email: commit.email,
      commits: 0,
      linesChanged: 0,
      filesChanged: 0,
    };
    existing.commits += 1;
    existing.linesChanged += commitLinesChanged(commit);
    existing.filesChanged += commit.files.length;
    contributors.set(key, existing);
  }
  return [...contributors.values()]
    .sort((left, right) => right.commits - left.commits || right.linesChanged - left.linesChanged)
    .slice(0, 100);
};

const buildQueryModules = (commits: ProjectActivityCommit[]): ProjectActivityQueryResult["modules"] => {
  const modules = new Map<string, { path: string; commitShas: Set<string>; contributorKeys: Set<string>; linesChanged: number; filesChanged: number }>();
  for (const commit of commits) {
    for (const file of commit.files) {
      const path = modulePathForFile(file.path);
      const existing = modules.get(path) ?? { path, commitShas: new Set<string>(), contributorKeys: new Set<string>(), linesChanged: 0, filesChanged: 0 };
      existing.commitShas.add(commit.sha);
      existing.contributorKeys.add(contributorKeyForCommit(commit));
      existing.linesChanged += file.linesAdded + file.linesDeleted;
      existing.filesChanged += 1;
      modules.set(path, existing);
    }
  }
  return [...modules.values()]
    .map((module) => ({
      path: module.path,
      commits: module.commitShas.size,
      contributors: module.contributorKeys.size,
      linesChanged: module.linesChanged,
      filesChanged: module.filesChanged,
    }))
    .sort((left, right) => right.commits - left.commits || right.linesChanged - left.linesChanged)
    .slice(0, 100);
};

const buildQuerySummary = (commits: ProjectActivityCommit[]): ProjectActivityQueryResult["summary"] => {
  const linesAdded = commits.reduce((sum, commit) => sum + commit.files.reduce((fileSum, file) => fileSum + file.linesAdded, 0), 0);
  const linesDeleted = commits.reduce((sum, commit) => sum + commit.files.reduce((fileSum, file) => fileSum + file.linesDeleted, 0), 0);
  const dates = commits.map((commit) => commit.date).filter(Boolean).sort((left, right) => timestampFromIso(left) - timestampFromIso(right));
  const sizes = commits.map(commitLinesChanged);
  return {
    commits: commits.length,
    contributors: new Set(commits.map(contributorKeyForCommit)).size,
    linesAdded,
    linesDeleted,
    linesChanged: linesAdded + linesDeleted,
    netLines: linesAdded - linesDeleted,
    filesChanged: commits.reduce((sum, commit) => sum + commit.files.length, 0),
    filesCreated: commits.reduce((sum, commit) => sum + commit.files.filter((file) => file.changeType === "added").length, 0),
    filesDeleted: commits.reduce((sum, commit) => sum + commit.files.filter((file) => file.changeType === "deleted").length, 0),
    activeDays: new Set(commits.map((commit) => dateKeyFromIso(commit.date)).filter(Boolean)).size,
    medianCommitSize: median(sizes),
    megaCommits: sizes.filter((size) => size >= MEGA_COMMIT_THRESHOLD).length,
    firstCommitAt: dates[0] ?? null,
    latestCommitAt: dates.at(-1) ?? null,
  };
};

const activityQueryNow = (input: ProjectActivityQueryInput, fallback: Date): Date =>
  input.dateTo ? new Date(`${input.dateTo}T23:59:59.999Z`) : fallback;

const withoutQueryDateRange = (input: ProjectActivityQueryInput): ProjectActivityQueryInput => {
  const next = { ...input };
  delete next.dateFrom;
  delete next.dateTo;
  return next;
};

const buildQueryMomentum = (
  commits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
  now: Date,
): NonNullable<ProjectActivityInsightData["momentum"]> => {
  const contextualCommits = filterProjectActivityCommits(commits, withoutQueryDateRange(input));
  if (!input.dateFrom) return buildMomentum(contextualCommits, now);

  const start = Date.parse(`${input.dateFrom}T00:00:00.000Z`);
  const endDateKey = input.dateTo ?? dateKeyFromIso(now.toISOString());
  const parsedEnd = Date.parse(`${addDaysToDateKey(endDateKey, 1)}T00:00:00.000Z`);
  const end = Math.max(start + DAY_MS, parsedEnd);
  const days = Math.max(1, Math.round((end - start) / DAY_MS));
  const current = periodStats(contextualCommits, start, end);
  const previous = periodStats(contextualCommits, start - (days * DAY_MS), start);
  return [{
    days,
    current,
    previous,
    changePercent: {
      commits: changePercent(current.commits, previous.commits),
      contributors: changePercent(current.contributors, previous.contributors),
      linesChanged: changePercent(current.linesChanged, previous.linesChanged),
    },
  }];
};

const scopeQueryReleases = (
  releases: ProjectActivityReleaseInput[],
  filteredCommits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
): ProjectActivityReleaseInput[] => {
  const sortedReleases = [...releases].sort((left, right) => timestampFromIso(left.date) - timestampFromIso(right.date));
  const sortedCommits = [...filteredCommits].sort((left, right) => timestampFromIso(left.date) - timestampFromIso(right.date));
  const scopedReleases: ProjectActivityReleaseInput[] = [];
  let commitIndex = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  for (const release of sortedReleases) {
    const releaseTimestamp = timestampFromIso(release.date);
    let commitsSincePrevious = 0;
    let linesChanged = 0;
    let filesChanged = 0;
    while (commitIndex < sortedCommits.length) {
      const commit = sortedCommits[commitIndex]!;
      const timestamp = timestampFromIso(commit.date);
      if (timestamp > releaseTimestamp) break;
      commitIndex += 1;
      if (timestamp <= previousTimestamp) continue;
      commitsSincePrevious += 1;
      linesChanged += commitLinesChanged(commit);
      filesChanged += commit.files.length;
    }

    const releaseDateKey = dateKeyFromIso(release.date);
    if ((!input.dateFrom || releaseDateKey >= input.dateFrom) && (!input.dateTo || releaseDateKey <= input.dateTo)) {
      scopedReleases.push({ name: release.name, date: release.date, commitsSincePrevious, linesChanged, filesChanged });
    }
    previousTimestamp = releaseTimestamp;
  }
  return scopedReleases;
};

const commitsForSelectedFiles = (
  commits: ProjectActivityCommit[],
  selectedCommits: ProjectActivityCommit[],
): ProjectActivityCommit[] => {
  const selectedPaths = new Set(selectedCommits.flatMap((commit) => commit.files.map((file) => normalizePath(file.path))));
  return commits.flatMap((commit) => {
    const files = commit.files.filter((file) => selectedPaths.has(normalizePath(file.path)));
    return files.length > 0 ? [{ ...commit, files }] : [];
  });
};

const commitsForScopedOwnership = (
  commits: ProjectActivityCommit[],
  selectedCommits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
): ProjectActivityCommit[] => {
  const selectedModules = new Set(selectedCommits.flatMap((commit) => commit.files.map((file) => modulePathForFile(file.path))));
  const ownershipInput = { ...input };
  delete ownershipInput.contributorKey;
  return filterProjectActivityCommits(commits, ownershipInput).flatMap((commit) => {
    const files = commit.files.filter((file) => selectedModules.has(modulePathForFile(file.path)));
    return files.length > 0 ? [{ ...commit, files }] : [];
  });
};

export const queryProjectActivity = (
  commits: ProjectActivityCommit[],
  input: ProjectActivityQueryInput,
  options: BuildProjectActivityInsightOptions = {},
): ProjectActivityQueryResult => {
  const filteredCommits = filterProjectActivityCommits(commits, input);
  const now = activityQueryNow(input, options.now ?? new Date());
  const scopedReleases = scopeQueryReleases(options.releases ?? [], filteredCommits, input);
  const activity = buildProjectActivityInsight(filteredCommits, {
    now,
    currentFiles: options.currentFiles,
    releases: scopedReleases,
    totalReleaseCount: input.dateFrom || input.dateTo
      ? scopedReleases.length
      : options.totalReleaseCount ?? scopedReleases.length,
  });
  activity.momentum = buildQueryMomentum(commits, input, now);
  activity.fileAge = buildProjectActivityInsight(commitsForSelectedFiles(commits, filteredCommits), {
    now,
    currentFiles: options.currentFiles,
  }).fileAge;
  activity.moduleOwnership = buildProjectActivityInsight(commitsForScopedOwnership(commits, filteredCommits, input), { now }).moduleOwnership;
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  for (const commit of filteredCommits) {
    const weekday = weekdayFromDateKey(dateKeyFromIso(commit.date));
    if (weekday >= 0) weekdayCounts[weekday] = (weekdayCounts[weekday] ?? 0) + 1;
  }
  return {
    appliedFilters: {
      ...(input.contributorKey ? { contributorKey: input.contributorKey } : {}),
      ...(input.modulePath ? { modulePath: input.modulePath } : {}),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
    },
    groupBy: input.groupBy,
    summary: buildQuerySummary(filteredCommits),
    ...buildQueryGroups(filteredCommits, input),
    contributors: buildQueryContributors(filteredCommits),
    modules: buildQueryModules(filteredCommits),
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
      weekday,
      label: WEEKDAY_LABELS[weekday] ?? "",
      commits: weekdayCounts[weekday] ?? 0,
    })),
    activity,
    commits: [...filteredCommits]
      .sort((left, right) => timestampFromIso(right.date) - timestampFromIso(left.date))
      .slice(0, 100)
      .map(commitSummary),
    commitResultLimit: 100,
  };
};
