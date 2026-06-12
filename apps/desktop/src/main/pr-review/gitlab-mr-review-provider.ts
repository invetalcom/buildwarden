import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  PostProjectPrMrReviewInput,
  ProjectForgeActivityItem,
  ProjectForgeRequestDetails,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectForgeRequestsResult,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
  ProjectPrMrDiffComment,
  SubmitProjectPrMrCommentsInput,
} from "@buildwarden/shared";
import type { PrReviewHttpClient } from "./pr-review-http-client";
import type { GitlabDiffRefs, ProjectPrReviewProvider, ProjectPrReviewRemoteContext } from "./pr-review-types";
import {
  assertDraftCommentsAreSubmittable,
  isRecord,
  normalizeDraftComments,
  parseAndValidatePrMrUrl,
  recordBoolean,
  recordNumber,
  recordObject,
  recordString,
} from "./pr-review-utils";

type GitlabMrReviewContext = ProjectPrReviewRemoteContext & {
  provider: "gitlab";
  gitlab: {
    projectPath: string;
    encodedProjectPath: string;
  };
};

const gitlabRequestState = (state: ProjectForgeRequestState | undefined): "opened" | "closed" | "merged" | "all" => {
  if (state === "closed" || state === "merged" || state === "all") {
    return state;
  }
  return "opened";
};

const mapGitlabRequestSummary = (record: Record<string, unknown>): ProjectForgeRequestSummary | null => {
  const number = recordNumber(record, "iid");
  const title = recordString(record, "title");
  const url = recordString(record, "web_url");
  if (!number || !title || !url) {
    return null;
  }
  const author = recordObject(record, "author");
  return {
    provider: "gitlab",
    number,
    title,
    url,
    state: recordString(record, "state") ?? "unknown",
    draft: recordBoolean(record, "draft") || recordBoolean(record, "work_in_progress"),
    author: author ? (recordString(author, "username") ?? recordString(author, "name")) : null,
    sourceBranch: recordString(record, "source_branch") ?? "",
    targetBranch: recordString(record, "target_branch") ?? "",
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
  };
};

const gitlabUserSummary = (record: Record<string, unknown> | null): ProjectForgeActivityItem["author"] => {
  if (!record) {
    return null;
  }
  const username = recordString(record, "username") ?? recordString(record, "name");
  if (!username) {
    return null;
  }
  return {
    username,
    name: recordString(record, "name"),
    avatarUrl: recordString(record, "avatar_url"),
    webUrl: recordString(record, "web_url"),
  };
};

const gitlabLabels = (record: Record<string, unknown>): string[] => {
  const labels = record.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      return isRecord(entry) ? recordString(entry, "name") : null;
    })
    .filter((entry): entry is string => Boolean(entry));
};

const mapGitlabRequestDetails = (record: Record<string, unknown>): ProjectForgeRequestDetails | null => {
  const summary = mapGitlabRequestSummary(record);
  if (!summary) {
    return null;
  }
  const changesCount = recordString(record, "changes_count");
  return {
    ...summary,
    description: recordString(record, "description") ?? "",
    authorUser: gitlabUserSummary(recordObject(record, "author")),
    labels: gitlabLabels(record),
    additions: null,
    deletions: null,
    changedFiles: changesCount ? Number(changesCount.replace(/\+$/g, "")) || null : null,
    commentCount: recordNumber(record, "user_notes_count"),
    reviewCommentCount: null,
  };
};

const activityTimestamp = (item: ProjectForgeActivityItem): string => item.createdAt ?? item.updatedAt ?? "";

const sortActivity = (items: ProjectForgeActivityItem[]) =>
  [...items].sort((left, right) => activityTimestamp(left).localeCompare(activityTimestamp(right)));

const onlyRecords = (items: unknown[]): Record<string, unknown>[] =>
  items.filter((entry): entry is Record<string, unknown> => isRecord(entry));

const extractGitlabDiffRefs = (record: Record<string, unknown>): GitlabDiffRefs | null => {
  const baseSha = recordString(record, "base_sha") ?? recordString(record, "base_commit_sha");
  const startSha = recordString(record, "start_sha") ?? recordString(record, "start_commit_sha");
  const headSha = recordString(record, "head_sha") ?? recordString(record, "head_commit_sha");
  if (!baseSha || !startSha || !headSha) {
    return null;
  }
  return { baseSha, startSha, headSha };
};

const toGitlabDiscussionPosition = (comment: ProjectPrMrDiffComment, refs: GitlabDiffRefs): Record<string, unknown> => {
  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    old_path: comment.oldPath || comment.newPath,
    new_path: comment.newPath || comment.oldPath,
  };

  if (comment.changeType === "normal") {
    if (!comment.oldLineNumber || !comment.newLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab context line.");
    }
    position.old_line = comment.oldLineNumber;
    position.new_line = comment.newLineNumber;
    return position;
  }

  if (comment.side === "old") {
    if (!comment.oldLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab old diff line.");
    }
    position.old_line = comment.oldLineNumber;
  } else {
    if (!comment.newLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab new diff line.");
    }
    position.new_line = comment.newLineNumber;
  }

  return position;
};

export class GitlabMrReviewProvider implements ProjectPrReviewProvider {
  constructor(
    private readonly context: GitlabMrReviewContext,
    private readonly http: PrReviewHttpClient,
  ) {}

  async listRequests(input?: ListProjectForgeRequestsInput): Promise<ProjectForgeRequestsResult> {
    const requestedState = input?.state ?? "all";
    const params = new URLSearchParams({
      state: gitlabRequestState(requestedState),
      order_by: "updated_at",
      sort: "desc",
      per_page: "100",
    });
    const payloadItems: unknown[] = [];
    let page = 1;
    for (;;) {
      params.set("page", String(page));
      const result = await this.http.jsonWithHeaders(
        `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests?${params.toString()}`,
      );
      if (!Array.isArray(result.payload)) {
        throw new Error("The hosting API returned an unexpected response while listing requests.");
      }
      payloadItems.push(...result.payload);
      const nextPage = Number(result.headers.get("x-next-page") ?? 0);
      if (!Number.isInteger(nextPage) || nextPage <= 0 || nextPage === page) {
        break;
      }
      page = nextPage;
    }

    return {
      provider: this.context.provider,
      webBaseUrl: this.context.webBaseUrl,
      repoLabel: this.context.repoLabel,
      items: payloadItems
        .filter(isRecord)
        .map(mapGitlabRequestSummary)
        .filter((entry): entry is ProjectForgeRequestSummary => {
          if (!entry) {
            return false;
          }
          return requestedState !== "merged" || entry.state === "merged";
        }),
    };
  }

  async getRequestDetails(input: GetProjectForgeRequestDetailsInput): Promise<ProjectForgeRequestDetailsResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const iid = String(parsed.number);
    const projectPath = this.context.gitlab.encodedProjectPath;
    const warnings: string[] = [];

    const mergeRequest = await this.http.json(`/projects/${projectPath}/merge_requests/${iid}`);
    if (!isRecord(mergeRequest)) {
      throw new Error("The hosting API returned an unexpected response while loading the merge request.");
    }
    const request = mapGitlabRequestDetails(mergeRequest);
    if (!request) {
      throw new Error("The hosting API returned an incomplete merge request response.");
    }

    const [notes, discussions, stateEvents] = await Promise.all([
      this.getPagedArray(`/projects/${projectPath}/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load merge request notes.");
        return [];
      }),
      this.getPagedArray(`/projects/${projectPath}/merge_requests/${iid}/discussions?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load merge request discussions.");
        return [];
      }),
      this.getPagedArray(`/projects/${projectPath}/merge_requests/${iid}/resource_state_events?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load merge request state events.");
        return [];
      }),
    ]);

    const noteIds = new Set<string>();
    const activity: ProjectForgeActivityItem[] = [];

    for (const entry of onlyRecords(notes)) {
      const id = recordNumber(entry, "id");
      if (recordString(entry, "type") === "DiffNote") {
        continue;
      }
      if (id) {
        noteIds.add(String(id));
      }
      if (recordBoolean(entry, "system")) {
        activity.push({
          id: `gitlab-system-note-${String(id ?? activity.length)}`,
          provider: "gitlab",
          kind: "event",
          title: recordString(entry, "body") ?? "updated the merge request",
          body: null,
          state: "system_note",
          path: null,
          line: null,
          url: null,
          createdAt: recordString(entry, "created_at"),
          updatedAt: recordString(entry, "updated_at"),
          author: gitlabUserSummary(recordObject(entry, "author")),
        });
        continue;
      }
      activity.push({
        id: `gitlab-note-${String(id ?? activity.length)}`,
        provider: "gitlab",
        kind: "comment",
        title: "commented",
        body: recordString(entry, "body"),
        state: null,
        path: null,
        line: null,
        url: null,
        createdAt: recordString(entry, "created_at"),
        updatedAt: recordString(entry, "updated_at"),
        author: gitlabUserSummary(recordObject(entry, "author")),
      });
    }

    for (const discussion of onlyRecords(discussions)) {
      const notesValue = discussion.notes;
      const notesList = Array.isArray(notesValue) ? onlyRecords(notesValue) : [];
      for (const note of notesList) {
        const id = recordNumber(note, "id");
        if (id && noteIds.has(String(id))) {
          continue;
        }
        const position = recordObject(note, "position");
        const path = position ? (recordString(position, "new_path") ?? recordString(position, "old_path")) : null;
        const line = position ? (recordNumber(position, "new_line") ?? recordNumber(position, "old_line")) : null;
        const isDiffNote = Boolean(path || line);
        activity.push({
          id: `gitlab-discussion-note-${String(id ?? activity.length)}`,
          provider: "gitlab",
          kind: isDiffNote ? "diff-comment" : "comment",
          title: isDiffNote ? "commented on the diff" : "commented",
          body: recordString(note, "body"),
          state: null,
          path,
          line,
          url: null,
          createdAt: recordString(note, "created_at"),
          updatedAt: recordString(note, "updated_at"),
          author: gitlabUserSummary(recordObject(note, "author")),
          resolved: recordBoolean(note, "resolved") || recordBoolean(discussion, "resolved"),
        });
      }
    }

    for (const entry of onlyRecords(stateEvents)) {
      const id = recordNumber(entry, "id");
      const state = recordString(entry, "state");
      activity.push({
        id: `gitlab-state-${String(id ?? activity.length)}`,
        provider: "gitlab",
        kind: "state",
        title: state ? `${state} this merge request` : "changed state",
        body: null,
        state,
        path: null,
        line: null,
        url: null,
        createdAt: recordString(entry, "created_at"),
        updatedAt: null,
        author: gitlabUserSummary(recordObject(entry, "user")),
      });
    }

    return {
      provider: this.context.provider,
      webBaseUrl: this.context.webBaseUrl,
      repoLabel: this.context.repoLabel,
      request,
      activity: sortActivity(activity),
      warnings,
    };
  }

  async getRequestDiff(input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const iid = String(parsed.number);
    const projectPath = this.context.gitlab.encodedProjectPath;
    const diff = (await this.http.text(`/projects/${projectPath}/merge_requests/${iid}/raw_diffs`)).trim();
    return {
      diff,
      provider: "gitlab",
      number: parsed.number,
      baseRef: "GitLab API",
    };
  }

  async postReview(input: PostProjectPrMrReviewInput): Promise<ProjectForgeReviewActionResult> {
    const prUrl = input.prUrl.trim();
    const body = input.body.trim();
    const parsed = parseAndValidatePrMrUrl(prUrl, this.context);
    if (input.event === "comment" && !body) {
      throw new Error("Review comments need a message body.");
    }

    if (input.event === "approve") {
      await this.http.json(`/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/approve`, {
        method: "POST",
      });
      if (body) {
        try {
          await this.postNote(parsed.number, body);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Could not post the AI review note.";
          return {
            message: `Approved the merge request, but could not post the AI review note. ${msg}`,
            url: prUrl,
          };
        }
      }
      return {
        message: body ? "Posted the AI review and approved the merge request." : "Approved the merge request.",
        url: prUrl,
      };
    }

    if (body) {
      await this.postNote(parsed.number, body);
    }
    return {
      message: "Posted the AI review to the merge request.",
      url: prUrl,
    };
  }

  async submitComments(input: SubmitProjectPrMrCommentsInput): Promise<ProjectForgeReviewActionResult> {
    const prUrl = input.prUrl.trim();
    const parsed = parseAndValidatePrMrUrl(prUrl, this.context);
    const comments = normalizeDraftComments(input.comments);
    assertDraftCommentsAreSubmittable(comments);

    const refs = await this.resolveDiffRefs(parsed.number);
    for (const comment of comments) {
      const body = new URLSearchParams({ body: comment.body });
      const position = toGitlabDiscussionPosition(comment, refs);
      for (const [key, value] of Object.entries(position)) {
        body.set(`position[${key}]`, String(value));
      }
      await this.http.json(`/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/discussions`, {
        method: "POST",
        body: body.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }

    return {
      message: `Submitted ${String(comments.length)} merge request diff comment${comments.length === 1 ? "" : "s"}.`,
      url: prUrl,
    };
  }

  private async postNote(mergeRequestIid: number, body: string): Promise<void> {
    await this.http.json(`/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(mergeRequestIid)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
  }

  private async resolveDiffRefs(mergeRequestIid: number): Promise<GitlabDiffRefs> {
    const mergeRequest = await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(mergeRequestIid)}`,
    );
    const diffRefs = isRecord(mergeRequest) ? recordObject(mergeRequest, "diff_refs") : null;
    const fromMergeRequest = diffRefs ? extractGitlabDiffRefs(diffRefs) : null;
    if (fromMergeRequest) {
      return fromMergeRequest;
    }

    const versions = await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(mergeRequestIid)}/versions?per_page=1`,
    );
    const latest = Array.isArray(versions) && isRecord(versions[0]) ? versions[0] : null;
    const fromVersion = latest ? extractGitlabDiffRefs(latest) : null;
    if (fromVersion) {
      return fromVersion;
    }

    throw new Error("Could not resolve GitLab diff refs for line comments.");
  }

  private async getPagedArray(path: string): Promise<unknown[]> {
    const payloadItems: unknown[] = [];
    let currentPath = path;
    let page = 1;
    for (;;) {
      const result = await this.http.jsonWithHeaders(currentPath);
      if (!Array.isArray(result.payload)) {
        throw new Error("The hosting API returned an unexpected paginated response.");
      }
      payloadItems.push(...result.payload);
      const nextPage = Number(result.headers.get("x-next-page") ?? 0);
      if (!Number.isInteger(nextPage) || nextPage <= 0 || nextPage === page) {
        break;
      }
      const separator = path.includes("?") ? "&" : "?";
      currentPath = `${path}${separator}page=${String(nextPage)}`;
      page = nextPage;
    }
    return payloadItems;
  }
}

export const isGitlabMrReviewContext = (context: ProjectPrReviewRemoteContext): context is GitlabMrReviewContext =>
  context.provider === "gitlab" && Boolean(context.gitlab);
