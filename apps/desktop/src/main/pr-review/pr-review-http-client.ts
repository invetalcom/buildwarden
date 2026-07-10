import type { ProjectForgeProvider } from "@buildwarden/shared";
import type { ProjectPrReviewRemoteContext } from "./pr-review-types";
import { isRecord } from "./pr-review-utils";

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

export class PrReviewHttpClient {
  constructor(
    private readonly context: ProjectPrReviewRemoteContext,
    private readonly token: string,
  ) {}

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const result = await this.jsonWithHeaders(path, init);
    return result.payload;
  }

  async jsonWithHeaders(path: string, init: RequestInit = {}): Promise<{ payload: unknown; headers: Headers }> {
    const headers = new Headers(init.headers);
    if (this.context.provider === "github") {
      headers.set("Accept", "application/vnd.github+json");
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    } else {
      headers.set("Accept", "application/json");
      headers.set("PRIVATE-TOKEN", this.token);
    }

    const response = await fetch(`${this.context.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw await this.buildApiError(response, path);
    }
    return {
      payload: await readJsonResponse(response),
      headers: response.headers,
    };
  }

  async text(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (this.context.provider === "github") {
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/vnd.github+json");
      }
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    } else {
      if (!headers.has("Accept")) {
        headers.set("Accept", "text/plain");
      }
      headers.set("PRIVATE-TOKEN", this.token);
    }

    const response = await fetch(`${this.context.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw await this.buildApiError(response, path);
    }
    return response.text();
  }

  private async buildApiError(response: Response, path: string): Promise<Error> {
    const message = await responseErrorMessage(response);
    const hint = prReviewErrorHint(this.context.provider, path, response.status);
    const providerName = this.context.provider === "github" ? "GitHub" : "GitLab";
    const detail = hint ? `${message}. ${hint}` : message;
    return new Error(`${providerName} API ${String(response.status)}: ${detail}`);
  }
}
