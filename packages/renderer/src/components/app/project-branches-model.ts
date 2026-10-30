import type { ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";

export type BranchFilter = "all" | "local" | "remote" | "runs" | "merged" | "stale";
export type BranchSort = "recent" | "name";

/** Matches GitHub's branch view: no commits for three months makes a branch stale. */
export const STALE_BRANCH_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const BRANCH_FILTER_LABELS: Record<BranchFilter, string> = {
  all: "All",
  local: "Local",
  remote: "Remote only",
  runs: "Agent runs",
  merged: "Merged",
  stale: "Stale",
};

const timestampOf = (branch: ProjectGitBranchInfo): number => {
  const time = branch.updatedAt ? new Date(branch.updatedAt).getTime() : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
};

export const isStaleBranch = (branch: ProjectGitBranchInfo, now: number): boolean =>
  !branch.isBase && !branch.isCurrent && timestampOf(branch) > 0 && now - timestampOf(branch) > STALE_BRANCH_DAYS * DAY_MS;

export const matchesBranchFilter = (branch: ProjectGitBranchInfo, filter: BranchFilter, now: number): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "local":
      return branch.hasLocal;
    case "remote":
      return !branch.hasLocal && branch.hasRemote;
    case "runs":
      return (branch.linkedRunCount ?? 0) > 0;
    case "merged":
      return branch.mergedIntoBase === true;
    case "stale":
      return isStaleBranch(branch, now);
  }
};

export const countBranchFilters = (branches: ProjectGitBranchInfo[], now: number): Record<BranchFilter, number> => {
  const counts: Record<BranchFilter, number> = { all: 0, local: 0, remote: 0, runs: 0, merged: 0, stale: 0 };
  for (const branch of branches) {
    for (const filter of Object.keys(counts) as BranchFilter[]) {
      if (matchesBranchFilter(branch, filter, now)) counts[filter] += 1;
    }
  }
  return counts;
};

const matchesQuery = (branch: ProjectGitBranchInfo, query: string): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [branch.name, branch.subject, branch.authorName, branch.upstream, branch.commitSha].filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

/** Current and base branches stay pinned on top; the rest follow the chosen order. */
export const selectVisibleBranches = (
  branches: ProjectGitBranchInfo[],
  options: { filter: BranchFilter; query: string; sort: BranchSort; now: number },
): ProjectGitBranchInfo[] => {
  const rank = (branch: ProjectGitBranchInfo) => (branch.isCurrent ? 0 : branch.isBase ? 1 : 2);
  return branches
    .filter((branch) => matchesBranchFilter(branch, options.filter, options.now) && matchesQuery(branch, options.query))
    .sort((left, right) => {
      if (rank(left) !== rank(right)) return rank(left) - rank(right);
      if (options.sort === "recent" && timestampOf(left) !== timestampOf(right)) return timestampOf(right) - timestampOf(left);
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });
};

/** Local branches that the base already contains and nothing else depends on. */
export const selectMergedCleanupCandidates = (branches: ProjectGitBranchInfo[]): ProjectGitBranchInfo[] =>
  branches.filter(
    (branch) =>
      branch.hasLocal &&
      branch.mergedIntoBase === true &&
      !branch.isCurrent &&
      !branch.isBase &&
      !branch.worktreePath &&
      (branch.linkedRunCount ?? 0) === 0,
  );

/** Ref Git understands for a branch: the local name, or `<remote>/<name>` for remote-only branches. */
export const branchRefName = (branch: ProjectGitBranchInfo, remoteName: string | null | undefined): string =>
  branch.hasLocal ? branch.name : `${remoteName || "origin"}/${branch.name}`;

export const forgeLabel = (provider: ProjectGitBranchOverview["provider"] | null | undefined): string | null => {
  if (provider === "github") return "GitHub";
  if (provider === "gitlab") return "GitLab";
  return null;
};

export const branchWebUrl = (overview: ProjectGitBranchOverview | null, branch: string): string | null => {
  if (!overview?.webBaseUrl || overview.provider === "unknown") return null;
  const encoded = encodeURIComponent(branch);
  return overview.provider === "gitlab" ? `${overview.webBaseUrl}/-/tree/${encoded}` : `${overview.webBaseUrl}/tree/${encoded}`;
};

/** Opens the forge's compare page, which offers to create the pull or merge request. */
export const branchCompareUrl = (overview: ProjectGitBranchOverview | null, branch: string): string | null => {
  if (!overview?.webBaseUrl || overview.provider === "unknown" || !overview.baseBranch) return null;
  if (overview.provider === "gitlab") {
    const params = new URLSearchParams({
      "merge_request[source_branch]": branch,
      "merge_request[target_branch]": overview.baseBranch,
    });
    return `${overview.webBaseUrl}/-/merge_requests/new?${params.toString()}`;
  }
  return `${overview.webBaseUrl}/compare/${encodeURIComponent(overview.baseBranch)}...${encodeURIComponent(branch)}?expand=1`;
};

export const formatBranchAge = (value: string | null, now: number): string => {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)}d ago`;
  if (days < 365) return `${String(Math.floor(days / 30))}mo ago`;
  return `${String(Math.floor(days / 365))}y ago`;
};

/** Log scale keeps a branch 3 commits ahead visible next to one 400 commits behind. */
export const divergenceBarPercent = (value: number, max: number): number => {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(8, Math.round((Math.log1p(value) / Math.log1p(max)) * 100));
};
