import type {
  CommentProjectForgeIssueInput,
  CreateProjectForgeIssueInput,
  GetProjectForgeIssueDetailsInput,
  GetProjectForgeIssueImageInput,
  ListProjectForgeIssuesInput,
  ProjectForgeIssueAccess,
  ProjectForgeIssueActionResult,
  ProjectForgeIssueDetails,
  ProjectForgeIssueDetailsResult,
  ProjectForgeIssueImageResult,
  ProjectForgeIssueLabel,
  ProjectForgeIssueMetadataResult,
  ProjectForgeIssueSummary,
  ProjectForgeIssueWorkLink,
  ProjectForgeIssuesResult,
  ProjectForgeIssuesUnavailable,
  ProjectForgeProvider,
  UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import { PrReviewHttpClient, PrReviewHttpError } from "../pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { loadForgeIssueImage } from "./forge-issue-images";
import { readForgeIssueTemplates } from "./forge-issue-templates";
import type { ForgeIssueListQuery, ForgeIssueProvider, ForgeIssueThread, ForgeIssueTokenAccess } from "./forge-issue-types";
import { GithubIssueProvider, isGithubIssueContext } from "./github-issue-provider";
import { GitlabIssueProvider, isGitlabIssueContext } from "./gitlab-issue-provider";

/** Anonymous requests are scarce (GitHub: 60 per hour and IP), so their results are reused for a while. */
const ANONYMOUS_CACHE_MS = 10 * 60_000;
const TOKEN_LIST_CACHE_MS = 60_000;
const TOKEN_DETAILS_CACHE_MS = 30_000;
const METADATA_CACHE_MS = 10 * 60_000;
const TOKEN_ACCESS_CACHE_MS = 10 * 60_000;
/** GitHub signs attachment addresses for five minutes. */
const SIGNED_IMAGE_CACHE_MS = 4 * 60_000;
const SIGNED_IMAGE_RETRY_MS = 20_000;
const IMAGE_URL_MAX_LENGTH = 2_000;

export const FORGE_ISSUE_TOKEN_REQUIRED_MESSAGE = "Add a Git hosting access token in Project Settings to change issues.";

export interface ForgeIssueServiceDeps {
  resolveContext(projectId: string): Promise<ProjectPrReviewRemoteContext>;
  readToken(projectId: string): Promise<string | null>;
  getRepoPath(projectId: string): string;
  /** Links whose run, chat, or task still exists. */
  listLinks(projectId: string): ProjectForgeIssueWorkLink[];
  /** Called with issues just read from the host, so linked tasks can follow their state. */
  onIssuesObserved?(projectId: string, issues: ProjectForgeIssueSummary[]): void;
  now?: () => number;
  createHttpClient?: (context: ProjectPrReviewRemoteContext, token: string | null) => PrReviewHttpClient;
}

export interface ForgeIssueNotification {
  kind: "new-issue" | "new-comment";
  issue: ProjectForgeIssueSummary;
}

type Cached<T> = { value: T; fetchedAt: number };

type ProjectSession = {
  context: ProjectPrReviewRemoteContext;
  token: string | null;
  http: PrReviewHttpClient;
  provider: ForgeIssueProvider;
  tokenAccess: Cached<ForgeIssueTokenAccess> | null;
  lists: Map<string, Cached<{ items: ProjectForgeIssueDetails[]; hasMore: boolean }>>;
  threads: Map<number, Cached<ForgeIssueThread>>;
  issues: Map<number, Cached<ProjectForgeIssueDetails>>;
  metadata: Cached<ProjectForgeIssueMetadataResult> | null;
  labelColors: Map<string, string>;
  signedImages: Map<number, Cached<Promise<Map<string, string>>>>;
  /** Counts finished writes, so a read that a write overtook can tell that its snapshot is outdated. */
  writeCount: number;
};

type MonitorState = { startedAt: number; commentCounts: Map<number, number> };

const providerName = (provider: ProjectForgeProvider): string => (provider === "gitlab" ? "GitLab" : "GitHub");

export const toForgeIssueSummary = (issue: ProjectForgeIssueDetails): ProjectForgeIssueSummary => {
  const summary: ProjectForgeIssueSummary & { body?: string } = { ...issue };
  delete summary.body;
  return summary;
};

const createProvider = (context: ProjectPrReviewRemoteContext, http: PrReviewHttpClient): ForgeIssueProvider => {
  if (isGithubIssueContext(context)) return new GithubIssueProvider(context, http);
  if (isGitlabIssueContext(context)) return new GitlabIssueProvider(context, http);
  throw new Error("Could not resolve a GitHub or GitLab provider for this project.");
};

const normalizeQuery = (input: ListProjectForgeIssuesInput | undefined): Omit<ForgeIssueListQuery, "viewer"> => ({
  state: input?.state ?? "open",
  labels: [...new Set((input?.labels ?? []).map((label) => label.trim()).filter(Boolean))].sort(),
  assignee: input?.assignee?.trim() || undefined,
  author: input?.author?.trim() || undefined,
  milestone: input?.milestone?.trim() || undefined,
  sort: input?.sort ?? "updated",
  page: Math.max(1, Math.trunc(input?.page ?? 1)),
});

const formatTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Classifies a failed read into a condition the UI has a dedicated prompt for.
 * Returns `null` for anything else (network errors, server errors), which callers rethrow.
 */
export const classifyForgeIssueReadError = (
  error: unknown,
  input: { provider: ProjectForgeProvider; authenticated: boolean; rateLimitRemaining: number | null; now: number },
): ProjectForgeIssuesUnavailable | null => {
  if (!(error instanceof PrReviewHttpError)) return null;
  const host = providerName(input.provider);
  // GitHub answers an exhausted budget with 403, the same status as a missing permission; the remaining count tells them apart.
  if (error.status === 429 || (error.status === 403 && input.rateLimitRemaining === 0)) {
    const retryAt = error.retryAfterMs !== null ? input.now + error.retryAfterMs : null;
    const until = retryAt !== null ? ` It refills at ${formatTime(retryAt)}.` : "";
    return {
      reason: "rate-limited",
      message: input.authenticated
        ? `${host}'s request limit for the saved token is used up.${until}`
        : `${host}'s request limit for access without a token is used up.${until} A saved access token has a much higher limit.`,
      retryAt: retryAt !== null ? new Date(retryAt).toISOString() : null,
    };
  }
  if (!input.authenticated) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return {
        reason: "needs-token",
        message: `${host} does not show this repository's issues without signing in. Add a Git hosting access token to load them.`,
        retryAt: null,
      };
    }
    return null;
  }
  if (error.status === 401) {
    return { reason: "token-rejected", message: `${host} rejected the saved access token. It may have expired or been revoked.`, retryAt: null };
  }
  if (error.status === 403 || error.status === 404) {
    return {
      reason: "token-lacks-permission",
      message: input.provider === "github"
        ? 'The saved token may not read this repository\'s issues. Fine-grained GitHub tokens need the "Issues" repository permission; classic tokens need the "repo" scope.'
        : 'The saved token may not read this project\'s issues. GitLab tokens need the "read_api" scope to read and "api" to comment.',
      retryAt: null,
    };
  }
  if (error.status === 410) {
    return { reason: "issues-disabled", message: "Issues are switched off for this repository.", retryAt: null };
  }
  return null;
};

/** Rewrites a failed write into a message that says which permission is missing. */
export const describeForgeIssueWriteError = (error: unknown, provider: ProjectForgeProvider): Error => {
  if (!(error instanceof PrReviewHttpError)) return error instanceof Error ? error : new Error(String(error));
  const host = providerName(provider);
  if (error.status === 401) return new Error(`${host} rejected the saved access token. It may have expired or been revoked.`);
  if (error.status === 403 || error.status === 404) {
    const hint = provider === "github"
      ? 'Fine-grained GitHub tokens need the "Issues" repository permission set to "Read and write". Labels, assignees, milestones, and closing also need triage rights on the repository.'
      : 'GitLab tokens need the "api" scope. Labels, assignees, milestones, and closing also need at least the Reporter role.';
    return new Error(`The saved token may not make this change. ${hint} (${error.message})`);
  }
  if (error.status === 410) return new Error("Issues are switched off for this repository.");
  return error;
};

export class ForgeIssueService {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly monitors = new Map<string, MonitorState>();
  private readonly now: () => number;

  constructor(private readonly deps: ForgeIssueServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Forget everything cached for a project, e.g. after its token changed or it was deleted. */
  forgetProject(projectId: string): void {
    this.sessions.delete(projectId);
    this.monitors.delete(projectId);
  }

  async listIssues(projectId: string, input?: ListProjectForgeIssuesInput): Promise<ProjectForgeIssuesResult> {
    const session = await this.getSession(projectId);
    const query = normalizeQuery(input);
    const cacheKey = JSON.stringify(query);
    const base = {
      provider: session.context.provider,
      webBaseUrl: session.context.webBaseUrl,
      repoLabel: session.context.repoLabel,
      links: this.deps.listLinks(projectId),
      page: query.page ?? 1,
    };

    const unavailable = (reason: ProjectForgeIssuesUnavailable): ProjectForgeIssuesResult => ({
      ...base,
      access: this.accessOf(session, null),
      unavailable: reason,
      items: [],
      hasMore: false,
      fetchedAt: new Date(this.now()).toISOString(),
      fromCache: false,
    });

    try {
      const tokenAccess = await this.resolveTokenAccess(session);
      if (tokenAccess && !tokenAccess.issuesEnabled) {
        return unavailable({ reason: "issues-disabled", message: "Issues are switched off for this repository.", retryAt: null });
      }
      const cached = session.lists.get(cacheKey);
      const fresh = cached && this.now() - cached.fetchedAt < (session.token ? TOKEN_LIST_CACHE_MS : ANONYMOUS_CACHE_MS);
      const page = cached && fresh && !input?.refresh
        ? cached
        : await this.fetchList(projectId, session, cacheKey, { ...query, viewer: tokenAccess?.viewer ?? null });
      return {
        ...base,
        access: this.accessOf(session, tokenAccess),
        unavailable: null,
        items: page.value.items.map(toForgeIssueSummary),
        hasMore: page.value.hasMore,
        fetchedAt: new Date(page.fetchedAt).toISOString(),
        fromCache: page === cached,
      };
    } catch (error) {
      const reason = this.classify(session, error);
      if (reason) return unavailable(reason);
      throw error;
    }
  }

  async getIssueDetails(projectId: string, input: GetProjectForgeIssueDetailsInput): Promise<ProjectForgeIssueDetailsResult> {
    const issueNumber = this.requireIssueNumber(input.issueNumber);
    const session = await this.getSession(projectId);
    try {
      const tokenAccess = await this.resolveTokenAccess(session);
      const cached = await this.loadThread(projectId, session, issueNumber, input.refresh === true);
      const thread = cached.value;
      return {
        provider: session.context.provider,
        webBaseUrl: session.context.webBaseUrl,
        repoLabel: session.context.repoLabel,
        access: this.accessOf(session, tokenAccess),
        issue: { ...thread.issue, labels: this.withLabelColors(session, thread.issue.labels) },
        timeline: thread.timeline,
        linkedRequests: thread.linkedRequests,
        subIssues: thread.subIssues,
        links: this.deps.listLinks(projectId).filter((link) => link.issueNumber === issueNumber),
        warnings: thread.warnings,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
      };
    } catch (error) {
      const reason = this.classify(session, error);
      throw reason ? new Error(reason.message) : error;
    }
  }

  async getMetadata(projectId: string): Promise<ProjectForgeIssueMetadataResult> {
    const session = await this.getSession(projectId);
    if (session.metadata && this.now() - session.metadata.fetchedAt < METADATA_CACHE_MS) return session.metadata.value;
    try {
      const [metadata, templates] = await Promise.all([
        session.provider.getMetadata(),
        readForgeIssueTemplates(this.deps.getRepoPath(projectId), session.context.provider),
      ]);
      for (const label of metadata.labels) {
        if (label.color) session.labelColors.set(label.name, label.color);
      }
      const value: ProjectForgeIssueMetadataResult = { ...metadata, templates };
      session.metadata = { value, fetchedAt: this.now() };
      return value;
    } catch (error) {
      const reason = this.classify(session, error);
      throw reason ? new Error(reason.message) : error;
    }
  }

  async createIssue(projectId: string, input: CreateProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    const title = input.title.trim();
    if (!title) throw new Error("Enter an issue title.");
    const session = await this.requireWriteSession(projectId);
    const issue = await this.write(session, () => session.provider.createIssue({ ...input, title, body: input.body.trim() }));
    this.afterWrite(projectId, session, issue);
    return { message: `Issue #${String(issue.number)} created.`, url: issue.url, issue: toForgeIssueSummary(issue) };
  }

  async updateIssue(projectId: string, input: UpdateProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    const issueNumber = this.requireIssueNumber(input.issueNumber);
    if (input.title !== undefined && !input.title.trim()) throw new Error("An issue needs a title.");
    const session = await this.requireWriteSession(projectId);
    const issue = await this.write(session, () => session.provider.updateIssue({ ...input, issueNumber }));
    this.afterWrite(projectId, session, issue);
    let message = `Issue #${String(issueNumber)} updated.`;
    if (input.state === "closed") message = `Issue #${String(issueNumber)} closed.`;
    if (input.state === "open") message = `Issue #${String(issueNumber)} reopened.`;
    return { message, url: issue.url, issue: toForgeIssueSummary(issue) };
  }

  async commentIssue(projectId: string, input: CommentProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    const issueNumber = this.requireIssueNumber(input.issueNumber);
    const body = input.body.trim();
    if (!body) throw new Error("Write a comment before posting.");
    const session = await this.requireWriteSession(projectId);
    // The issue is read before posting. A read that failed afterwards would report a posted comment as failed, and a retry would post it twice.
    const issue = session.issues.get(issueNumber)?.value ?? (await this.write(session, async () => (await session.provider.getIssueThread(issueNumber)).issue));
    const comment = await this.write(session, () => session.provider.addComment(issueNumber, body));
    session.writeCount += 1;
    session.threads.delete(issueNumber);
    session.lists.clear();
    // The watcher must not report the user's own comment back to them.
    const monitor = this.monitors.get(projectId);
    if (monitor) monitor.commentCounts.set(issueNumber, (monitor.commentCounts.get(issueNumber) ?? issue.commentCount) + 1);
    const commented = { ...issue, commentCount: issue.commentCount + 1 };
    this.rememberIssues(projectId, session, [commented]);
    const url = comment.url?.startsWith("#") ? `${issue.url}${comment.url}` : comment.url;
    return { message: `Comment posted on #${String(issueNumber)}.`, url: url ?? issue.url, issue: toForgeIssueSummary(commented) };
  }

  /**
   * Downloads an image shown in an issue or comment with the project's access, so private attachments load too.
   * Only images on the project's Git host are fetched; anything else is left to the renderer's click-to-load prompt.
   */
  async getIssueImage(projectId: string, input: GetProjectForgeIssueImageInput): Promise<ProjectForgeIssueImageResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url || url.length > IMAGE_URL_MAX_LENGTH) throw new Error("The image address is not valid.");
    const session = await this.getSession(projectId);
    const issueNumber = typeof input.issueNumber === "number" && Number.isInteger(input.issueNumber) && input.issueNumber > 0 ? input.issueNumber : null;
    const dataUrl = await loadForgeIssueImage({
      context: session.context,
      token: session.token,
      url,
      resolveSignedUrl: issueNumber === null ? undefined : (assetId) => this.signedImageUrl(session, issueNumber, assetId),
    });
    return { dataUrl };
  }

  /** The issue with its conversation, for building model prompts and run context. */
  async getIssueThread(projectId: string, issueNumber: number): Promise<{ thread: ForgeIssueThread; context: ProjectPrReviewRemoteContext }> {
    const session = await this.getSession(projectId);
    try {
      const cached = await this.loadThread(projectId, session, this.requireIssueNumber(issueNumber), false);
      return { thread: cached.value, context: session.context };
    } catch (error) {
      const reason = this.classify(session, error);
      throw reason ? new Error(reason.message) : error;
    }
  }

  /** Open issues carrying a label, newest first. Token only: unattended work never runs on anonymous access. */
  async listOpenIssuesWithLabel(projectId: string, label: string): Promise<ProjectForgeIssueDetails[]> {
    const session = await this.getSession(projectId);
    if (!session.token) return [];
    const tokenAccess = await this.resolveTokenAccess(session);
    const page = await this.fetchList(projectId, session, null, { state: "open", labels: [label], sort: "created", page: 1, viewer: tokenAccess?.viewer ?? null });
    return page.value.items;
  }

  /** Other open issues' titles, for duplicate detection. Uses the cached first page when there is one. */
  async listOpenIssueTitles(projectId: string): Promise<Array<{ number: number; title: string }>> {
    const result = await this.listIssues(projectId, { state: "open" });
    return result.items.map((issue) => ({ number: issue.number, title: issue.title }));
  }

  /**
   * Compares the open issues with the previous check. The first call only records a baseline.
   * Reports issues opened since, and new comments on issues the user is involved in.
   */
  async collectNotifications(projectId: string): Promise<ForgeIssueNotification[]> {
    const session = await this.getSession(projectId);
    if (!session.token) return [];
    const tokenAccess = await this.resolveTokenAccess(session);
    const viewer = tokenAccess?.viewer ?? null;
    const page = await this.fetchList(projectId, session, null, { state: "open", sort: "updated", page: 1, viewer });
    const linked = new Set(this.deps.listLinks(projectId).map((link) => link.issueNumber));
    const previous = this.monitors.get(projectId);
    const state: MonitorState = previous ?? { startedAt: this.now(), commentCounts: new Map() };
    const notifications: ForgeIssueNotification[] = [];
    for (const issue of page.value.items) {
      const before = state.commentCounts.get(issue.number);
      if (previous) {
        const involved = linked.has(issue.number) || (viewer !== null && (issue.author === viewer || issue.assignees.some((user) => user.username === viewer)));
        if (before === undefined) {
          const createdAt = issue.createdAt ? Date.parse(issue.createdAt) : Number.NaN;
          if (Number.isFinite(createdAt) && createdAt >= state.startedAt && issue.author !== viewer) {
            notifications.push({ kind: "new-issue", issue: toForgeIssueSummary(issue) });
          }
        } else if (issue.commentCount > before && involved) {
          notifications.push({ kind: "new-comment", issue: toForgeIssueSummary(issue) });
        }
      }
      state.commentCounts.set(issue.number, issue.commentCount);
    }
    this.monitors.set(projectId, state);
    return notifications;
  }

  private async getSession(projectId: string): Promise<ProjectSession> {
    const context = await this.deps.resolveContext(projectId);
    const token = (await this.deps.readToken(projectId))?.trim() || null;
    const current = this.sessions.get(projectId);
    if (current && current.token === token && current.context.webBaseUrl === context.webBaseUrl) return current;
    const http = this.deps.createHttpClient?.(context, token) ?? new PrReviewHttpClient(context, token);
    const session: ProjectSession = {
      context,
      token,
      http,
      provider: createProvider(context, http),
      tokenAccess: null,
      lists: new Map(),
      threads: new Map(),
      issues: new Map(),
      metadata: null,
      labelColors: new Map(),
      signedImages: new Map(),
      writeCount: 0,
    };
    this.sessions.set(projectId, session);
    return session;
  }

  /**
   * One lookup serves every image of an issue that asks while the signed addresses are still valid.
   * An attachment missing from a lookup that is not brand new may sit in a newer comment, so that is looked up again.
   */
  private async signedImageUrl(session: ProjectSession, issueNumber: number, assetId: string): Promise<string | null> {
    const cached = session.signedImages.get(issueNumber);
    if (cached && this.now() - cached.fetchedAt < SIGNED_IMAGE_CACHE_MS) {
      const known = (await cached.value).get(assetId);
      if (known || this.now() - cached.fetchedAt < SIGNED_IMAGE_RETRY_MS) return known ?? null;
      const newer = session.signedImages.get(issueNumber);
      if (newer && newer !== cached) return (await newer.value).get(assetId) ?? null;
    }
    const lookup = session.provider.getSignedImageUrls
      ? session.provider.getSignedImageUrls(issueNumber).catch(() => new Map<string, string>())
      : Promise.resolve(new Map<string, string>());
    session.signedImages.set(issueNumber, { value: lookup, fetchedAt: this.now() });
    return (await lookup).get(assetId) ?? null;
  }

  private async requireWriteSession(projectId: string): Promise<ProjectSession> {
    const session = await this.getSession(projectId);
    if (!session.token) throw new Error(FORGE_ISSUE_TOKEN_REQUIRED_MESSAGE);
    return session;
  }

  private async resolveTokenAccess(session: ProjectSession): Promise<ForgeIssueTokenAccess | null> {
    if (!session.token) return null;
    if (session.tokenAccess && this.now() - session.tokenAccess.fetchedAt < TOKEN_ACCESS_CACHE_MS) return session.tokenAccess.value;
    const value = await session.provider.resolveTokenAccess();
    session.tokenAccess = { value, fetchedAt: this.now() };
    return value;
  }

  private accessOf(session: ProjectSession, tokenAccess: ForgeIssueTokenAccess | null): ProjectForgeIssueAccess {
    return {
      mode: session.token ? "token" : "anonymous",
      canWrite: tokenAccess?.canWrite ?? false,
      canTriage: tokenAccess?.canTriage ?? false,
      viewer: tokenAccess?.viewer ?? null,
      rateLimit: session.http.rateLimit,
    };
  }

  private classify(session: ProjectSession, error: unknown): ProjectForgeIssuesUnavailable | null {
    return classifyForgeIssueReadError(error, {
      provider: session.context.provider,
      authenticated: session.token !== null,
      rateLimitRemaining: session.http.rateLimit?.remaining ?? null,
      now: this.now(),
    });
  }

  /** The issue with its conversation, from the cache while that is recent enough. */
  private async loadThread(projectId: string, session: ProjectSession, issueNumber: number, refresh: boolean): Promise<Cached<ForgeIssueThread>> {
    const ttl = session.token ? TOKEN_DETAILS_CACHE_MS : ANONYMOUS_CACHE_MS;
    const cached = session.threads.get(issueNumber);
    if (cached && !refresh && this.now() - cached.fetchedAt < ttl) return cached;
    // Without a token every request counts, so an issue that was just listed is not fetched a second time.
    const listed = session.issues.get(issueNumber);
    const known = !session.token && !refresh && listed && this.now() - listed.fetchedAt < ANONYMOUS_CACHE_MS ? listed.value : null;
    const writesBefore = session.writeCount;
    const thread = await session.provider.getIssueThread(issueNumber, known);
    const loaded = { value: thread, fetchedAt: this.now() };
    // A write that finished during this read makes its snapshot outdated: it is returned, but neither kept nor published.
    if (writesBefore !== session.writeCount) return loaded;
    session.threads.set(issueNumber, loaded);
    this.rememberIssues(projectId, session, [thread.issue]);
    return loaded;
  }

  private async fetchList(
    projectId: string,
    session: ProjectSession,
    cacheKey: string | null,
    query: ForgeIssueListQuery,
  ): Promise<Cached<{ items: ProjectForgeIssueDetails[]; hasMore: boolean }>> {
    const writesBefore = session.writeCount;
    const page = await session.provider.listIssues(query);
    const items = page.items.map((issue) => ({ ...issue, labels: this.withLabelColors(session, issue.labels) }));
    const cached = { value: { items, hasMore: page.hasMore }, fetchedAt: this.now() };
    // A write that finished during this read makes its snapshot outdated. Publishing it could, for example,
    // mark the task of a just reopened issue as done.
    if (writesBefore !== session.writeCount) return cached;
    if (cacheKey !== null) session.lists.set(cacheKey, cached);
    this.rememberIssues(projectId, session, items);
    return cached;
  }

  private rememberIssues(projectId: string, session: ProjectSession, issues: ProjectForgeIssueDetails[]): void {
    const fetchedAt = this.now();
    for (const issue of issues) {
      session.issues.set(issue.number, { value: issue, fetchedAt });
      for (const label of issue.labels) {
        if (label.color) session.labelColors.set(label.name, label.color);
      }
    }
    if (issues.length > 0) this.deps.onIssuesObserved?.(projectId, issues.map(toForgeIssueSummary));
  }

  /** Single-issue responses of some hosts omit label colors; fill them in from what was seen before. */
  private withLabelColors(session: ProjectSession, labels: ProjectForgeIssueLabel[]): ProjectForgeIssueLabel[] {
    return labels.map((label) => (label.color ? label : { ...label, color: session.labelColors.get(label.name) ?? null }));
  }

  private async write<T>(session: ProjectSession, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw describeForgeIssueWriteError(error, session.context.provider);
    }
  }

  private afterWrite(projectId: string, session: ProjectSession, issue: ProjectForgeIssueDetails): void {
    session.writeCount += 1;
    session.lists.clear();
    session.threads.delete(issue.number);
    this.rememberIssues(projectId, session, [{ ...issue, labels: this.withLabelColors(session, issue.labels) }]);
  }

  private requireIssueNumber(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("Select an issue first.");
    return value;
  }
}
