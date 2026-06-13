import { describe, expect, it } from "vitest";
import type { PrReviewHttpClient } from "./pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "./pr-review/pr-review-types";
import { GithubPrReviewProvider } from "./pr-review/github-pr-review-provider";
import { GitlabMrReviewProvider } from "./pr-review/gitlab-mr-review-provider";

type FakeCall = {
  kind: "json" | "jsonWithHeaders" | "text";
  path: string;
  init?: RequestInit;
};

class FakePrReviewHttp {
  readonly calls: FakeCall[] = [];

  constructor(
    private readonly jsonRoutes: Record<string, unknown>,
    private readonly textRoutes: Record<string, string> = {},
  ) {}

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    this.calls.push({ kind: "json", path, init });
    return this.readRoute(this.jsonRoutes, path);
  }

  async jsonWithHeaders(path: string, init: RequestInit = {}): Promise<{ payload: unknown; headers: Headers }> {
    this.calls.push({ kind: "jsonWithHeaders", path, init });
    return {
      payload: this.readRoute(this.jsonRoutes, path),
      headers: new Headers(),
    };
  }

  async text(path: string, init: RequestInit = {}): Promise<string> {
    this.calls.push({ kind: "text", path, init });
    return String(this.readRoute(this.textRoutes, path));
  }

  private readRoute(routes: Record<string, unknown>, path: string): unknown {
    if (!(path in routes)) {
      throw new Error(`Missing fake route: ${path}`);
    }
    const value = routes[path];
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}

const githubContext: ProjectPrReviewRemoteContext = {
  provider: "github",
  webBaseUrl: "https://github.com/invetalcom/stockgenius",
  repoLabel: "invetalcom/stockgenius",
  apiBaseUrl: "https://api.github.com",
  github: { owner: "invetalcom", repo: "stockgenius" },
};

const gitlabContext: ProjectPrReviewRemoteContext = {
  provider: "gitlab",
  webBaseUrl: "https://gitlab.com/group/project",
  repoLabel: "group/project",
  apiBaseUrl: "https://gitlab.com/api/v4",
  gitlab: { projectPath: "group/project", encodedProjectPath: "group%2Fproject" },
};

const githubPull = {
  number: 11,
  node_id: "pull-request-node-11",
  title: "WorkOS integration",
  html_url: "https://github.com/invetalcom/stockgenius/pull/11",
  state: "open",
  draft: false,
  body: "Adds SSO.",
  user: { login: "invetalcom", avatar_url: "https://example.test/avatar.png" },
  head: { ref: "feature/workos", sha: "head-sha-123" },
  base: { ref: "main" },
  labels: [{ name: "auth" }],
  additions: 24,
  deletions: 3,
  changed_files: 2,
  comments: 1,
  review_comments: 1,
  created_at: "2026-05-26T12:00:00Z",
  updated_at: "2026-05-26T13:00:00Z",
};

describe("PR/MR review providers", () => {
  it("maps GitHub commits, changed files, review threads, and commit timeline events", async () => {
    const commitSha = "abcdef1234567890";
    const fake = new FakePrReviewHttp({
      "/repos/invetalcom/stockgenius/pulls/11": githubPull,
      "/repos/invetalcom/stockgenius/issues/11/comments?per_page=100": [],
      "/repos/invetalcom/stockgenius/pulls/11/reviews?per_page=100": [],
      "/repos/invetalcom/stockgenius/pulls/11/comments?per_page=100": [
        {
          id: 991,
          body: "Check this config.",
          path: "Backend/src/WorkOSConfig.java",
          line: 13,
          side: "RIGHT",
          commit_id: commitSha,
          user: { login: "reviewer" },
          html_url: "https://github.com/invetalcom/stockgenius/pull/11#discussion_r991",
          created_at: "2026-05-26T14:00:00Z",
        },
      ],
      "/repos/invetalcom/stockgenius/issues/11/timeline?per_page=100": [
        {
          id: 44,
          event: "committed",
          commit_id: commitSha,
          commit: { message: "Add WorkOS config" },
          actor: { login: "invetalcom" },
          created_at: "2026-05-26T12:30:00Z",
        },
      ],
      "/repos/invetalcom/stockgenius/pulls/11/commits?per_page=100": [
        {
          sha: commitSha,
          html_url: "https://github.com/invetalcom/stockgenius/commit/abcdef",
          author: { login: "invetalcom" },
          commit: {
            message: "Add WorkOS config\n\nDetails",
            author: { name: "Rudolf", email: "r@example.test", date: "2026-05-26T12:00:00Z" },
            committer: { name: "Rudolf", date: "2026-05-26T12:10:00Z" },
            comment_count: 2,
          },
        },
      ],
      "/repos/invetalcom/stockgenius/pulls/11/files?per_page=100": [
        {
          filename: "Backend/src/WorkOSConfig.java",
          status: "modified",
          additions: 12,
          deletions: 1,
          patch: "@@ -1 +1 @@",
        },
      ],
      "/graphql": {
        data: {
          node: {
            reviewThreads: {
              nodes: [
                {
                  id: "github-thread-node-1",
                  isResolved: false,
                  path: "Backend/src/WorkOSConfig.java",
                  line: 13,
                  diffSide: "RIGHT",
                  comments: {
                    nodes: [
                      {
                        id: "github-comment-node-991",
                        databaseId: 991,
                        body: "Check this config.",
                        author: { login: "reviewer" },
                        createdAt: "2026-05-26T14:00:00Z",
                        url: "https://github.com/invetalcom/stockgenius/pull/11#discussion_r991",
                        path: "Backend/src/WorkOSConfig.java",
                        line: 13,
                        diffHunk: "@@ -12,3 +12,3 @@\n context\n+Check this config.",
                        commit: { oid: commitSha },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const provider = new GithubPrReviewProvider(githubContext as typeof githubContext & { provider: "github"; github: NonNullable<typeof githubContext.github> }, fake as unknown as PrReviewHttpClient);

    const result = await provider.getRequestDetails({ prUrl: "https://github.com/invetalcom/stockgenius/pull/11" });

    expect(result.commits).toMatchObject([{ sha: commitSha, shortSha: "abcdef1", title: "Add WorkOS config", commentCount: 2 }]);
    expect(result.files).toMatchObject([{ path: "Backend/src/WorkOSConfig.java", additions: 12, deletions: 1, commentCount: 1 }]);
    expect(result.reviewThreads[0]).toMatchObject({
      provider: "github",
      path: "Backend/src/WorkOSConfig.java",
      side: "new",
      newLineNumber: 13,
      commitSha,
      diffHunk: "@@ -12,3 +12,3 @@\n context\n+Check this config.",
      replyToCommentId: "991",
    });
    expect(result.activity.find((item) => item.kind === "event" && item.state === "committed")?.commitSha).toBe(commitSha);
  });

  it("uses GitHub commit diffs plus separate single and batched review comment endpoints", async () => {
    const fake = new FakePrReviewHttp(
      {
        "/repos/invetalcom/stockgenius/pulls/11": githubPull,
        "/repos/invetalcom/stockgenius/pulls/11/comments": { html_url: "https://github.com/comment/1" },
        "/repos/invetalcom/stockgenius/pulls/11/reviews": { html_url: "https://github.com/review/1" },
        "/repos/invetalcom/stockgenius/pulls/11/comments/991/replies": { html_url: "https://github.com/reply/1" },
        "/graphql": { data: { resolveReviewThread: { thread: { id: "thread-node", isResolved: true } } } },
      },
      {
        "/repos/invetalcom/stockgenius/commits/abcdef1234567890": "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b",
      },
    );
    const provider = new GithubPrReviewProvider(githubContext as typeof githubContext & { provider: "github"; github: NonNullable<typeof githubContext.github> }, fake as unknown as PrReviewHttpClient);
    const comment = {
      oldPath: "a.ts",
      newPath: "a.ts",
      side: "new" as const,
      oldLineNumber: null,
      newLineNumber: 1,
      changeType: "insert" as const,
      body: "Looks good.",
    };

    const diff = await provider.getRequestDiff({ prUrl: "https://github.com/invetalcom/stockgenius/pull/11", commitSha: "abcdef1234567890" });
    await provider.submitComments({ prUrl: "https://github.com/invetalcom/stockgenius/pull/11", mode: "single", comments: [comment] });
    await provider.submitComments({ prUrl: "https://github.com/invetalcom/stockgenius/pull/11", mode: "review", body: "Review summary", comments: [comment] });
    await provider.replyToThread({
      prUrl: "https://github.com/invetalcom/stockgenius/pull/11",
      threadId: "thread-node",
      replyToCommentId: "991",
      body: "Thanks, fixed.",
    });
    await provider.resolveThread({ prUrl: "https://github.com/invetalcom/stockgenius/pull/11", threadId: "thread-node", resolved: true });

    expect(diff.baseRef).toBe("GitHub commit abcdef123456");
    expect(fake.calls.find((call) => call.kind === "text")?.init?.headers).toMatchObject({ Accept: "application/vnd.github.diff" });
    const singleCall = fake.calls.find((call) => call.path.endsWith("/pulls/11/comments") && call.init?.method === "POST");
    expect(JSON.parse(String(singleCall?.init?.body))).toMatchObject({ commit_id: "head-sha-123", path: "a.ts", line: 1, side: "RIGHT" });
    const reviewCall = fake.calls.find((call) => call.path.endsWith("/pulls/11/reviews") && call.init?.method === "POST");
    expect(JSON.parse(String(reviewCall?.init?.body))).toMatchObject({ event: "COMMENT", body: "Review summary", comments: [{ path: "a.ts" }] });
    const replyCall = fake.calls.find((call) => call.path.endsWith("/comments/991/replies") && call.init?.method === "POST");
    expect(JSON.parse(String(replyCall?.init?.body))).toEqual({ body: "Thanks, fixed." });
    const resolveCall = fake.calls.find((call) => call.path === "/graphql" && call.init?.method === "POST");
    expect(String(resolveCall?.init?.body)).toContain("resolveReviewThread");
  });

  it("maps GitLab commits, changed files, resolved discussions, and diff notes", async () => {
    const commitSha = "fedcba9876543210";
    const fake = new FakePrReviewHttp({
      "/projects/group%2Fproject/merge_requests/7": {
        iid: 7,
        title: "WorkOS integration",
        web_url: "https://gitlab.com/group/project/-/merge_requests/7",
        state: "opened",
        draft: false,
        description: "Adds SSO.",
        author: { username: "invetalcom" },
        source_branch: "feature/workos",
        target_branch: "main",
        labels: ["auth"],
        changes_count: "1",
        user_notes_count: 1,
        created_at: "2026-05-26T12:00:00Z",
        updated_at: "2026-05-26T13:00:00Z",
      },
      "/projects/group%2Fproject/merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100": [],
      "/projects/group%2Fproject/merge_requests/7/discussions?per_page=100": [
        {
          id: "discussion-1",
          resolved: true,
          notes: [
            {
              id: 501,
              type: "DiffNote",
              body: "Manual Test",
              author: { username: "reviewer" },
              created_at: "2026-05-26T14:00:00Z",
              position: {
                base_sha: "base",
                start_sha: "start",
                head_sha: commitSha,
                old_path: "Backend/src/WorkOSConfig.java",
                new_path: "Backend/src/WorkOSConfig.java",
                new_line: 13,
              },
            },
          ],
        },
      ],
      "/projects/group%2Fproject/merge_requests/7/resource_state_events?per_page=100": [],
      "/projects/group%2Fproject/merge_requests/7/commits?per_page=100": [
        {
          id: commitSha,
          short_id: "fedcba9",
          title: "Add GitLab WorkOS config",
          message: "Add GitLab WorkOS config\n\nDetails",
          author_name: "Rudolf",
          author_email: "r@example.test",
          committed_date: "2026-05-26T12:10:00Z",
          web_url: "https://gitlab.com/group/project/-/commit/fedcba9",
        },
      ],
      "/projects/group%2Fproject/merge_requests/7/changes": {
        changes: [
          {
            old_path: "Backend/src/WorkOSConfig.java",
            new_path: "Backend/src/WorkOSConfig.java",
            diff: "@@ -1 +1 @@\n-old\n+new",
            new_file: false,
            deleted_file: false,
            renamed_file: false,
          },
        ],
      },
    });
    const provider = new GitlabMrReviewProvider(gitlabContext as typeof gitlabContext & { provider: "gitlab"; gitlab: NonNullable<typeof gitlabContext.gitlab> }, fake as unknown as PrReviewHttpClient);

    const result = await provider.getRequestDetails({ prUrl: "https://gitlab.com/group/project/-/merge_requests/7" });

    expect(result.commits).toMatchObject([{ sha: commitSha, shortSha: "fedcba9", title: "Add GitLab WorkOS config" }]);
    expect(result.files).toMatchObject([{ path: "Backend/src/WorkOSConfig.java", status: "modified", commentCount: 1 }]);
    expect(result.reviewThreads[0]).toMatchObject({
      provider: "gitlab",
      path: "Backend/src/WorkOSConfig.java",
      side: "new",
      newLineNumber: 13,
      commitSha,
      resolved: true,
    });
    expect(result.activity.find((item) => item.kind === "diff-comment")?.commitSha).toBe(commitSha);
  });

  it("uses GitLab commit diff rows and posts single versus batched discussions", async () => {
    const baseRoutes = {
      "/projects/group%2Fproject/merge_requests/7": {
        iid: 7,
        title: "WorkOS integration",
        web_url: "https://gitlab.com/group/project/-/merge_requests/7",
        state: "opened",
        author: { username: "invetalcom" },
        source_branch: "feature/workos",
        target_branch: "main",
        diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" },
      },
      "/projects/group%2Fproject/repository/commits/fedcba9876543210/diff?unidiff=true&per_page=100": [
        {
          old_path: "a.ts",
          new_path: "a.ts",
          diff: "@@ -1 +1 @@\n-old\n+new",
          new_file: false,
          deleted_file: false,
          renamed_file: false,
        },
      ],
      "/projects/group%2Fproject/merge_requests/7/discussions": { id: "discussion" },
      "/projects/group%2Fproject/merge_requests/7/discussions/discussion-1": { id: "discussion-1", resolved: true },
      "/projects/group%2Fproject/merge_requests/7/discussions/discussion-1/notes": { id: 2 },
      "/projects/group%2Fproject/merge_requests/7/notes": { id: 1 },
    };
    const fake = new FakePrReviewHttp(baseRoutes);
    const provider = new GitlabMrReviewProvider(gitlabContext as typeof gitlabContext & { provider: "gitlab"; gitlab: NonNullable<typeof gitlabContext.gitlab> }, fake as unknown as PrReviewHttpClient);
    const comment = {
      oldPath: "a.ts",
      newPath: "a.ts",
      side: "new" as const,
      oldLineNumber: null,
      newLineNumber: 1,
      changeType: "insert" as const,
      body: "Please check this.",
    };

    const diff = await provider.getRequestDiff({ prUrl: "https://gitlab.com/group/project/-/merge_requests/7", commitSha: "fedcba9876543210" });
    await provider.submitComments({ prUrl: "https://gitlab.com/group/project/-/merge_requests/7", mode: "single", comments: [comment] });
    await provider.submitComments({
      prUrl: "https://gitlab.com/group/project/-/merge_requests/7",
      mode: "review",
      body: "Review summary",
      comments: [comment, { ...comment, body: "Second note." }],
    });
    await provider.replyToThread({
      prUrl: "https://gitlab.com/group/project/-/merge_requests/7",
      threadId: "discussion-1",
      body: "Thanks, fixed.",
    });
    await provider.resolveThread({ prUrl: "https://gitlab.com/group/project/-/merge_requests/7", threadId: "discussion-1", resolved: true });

    expect(diff.diff).toContain("diff --git a/a.ts b/a.ts");
    const discussionCalls = fake.calls.filter((call) => call.path.endsWith("/merge_requests/7/discussions") && call.init?.method === "POST");
    expect(discussionCalls).toHaveLength(3);
    expect(String(discussionCalls[0]?.init?.body)).toContain("position%5Bhead_sha%5D=head");
    const summaryCall = fake.calls.find((call) => call.path.endsWith("/merge_requests/7/notes") && call.init?.method === "POST");
    expect(JSON.parse(String(summaryCall?.init?.body))).toEqual({ body: "Review summary" });
    const replyCall = fake.calls.find((call) => call.path.endsWith("/discussions/discussion-1/notes") && call.init?.method === "POST");
    expect(String(replyCall?.init?.body)).toContain("body=Thanks%2C+fixed.");
    const resolveCall = fake.calls.find((call) => call.path.endsWith("/discussions/discussion-1") && call.init?.method === "PUT");
    expect(String(resolveCall?.init?.body)).toBe("resolved=true");
  });
});
