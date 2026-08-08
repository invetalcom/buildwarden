import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  PostProjectPrMrReviewInput,
  ProjectForgeActivityItem,
  ProjectForgeChangedFileStatus,
  ProjectForgeChangedFileSummary,
  ProjectForgeCommitSummary,
  ProjectForgeRequestDetails,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectForgeRequestsResult,
  ProjectForgeReviewThread,
  ProjectForgeReviewThreadComment,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
  ProjectPrMrDiffComment,
  RunForgeCheck,
  ReplyProjectPrMrReviewThreadInput,
  ResolveProjectPrMrReviewThreadInput,
  SubmitProjectPrMrCommentsInput,
} from "@buildwarden/shared";
import type { PrReviewHttpClient } from "./pr-review-http-client";
import type {
  CreateForgeRequestInput,
  ForgeRequestApprovalStatus,
  ForgeRequestStatusInput,
  ForgeRequestStatusResult,
  GitlabDiffRefs,
  MergeForgeRequestInput,
  ProjectPrReviewProvider,
  ProjectPrReviewRemoteContext,
  UpdateForgeRequestInput,
} from "./pr-review-types";
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

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0]?.trim() || value.trim();

const mapGitlabCommitSummary = (record: Record<string, unknown>): ProjectForgeCommitSummary | null => {
  const sha = recordString(record, "id");
  const message = recordString(record, "message") ?? recordString(record, "title") ?? "";
  if (!sha) {
    return null;
  }
  return {
    sha,
    shortSha: recordString(record, "short_id") ?? sha.slice(0, 8),
    title: recordString(record, "title") ?? firstLine(message),
    message,
    authorName: recordString(record, "author_name"),
    authorEmail: recordString(record, "author_email"),
    authorUser: null,
    committerName: recordString(record, "committer_name"),
    committedAt: recordString(record, "committed_date") ?? recordString(record, "created_at"),
    authoredAt: recordString(record, "authored_date"),
    url: recordString(record, "web_url"),
    commentCount: null,
  };
};

const gitlabChangedFileStatus = (record: Record<string, unknown>): ProjectForgeChangedFileStatus => {
  if (recordBoolean(record, "new_file")) return "added";
  if (recordBoolean(record, "deleted_file")) return "removed";
  if (recordBoolean(record, "renamed_file")) return "renamed";
  return "modified";
};

const mapGitlabChangedFileSummary = (record: Record<string, unknown>): ProjectForgeChangedFileSummary | null => {
  const path = recordString(record, "new_path") ?? recordString(record, "old_path");
  if (!path) {
    return null;
  }
  return {
    path,
    oldPath: recordString(record, "old_path"),
    status: gitlabChangedFileStatus(record),
    additions: null,
    deletions: null,
    patchAvailable: Boolean(recordString(record, "diff")) && !recordBoolean(record, "too_large"),
    commentCount: 0,
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

const gitlabThreadComment = (note: Record<string, unknown>): ProjectForgeReviewThreadComment => {
  const id = recordNumber(note, "id") ?? crypto.randomUUID();
  return {
    id: `gitlab-discussion-note-${String(id)}`,
    providerCommentId: String(id),
    body: recordString(note, "body") ?? "",
    author: gitlabUserSummary(recordObject(note, "author")),
    createdAt: recordString(note, "created_at"),
    updatedAt: recordString(note, "updated_at"),
    url: null,
  };
};

const buildGitlabReviewThread = (
  discussion: Record<string, unknown>,
  notesList: Record<string, unknown>[],
  fallbackIndex: number,
): ProjectForgeReviewThread | null => {
  const positionedNote = notesList.find((note) => recordObject(note, "position"));
  const position = positionedNote ? recordObject(positionedNote, "position") : null;
  if (!position) {
    return null;
  }
  const path = recordString(position, "new_path") ?? recordString(position, "old_path");
  const oldLine = recordNumber(position, "old_line");
  const newLine = recordNumber(position, "new_line");
  if (!path || (!oldLine && !newLine)) {
    return null;
  }
  return {
    id: `gitlab-thread-${recordString(discussion, "id") ?? String(fallbackIndex)}`,
    providerThreadId: recordString(discussion, "id") ?? String(fallbackIndex),
    replyToCommentId: null,
    provider: "gitlab",
    path,
    oldPath: recordString(position, "old_path"),
    side: newLine ? "new" : "old",
    oldLineNumber: oldLine,
    newLineNumber: newLine,
    commitSha: recordString(position, "head_sha"),
    diffHunk: null,
    resolved: recordBoolean(discussion, "resolved") || notesList.some((note) => recordBoolean(note, "resolved")),
    comments: notesList.map(gitlabThreadComment),
  };
};

const quoteDiffPath = (path: string) => path.replace(/\\/g, "/");

const gitlabDiffRowToUnifiedDiff = (row: Record<string, unknown>): string | null => {
  const oldPath = recordString(row, "old_path") ?? recordString(row, "new_path") ?? "unknown";
  const newPath = recordString(row, "new_path") ?? oldPath;
  const diff = recordString(row, "diff") ?? "";
  if (!diff.trim()) return null;
  if (diff.startsWith("diff --git")) return diff.trimEnd();
  const renamed = recordBoolean(row, "renamed_file") && oldPath !== newPath;
  const oldDisplay = recordBoolean(row, "new_file") ? "/dev/null" : `a/${quoteDiffPath(oldPath)}`;
  const newDisplay = recordBoolean(row, "deleted_file") ? "/dev/null" : `b/${quoteDiffPath(newPath)}`;
  const header = [
    `diff --git a/${quoteDiffPath(oldPath)} b/${quoteDiffPath(newPath)}`,
    recordBoolean(row, "new_file") ? "new file mode 100644" : null,
    recordBoolean(row, "deleted_file") ? "deleted file mode 100644" : null,
    renamed ? `rename from ${quoteDiffPath(oldPath)}` : null,
    renamed ? `rename to ${quoteDiffPath(newPath)}` : null,
    `--- ${oldDisplay}`,
    `+++ ${newDisplay}`,
  ].filter((line): line is string => Boolean(line));
  return `${header.join("\n")}\n${diff.trimEnd()}`;
};

const gitlabDiffRowsToUnifiedDiff = (rows: Record<string, unknown>[]): string => {
  return rows.map(gitlabDiffRowToUnifiedDiff).filter((section): section is string => Boolean(section)).join("\n");
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

const gitlabCheckStatus = (status: string | null): RunForgeCheck["status"] => {
  switch (status?.toLowerCase()) {
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
    case "pending": return "queued";
    case "canceling":
    case "running": return "running";
    case "success": return "success";
    case "skipped":
    case "manual": return "skipped";
    case "canceled": return "cancelled";
    default: return "failure";
  }
};

const gitlabDurationMs = (record: Record<string, unknown>): number | null => {
  const seconds = recordNumber(record, "duration");
  if (seconds != null && seconds >= 0) return Math.round(seconds * 1000);
  const startedAt = recordString(record, "started_at");
  const finishedAt = recordString(record, "finished_at");
  if (!startedAt || !finishedAt) return null;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
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

    const [notes, discussions, stateEvents, commits, changesPayload] = await Promise.all([
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
      this.getPagedArray(`/projects/${projectPath}/merge_requests/${iid}/commits?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load merge request commits.");
        return [];
      }),
      this.http.json(`/projects/${projectPath}/merge_requests/${iid}/changes`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load changed files.");
        return null;
      }),
    ]);

    const noteIds = new Set<string>();
    const activity: ProjectForgeActivityItem[] = [];
    const reviewThreads: ProjectForgeReviewThread[] = [];

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
      const reviewThread = buildGitlabReviewThread(discussion, notesList, activity.length);
      if (reviewThread) {
        reviewThreads.push(reviewThread);
      }
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
          commitSha: position ? recordString(position, "head_sha") : null,
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

    const changes = isRecord(changesPayload) && Array.isArray(changesPayload.changes) ? onlyRecords(changesPayload.changes) : [];
    const commitSummaries = onlyRecords(commits).map(mapGitlabCommitSummary).filter((entry): entry is ProjectForgeCommitSummary => Boolean(entry));
    const diffCommentCountsByPath = new Map<string, number>();
    for (const thread of reviewThreads) {
      diffCommentCountsByPath.set(thread.path, (diffCommentCountsByPath.get(thread.path) ?? 0) + thread.comments.length);
    }

    return {
      provider: this.context.provider,
      webBaseUrl: this.context.webBaseUrl,
      repoLabel: this.context.repoLabel,
      request,
      activity: sortActivity(activity),
      commits: commitSummaries,
      files: changes
        .map(mapGitlabChangedFileSummary)
        .filter((entry): entry is ProjectForgeChangedFileSummary => Boolean(entry))
        .map((file) => ({ ...file, commentCount: diffCommentCountsByPath.get(file.path) ?? 0 })),
      reviewThreads,
      warnings,
    };
  }

  async getRequestDiff(input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const iid = String(parsed.number);
    const projectPath = this.context.gitlab.encodedProjectPath;
    const commitSha = input.commitSha?.trim();
    if (commitSha) {
      const rows = await this.getPagedArray(
        `/projects/${projectPath}/repository/commits/${encodeURIComponent(commitSha)}/diff?unidiff=true&per_page=100`,
      );
      return {
        diff: gitlabDiffRowsToUnifiedDiff(onlyRecords(rows)),
        provider: "gitlab",
        number: parsed.number,
        baseRef: `GitLab commit ${commitSha.slice(0, 12)}`,
      };
    }
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
    if (input.mode === "single" && comments.length !== 1) {
      throw new Error("Single diff comments must contain exactly one comment.");
    }
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
    if (input.mode !== "single" && input.body?.trim()) {
      await this.postNote(parsed.number, input.body.trim());
    }

    let message = `Submitted ${String(comments.length)} merge request diff comment${comments.length === 1 ? "" : "s"}.`;
    if (input.mode === "single") {
      message = "Submitted one merge request diff comment.";
    }
    return { message, url: prUrl };
  }

  async replyToThread(input: ReplyProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult> {
    const body = input.body.trim();
    if (!body) {
      throw new Error("Replies need a message body.");
    }
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const discussionId = input.threadId.trim();
    if (!discussionId) {
      throw new Error("This GitLab discussion cannot be replied to because its discussion ID is missing.");
    }
    const payload = new URLSearchParams({ body });
    await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/discussions/${encodeURIComponent(discussionId)}/notes`,
      {
        method: "POST",
        body: payload.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
    return {
      message: "Replied to the merge request discussion.",
      url: input.prUrl.trim(),
    };
  }

  async resolveThread(input: ResolveProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const discussionId = input.threadId.trim();
    if (!discussionId) {
      throw new Error("This GitLab discussion cannot be updated because its discussion ID is missing.");
    }
    const payload = new URLSearchParams({ resolved: String(input.resolved) });
    await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/discussions/${encodeURIComponent(discussionId)}`,
      {
        method: "PUT",
        body: payload.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
    return {
      message: input.resolved ? "Resolved the merge request discussion." : "Reopened the merge request discussion.",
      url: input.prUrl.trim(),
    };
  }

  async createRequest(input: CreateForgeRequestInput): Promise<ProjectForgeRequestSummary> {
    const payload = await this.http.json(`/projects/${this.context.gitlab.encodedProjectPath}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!isRecord(payload)) {
      throw new Error("The hosting API returned an unexpected response while creating the merge request.");
    }
    const summary = mapGitlabRequestSummary(payload);
    if (!summary) {
      throw new Error("The hosting API returned an incomplete response while creating the merge request.");
    }
    return summary;
  }

  async mergeRequest(input: MergeForgeRequestInput): Promise<ProjectForgeReviewActionResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const body: Record<string, unknown> = {};
    if (input.expectedHeadSha) body.sha = input.expectedHeadSha;
    if (input.method === "squash") body.squash = true;
    if (input.method === "rebase") throw new Error("GitLab does not expose rebase as a merge method for this action.");
    if (input.mergeCommitTitle?.trim()) {
      body.merge_commit_message = input.mergeCommitTitle.trim();
    }
    await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/merge`,
      {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
    return {
      message: "Merged the merge request.",
      url: input.prUrl.trim(),
    };
  }

  async getRequestApprovalStatus(input: GetProjectForgeRequestDetailsInput): Promise<ForgeRequestApprovalStatus> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const payload = await this.http.json(
      `/projects/${this.context.gitlab.encodedProjectPath}/merge_requests/${String(parsed.number)}/approvals`,
    );
    if (!isRecord(payload)) {
      return { approved: false, approvedBy: [] };
    }
    const approvedByRaw = Array.isArray(payload.approved_by) ? payload.approved_by : [];
    const approvedBy = approvedByRaw
      .map((entry) => {
        if (!isRecord(entry)) {
          return null;
        }
        const user = recordObject(entry, "user");
        return user ? (recordString(user, "username") ?? recordString(user, "name")) : null;
      })
      .filter((entry): entry is string => Boolean(entry));
    const approvedFlag = recordBoolean(payload, "approved");
    return {
      approved: approvedFlag || approvedBy.length > 0,
      approvedBy,
    };
  }

  async getRequestStatus(input: ForgeRequestStatusInput): Promise<ForgeRequestStatusResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const projectPath = this.context.gitlab.encodedProjectPath;
    const iid = String(parsed.number);
    const conditionalHeaders: Record<string, string> = {};
    if (input.etag) conditionalHeaders["If-None-Match"] = input.etag;
    if (input.lastModified) conditionalHeaders["If-Modified-Since"] = input.lastModified;
    const requestResult = await this.http.jsonWithHeaders(
      `/projects/${projectPath}/merge_requests/${iid}`,
      Object.keys(conditionalHeaders).length > 0 ? { headers: conditionalHeaders } : {},
    );
    const requestPayload = isRecord(requestResult.payload) ? requestResult.payload : null;
    if (!requestPayload && !(requestResult.notModified && input.previousStatus)) {
      throw new Error("GitLab returned an unexpected merge request status response.");
    }
    const previousStatus = input.previousStatus ?? null;
    const diffRefs = requestPayload ? recordObject(requestPayload, "diff_refs") : null;
    const headSha = requestPayload
      ? recordString(requestPayload, "sha") ?? (diffRefs ? recordString(diffRefs, "head_sha") : null)
      : previousStatus!.headSha;
    const pipelines = await this.http.json(`/projects/${projectPath}/merge_requests/${iid}/pipelines?per_page=1`);
    const pipeline = Array.isArray(pipelines) && isRecord(pipelines[0])
      ? pipelines[0]
      : requestPayload ? recordObject(requestPayload, "head_pipeline") : null;
    let jobRows: Record<string, unknown>[] = [];
    const pipelineId = pipeline ? recordNumber(pipeline, "id") : null;
    if (pipelineId) {
      const jobs = await this.http.json(`/projects/${projectPath}/pipelines/${String(pipelineId)}/jobs?per_page=100&include_retried=false`);
      if (Array.isArray(jobs)) jobRows = onlyRecords(jobs);
    }
    const checks: RunForgeCheck[] = jobRows.map((job, index) => ({
      id: String(recordNumber(job, "id") ?? `gitlab-job-${String(index)}`),
      name: recordString(job, "name") ?? "Pipeline job",
      status: gitlabCheckStatus(recordString(job, "status")),
      url: recordString(job, "web_url"),
      description: recordString(job, "stage"),
      startedAt: recordString(job, "started_at"),
      completedAt: recordString(job, "finished_at"),
      durationMs: gitlabDurationMs(job),
    }));
    if (checks.length === 0 && pipeline) {
      checks.push({
        id: String(recordNumber(pipeline, "id") ?? "gitlab-pipeline"),
        name: "Pipeline",
        status: gitlabCheckStatus(recordString(pipeline, "status")),
        url: recordString(pipeline, "web_url"),
        description: null,
        startedAt: recordString(pipeline, "created_at"),
        completedAt: recordString(pipeline, "updated_at"),
        durationMs: null,
      });
    }

    const rawState = requestPayload ? recordString(requestPayload, "state")?.toLowerCase() : null;
    const state = requestPayload
      ? rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open"
      : previousStatus!.state;
    const detailedMergeStatus = requestPayload
      ? (recordString(requestPayload, "detailed_merge_status") ?? recordString(requestPayload, "merge_status") ?? "").toLowerCase()
      : "";
    const mergeability = requestPayload
      ? recordBoolean(requestPayload, "has_conflicts") || detailedMergeStatus.includes("conflict")
        ? "conflicting"
        : ["checking", "unchecked", "preparing", "approvals_syncing"].includes(detailedMergeStatus)
          ? "checking"
          : ["mergeable", "can_be_merged"].includes(detailedMergeStatus) ? "mergeable" : "unknown"
      : previousStatus!.mergeability;
    const approval = await this.getRequestApprovalStatus(input);
    const approvalsRequired = requestPayload ? recordNumber(requestPayload, "approvals_before_merge") ?? 0 : 0;
    const unresolvedThreadCount = requestPayload
      ? recordBoolean(requestPayload, "blocking_discussions_resolved") ? 0 : 1
      : previousStatus!.unresolvedThreadCount;
    const reviewDecision = approval.approved
      ? "approved"
      : requestPayload ? approvalsRequired > 0 ? "review-required" : "none" : previousStatus!.reviewDecision;
    const draft = requestPayload
      ? recordBoolean(requestPayload, "draft") || recordBoolean(requestPayload, "work_in_progress")
      : previousStatus!.draft;
    return {
      state,
      draft,
      mergeability,
      reviewDecision,
      headSha,
      checks,
      unresolvedThreadCount,
      supportedActions: state === "open"
        ? ["refresh", "open", draft ? "mark-ready" : "mark-draft", "merge", "close"]
        : state === "closed" ? ["refresh", "open", "reopen"] : ["refresh", "open"],
      supportedMergeMethods: ["merge", "squash"],
      etag: requestResult.headers.get("etag") ?? input.etag ?? null,
      lastModified: requestResult.headers.get("last-modified") ?? input.lastModified ?? null,
    };
  }

  async updateRequest(input: UpdateForgeRequestInput): Promise<ProjectForgeReviewActionResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const projectPath = this.context.gitlab.encodedProjectPath;
    const iid = String(parsed.number);
    if (input.expectedHeadSha) {
      const request = await this.http.json(`/projects/${projectPath}/merge_requests/${iid}`);
      const actual = isRecord(request) ? recordString(request, "sha") : null;
      if (!actual || actual.toLowerCase() !== input.expectedHeadSha.trim().toLowerCase()) {
        throw new Error("The merge request head changed. Refresh it before performing this action.");
      }
    }
    const body: Record<string, unknown> = input.action === "mark-draft"
      ? { draft: true }
      : input.action === "mark-ready"
        ? { draft: false }
        : { state_event: input.action === "close" ? "close" : "reopen" };
    await this.http.json(`/projects/${projectPath}/merge_requests/${iid}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return { message: `Merge request updated: ${input.action.replace(/-/g, " ")}.`, url: input.prUrl.trim() };
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
