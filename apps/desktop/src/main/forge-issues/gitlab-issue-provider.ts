import type {
  CreateProjectForgeIssueInput,
  ProjectForgeIssueDetails,
  ProjectForgeIssueLabel,
  ProjectForgeIssueLinkedRequest,
  ProjectForgeIssueMilestone,
  ProjectForgeIssueReaction,
  ProjectForgeIssueTimelineItem,
  ProjectForgeUserSummary,
  UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import type { PrReviewHttpClient } from "../pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { isRecord, recordBoolean, recordNumber, recordObject, recordString } from "../pr-review/pr-review-utils";
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

type GitlabIssueContext = ProjectPrReviewRemoteContext & { gitlab: { projectPath: string; encodedProjectPath: string } };

const JSON_HEADERS = { "Content-Type": "application/json" };
/** GitLab's Reporter role: the lowest that may label, assign, and close issues. */
const GITLAB_REPORTER_ACCESS_LEVEL = 20;

const onlyRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const gitlabUser = (record: Record<string, unknown> | null): ProjectForgeUserSummary | null => {
  const username = record ? recordString(record, "username") : null;
  if (!record || !username) return null;
  return { username, name: recordString(record, "name"), avatarUrl: recordString(record, "avatar_url"), webUrl: recordString(record, "web_url") };
};

const gitlabLabel = (value: unknown): ProjectForgeIssueLabel | null => {
  if (typeof value === "string") return value.trim() ? { name: value.trim(), color: null, description: null } : null;
  if (!isRecord(value)) return null;
  const name = recordString(value, "name");
  if (!name) return null;
  const color = recordString(value, "color")?.replace(/^#/, "") ?? null;
  return { name, color: color && /^[\da-f]{6}$/i.test(color) ? color.toLowerCase() : null, description: recordString(value, "description") };
};

const gitlabMilestone = (record: Record<string, unknown> | null): ProjectForgeIssueMilestone | null => {
  const id = record ? recordNumber(record, "id") : null;
  const title = record ? recordString(record, "title") : null;
  if (!record || id === null || !title) return null;
  return { number: id, title, state: recordString(record, "state") ?? "active", dueOn: recordString(record, "due_date"), url: recordString(record, "web_url") };
};

const gitlabVotes = (record: Record<string, unknown>): ProjectForgeIssueReaction[] => {
  const reactions: ProjectForgeIssueReaction[] = [];
  const upvotes = recordNumber(record, "upvotes") ?? 0;
  const downvotes = recordNumber(record, "downvotes") ?? 0;
  if (upvotes > 0) reactions.push({ content: "👍", count: upvotes });
  if (downvotes > 0) reactions.push({ content: "👎", count: downvotes });
  return reactions;
};

export const mapGitlabIssue = (record: Record<string, unknown>): ProjectForgeIssueDetails | null => {
  const number = recordNumber(record, "iid");
  const url = recordString(record, "web_url");
  if (number === null || !url) return null;
  const authorUser = gitlabUser(recordObject(record, "author"));
  const body = typeof record.description === "string" ? record.description : "";
  const tasks = recordObject(record, "task_completion_status");
  const taskTotal = tasks ? (recordNumber(tasks, "count") ?? 0) : 0;
  const issueType = recordString(record, "issue_type");
  return {
    provider: "gitlab",
    number,
    title: recordString(record, "title") ?? `Issue #${String(number)}`,
    url,
    state: recordString(record, "state") === "closed" ? "closed" : "open",
    stateReason: null,
    author: authorUser?.username ?? null,
    authorUser,
    labels: (Array.isArray(record.labels) ? record.labels : []).flatMap((label) => {
      const mapped = gitlabLabel(label);
      return mapped ? [mapped] : [];
    }),
    assignees: onlyRecords(record.assignees).flatMap((assignee) => {
      const user = gitlabUser(assignee);
      return user ? [user] : [];
    }),
    milestone: gitlabMilestone(recordObject(record, "milestone")),
    commentCount: recordNumber(record, "user_notes_count") ?? 0,
    bodyPreview: forgeIssueBodyPreview(body),
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
    closedAt: recordString(record, "closed_at"),
    locked: recordBoolean(record, "discussion_locked"),
    confidential: recordBoolean(record, "confidential"),
    weight: recordNumber(record, "weight"),
    issueType: issueType && issueType !== "issue" ? issueType.replace(/_/g, " ") : null,
    epic: recordString(recordObject(record, "epic") ?? {}, "title"),
    taskProgress: tasks && taskTotal > 0 ? { completed: recordNumber(tasks, "completed_count") ?? 0, total: taskTotal } : null,
    reactions: gitlabVotes(record),
    body,
  };
};

const mapGitlabNote = (record: Record<string, unknown>): ProjectForgeIssueTimelineItem | null => {
  const id = recordNumber(record, "id");
  if (id === null) return null;
  const body = typeof record.body === "string" ? record.body : "";
  const system = recordBoolean(record, "system");
  return {
    itemKey: `${system ? "event" : "comment"}-${String(id)}`,
    kind: system ? "event" : "comment",
    // System notes are sentences like "added ~bug label"; only their first line reads as a title.
    title: system ? (body.split(/\r?\n/, 1)[0]?.trim() ?? "") : "",
    body: system ? null : body,
    author: gitlabUser(recordObject(record, "author")),
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
    url: null,
    reactions: [],
  };
};

const mapGitlabLinkedRequest = (record: Record<string, unknown>, relation: ProjectForgeIssueLinkedRequest["relation"]): ProjectForgeIssueLinkedRequest | null => {
  const number = recordNumber(record, "iid");
  const url = recordString(record, "web_url");
  if (number === null || !url) return null;
  const state = recordString(record, "state") ?? "opened";
  return {
    number,
    title: recordString(record, "title") ?? "",
    url,
    state: state === "opened" ? "open" : state,
    draft: recordBoolean(record, "draft") || recordBoolean(record, "work_in_progress"),
    relation,
  };
};

export class GitlabIssueProvider implements ForgeIssueProvider {
  private readonly projectPath: string;

  constructor(
    context: GitlabIssueContext,
    private readonly http: PrReviewHttpClient,
  ) {
    this.projectPath = `/projects/${context.gitlab.encodedProjectPath}`;
  }

  async resolveTokenAccess(): Promise<ForgeIssueTokenAccess> {
    const [project, user] = await Promise.allSettled([this.http.json(this.projectPath), this.http.json("/user")]);
    if (project.status === "rejected") throw project.reason;
    const record = isRecord(project.value) ? project.value : {};
    const permissions = recordObject(record, "permissions") ?? {};
    const accessLevel = Math.max(
      recordNumber(recordObject(permissions, "project_access") ?? {}, "access_level") ?? 0,
      recordNumber(recordObject(permissions, "group_access") ?? {}, "access_level") ?? 0,
    );
    return {
      canWrite: true,
      canTriage: accessLevel >= GITLAB_REPORTER_ACCESS_LEVEL,
      viewer: user.status === "fulfilled" && isRecord(user.value) ? recordString(user.value, "username") : null,
      issuesEnabled: record.issues_enabled !== false && recordString(record, "issues_access_level") !== "disabled",
    };
  }

  async listIssues(query: ForgeIssueListQuery): Promise<ForgeIssueListPage> {
    const params = new URLSearchParams({
      per_page: String(FORGE_ISSUE_PAGE_SIZE),
      page: String(Math.max(1, query.page ?? 1)),
      // GitLab has no order by comment count. "popularity" (upvotes) is the closest, and the page names it "Upvotes".
      order_by: query.sort === "created" ? "created_at" : query.sort === "comments" ? "popularity" : "updated_at",
      sort: "desc",
      with_labels_details: "true",
    });
    const state = query.state ?? "open";
    if (state !== "all") params.set("state", state === "open" ? "opened" : "closed");
    if (query.labels?.length) params.set("labels", query.labels.join(","));
    if (query.assignee) {
      if (query.assignee === "none") {
        params.set("assignee_id", "None");
      } else if (query.assignee === "@me") {
        if (!query.viewer) throw new Error('"Assigned to me" needs a Git hosting access token.');
        params.set("assignee_username", query.viewer);
      } else {
        params.set("assignee_username", query.assignee);
      }
    }
    if (query.author) params.set("author_username", query.author);
    if (query.milestone) params.set("milestone", query.milestone);
    const { payload, headers } = await this.http.jsonWithHeaders(`${this.projectPath}/issues?${params.toString()}`);
    const items = onlyRecords(payload).flatMap((record) => {
      const issue = mapGitlabIssue(record);
      return issue ? [issue] : [];
    });
    return { items, hasMore: Boolean(headers.get("x-next-page")?.trim()) };
  }

  async getIssueThread(issueNumber: number, known?: ProjectForgeIssueDetails | null): Promise<ForgeIssueThread> {
    const warnings: string[] = [];
    const issuePath = `${this.projectPath}/issues/${String(issueNumber)}`;
    const [issueResult, notesResult, closedByResult, relatedResult] = await Promise.allSettled([
      known ? Promise.resolve(known) : this.fetchIssue(issueNumber),
      this.fetchNotes(issuePath, warnings),
      this.http.json(`${issuePath}/closed_by?per_page=50`),
      this.http.json(`${issuePath}/related_merge_requests?per_page=50`),
    ]);
    if (issueResult.status === "rejected") throw issueResult.reason;
    if (notesResult.status === "rejected") throw notesResult.reason;
    if (closedByResult.status === "rejected" || relatedResult.status === "rejected") {
      warnings.push("Could not load the merge requests linked to this issue.");
    }
    const linked = [
      ...(relatedResult.status === "fulfilled" ? onlyRecords(relatedResult.value).map((record) => mapGitlabLinkedRequest(record, "mentions")) : []),
      ...(closedByResult.status === "fulfilled" ? onlyRecords(closedByResult.value).map((record) => mapGitlabLinkedRequest(record, "closes")) : []),
    ].filter((request): request is ProjectForgeIssueLinkedRequest => request !== null);
    return {
      issue: issueResult.value,
      timeline: sortForgeIssueTimeline(notesResult.value),
      linkedRequests: mergeForgeIssueLinkedRequests(linked),
      subIssues: [],
      warnings,
    };
  }

  async getMetadata(): Promise<ForgeIssueRepositoryMetadata> {
    const warnings: string[] = [];
    const [labels, milestones, members] = await Promise.allSettled([
      this.http.json(`${this.projectPath}/labels?per_page=100`),
      this.http.json(`${this.projectPath}/milestones?state=active&per_page=100`),
      // Member lists are not public, even on public projects.
      this.http.authenticated ? this.http.json(`${this.projectPath}/members/all?per_page=100`) : Promise.resolve([]),
    ]);
    if (labels.status === "rejected") warnings.push("Could not load the project's labels.");
    if (milestones.status === "rejected") warnings.push("Could not load the project's milestones.");
    if (members.status === "rejected") warnings.push("Could not load assignable members.");
    return {
      labels: labels.status === "fulfilled"
        ? onlyRecords(labels.value).flatMap((label) => {
            const mapped = gitlabLabel(label);
            return mapped ? [mapped] : [];
          })
        : [],
      milestones: milestones.status === "fulfilled"
        ? onlyRecords(milestones.value).flatMap((record) => {
            const milestone = gitlabMilestone(record);
            return milestone ? [milestone] : [];
          })
        : [],
      assignees: members.status === "fulfilled"
        ? onlyRecords(members.value).flatMap((entry) => {
            const user = gitlabUser(entry);
            return user ? [user] : [];
          })
        : [],
      warnings,
    };
  }

  async createIssue(input: CreateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails> {
    const payload = await this.http.json(`${this.projectPath}/issues`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: input.title,
        description: input.body,
        ...(input.labels?.length ? { labels: input.labels.join(",") } : {}),
        ...(input.assignees?.length ? { assignee_ids: await this.resolveUserIds(input.assignees) } : {}),
        ...(typeof input.milestone === "number" ? { milestone_id: input.milestone } : {}),
        ...(input.confidential ? { confidential: true } : {}),
      }),
    });
    return this.requireIssue(payload);
  }

  async updateIssue(input: UpdateProjectForgeIssueInput): Promise<ProjectForgeIssueDetails> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.body !== undefined) body.description = input.body;
    if (input.state !== undefined) body.state_event = input.state === "closed" ? "close" : "reopen";
    if (input.labels !== undefined) body.labels = input.labels.join(",");
    // GitLab clears assignees with `[0]` and the milestone with `0`.
    if (input.assignees !== undefined) body.assignee_ids = input.assignees.length > 0 ? await this.resolveUserIds(input.assignees) : [0];
    if (input.milestone !== undefined) body.milestone_id = input.milestone ?? 0;
    const payload = await this.http.json(`${this.projectPath}/issues/${String(input.issueNumber)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return this.requireIssue(payload);
  }

  async addComment(issueNumber: number, body: string): Promise<{ url: string | null }> {
    const payload = await this.http.json(`${this.projectPath}/issues/${String(issueNumber)}/notes`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ body }),
    });
    const noteId = isRecord(payload) ? recordNumber(payload, "id") : null;
    // Notes carry no web URL; the caller appends the anchor to the issue's own URL.
    return { url: noteId === null ? null : `#note_${String(noteId)}` };
  }

  private requireIssue(payload: unknown): ProjectForgeIssueDetails {
    const issue = isRecord(payload) ? mapGitlabIssue(payload) : null;
    if (!issue) throw new Error("GitLab returned an issue BuildWarden could not read.");
    return issue;
  }

  getIssue(issueNumber: number): Promise<ProjectForgeIssueDetails> {
    return this.fetchIssue(issueNumber);
  }

  private async fetchIssue(issueNumber: number): Promise<ProjectForgeIssueDetails> {
    return this.requireIssue(await this.http.json(`${this.projectPath}/issues/${String(issueNumber)}`));
  }

  private async fetchNotes(issuePath: string, warnings: string[]): Promise<ProjectForgeIssueTimelineItem[]> {
    const notes: ProjectForgeIssueTimelineItem[] = [];
    for (let page = 1; page <= FORGE_ISSUE_TIMELINE_MAX_PAGES; page += 1) {
      const { payload, headers } = await this.http.jsonWithHeaders(
        `${issuePath}/notes?sort=asc&order_by=created_at&per_page=100&page=${String(page)}`,
      );
      for (const record of onlyRecords(payload)) {
        const note = mapGitlabNote(record);
        if (note) notes.push(note);
      }
      if (!headers.get("x-next-page")?.trim()) return notes;
    }
    warnings.push(`This issue has a long history; showing its first ${String(FORGE_ISSUE_TIMELINE_MAX_PAGES * 100)} entries.`);
    return notes;
  }

  private async resolveUserIds(usernames: string[]): Promise<number[]> {
    const ids = await Promise.all(usernames.map(async (username) => {
      const payload = await this.http.json(`/users?username=${encodeURIComponent(username)}`);
      const id = recordNumber(onlyRecords(payload)[0] ?? {}, "id");
      if (id === null) throw new Error(`GitLab has no user named "${username}".`);
      return id;
    }));
    return ids;
  }
}

export const isGitlabIssueContext = (context: ProjectPrReviewRemoteContext): context is GitlabIssueContext =>
  context.provider === "gitlab" && context.gitlab !== undefined;
