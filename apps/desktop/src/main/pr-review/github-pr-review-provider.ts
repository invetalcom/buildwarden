import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  ProjectForgeActivityItem,
  ProjectForgeChangedFileStatus,
  ProjectForgeChangedFileSummary,
  ProjectForgeCommitSummary,
  ProjectForgeRequestDetails,
  ProjectForgeRequestDetailsResult,
  ProjectForgeReviewThread,
  ProjectForgeReviewThreadComment,
  PostProjectPrMrReviewInput,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectForgeRequestsResult,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
  ProjectPrMrDiffComment,
  ReplyProjectPrMrReviewThreadInput,
  ResolveProjectPrMrReviewThreadInput,
  SubmitProjectPrMrCommentsInput,
} from "@buildwarden/shared";
import type { PrReviewHttpClient } from "./pr-review-http-client";
import type {
  CreateForgeRequestInput,
  ForgeRequestApprovalStatus,
  MergeForgeRequestInput,
  ProjectPrReviewProvider,
  ProjectPrReviewRemoteContext,
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

type GithubPrReviewContext = ProjectPrReviewRemoteContext & {
  provider: "github";
  github: {
    owner: string;
    repo: string;
  };
};

const githubRequestState = (state: ProjectForgeRequestState | undefined): "open" | "closed" | "all" => {
  if (state === "closed" || state === "merged") {
    return "closed";
  }
  if (state === "all") {
    return "all";
  }
  return "open";
};

const githubNextPageFromLinkHeader = (linkHeader: string | null): number | null => {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    if (!/\brel="next"/.test(part)) {
      continue;
    }
    const match = part.match(/<([^>]+)>/);
    if (!match?.[1]) {
      continue;
    }
    try {
      const page = Number(new URL(match[1]).searchParams.get("page"));
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
};

const mapGithubRequestSummary = (record: Record<string, unknown>): ProjectForgeRequestSummary | null => {
  const number = recordNumber(record, "number");
  const title = recordString(record, "title");
  const url = recordString(record, "html_url");
  if (!number || !title || !url) {
    return null;
  }
  const user = recordObject(record, "user");
  const head = recordObject(record, "head");
  const base = recordObject(record, "base");
  const mergedAt = recordString(record, "merged_at");
  return {
    provider: "github",
    number,
    title,
    url,
    state: mergedAt ? "merged" : (recordString(record, "state") ?? "unknown"),
    draft: recordBoolean(record, "draft"),
    author: user ? recordString(user, "login") : null,
    sourceBranch: head ? (recordString(head, "ref") ?? "") : "",
    targetBranch: base ? (recordString(base, "ref") ?? "") : "",
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
  };
};

const githubUserSummary = (record: Record<string, unknown> | null): ProjectForgeActivityItem["author"] => {
  if (!record) {
    return null;
  }
  const username = recordString(record, "login") ?? recordString(record, "name");
  if (!username) {
    return null;
  }
  return {
    username,
    name: recordString(record, "name"),
    avatarUrl: recordString(record, "avatar_url"),
    webUrl: recordString(record, "html_url"),
  };
};

const githubLabels = (record: Record<string, unknown>): string[] => {
  const labels = record.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((entry) => (isRecord(entry) ? recordString(entry, "name") : typeof entry === "string" ? entry.trim() : null))
    .filter((entry): entry is string => Boolean(entry));
};

const mapGithubRequestDetails = (record: Record<string, unknown>): ProjectForgeRequestDetails | null => {
  const summary = mapGithubRequestSummary(record);
  if (!summary) {
    return null;
  }
  return {
    ...summary,
    description: recordString(record, "body") ?? "",
    authorUser: githubUserSummary(recordObject(record, "user")),
    labels: githubLabels(record),
    additions: recordNumber(record, "additions"),
    deletions: recordNumber(record, "deletions"),
    changedFiles: recordNumber(record, "changed_files"),
    commentCount: recordNumber(record, "comments"),
    reviewCommentCount: recordNumber(record, "review_comments"),
  };
};

const firstLine = (value: string) => value.split(/\r?\n/, 1)[0]?.trim() || value.trim();

const mapGithubCommitSummary = (record: Record<string, unknown>): ProjectForgeCommitSummary | null => {
  const sha = recordString(record, "sha");
  const commit = recordObject(record, "commit");
  const message = commit ? (recordString(commit, "message") ?? "") : "";
  if (!sha || !commit) {
    return null;
  }
  const author = recordObject(commit, "author");
  const committer = recordObject(commit, "committer");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    title: firstLine(message),
    message,
    authorName: author ? recordString(author, "name") : null,
    authorEmail: author ? recordString(author, "email") : null,
    authorUser: githubUserSummary(recordObject(record, "author")),
    committerName: committer ? recordString(committer, "name") : null,
    committedAt: committer ? recordString(committer, "date") : null,
    authoredAt: author ? recordString(author, "date") : null,
    url: recordString(record, "html_url"),
    commentCount: recordNumber(commit, "comment_count"),
  };
};

const githubGraphqlUserSummary = (record: Record<string, unknown> | null): ProjectForgeActivityItem["author"] => {
  if (!record) {
    return null;
  }
  const username = recordString(record, "login");
  if (!username) {
    return null;
  }
  return {
    username,
    name: null,
    avatarUrl: recordString(record, "avatarUrl"),
    webUrl: recordString(record, "url"),
  };
};

const githubChangedFileStatus = (value: string | null): ProjectForgeChangedFileStatus => {
  if (value === "added" || value === "modified" || value === "removed" || value === "renamed" || value === "changed") {
    return value;
  }
  if (value === "copied" || value === "unchanged") {
    return value;
  }
  return "unknown";
};

const mapGithubChangedFileSummary = (record: Record<string, unknown>): ProjectForgeChangedFileSummary | null => {
  const path = recordString(record, "filename");
  if (!path) {
    return null;
  }
  return {
    path,
    oldPath: recordString(record, "previous_filename"),
    status: githubChangedFileStatus(recordString(record, "status")),
    additions: recordNumber(record, "additions"),
    deletions: recordNumber(record, "deletions"),
    patchAvailable: Boolean(recordString(record, "patch")),
    commentCount: 0,
  };
};

const activityTimestamp = (item: ProjectForgeActivityItem): string => item.createdAt ?? item.updatedAt ?? "";

const sortActivity = (items: ProjectForgeActivityItem[]) =>
  [...items].sort((left, right) => activityTimestamp(left).localeCompare(activityTimestamp(right)));

const onlyRecords = (items: unknown[]): Record<string, unknown>[] =>
  items.filter((entry): entry is Record<string, unknown> => isRecord(entry));

const githubActivityTitle = (event: string): string => {
  if (event === "commented") return "commented";
  if (event === "committed") return "committed";
  if (event === "reviewed") return "reviewed";
  if (event === "closed") return "closed this pull request";
  if (event === "reopened") return "reopened this pull request";
  if (event === "merged") return "merged this pull request";
  if (event === "assigned") return "assigned this pull request";
  if (event === "unassigned") return "unassigned this pull request";
  if (event === "review_requested") return "requested review";
  if (event === "review_request_removed") return "removed review request";
  if (event === "labeled") return "added a label";
  if (event === "unlabeled") return "removed a label";
  if (event === "renamed") return "renamed this pull request";
  if (event === "ready_for_review") return "marked ready for review";
  if (event === "converted_to_draft") return "converted to draft";
  return event.replace(/_/g, " ");
};

const githubTimelineAuthor = (record: Record<string, unknown>): ProjectForgeActivityItem["author"] => {
  const actor =
    recordObject(record, "actor") ??
    recordObject(record, "user") ??
    recordObject(record, "author") ??
    recordObject(record, "committer") ??
    recordObject(record, "requested_reviewer");
  if (actor) {
    return githubUserSummary(actor);
  }
  const commit = recordObject(record, "commit");
  return commit ? githubUserSummary(recordObject(commit, "author") ?? recordObject(commit, "committer")) : null;
};

const githubTimelineEventBody = (record: Record<string, unknown>): string | null => {
  const event = recordString(record, "event");
  if (event === "committed") {
    const commitId = recordString(record, "commit_id");
    const commit = recordObject(record, "commit");
    const message = commit ? recordString(commit, "message") : null;
    return [commitId ? `Commit: ${commitId.slice(0, 12)}` : null, message].filter(Boolean).join("\n\n") || null;
  }
  const rename = recordObject(record, "rename");
  if (rename) {
    const from = recordString(rename, "from");
    const to = recordString(rename, "to");
    if (from || to) {
      return [from ? `From: ${from}` : null, to ? `To: ${to}` : null].filter(Boolean).join("\n");
    }
  }
  return null;
};

const toGithubReviewThreadComment = (entry: Record<string, unknown>): ProjectForgeReviewThreadComment => {
  const id = recordNumber(entry, "id") ?? recordString(entry, "node_id") ?? crypto.randomUUID();
  return {
    id: `github-diff-comment-${String(id)}`,
    providerCommentId: String(id),
    body: recordString(entry, "body") ?? "",
    author: githubUserSummary(recordObject(entry, "user")),
    createdAt: recordString(entry, "created_at"),
    updatedAt: recordString(entry, "updated_at"),
    url: recordString(entry, "html_url"),
  };
};

const githubGraphqlReviewThreadComment = (entry: Record<string, unknown>): ProjectForgeReviewThreadComment => {
  const providerCommentId = recordNumber(entry, "databaseId") ?? recordString(entry, "fullDatabaseId");
  const id = providerCommentId != null ? String(providerCommentId) : (recordString(entry, "id") ?? crypto.randomUUID());
  return {
    id: `github-diff-comment-${String(id)}`,
    providerCommentId: providerCommentId != null ? String(providerCommentId) : null,
    body: recordString(entry, "body") ?? "",
    author: githubGraphqlUserSummary(recordObject(entry, "author")),
    createdAt: recordString(entry, "createdAt"),
    updatedAt: recordString(entry, "updatedAt"),
    url: recordString(entry, "url"),
  };
};

const githubGraphqlReviewThreadFromNode = (node: Record<string, unknown>): ProjectForgeReviewThread | null => {
  const providerThreadId = recordString(node, "id");
  const path = recordString(node, "path");
  const line = recordNumber(node, "line") ?? recordNumber(node, "originalLine");
  const commentsConnection = recordObject(node, "comments");
  const commentsValue = commentsConnection?.nodes;
  const commentRecords = Array.isArray(commentsValue) ? onlyRecords(commentsValue) : [];
  const firstComment = commentRecords[0] ?? null;
  const firstCommentPath = firstComment ? recordString(firstComment, "path") : null;
  const firstLine = firstComment ? (recordNumber(firstComment, "line") ?? recordNumber(firstComment, "originalLine")) : null;
  const resolvedPath = path ?? firstCommentPath;
  const resolvedLine = line ?? firstLine;
  if (!providerThreadId || !resolvedPath || !resolvedLine) {
    return null;
  }
  const rawSide = recordString(node, "diffSide");
  const side = rawSide === "LEFT" ? "old" : "new";
  const comments = commentRecords.map(githubGraphqlReviewThreadComment);
  return {
    id: providerThreadId,
    providerThreadId,
    replyToCommentId: comments[0]?.providerCommentId ?? null,
    provider: "github",
    path: resolvedPath,
    oldPath: resolvedPath,
    side,
    oldLineNumber: side === "old" ? resolvedLine : null,
    newLineNumber: side === "new" ? resolvedLine : null,
    commitSha: firstComment ? (recordString(recordObject(firstComment, "commit") ?? {}, "oid") ?? recordString(recordObject(firstComment, "originalCommit") ?? {}, "oid")) : null,
    diffHunk: firstComment ? recordString(firstComment, "diffHunk") : null,
    resolved: recordBoolean(node, "isResolved"),
    comments: comments.length > 0 ? comments : [],
  };
};

const githubReviewThreadFromComment = (entry: Record<string, unknown>, fallbackIndex: number): ProjectForgeReviewThread | null => {
  const id = recordNumber(entry, "id") ?? recordString(entry, "node_id") ?? fallbackIndex;
  const path = recordString(entry, "path");
  const line = recordNumber(entry, "line") ?? recordNumber(entry, "original_line");
  if (!path || !line) {
    return null;
  }
  const rawSide = recordString(entry, "side");
  const side = rawSide === "LEFT" ? "old" : "new";
  return {
    id: `github-thread-${String(id)}`,
    providerThreadId: `github-thread-${String(id)}`,
    replyToCommentId: String(id),
    provider: "github",
    path,
    oldPath: recordString(entry, "original_path"),
    side,
    oldLineNumber: side === "old" ? line : null,
    newLineNumber: side === "new" ? line : null,
    commitSha: recordString(entry, "commit_id") ?? recordString(entry, "original_commit_id"),
    diffHunk: recordString(entry, "diff_hunk"),
    resolved: null,
    comments: [toGithubReviewThreadComment(entry)],
  };
};

const toGithubReviewComment = (comment: ProjectPrMrDiffComment): Record<string, unknown> => {
  const line = comment.side === "old" ? comment.oldLineNumber : comment.newLineNumber;
  if (!line) {
    throw new Error("A draft comment could not be mapped to a GitHub diff line.");
  }
  return {
    path: comment.side === "old" ? (comment.oldPath || comment.newPath) : (comment.newPath || comment.oldPath),
    line,
    side: comment.side === "old" ? "LEFT" : "RIGHT",
    body: comment.body,
  };
};

const toGithubSingleReviewComment = (comment: ProjectPrMrDiffComment, commitId: string): Record<string, unknown> => {
  const line = comment.side === "old" ? comment.oldLineNumber : comment.newLineNumber;
  if (!line) {
    throw new Error("A draft comment could not be mapped to a GitHub diff line.");
  }
  return {
    body: comment.body,
    commit_id: commitId,
    path: comment.side === "old" ? (comment.oldPath || comment.newPath) : (comment.newPath || comment.oldPath),
    line,
    side: comment.side === "old" ? "LEFT" : "RIGHT",
  };
};

export class GithubPrReviewProvider implements ProjectPrReviewProvider {
  constructor(
    private readonly context: GithubPrReviewContext,
    private readonly http: PrReviewHttpClient,
  ) {}

  async listRequests(input?: ListProjectForgeRequestsInput): Promise<ProjectForgeRequestsResult> {
    const requestedState = input?.state ?? "all";
    const params = new URLSearchParams({
      state: githubRequestState(requestedState),
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
    const payloadItems: unknown[] = [];
    let page = 1;
    for (;;) {
      params.set("page", String(page));
      const result = await this.http.jsonWithHeaders(
        `/repos/${encodeURIComponent(this.context.github.owner)}/${encodeURIComponent(this.context.github.repo)}/pulls?${params.toString()}`,
      );
      if (!Array.isArray(result.payload)) {
        throw new Error("The hosting API returned an unexpected response while listing requests.");
      }
      payloadItems.push(...result.payload);
      const nextPage = githubNextPageFromLinkHeader(result.headers.get("link"));
      if (!nextPage || nextPage === page) {
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
        .map(mapGithubRequestSummary)
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
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const number = String(parsed.number);
    const warnings: string[] = [];

    const pullRequest = await this.http.json(`/repos/${owner}/${repo}/pulls/${number}`);
    if (!isRecord(pullRequest)) {
      throw new Error("The hosting API returned an unexpected response while loading the pull request.");
    }
    const request = mapGithubRequestDetails(pullRequest);
    if (!request) {
      throw new Error("The hosting API returned an incomplete pull request response.");
    }

    const pullRequestNodeId = recordString(pullRequest, "node_id");
    const [issueComments, reviews, reviewComments, timeline, commits, files, graphqlReviewThreads] = await Promise.all([
      this.getPagedArray(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load pull request comments.");
        return [];
      }),
      this.getPagedArray(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load pull request reviews.");
        return [];
      }),
      this.getPagedArray(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load pull request diff comments.");
        return [];
      }),
      this.getPagedArray(`/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load pull request timeline events.");
        return [];
      }),
      this.getPagedArray(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load pull request commits.");
        return [];
      }),
      this.getPagedArray(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`).catch((error) => {
        warnings.push(error instanceof Error ? error.message : "Could not load changed files.");
        return [];
      }),
      pullRequestNodeId
        ? this.getGraphqlReviewThreads(pullRequestNodeId).catch((error) => {
            warnings.push(error instanceof Error ? error.message : "Could not load pull request review threads.");
            return [];
          })
        : Promise.resolve([]),
    ]);

    const commentIds = new Set<string>();
    const activity: ProjectForgeActivityItem[] = [];
    const reviewThreads: ProjectForgeReviewThread[] = [];

    for (const entry of onlyRecords(issueComments)) {
      const id = recordNumber(entry, "id");
      if (id) {
        commentIds.add(String(id));
      }
      activity.push({
        id: `github-comment-${String(id ?? activity.length)}`,
        provider: "github",
        kind: "comment",
        title: "commented",
        body: recordString(entry, "body"),
        state: null,
        path: null,
        line: null,
        url: recordString(entry, "html_url"),
        createdAt: recordString(entry, "created_at"),
        updatedAt: recordString(entry, "updated_at"),
        author: githubUserSummary(recordObject(entry, "user")),
      });
    }

    for (const entry of onlyRecords(reviews)) {
      const id = recordNumber(entry, "id");
      const state = recordString(entry, "state");
      activity.push({
        id: `github-review-${String(id ?? activity.length)}`,
        provider: "github",
        kind: "review",
        title: state ? `reviewed: ${state.toLowerCase().replace(/_/g, " ")}` : "reviewed",
        body: recordString(entry, "body"),
        state,
        path: null,
        line: null,
        url: recordString(entry, "html_url"),
        createdAt: recordString(entry, "submitted_at") ?? recordString(entry, "created_at"),
        updatedAt: null,
        author: githubUserSummary(recordObject(entry, "user")),
      });
    }

    for (const entry of onlyRecords(reviewComments)) {
      const id = recordNumber(entry, "id");
      const thread = githubReviewThreadFromComment(entry, activity.length);
      if (thread && graphqlReviewThreads.length === 0) {
        reviewThreads.push(thread);
      }
      activity.push({
        id: `github-diff-comment-${String(id ?? activity.length)}`,
        provider: "github",
        kind: "diff-comment",
        title: "commented on the diff",
        body: recordString(entry, "body"),
        state: null,
        path: recordString(entry, "path"),
        line: recordNumber(entry, "line") ?? recordNumber(entry, "original_line"),
        url: recordString(entry, "html_url"),
        createdAt: recordString(entry, "created_at"),
        updatedAt: recordString(entry, "updated_at"),
        author: githubUserSummary(recordObject(entry, "user")),
        commitSha: recordString(entry, "commit_id") ?? recordString(entry, "original_commit_id"),
      });
    }

    if (graphqlReviewThreads.length > 0) {
      reviewThreads.push(...graphqlReviewThreads);
    }

    for (const entry of onlyRecords(timeline)) {
      const event = recordString(entry, "event");
      const id = recordNumber(entry, "id") ?? recordNumber(entry, "node_id");
      const commentId = recordNumber(entry, "id");
      if (!event || event === "commented" || event === "reviewed" || (commentId && commentIds.has(String(commentId)))) {
        continue;
      }
      activity.push({
        id: `github-event-${event}-${String(id ?? activity.length)}`,
        provider: "github",
        kind: "event",
        title: githubActivityTitle(event),
        body: githubTimelineEventBody(entry),
        state: event,
        path: null,
        line: null,
        url: recordString(entry, "html_url"),
        createdAt: recordString(entry, "created_at"),
        updatedAt: null,
        author: githubTimelineAuthor(entry),
        commitSha: event === "committed" ? recordString(entry, "commit_id") : null,
      });
    }

    const commitSummaries = onlyRecords(commits).map(mapGithubCommitSummary).filter((entry): entry is ProjectForgeCommitSummary => Boolean(entry));
    const fileSummaries = onlyRecords(files).map(mapGithubChangedFileSummary).filter((entry): entry is ProjectForgeChangedFileSummary => Boolean(entry));
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
      files: fileSummaries.map((file) => ({ ...file, commentCount: diffCommentCountsByPath.get(file.path) ?? 0 })),
      reviewThreads,
      warnings,
    };
  }

  async getRequestDiff(input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const number = String(parsed.number);
    const commitSha = input.commitSha?.trim();
    if (commitSha) {
      const diff = (await this.http.text(`/repos/${owner}/${repo}/commits/${encodeURIComponent(commitSha)}`, {
        headers: { Accept: "application/vnd.github.diff" },
      })).trim();
      return {
        diff,
        provider: "github",
        number: parsed.number,
        baseRef: `GitHub commit ${commitSha.slice(0, 12)}`,
      };
    }
    const diff = (await this.http.text(`/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { Accept: "application/vnd.github.diff" },
    })).trim();
    return {
      diff,
      provider: "github",
      number: parsed.number,
      baseRef: "GitHub API",
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
      await this.assertPullRequestCanBeApprovedByToken(parsed.number);
    }

    const reviewBody: Record<string, unknown> = {
      event: input.event === "approve" ? "APPROVE" : "COMMENT",
    };
    if (body) {
      reviewBody.body = body;
    }
    const payload = await this.http.json(
      `/repos/${encodeURIComponent(this.context.github.owner)}/${encodeURIComponent(this.context.github.repo)}/pulls/${String(parsed.number)}/reviews`,
      {
        method: "POST",
        body: JSON.stringify(reviewBody),
        headers: { "Content-Type": "application/json" },
      },
    );
    const url = isRecord(payload) ? (recordString(payload, "html_url") ?? undefined) : undefined;
    return {
      message: input.event === "approve" ? "Approved the pull request." : "Posted the AI review to the pull request.",
      url,
    };
  }

  async submitComments(input: SubmitProjectPrMrCommentsInput): Promise<ProjectForgeReviewActionResult> {
    const prUrl = input.prUrl.trim();
    const parsed = parseAndValidatePrMrUrl(prUrl, this.context);
    const comments = normalizeDraftComments(input.comments);
    assertDraftCommentsAreSubmittable(comments);
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const pullNumber = String(parsed.number);

    if (input.mode === "single") {
      if (comments.length !== 1) {
        throw new Error("Single diff comments must contain exactly one comment.");
      }
      const pullRequest = await this.http.json(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
      const head = isRecord(pullRequest) ? recordObject(pullRequest, "head") : null;
      const headSha = head ? recordString(head, "sha") : null;
      if (!headSha) {
        throw new Error("Could not resolve the pull request head commit for this single comment.");
      }
      const payload = await this.http.json(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
        {
          method: "POST",
          body: JSON.stringify(toGithubSingleReviewComment(comments[0]!, headSha)),
          headers: { "Content-Type": "application/json" },
        },
      );
      const url = isRecord(payload) ? (recordString(payload, "html_url") ?? undefined) : undefined;
      return {
        message: "Submitted one pull request diff comment.",
        url,
      };
    }

    const payload = await this.http.json(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({
          event: "COMMENT",
          body: input.body?.trim() || `BuildWarden submitted ${String(comments.length)} diff comment${comments.length === 1 ? "" : "s"}.`,
          comments: comments.map(toGithubReviewComment),
        }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const url = isRecord(payload) ? (recordString(payload, "html_url") ?? undefined) : undefined;
    return {
      message: `Submitted ${String(comments.length)} pull request diff comment${comments.length === 1 ? "" : "s"}.`,
      url,
    };
  }

  async replyToThread(input: ReplyProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult> {
    const body = input.body.trim();
    if (!body) {
      throw new Error("Replies need a message body.");
    }
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const commentId = input.replyToCommentId?.trim();
    if (!commentId) {
      throw new Error("This GitHub review thread cannot be replied to because the top-level comment ID was not returned by GitHub.");
    }
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const payload = await this.http.json(
      `/repos/${owner}/${repo}/pulls/${String(parsed.number)}/comments/${encodeURIComponent(commentId)}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const url = isRecord(payload) ? (recordString(payload, "html_url") ?? undefined) : undefined;
    return {
      message: "Replied to the pull request review thread.",
      url,
    };
  }

  async resolveThread(input: ResolveProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult> {
    parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const threadId = input.threadId.trim();
    if (!threadId || threadId.startsWith("github-thread-")) {
      throw new Error("This GitHub review thread cannot be resolved because GitHub did not return a GraphQL review thread ID.");
    }
    const mutation = input.resolved ? "resolveReviewThread" : "unresolveReviewThread";
    await this.http.json("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `mutation UpdateReviewThread($threadId: ID!) {
          ${mutation}(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        variables: { threadId },
      }),
      headers: { "Content-Type": "application/json" },
    });
    return {
      message: input.resolved ? "Resolved the pull request review thread." : "Reopened the pull request review thread.",
      url: input.prUrl.trim(),
    };
  }

  async createRequest(input: CreateForgeRequestInput): Promise<ProjectForgeRequestSummary> {
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const payload = await this.http.json(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        head: input.sourceBranch,
        base: input.targetBranch,
        body: input.description,
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!isRecord(payload)) {
      throw new Error("The hosting API returned an unexpected response while creating the pull request.");
    }
    const summary = mapGithubRequestSummary(payload);
    if (!summary) {
      throw new Error("The hosting API returned an incomplete response while creating the pull request.");
    }
    return summary;
  }

  async mergeRequest(input: MergeForgeRequestInput): Promise<ProjectForgeReviewActionResult> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const body: Record<string, unknown> = { merge_method: "merge" };
    if (input.mergeCommitTitle?.trim()) {
      body.commit_title = input.mergeCommitTitle.trim();
    }
    const payload = await this.http.json(`/repos/${owner}/${repo}/pulls/${String(parsed.number)}/merge`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const merged = isRecord(payload) ? recordBoolean(payload, "merged") : false;
    if (!merged) {
      const message = isRecord(payload) ? (recordString(payload, "message") ?? "GitHub did not merge the pull request.") : "GitHub did not merge the pull request.";
      throw new Error(message);
    }
    return {
      message: "Merged the pull request.",
      url: input.prUrl.trim(),
    };
  }

  async getRequestApprovalStatus(input: GetProjectForgeRequestDetailsInput): Promise<ForgeRequestApprovalStatus> {
    const parsed = parseAndValidatePrMrUrl(input.prUrl.trim(), this.context);
    const owner = encodeURIComponent(this.context.github.owner);
    const repo = encodeURIComponent(this.context.github.repo);
    const reviews = await this.getPagedArray(`/repos/${owner}/${repo}/pulls/${String(parsed.number)}/reviews?per_page=100`);
    // Only the latest substantive review per user counts (APPROVED / CHANGES_REQUESTED supersede earlier ones).
    const latestStateByUser = new Map<string, string>();
    for (const entry of onlyRecords(reviews)) {
      const state = recordString(entry, "state")?.toUpperCase();
      const user = recordObject(entry, "user");
      const login = user ? recordString(user, "login") : null;
      if (!state || !login) {
        continue;
      }
      if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED") {
        latestStateByUser.set(login, state);
      }
    }
    const approvedBy = [...latestStateByUser.entries()].filter(([, state]) => state === "APPROVED").map(([login]) => login);
    return {
      approved: approvedBy.length > 0,
      approvedBy,
    };
  }

  private async assertPullRequestCanBeApprovedByToken(pullNumber: number): Promise<void> {
    const pullRequest = await this.http.json(
      `/repos/${encodeURIComponent(this.context.github.owner)}/${encodeURIComponent(this.context.github.repo)}/pulls/${String(pullNumber)}`,
    );

    if (isRecord(pullRequest)) {
      const state = recordString(pullRequest, "state");
      if (state && state !== "open") {
        throw new Error(`GitHub only allows approving open pull requests. This pull request is ${state}.`);
      }
      if (recordBoolean(pullRequest, "draft")) {
        throw new Error("GitHub does not allow approving draft pull requests. Mark it ready for review first.");
      }
    }

    let viewerLogin: string | null = null;
    try {
      const viewer = await this.http.json("/user");
      viewerLogin = isRecord(viewer) ? recordString(viewer, "login") : null;
    } catch {
      viewerLogin = null;
    }
    const author = isRecord(pullRequest) ? recordObject(pullRequest, "user") : null;
    const authorLogin = author ? recordString(author, "login") : null;
    if (viewerLogin && authorLogin && viewerLogin.toLowerCase() === authorLogin.toLowerCase()) {
      throw new Error("GitHub does not allow approving your own pull request. Use Comment instead, or approve with a reviewer token.");
    }
  }

  private async getGraphqlReviewThreads(pullRequestNodeId: string): Promise<ProjectForgeReviewThread[]> {
    const payload = await this.http.json("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query PullRequestReviewThreads($id: ID!) {
          node(id: $id) {
            ... on PullRequest {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  isOutdated
                  path
                  line
                  originalLine
                  diffSide
                  comments(first: 100) {
                    nodes {
                      id
                      databaseId
                      fullDatabaseId
                      body
                      createdAt
                      updatedAt
                      url
                      path
                      line
                      originalLine
                      diffHunk
                      author { login avatarUrl url }
                      commit { oid }
                      originalCommit { oid }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { id: pullRequestNodeId },
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!isRecord(payload)) {
      throw new Error("The hosting API returned an unexpected GraphQL response while loading review threads.");
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("GitHub GraphQL could not load review threads.");
    }
    const data = recordObject(payload, "data");
    const node = data ? recordObject(data, "node") : null;
    const reviewThreadsConnection = node ? recordObject(node, "reviewThreads") : null;
    const nodes = reviewThreadsConnection?.nodes;
    if (!Array.isArray(nodes)) {
      return [];
    }
    return onlyRecords(nodes)
      .map(githubGraphqlReviewThreadFromNode)
      .filter((thread): thread is ProjectForgeReviewThread => Boolean(thread));
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
      const nextPage = githubNextPageFromLinkHeader(result.headers.get("link"));
      if (!nextPage || nextPage === page) {
        break;
      }
      const separator = path.includes("?") ? "&" : "?";
      currentPath = `${path}${separator}page=${String(nextPage)}`;
      page = nextPage;
    }
    return payloadItems;
  }
}

export const isGithubPrReviewContext = (context: ProjectPrReviewRemoteContext): context is GithubPrReviewContext =>
  context.provider === "github" && Boolean(context.github);
