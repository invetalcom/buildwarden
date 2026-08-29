import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  PostProjectPrMrReviewInput,
  ProjectForgeChangedFileSummary,
  ProjectForgeCommitSummary,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestSummary,
  ProjectForgeRequestsResult,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
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

import {
  buildGitlabActivity,
  extractGitlabDiffRefs,
  gitlabCheckStatus,
  gitlabDiffRowsToUnifiedDiff,
  gitlabDurationMs,
  gitlabMergeabilityFromPayload,
  gitlabRequestHeadSha,
  gitlabRequestState,
  gitlabRequestStateFromPayload,
  gitlabReviewDecision,
  gitlabSupportedActions,
  mapGitlabChangedFileSummary,
  mapGitlabCommitSummary,
  mapGitlabRequestDetails,
  mapGitlabRequestSummary,
  onlyRecords,
  sortActivity,
  toGitlabDiscussionPosition,
} from "./gitlab-mr-review-mappers";
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

    const { activity, reviewThreads } = buildGitlabActivity(notes, discussions, stateEvents);

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

  private async getRequestChecks(
    projectPath: string,
    mergeRequestIid: string,
    requestPayload: Record<string, unknown> | null,
  ): Promise<RunForgeCheck[]> {
    const pipelines = await this.http.json(
      `/projects/${projectPath}/merge_requests/${mergeRequestIid}/pipelines?per_page=1`,
    );
    let pipeline = requestPayload ? recordObject(requestPayload, "head_pipeline") : null;
    if (Array.isArray(pipelines) && isRecord(pipelines[0])) {
      pipeline = pipelines[0];
    }

    const pipelineId = pipeline ? recordNumber(pipeline, "id") : null;
    const jobs = pipelineId
      ? await this.http.json(`/projects/${projectPath}/pipelines/${String(pipelineId)}/jobs?per_page=100&include_retried=false`)
      : [];
    const checks: RunForgeCheck[] = (Array.isArray(jobs) ? onlyRecords(jobs) : []).map((job, index) => ({
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
    return checks;
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
    const headSha = gitlabRequestHeadSha(requestPayload, previousStatus);
    const checks = await this.getRequestChecks(projectPath, iid, requestPayload);
    const state = gitlabRequestStateFromPayload(requestPayload, previousStatus);
    const mergeability = gitlabMergeabilityFromPayload(requestPayload, previousStatus);
    const approval = await this.getRequestApprovalStatus(input);
    const approvalsRequired = requestPayload ? recordNumber(requestPayload, "approvals_before_merge") ?? 0 : 0;
    let unresolvedThreadCount = previousStatus?.unresolvedThreadCount ?? 0;
    if (requestPayload) {
      unresolvedThreadCount = recordBoolean(requestPayload, "blocking_discussions_resolved") ? 0 : 1;
    }
    const reviewDecision = gitlabReviewDecision(approval.approved, approvalsRequired, requestPayload, previousStatus);
    const draft = requestPayload
      ? recordBoolean(requestPayload, "draft") || recordBoolean(requestPayload, "work_in_progress")
      : (previousStatus?.draft ?? false);
    const supportedActions = gitlabSupportedActions(state, draft);
    return {
      state,
      draft,
      mergeability,
      reviewDecision,
      headSha,
      checks,
      unresolvedThreadCount,
      supportedActions,
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
    let body: Record<string, unknown> = { state_event: input.action === "close" ? "close" : "reopen" };
    if (input.action === "mark-draft") body = { draft: true };
    else if (input.action === "mark-ready") body = { draft: false };
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
