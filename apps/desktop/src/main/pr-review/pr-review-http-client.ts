import type { ProjectForgeProvider, ProjectForgeRateLimit } from "@buildwarden/shared";
import type { ProjectPrReviewRemoteContext } from "./pr-review-types";
import { isRecord } from "./pr-review-utils";

const REQUEST_DEADLINE_MS = 30_000;

export class PrReviewRequestTimeoutError extends Error {
  constructor(provider: ProjectForgeProvider) {
    super(`${provider === "github" ? "GitHub" : "GitLab"} API request timed out after 30 seconds.`);
    this.name = "PrReviewRequestTimeoutError";
  }
}

const formatApiErrorValue = (value: unknown, path = ""): string[] => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    return [path ? `${path}: ${trimmed}` : trimmed];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => formatApiErrorValue(entry, path));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => {
      let nextPath = key;
      if (key === "message" || key === "error" || key === "error_description") {
        nextPath = path;
      } else if (path) {
        nextPath = `${path}.${key}`;
      }
      return formatApiErrorValue(entry, nextPath);
    });
  }
  return [];
};

const readJsonResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const responseErrorMessage = async (response: Response): Promise<string> => {
  const body = await readJsonResponse(response);
  if (isRecord(body)) {
    const messages = [
      ...formatApiErrorValue(body.message),
      ...formatApiErrorValue(body.error_description),
      ...formatApiErrorValue(body.error),
      ...formatApiErrorValue(body.errors),
    ];
    if (messages.length > 0) {
      return [...new Set(messages)].join("; ");
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return response.statusText || "Request failed.";
};

const prReviewErrorHint = (provider: ProjectForgeProvider, path: string, status: number): string | null => {
  if (provider !== "gitlab" || !path.includes("/merge_requests/") || !path.endsWith("/approve")) {
    return null;
  }
  if (status === 401 || status === 403) {
    return "GitLab requires the token user to be an eligible approver. Check the token user's role, approval rules, self-approval or committer-approval restrictions, and whether the project requires re-authentication to approve.";
  }
  if (status === 409) {
    return "The merge request changed before it could be approved. Refresh the MR and try again.";
  }
  if (status === 422) {
    return "GitLab could not process the approval for this merge request. Check whether the MR is open, ready for review, and still eligible for the token user to approve.";
  }
  return null;
};

const retryDelayFromHeaders = (headers: Headers, status: number): number | null => {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  const remainingHeader = headers.get("x-ratelimit-remaining");
  const rateLimitExhausted = remainingHeader !== null && Number(remainingHeader) === 0;
  const rateLimitReset = Number(headers.get("x-ratelimit-reset"));
  if ((status === 403 || status === 429 || rateLimitExhausted) && Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return Math.max(0, Math.round(rateLimitReset * 1_000 - Date.now()));
  }
  return null;
};

export class PrReviewHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "PrReviewHttpError";
  }
}

const rateLimitFromHeaders = (headers: Headers): ProjectForgeRateLimit | null => {
  const read = (...names: string[]): number | null => {
    for (const name of names) {
      const raw = headers.get(name);
      const value = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  // GitHub sends `x-ratelimit-*`; GitLab sends `ratelimit-*`. Both report the reset as epoch seconds.
  const limit = read("x-ratelimit-limit", "ratelimit-limit");
  const remaining = read("x-ratelimit-remaining", "ratelimit-remaining");
  const reset = read("x-ratelimit-reset", "ratelimit-reset");
  if (limit === null && remaining === null) return null;
  return { limit, remaining, resetAt: reset !== null && reset > 0 ? new Date(reset * 1_000).toISOString() : null };
};

export class PrReviewHttpClient {
  private latestRateLimit: ProjectForgeRateLimit | null = null;

  /**
   * @param token Hosting access token, or `null` to call the host's public API without credentials.
   */
  constructor(
    private readonly context: ProjectPrReviewRemoteContext,
    private readonly token: string | null,
  ) {}

  /** Request budget from the most recent response, when the host reported one. */
  get rateLimit(): ProjectForgeRateLimit | null {
    return this.latestRateLimit;
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const result = await this.jsonWithHeaders(path, init);
    return result.payload;
  }

  async jsonWithHeaders(path: string, init: RequestInit = {}): Promise<{ payload: unknown; headers: Headers; notModified?: boolean }> {
    const headers = new Headers(init.headers);
    if (this.context.provider === "github") {
      headers.set("Accept", "application/vnd.github+json");
      if (this.token !== null) headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    } else {
      headers.set("Accept", "application/json");
      if (this.token !== null) headers.set("PRIVATE-TOKEN", this.token);
    }

    return this.request(path, { ...init, headers }, async (response) => {
      if (response.status === 304) {
        return { payload: null, headers: response.headers, notModified: true };
      }
      if (!response.ok) throw await this.buildApiError(response, path);
      return { payload: await readJsonResponse(response), headers: response.headers };
    });
  }

  async text(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (this.context.provider === "github") {
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/vnd.github+json");
      }
      if (this.token !== null) headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    } else {
      if (!headers.has("Accept")) {
        headers.set("Accept", "text/plain");
      }
      if (this.token !== null) headers.set("PRIVATE-TOKEN", this.token);
    }

    return this.request(path, { ...init, headers }, async (response) => {
      if (!response.ok) throw await this.buildApiError(response, path);
      return response.text();
    });
  }

  private async request<T>(path: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const callerSignal = init.signal;
    const cancel = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new PrReviewRequestTimeoutError(this.context.provider)), REQUEST_DEADLINE_MS);
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
      if (controller.signal.aborted) rejectAborted();
    });
    try {
      const operation = (async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(`${this.context.apiBaseUrl}${path}`, { ...init, signal: controller.signal });
        // Also cover clients/transports that deliver a late response after abort.
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        this.latestRateLimit = rateLimitFromHeaders(response.headers) ?? this.latestRateLimit;
        return consume(response);
      })();
      // One deadline includes headers, success bodies, and API error bodies.
      // Do not retry here: writes may have succeeded before the connection stalled.
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }

  private async buildApiError(response: Response, path: string): Promise<PrReviewHttpError> {
    const message = await responseErrorMessage(response);
    const hint = prReviewErrorHint(this.context.provider, path, response.status);
    const providerName = this.context.provider === "github" ? "GitHub" : "GitLab";
    const detail = hint ? `${message}. ${hint}` : message;
    return new PrReviewHttpError(
      `${providerName} API ${String(response.status)}: ${detail}`,
      response.status,
      retryDelayFromHeaders(response.headers, response.status),
    );
  }
}
