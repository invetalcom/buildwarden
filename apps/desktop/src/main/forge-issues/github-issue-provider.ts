import type {
  CreateProjectForgeIssueInput,
  ProjectForgeIssueDetails,
  ProjectForgeIssueLabel,
  ProjectForgeIssueLinkedRequest,
  ProjectForgeIssueMilestone,
  ProjectForgeIssueReaction,
  ProjectForgeIssueSubIssue,
  ProjectForgeIssueTimelineItem,
  ProjectForgeUserSummary,
  UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import { PrReviewHttpError, type PrReviewHttpClient } from "../pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { isRecord, recordBoolean, recordNumber, recordObject, recordString } from "../pr-review/pr-review-utils";
import { extractSignedGithubImageUrls } from "./forge-issue-images";
import {
  FORGE_ISSUE_PAGE_SIZE,
  FORGE_ISSUE_TIMELINE_MAX_PAGES,
  forgeIssueBodyPreview,
  mergeForgeIssueLinkedRequests,
  sortForgeIssueTimeline,
  type ForgeIssueListPage,
  type ForgeIssueListQuery,
  type ForgeIssueProvider,
  type ForgeIssueRepositoryMetadata,
  type ForgeIssueThread,
  type ForgeIssueTokenAccess,
} from "./forge-issue-types";

type GithubIssueContext = ProjectPrReviewRemoteContext & { github: { owner: string; repo: string } };

const JSON_HEADERS = { "Content-Type": "application/json" };

const onlyRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const GITHUB_REACTION_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ["+1", "👍"],
  ["-1", "👎"],
  ["laugh", "😄"],
  ["hooray", "🎉"],
  ["confused", "😕"],
  ["heart", "❤️"],
  ["rocket", "🚀"],
  ["eyes", "👀"],
];

const githubReactions = (record: Record<string, unknown>): ProjectForgeIssueReaction[] => {
  const reactions = recordObject(record, "reactions");
  if (!reactions) return [];
  return GITHUB_REACTION_EMOJI.flatMap(([key, content]) => {
    const count = recordNumber(reactions, key) ?? 0;
    return count > 0 ? [{ content, count }] : [];
  });
};

const githubUser = (record: Record<string, unknown> | null): ProjectForgeUserSummary | null => {
  const username = record ? recordString(record, "login") : null;
  if (!record || !username) return null;
  return {
    username,
    name: recordString(record, "name"),
    avatarUrl: recordString(record, "avatar_url"),
    webUrl: recordString(record, "html_url"),
  };
};

const githubLabel = (value: unknown): ProjectForgeIssueLabel | null => {
  if (typeof value === "string") return value.trim() ? { name: value.trim(), color: null, description: null } : null;
  if (!isRecord(value)) return null;
  const name = recordString(value, "name");
  if (!name) return null;
  const color = recordString(value, "color");
  return { name, color: color && /^[\da-f]{6}$/i.test(color) ? color.toLowerCase() : null, description: recordString(value, "description") };
};

const githubMilestone = (record: Record<string, unknown> | null): ProjectForgeIssueMilestone | null => {
  const number = record ? recordNumber(record, "number") : null;
  const title = record ? recordString(record, "title") : null;
  if (!record || number === null || !title) return null;
  return { number, title, state: recordString(record, "state") ?? "open", dueOn: recordString(record, "due_on"), url: recordString(record, "html_url") };
};

/** Maps one REST issue. Returns `null` for pull requests, which the issues endpoint also lists. */
export const mapGithubIssue = (record: Record<string, unknown>): ProjectForgeIssueDetails | null => {
  if (record.pull_request !== undefined && record.pull_request !== null) return null;
  const number = recordNumber(record, "number");
  const url = recordString(record, "html_url");
  if (number === null || !url) return null;
  const authorUser = githubUser(recordObject(record, "user"));
  const body = typeof record.body === "string" ? record.body : "";
  const subIssues = recordObject(record, "sub_issues_summary");
  const subIssueTotal = subIssues ? (recordNumber(subIssues, "total") ?? 0) : 0;
  return {
    provider: "github",
    number,
    title: recordString(record, "title") ?? `Issue #${String(number)}`,
    url,
    state: recordString(record, "state") === "closed" ? "closed" : "open",
    stateReason: recordString(record, "state_reason"),
    author: authorUser?.username ?? null,
    authorUser,
    labels: (Array.isArray(record.labels) ? record.labels : []).flatMap((label) => {
      const mapped = githubLabel(label);
      return mapped ? [mapped] : [];
    }),
    assignees: onlyRecords(record.assignees).flatMap((assignee) => {
      const user = githubUser(assignee);
      return user ? [user] : [];
    }),
    milestone: githubMilestone(recordObject(record, "milestone")),
    commentCount: recordNumber(record, "comments") ?? 0,
    bodyPreview: forgeIssueBodyPreview(body),
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
    closedAt: recordString(record, "closed_at"),
    locked: recordBoolean(record, "locked"),
    confidential: false,
    weight: null,
    issueType: recordString(recordObject(record, "type") ?? {}, "name"),
    epic: null,
    taskProgress: subIssues && subIssueTotal > 0 ? { completed: recordNumber(subIssues, "completed") ?? 0, total: subIssueTotal } : null,
    reactions: githubReactions(record),
    body,
  };
};

const hasNextPage = (linkHeader: string | null): boolean => Boolean(linkHeader && /rel="next"/.test(linkHeader));

const eventTarget = (record: Record<string, unknown>, key: string, field: string): string =>
  recordString(recordObject(record, key) ?? {}, field) ?? "";

/** One-line description of a timeline event, or `null` for events that add nothing to the conversation. */
const githubEventTitle = (event: string, record: Record<string, unknown>): string | null => {
  switch (event) {
    case "closed": {
      const reason = recordString(record, "state_reason");
      return reason === "not_planned" ? "closed this as not planned" : reason === "duplicate" ? "closed this as a duplicate" : "closed this as completed";
    }
    case "reopened":
      return "reopened this";
    case "labeled":
      return `added the ${eventTarget(record, "label", "name")} label`;
    case "unlabeled":
      return `removed the ${eventTarget(record, "label", "name")} label`;
    case "assigned":
      return `assigned ${eventTarget(record, "assignee", "login") || "someone"}`;
    case "unassigned":
      return `unassigned ${eventTarget(record, "assignee", "login") || "someone"}`;
    case "milestoned":
      return `added this to the ${eventTarget(record, "milestone", "title")} milestone`;
    case "demilestoned":
      return `removed this from the ${eventTarget(record, "milestone", "title")} milestone`;
    case "renamed": {
      const rename = recordObject(record, "rename") ?? {};
      return `changed the title from "${recordString(rename, "from") ?? ""}" to "${recordString(rename, "to") ?? ""}"`;
    }
    case "locked":
      return "locked the conversation";
    case "unlocked":
      return "unlocked the conversation";
    case "pinned":
      return "pinned this issue";
    case "unpinned":
      return "unpinned this issue";
    case "transferred":
      return "transferred this issue";
    case "marked_as_duplicate":
      return "marked this as a duplicate";
    case "connected":
      return "linked a pull request that will close this issue";
    case "disconnected":
      return "removed a linked pull request";
    case "referenced":
      return recordString(record, "commit_id") ? `referenced this in commit ${String(record.commit_id).slice(0, 7)}` : null;
    case "sub_issue_added":
      return "added a sub-issue";
    case "sub_issue_removed":
      return "removed a sub-issue";
    case "issue_type_added":
    case "issue_type_changed":
      return "changed the issue type";
    default:
      return null;
  }
};

const githubCrossReference = (record: Record<string, unknown>): { title: string; request: ProjectForgeIssueLinkedRequest | null } | null => {
  const source = recordObject(recordObject(record, "source") ?? {}, "issue");
  const number = source ? recordNumber(source, "number") : null;
  const url = source ? recordString(source, "html_url") : null;
  if (!source || number === null || !url) return null;
  const title = recordString(source, "title") ?? "";
  const pullRequest = recordObject(source, "pull_request");
  if (!pullRequest) return { title: `mentioned this in issue #${String(number)} ${title}`.trim(), request: null };
  const state = recordString(pullRequest, "merged_at") ? "merged" : (recordString(source, "state") ?? "open");
  return {
    title: `mentioned this in pull request #${String(number)} ${title}`.trim(),
    request: { number, title, url, state, draft: recordBoolean(source, "draft"), relation: "mentions" },
  };
};

const mapGithubComment = (record: Record<string, unknown>): ProjectForgeIssueTimelineItem | null => {
  const id = record.id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return {
    itemKey: `comment-${String(id)}`,
    kind: "comment",
    title: "",
    body: typeof record.body === "string" ? record.body : "",
    author: githubUser(recordObject(record, "user") ?? recordObject(record, "actor")),
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
    url: recordString(record, "html_url"),
    reactions: githubReactions(record),
  };
};

const CLOSING_REQUESTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
          nodes { number title url state isDraft }
        }
      }
    }
  }`;

export class GithubIssueProvider implements ForgeIssueProvider {
  private readonly repoPath: string;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    context: GithubIssueContext,
    private readonly http: PrReviewHttpClient,
  ) {
    this.owner = context.github.owner;
    this.repo = context.github.repo;
    this.repoPath = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async resolveTokenAccess(): Promise<ForgeIssueTokenAccess> {
    const [repository, user] = await Promise.allSettled([this.http.json(this.repoPath), this.http.json("/user")]);
    if (repository.status === "rejected") throw repository.reason;
    const repo = isRecord(repository.value) ? repository.value : {};
    const permissions = recordObject(repo, "permissions") ?? {};
    const canTriage = ["admin", "maintain", "push", "triage"].some((key) => recordBoolean(permissions, key));
    return {
      // GitHub lets any signed-in account comment on and open issues in a repository it can read.
      canWrite: true,
      canTriage,
      viewer: user.status === "fulfilled" && isRecord(user.value) ? recordString(user.value, "login") : null,
      issuesEnabled: repo.has_issues !== false,
    };
  }

  async listIssues(query: ForgeIssueListQuery): Promise<ForgeIssueListPage> {
    const params = new URLSearchParams({
      state: query.state ?? "open",
      per_page: String(FORGE_ISSUE_PAGE_SIZE),
      page: String(Math.max(1, query.page ?? 1)),
      sort: query.sort ?? "updated",
      direction: "desc",
    });
    if (query.labels?.length) params.set("labels", query.labels.join(","));
    if (query.assignee) {
      if (query.assignee === "@me") {
        if (!query.viewer) throw new Error('"Assigned to me" needs a Git hosting access token.');
        params.set("assignee", query.viewer);
      } else {
        params.set("assignee", query.assignee);
      }
    }
    if (query.author) params.set("creator", query.author);
    if (query.milestone) {
      const milestone = (await this.listMilestones("all")).find((entry) => entry.title === query.milestone);
      // GitHub filters by milestone number; an unknown title can match nothing.
      if (!milestone) return { items: [], hasMore: false };
      params.set("milestone", String(milestone.number));
    }
    const { payload, headers } = await this.http.jsonWithHeaders(`${this.repoPath}/issues?${params.toString()}`);
    const items = onlyRecords(payload).flatMap((record) => {
      const issue = mapGithubIssue(record);
      return issue ? [issue] : [];
    });
    return { items, hasMore: hasNextPage(headers.get("link")) };
  }

  async getIssueThread(issueNumber: number, known?: ProjectForgeIssueDetails | null): Promise<ForgeIssueThread> {
    const warnings: string[] = [];
    const issue = known ?? (await this.fetchIssue(issueNumber));
    const [timelineResult, closingResult, subIssueResult] = await Promise.allSettled([
      this.fetchTimeline(issueNumber, warnings),
      this.http.authenticated ? this.fetchClosingRequests(issueNumber) : Promise.resolve([]),
      issue.taskProgress ? this.fetchSubIssues(issueNumber) : Promise.resolve([]),
    ]);
    if (timelineResult.status === "rejected") throw timelineResult.reason;
    if (closingResult.status === "rejected") warnings.push("Could not check which pull requests close this issue.");
    if (subIssueResult.status === "rejected") warnings.push("Could not load the sub-issues of this issue.");
    const { timeline, mentioned } = timelineResult.value;
    return {
      issue,
      timeline: sortForgeIssueTimeline(timeline),
      linkedRequests: mergeForgeIssueLinkedRequests([...mentioned, ...(closingResult.status === "fulfilled" ? closingResult.value : [])]),
      subIssues: subIssueResult.status === "fulfilled" ? subIssueResult.value : [],
      warnings,
    };
  }

  async getMetadata(): Promise<ForgeIssueRepositoryMetadata> {
    const warnings: string[] = [];
    const [labels, milestones, assignees] = await Promise.allSettled([
      this.http.json(`${this.repoPath}/labels?per_page=100`),
      this.listMilestones("open"),
      this.http.json(`${this.repoPath}/assignees?per_page=100`),
    ]);
    if (labels.status === "rejected") warnings.push("Could not load the repository's labels.");
    if (milestones.status === "rejected") warnings.push("Could not load the repository's milestones.");
    if (assignees.status === "rejected") warnings.push("Could not load assignable users.");
    return {
      labels: labels.status === "fulfilled"
        ? onlyRecords(labels.value).flatMap((label) => {
            const mapped = githubLabel(label);
            return mapped ? [mapped] : [];
          })
        : [],
      milestones: milestones.status === "fulfilled" ? milestones.value : [],
      assignees: assignees.status === "fulfilled"
        ? onlyRecords(assignees.value).flatMap((entry) => {
            const user = githubUser(entry);
            return user ? [user] : [];
          })
        : [],
      warnings,
    };
  }

  async createIssue(input: CreateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails> {
    const payload = await this.http.json(`${this.repoPath}/issues`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.assignees?.length ? { assignees: input.assignees } : {}),
        ...(typeof input.milestone === "number" ? { milestone: input.milestone } : {}),
      }),
    });
    return this.requireIssue(payload);
  }

  async updateIssue(input: UpdateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.body !== undefined) body.body = input.body;
    if (input.state !== undefined) {
      body.state = input.state;
      body.state_reason = input.state === "closed" ? (input.closeReason ?? "completed") : "reopened";
    }
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.assignees !== undefined) body.assignees = input.assignees;
    if (input.milestone !== undefined) body.milestone = input.milestone;
    const payload = await this.http.json(`${this.repoPath}/issues/${String(input.issueNumber)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return this.requireIssue(payload);
  }

  async addComment(issueNumber: number, body: string): Promise<{ url: string | null }> {
    const payload = await this.http.json(`${this.repoPath}/issues/${String(issueNumber)}/comments`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ body }),
    });
    return { url: isRecord(payload) ? recordString(payload, "html_url") : null };
  }

  async getSignedImageUrls(issueNumber: number): Promise<Map<string, string>> {
    // Only the rendered HTML carries the signed addresses; the Markdown has the permanent ones a browser session is needed for.
    const rendered = { headers: { Accept: "application/vnd.github.full+json" } };
    const issuePath = `${this.repoPath}/issues/${String(issueNumber)}`;
    const [issue, comments] = await Promise.allSettled([
      this.http.text(issuePath, rendered),
      this.http.text(`${issuePath}/comments?per_page=100`, rendered),
    ]);
    const urls = new Map<string, string>();
    for (const result of [issue, comments]) {
      if (result.status !== "fulfilled") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(result.value);
      } catch {
        continue;
      }
      for (const record of Array.isArray(payload) ? onlyRecords(payload) : isRecord(payload) ? [payload] : []) {
        const html = recordString(record, "body_html");
        if (!html) continue;
        for (const [assetId, url] of extractSignedGithubImageUrls(html)) urls.set(assetId, url);
      }
    }
    if (urls.size === 0 && issue.status === "rejected") throw issue.reason;
    return urls;
  }

  private requireIssue(payload: unknown): ProjectForgeIssueDetails {
    const issue = isRecord(payload) ? mapGithubIssue(payload) : null;
    if (!issue) throw new Error("GitHub returned an issue BuildWarden could not read.");
    return issue;
  }

  private async fetchIssue(issueNumber: number): Promise<ProjectForgeIssueDetails> {
    const payload = await this.http.json(`${this.repoPath}/issues/${String(issueNumber)}`);
    const issue = isRecord(payload) ? mapGithubIssue(payload) : null;
    if (!issue) throw new Error(`#${String(issueNumber)} is a pull request, not an issue. Open it under PRs.`);
    return issue;
  }

  private async listMilestones(state: "open" | "all"): Promise<ProjectForgeIssueMilestone[]> {
    const payload = await this.http.json(`${this.repoPath}/milestones?state=${state}&per_page=100`);
    return onlyRecords(payload).flatMap((record) => {
      const milestone = githubMilestone(record);
      return milestone ? [milestone] : [];
    });
  }

  private async fetchTimeline(
    issueNumber: number,
    warnings: string[],
  ): Promise<{ timeline: ProjectForgeIssueTimelineItem[]; mentioned: ProjectForgeIssueLinkedRequest[] }> {
    let records: Record<string, unknown>[];
    try {
      records = await this.fetchPages(`${this.repoPath}/issues/${String(issueNumber)}/timeline`, warnings);
    } catch (error) {
      // An exhausted budget would fail the fallback too; report it as it is.
      if (error instanceof PrReviewHttpError && (error.status === 401 || error.status === 429 || error.retryAfterMs !== null)) throw error;
      const comments = await this.fetchPages(`${this.repoPath}/issues/${String(issueNumber)}/comments`, warnings);
      warnings.push("The issue's event history could not be loaded; showing comments only.");
      return {
        timeline: comments.flatMap((record) => {
          const comment = mapGithubComment(record);
          return comment ? [comment] : [];
        }),
        mentioned: [],
      };
    }

    const timeline: ProjectForgeIssueTimelineItem[] = [];
    const mentioned: ProjectForgeIssueLinkedRequest[] = [];
    records.forEach((record, index) => {
      const event = recordString(record, "event") ?? "";
      if (event === "commented") {
        const comment = mapGithubComment(record);
        if (comment) timeline.push(comment);
        return;
      }
      let title: string | null;
      if (event === "cross-referenced") {
        const reference = githubCrossReference(record);
        if (reference?.request) mentioned.push(reference.request);
        title = reference?.title ?? null;
      } else {
        title = githubEventTitle(event, record);
      }
      if (!title) return;
      timeline.push({
        itemKey: `event-${String(record.id ?? record.node_id ?? index)}`,
        kind: "event",
        title,
        body: null,
        author: githubUser(recordObject(record, "actor") ?? recordObject(record, "user")),
        createdAt: recordString(record, "created_at"),
        updatedAt: null,
        url: null,
        reactions: [],
      });
    });
    return { timeline, mentioned };
  }

  private async fetchPages(path: string, warnings: string[]): Promise<Record<string, unknown>[]> {
    const records: Record<string, unknown>[] = [];
    for (let page = 1; page <= FORGE_ISSUE_TIMELINE_MAX_PAGES; page += 1) {
      const { payload, headers } = await this.http.jsonWithHeaders(`${path}?per_page=100&page=${String(page)}`);
      records.push(...onlyRecords(payload));
      if (!hasNextPage(headers.get("link"))) return records;
    }
    warnings.push(`This issue has a long history; showing its first ${String(FORGE_ISSUE_TIMELINE_MAX_PAGES * 100)} entries.`);
    return records;
  }

  private async fetchClosingRequests(issueNumber: number): Promise<ProjectForgeIssueLinkedRequest[]> {
    const payload = await this.http.json("/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: CLOSING_REQUESTS_QUERY, variables: { owner: this.owner, repo: this.repo, number: issueNumber } }),
    });
    const issue = recordObject(recordObject(recordObject(isRecord(payload) ? payload : {}, "data") ?? {}, "repository") ?? {}, "issue");
    const nodes = onlyRecords(recordObject(issue ?? {}, "closedByPullRequestsReferences")?.nodes);
    return nodes.flatMap((node): ProjectForgeIssueLinkedRequest[] => {
      const number = recordNumber(node, "number");
      const url = recordString(node, "url");
      if (number === null || !url) return [];
      return [{
        number,
        title: recordString(node, "title") ?? "",
        url,
        state: (recordString(node, "state") ?? "open").toLowerCase(),
        draft: recordBoolean(node, "isDraft"),
        relation: "closes",
      }];
    });
  }

  private async fetchSubIssues(issueNumber: number): Promise<ProjectForgeIssueSubIssue[]> {
    const payload = await this.http.json(`${this.repoPath}/issues/${String(issueNumber)}/sub_issues?per_page=50`);
    return onlyRecords(payload).flatMap((record): ProjectForgeIssueSubIssue[] => {
      const number = recordNumber(record, "number");
      const url = recordString(record, "html_url");
      if (number === null || !url) return [];
      return [{ number, title: recordString(record, "title") ?? "", url, state: recordString(record, "state") === "closed" ? "closed" : "open" }];
    });
  }
}

export const isGithubIssueContext = (context: ProjectPrReviewRemoteContext): context is GithubIssueContext =>
  context.provider === "github" && context.github !== undefined;
