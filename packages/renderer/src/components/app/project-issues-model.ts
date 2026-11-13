import type {
  ChatAttachmentPayload,
  ChatSummary,
  ForgeIssueReference,
  ProjectForgeIssueAccess,
  ProjectForgeIssueSavedFilter,
  ProjectForgeIssueSort,
  ProjectForgeIssueStateFilter,
  ProjectForgeIssueSummary,
  ProjectForgeIssueWorkLink,
  ProjectForgeIssuesUnavailableReason,
  ProjectTaskSummary,
  RunListItem,
} from "@buildwarden/shared";
import type { CSSProperties } from "react";

export interface IssueFilters {
  state: ProjectForgeIssueStateFilter;
  labels: string[];
  /** `""` for anyone, `@me`, `none`, or a username. */
  assignee: string;
  milestone: string;
  sort: ProjectForgeIssueSort;
}

/** One run to start for an issue: the prompt plus the issue as an attached Markdown file. */
export interface ForgeIssueRunRequest {
  issue: ForgeIssueReference;
  prompt: string;
  attachments: ChatAttachmentPayload[];
}

export interface ForgeIssueChatRequest extends ForgeIssueRunRequest {
  modelId: string;
}

export const DEFAULT_ISSUE_FILTERS: IssueFilters ={ state: "open", labels: [], assignee: "", milestone: "", sort: "updated" };

export const issueFiltersEqual = (left: IssueFilters, right: IssueFilters): boolean =>
  left.state === right.state &&
  left.assignee === right.assignee &&
  left.milestone === right.milestone &&
  left.sort === right.sort &&
  left.labels.length === right.labels.length &&
  [...left.labels].sort().join("\n") === [...right.labels].sort().join("\n");

export const issueFiltersFromSaved = (saved: ProjectForgeIssueSavedFilter): IssueFilters => ({
  state: saved.state,
  labels: [...saved.labels],
  assignee: saved.assignee,
  milestone: saved.milestone,
  sort: saved.sort,
});

/** Number of filters that differ from the default view, for the "filters active" hint. */
export const countActiveIssueFilters = (filters: IssueFilters): number =>
  filters.labels.length + (filters.assignee ? 1 : 0) + (filters.milestone ? 1 : 0);

/** Narrows the loaded issues by a search over number, title, labels, author, and description start. */
export const searchIssues = (issues: readonly ProjectForgeIssueSummary[], search: string): ProjectForgeIssueSummary[] => {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...issues];
  return issues.filter((issue) => {
    const haystack = [
      `#${String(issue.number)}`,
      issue.title,
      issue.author ?? "",
      issue.bodyPreview,
      ...issue.labels.map((label) => label.name),
      ...issue.assignees.map((user) => user.username),
    ].join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
};

/**
 * Colors for a label chip. The host's label color tints the chip, and the text is that color
 * pulled towards the theme's text color, so it stays readable on dark and bright themes alike.
 */
export const issueLabelStyle = (color: string | null): CSSProperties | undefined => {
  if (!color || !/^[\da-f]{6}$/i.test(color)) return undefined;
  const tint = `#${color}`;
  return {
    backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)`,
    borderColor: `color-mix(in srgb, ${tint} 45%, transparent)`,
    color: `color-mix(in srgb, ${tint} 45%, var(--ec-text))`,
  };
};

export const formatIssueAge = (value: string | null, now = Date.now()): string => {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${String(days)}d`;
  const months = Math.round(days / 30);
  return months < 12 ? `${String(months)}mo` : `${String(Math.round(days / 365))}y`;
};

export const formatIssueDate = (value: string | null): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const issueStateLabel = (issue: Pick<ProjectForgeIssueSummary, "state" | "stateReason">): string => {
  if (issue.state === "open") return "Open";
  if (issue.stateReason === "not_planned") return "Not planned";
  if (issue.stateReason === "duplicate") return "Duplicate";
  return "Closed";
};

/** What the access chip in the header says, and whether it deserves attention. */
export const describeIssueAccess = (access: ProjectForgeIssueAccess | null): { label: string; title: string; tone: "neutral" | "warning" } | null => {
  if (!access) return null;
  if (access.mode === "token") {
    if (access.canTriage) return null;
    return {
      label: "Comment only",
      title: "The saved token may comment and open issues, but may not change labels, assignees, milestones, or close issues in this repository.",
      tone: "neutral",
    };
  }
  const { rateLimit } = access;
  const budget = rateLimit?.remaining != null && rateLimit.limit != null ? ` · ${String(rateLimit.remaining)}/${String(rateLimit.limit)} requests left` : "";
  const low = rateLimit?.remaining != null && rateLimit.remaining <= 10;
  return {
    label: `Read-only${budget}`,
    title: "No Git hosting token is saved, so issues are read from the host's public API. Commenting and editing need a token. Results are reused for 10 minutes to save requests.",
    tone: low ? "warning" : "neutral",
  };
};

export const issueUnavailableTitle = (reason: ProjectForgeIssuesUnavailableReason): string => {
  switch (reason) {
    case "needs-token":
      return "Issues need a hosting token";
    case "rate-limited":
      return "Request limit reached";
    case "issues-disabled":
      return "Issues are switched off";
    case "token-rejected":
      return "The saved token was rejected";
    case "token-lacks-permission":
      return "The saved token cannot read issues";
  }
};

export interface IssueWorkSummary {
  runs: Array<{ link: ProjectForgeIssueWorkLink; run: RunListItem | null }>;
  chats: Array<{ link: ProjectForgeIssueWorkLink; chat: ChatSummary | null }>;
  tasks: Array<{ link: ProjectForgeIssueWorkLink; task: ProjectTaskSummary | null }>;
  /** A run for this issue is working right now. */
  activeRun: boolean;
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "preparing", "running"]);

export const isActiveRunStatus = (status: string): boolean => ACTIVE_RUN_STATUSES.has(status);

/** Resolves an issue's links against the runs, chats, and tasks the client knows. Newest first. */
export const summarizeIssueWork = (
  issueNumber: number,
  links: readonly ProjectForgeIssueWorkLink[],
  known: { runs: readonly RunListItem[]; chats: readonly ChatSummary[]; tasks: readonly ProjectTaskSummary[] },
): IssueWorkSummary => {
  const mine = links.filter((link) => link.issueNumber === issueNumber).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const runs = mine.filter((link) => link.kind === "run").map((link) => ({ link, run: known.runs.find((run) => run.id === link.runId) ?? null }));
  return {
    runs,
    chats: mine.filter((link) => link.kind === "chat").map((link) => ({ link, chat: known.chats.find((chat) => chat.id === link.chatId) ?? null })),
    tasks: mine.filter((link) => link.kind === "task").map((link) => ({ link, task: known.tasks.find((task) => task.id === link.taskId) ?? null })),
    activeRun: runs.some(({ run }) => run !== null && isActiveRunStatus(run.status)),
  };
};

export const groupLinksByIssue = (links: readonly ProjectForgeIssueWorkLink[]): Map<number, ProjectForgeIssueWorkLink[]> => {
  const byIssue = new Map<number, ProjectForgeIssueWorkLink[]>();
  for (const link of links) {
    const list = byIssue.get(link.issueNumber);
    if (list) list.push(link);
    else byIssue.set(link.issueNumber, [link]);
  }
  return byIssue;
};

const SEEN_STORAGE_PREFIX = "buildwarden:project-issues-seen:";
const SEEN_LIMIT = 500;

/** Per issue number: the `updatedAt` the user last saw. Kept per device, like read state in a mail client. */
export type SeenIssues = Record<string, string>;

export const readSeenIssues = (projectId: string): SeenIssues => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${SEEN_STORAGE_PREFIX}${projectId}`) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
};

export const writeSeenIssues = (projectId: string, seen: SeenIssues): void => {
  try {
    const entries = Object.entries(seen);
    // Oldest markers go first; an issue that drops out simply shows as read again.
    const trimmed = entries.length > SEEN_LIMIT ? entries.sort((left, right) => right[1].localeCompare(left[1])).slice(0, SEEN_LIMIT) : entries;
    window.localStorage.setItem(`${SEEN_STORAGE_PREFIX}${projectId}`, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Read markers are a convenience; the list still works without storage.
  }
};

/** An issue is unread when it changed after the user last opened it. Issues never opened are not flagged. */
export const isIssueUnread = (issue: Pick<ProjectForgeIssueSummary, "number" | "updatedAt">, seen: SeenIssues): boolean => {
  const marker = seen[String(issue.number)];
  return Boolean(marker && issue.updatedAt && issue.updatedAt > marker);
};

const FORGE_SEGMENT_STORAGE_PREFIX = "buildwarden:project-forge-segment:";
export type ForgeSegment = "requests" | "issues";

export const readStoredForgeSegment = (projectId: string): ForgeSegment => {
  try {
    return window.localStorage.getItem(`${FORGE_SEGMENT_STORAGE_PREFIX}${projectId}`) === "issues" ? "issues" : "requests";
  } catch {
    return "requests";
  }
};

export const writeStoredForgeSegment = (projectId: string, segment: ForgeSegment): void => {
  try {
    window.localStorage.setItem(`${FORGE_SEGMENT_STORAGE_PREFIX}${projectId}`, segment);
  } catch {
    // The choice still holds for this session.
  }
};

export const newSavedFilterKey = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
