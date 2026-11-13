import type { ProjectForgeIssueSummary, ProjectForgeIssueWorkLink } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { ForgeIssueService } from "./forge-issue-service";

const githubContext: ProjectPrReviewRemoteContext = {
  provider: "github",
  webBaseUrl: "https://github.com/acme/widgets",
  repoLabel: "acme/widgets",
  apiBaseUrl: "https://api.github.com",
  github: { owner: "acme", repo: "widgets" },
};

const gitlabContext: ProjectPrReviewRemoteContext = {
  provider: "gitlab",
  webBaseUrl: "https://gitlab.com/acme/widgets",
  repoLabel: "acme/widgets",
  apiBaseUrl: "https://gitlab.com/api/v4",
  gitlab: { projectPath: "acme/widgets", encodedProjectPath: "acme%2Fwidgets" },
};

const githubIssue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${String(number)}`,
  html_url: `https://github.com/acme/widgets/issues/${String(number)}`,
  state: "open",
  user: { login: "octocat", avatar_url: "https://example.test/a.png", html_url: "https://github.com/octocat" },
  labels: [{ name: "bug", color: "D73A4A", description: "Something is broken" }],
  assignees: [],
  milestone: null,
  comments: 2,
  body: "It **breaks** on start.",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  closed_at: null,
  locked: false,
  ...extra,
});

type Route = { status?: number; body: unknown; headers?: Record<string, string> };
type Call = { url: string; method: string; headers: Headers; body: unknown };

const stubFetch = (route: (call: Call) => Route) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    const { status = 200, body, headers = {} } = route(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  });
  return calls;
};

const createService = (options: {
  context?: ProjectPrReviewRemoteContext;
  token?: string | null;
  links?: ProjectForgeIssueWorkLink[];
  now?: () => number;
  onIssuesObserved?: (projectId: string, issues: ProjectForgeIssueSummary[]) => void;
} = {}) =>
  new ForgeIssueService({
    resolveContext: async () => options.context ?? githubContext,
    readToken: async () => options.token ?? null,
    getRepoPath: () => "/nonexistent-repo",
    listLinks: () => options.links ?? [],
    onIssuesObserved: options.onIssuesObserved,
    now: options.now,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ForgeIssueService without a token", () => {
  it("lists public issues read-only, without credentials, and leaves out pull requests", async () => {
    const calls = stubFetch(() => ({
      body: [githubIssue(7), githubIssue(8, { pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/8" } })],
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1900000000" },
    }));
    const result = await createService().listIssues("project-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/repos/acme/widgets/issues?state=open");
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(result.unavailable).toBeNull();
    expect(result.items.map((issue) => issue.number)).toEqual([7]);
    expect(result.items[0]).toMatchObject({ state: "open", author: "octocat", commentCount: 2, labels: [{ name: "bug", color: "d73a4a" }] });
    expect(result.items[0]).not.toHaveProperty("body");
    expect(result.access).toMatchObject({ mode: "anonymous", canWrite: false, canTriage: false, viewer: null, rateLimit: { limit: 60, remaining: 59 } });
  });

  it("asks for a token when the repository is not public", async () => {
    stubFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    const result = await createService().listIssues("project-1");
    expect(result.items).toEqual([]);
    expect(result.unavailable?.reason).toBe("needs-token");
  });

  it("reports an exhausted request budget with the time it refills", async () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    const resetSeconds = Math.round(now / 1_000) + 900;
    stubFetch(() => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) },
    }));
    vi.useFakeTimers({ now });
    try {
      const result = await createService({ now: () => now }).listIssues("project-1");
      expect(result.unavailable?.reason).toBe("rate-limited");
      expect(result.unavailable?.retryAt).toBe(new Date(resetSeconds * 1_000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a listed issue when opening it, and reuses the list within its cache window", async () => {
    const calls = stubFetch((call) =>
      call.url.includes("/timeline")
        ? { body: [{ event: "commented", id: 1, body: "Same here.", user: { login: "hubot" }, created_at: "2026-11-02T09:00:00Z" }] }
        : { body: [githubIssue(7)] },
    );
    const service = createService();
    await service.listIssues("project-1");
    const second = await service.listIssues("project-1");
    const details = await service.getIssueDetails("project-1", { issueNumber: 7 });

    expect(second.fromCache).toBe(true);
    // One request for the list and one for the conversation; the issue itself is not fetched again.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/repos/acme/widgets/issues", "/repos/acme/widgets/issues/7/timeline"]);
    expect(details.issue.body).toBe("It **breaks** on start.");
    expect(details.timeline).toMatchObject([{ kind: "comment", body: "Same here.", author: { username: "hubot" } }]);
  });

  it("refuses to change issues", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    await expect(createService().commentIssue("project-1", { issueNumber: 7, body: "Thanks" })).rejects.toThrow(/access token/);
    expect(calls).toHaveLength(0);
  });
});

describe("ForgeIssueService with a token", () => {
  const tokenRoutes = (call: Call): Route => {
    const { pathname } = new URL(call.url);
    if (pathname === "/user") return { body: { login: "maintainer" } };
    if (pathname === "/repos/acme/widgets") return { body: { has_issues: true, permissions: { pull: true, triage: true } } };
    if (pathname === "/repos/acme/widgets/issues" && call.method === "GET") return { body: [githubIssue(7, { assignees: [{ login: "maintainer" }] })] };
    if (pathname === "/repos/acme/widgets/issues/7/comments") return { status: 201, body: { html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1" } };
    return { status: 404, body: { message: "Not Found" } };
  };

  it("sends the token and reports what it may do", async () => {
    const calls = stubFetch(tokenRoutes);
    const result = await createService({ token: " secret " }).listIssues("project-1", { assignee: "@me" });

    expect(calls.every((call) => call.headers.get("authorization") === "Bearer secret")).toBe(true);
    expect(calls.at(-1)?.url).toContain("assignee=maintainer");
    expect(result.access).toMatchObject({ mode: "token", canWrite: true, canTriage: true, viewer: "maintainer" });
  });

  it("posts a comment and drops cached lists so the next fetch is fresh", async () => {
    const calls = stubFetch(tokenRoutes);
    const service = createService({ token: "secret" });
    await service.listIssues("project-1");
    const result = await service.commentIssue("project-1", { issueNumber: 7, body: "  Fixed in the next release.  " });
    const after = await service.listIssues("project-1");

    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ body: "Fixed in the next release." });
    expect(result).toMatchObject({ url: "https://github.com/acme/widgets/issues/7#issuecomment-1", issue: { number: 7, commentCount: 3 } });
    expect(after.fromCache).toBe(false);
  });

  it("reads an unknown issue before commenting, so a failed read never follows a posted comment", async () => {
    const calls = stubFetch((call) => (new URL(call.url).pathname === "/repos/acme/widgets/issues/7" ? { status: 500, body: { message: "Server Error" } } : tokenRoutes(call)));
    await expect(createService({ token: "secret" }).commentIssue("project-1", { issueNumber: 7, body: "Thanks" })).rejects.toThrow();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("explains a rejected write in terms of the missing permission", async () => {
    stubFetch((call) => (call.method === "PATCH" ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : tokenRoutes(call)));
    await expect(createService({ token: "secret" }).updateIssue("project-1", { issueNumber: 7, labels: ["bug"] })).rejects.toThrow(/"Issues" repository permission/);
  });

  it("says issues are switched off instead of listing nothing", async () => {
    stubFetch((call) => (new URL(call.url).pathname === "/repos/acme/widgets" ? { body: { has_issues: false, permissions: {} } } : tokenRoutes(call)));
    const result = await createService({ token: "secret" }).listIssues("project-1");
    expect(result.unavailable?.reason).toBe("issues-disabled");
  });

  it("hands observed issues to the caller so linked tasks can follow them", async () => {
    stubFetch(tokenRoutes);
    const observed: number[] = [];
    await createService({ token: "secret", onIssuesObserved: (_projectId, issues) => observed.push(...issues.map((issue) => issue.number)) }).listIssues("project-1");
    expect(observed).toEqual([7]);
  });

  it("notifies about new comments only on issues the user is involved in, after a baseline", async () => {
    let comments = 2;
    stubFetch((call) => {
      const { pathname } = new URL(call.url);
      if (pathname === "/repos/acme/widgets/issues") {
        return { body: [githubIssue(7, { comments, assignees: [{ login: "maintainer" }] }), githubIssue(9, { comments })] };
      }
      return tokenRoutes(call);
    });
    const service = createService({ token: "secret" });

    expect(await service.collectNotifications("project-1")).toEqual([]);
    comments = 3;
    const notifications = await service.collectNotifications("project-1");
    expect(notifications.map((entry) => [entry.kind, entry.issue.number])).toEqual([["new-comment", 7]]);
  });
});

describe("ForgeIssueService on GitLab", () => {
  it("maps GitLab issues and their merge requests to the shared shape", async () => {
    const calls = stubFetch((call) => {
      const { pathname } = new URL(call.url);
      if (pathname.endsWith("/issues")) {
        return {
          body: [{
            iid: 4,
            title: "Crash on export",
            web_url: "https://gitlab.com/acme/widgets/-/issues/4",
            state: "opened",
            author: { username: "ada", name: "Ada" },
            labels: [{ name: "priority::high", color: "#FF0000", description: null }],
            assignees: [],
            user_notes_count: 1,
            description: "- [x] reproduce\n- [ ] fix",
            confidential: true,
            weight: 3,
            issue_type: "incident",
            task_completion_status: { count: 2, completed_count: 1 },
            upvotes: 2,
            downvotes: 0,
          }],
          headers: { "x-next-page": "2" },
        };
      }
      if (pathname.endsWith("/notes")) {
        return { body: [{ id: 11, body: "added ~bug label", system: true, author: { username: "ada" } }, { id: 12, body: "Looking into it.", system: false, author: { username: "bob" } }] };
      }
      if (pathname.endsWith("/closed_by")) return { body: [{ iid: 20, title: "Fix export", web_url: "https://gitlab.com/acme/widgets/-/merge_requests/20", state: "opened", draft: true }] };
      if (pathname.endsWith("/related_merge_requests")) return { body: [{ iid: 20, title: "Fix export", web_url: "https://gitlab.com/acme/widgets/-/merge_requests/20", state: "opened" }] };
      return { status: 404, body: {} };
    });
    const service = createService({ context: gitlabContext });
    const list = await service.listIssues("project-1", { state: "all" });
    const details = await service.getIssueDetails("project-1", { issueNumber: 4 });

    expect(calls[0]?.headers.has("private-token")).toBe(false);
    expect(new URL(calls[0]?.url ?? "").searchParams.has("state")).toBe(false);
    expect(list.hasMore).toBe(true);
    expect(list.items[0]).toMatchObject({
      number: 4,
      state: "open",
      confidential: true,
      weight: 3,
      issueType: "incident",
      taskProgress: { completed: 1, total: 2 },
      labels: [{ name: "priority::high", color: "ff0000" }],
      reactions: [{ content: "👍", count: 2 }],
    });
    expect(details.timeline.map((item) => item.kind)).toEqual(["event", "comment"]);
    expect(details.linkedRequests).toEqual([expect.objectContaining({ number: 20, state: "open", relation: "closes", draft: true })]);
  });
});
