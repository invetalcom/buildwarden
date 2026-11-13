import type {
  CreateProjectForgeIssueInput,
  ListProjectForgeIssuesInput,
  ProjectForgeIssueDetails,
  ProjectForgeIssueLabel,
  ProjectForgeIssueLinkedRequest,
  ProjectForgeIssueMilestone,
  ProjectForgeIssueSubIssue,
  ProjectForgeIssueTimelineItem,
  ProjectForgeUserSummary,
  UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";

export const FORGE_ISSUE_PAGE_SIZE = 50;
/** Timeline pages of 100 entries read for one issue before the rest is cut off. */
export const FORGE_ISSUE_TIMELINE_MAX_PAGES = 3;

/** What the saved token may do with issues. Only resolved when a token exists. */
export interface ForgeIssueTokenAccess {
  canWrite: boolean;
  canTriage: boolean;
  viewer: string | null;
  /** False when the repository has its issue tracker switched off. */
  issuesEnabled: boolean;
}

export interface ForgeIssueListPage {
  /** Full issues including the description, so opening one can skip a second request. */
  items: ProjectForgeIssueDetails[];
  hasMore: boolean;
}

export interface ForgeIssueThread {
  issue: ProjectForgeIssueDetails;
  timeline: ProjectForgeIssueTimelineItem[];
  linkedRequests: ProjectForgeIssueLinkedRequest[];
  subIssues: ProjectForgeIssueSubIssue[];
  warnings: string[];
}

export interface ForgeIssueRepositoryMetadata {
  labels: ProjectForgeIssueLabel[];
  milestones: ProjectForgeIssueMilestone[];
  assignees: ProjectForgeUserSummary[];
  warnings: string[];
}

export interface ForgeIssueListQuery extends Omit<ListProjectForgeIssuesInput, "refresh"> {
  /** Username `@me` resolves to; `null` without a token. */
  viewer: string | null;
}

export interface ForgeIssueProvider {
  resolveTokenAccess(): Promise<ForgeIssueTokenAccess>;
  listIssues(query: ForgeIssueListQuery): Promise<ForgeIssueListPage>;
  /**
   * @param known A recently listed copy of the issue. When given, the provider does not fetch the issue again.
   */
  getIssueThread(issueNumber: number, known?: ProjectForgeIssueDetails | null): Promise<ForgeIssueThread>;
  getMetadata(): Promise<ForgeIssueRepositoryMetadata>;
  createIssue(input: CreateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails>;
  updateIssue(input: UpdateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails>;
  addComment(issueNumber: number, body: string): Promise<{ url: string | null }>;
  /**
   * Short-lived download addresses of the attachments shown in an issue and its comments, by attachment id.
   * Only hosts that hide attachments behind signed addresses implement this.
   */
  getSignedImageUrls?(issueNumber: number): Promise<Map<string, string>>;
}

export const forgeIssueBodyPreview = (body: string): string =>
  body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()!|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

export const sortForgeIssueTimeline = (items: ProjectForgeIssueTimelineItem[]): ProjectForgeIssueTimelineItem[] =>
  [...items].sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));

/** Keeps the strongest relation when the same request is both mentioned and closing. */
export const mergeForgeIssueLinkedRequests = (requests: ProjectForgeIssueLinkedRequest[]): ProjectForgeIssueLinkedRequest[] => {
  const byNumber = new Map<number, ProjectForgeIssueLinkedRequest>();
  for (const request of requests) {
    const current = byNumber.get(request.number);
    if (!current || (current.relation === "mentions" && request.relation === "closes")) {
      byNumber.set(request.number, current ? { ...current, ...request } : request);
    }
  }
  return [...byNumber.values()].sort((left, right) => right.number - left.number);
};
