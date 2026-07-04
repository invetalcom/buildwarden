import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ModelRecord,
  ProjectForgeActivityItem,
  ProjectForgeReviewThread,
  ProjectRecord,
  ProviderAccountRecord,
  RunInput,
  RunRecord,
  SubmitProjectPrMrCommentsInput,
} from "@buildwarden/shared";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { GitService } from "@buildwarden/git-service";
import type { ProjectPrReviewProvider } from "../pr-review/pr-review-types";
import { ProjectLoopRunner, type ProjectLoopRunnerDeps } from "./loop-runner";

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the loop to reach the expected state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("ProjectLoopRunner", () => {
  let tempRoot: string;
  let db: BuildWardenDatabase;
  let project: ProjectRecord;
  let provider: ProviderAccountRecord;
  let model: ModelRecord;
  let askTextCalls: string[];
  let planResponse: string;
  let prReviewResponse: string;
  let forgeState: {
    merged: boolean;
    createRequests: number;
    threads: ProjectForgeReviewThread[];
    activity: ProjectForgeActivityItem[];
    submitted: SubmitProjectPrMrCommentsInput[];
    replies: Array<{ threadId: string; body: string }>;
    resolvedThreadIds: string[];
    commentCounter: number;
  };
  let worktreeSetup: ((worktreePath: string) => void) | null;
  let runner: ProjectLoopRunner;

  const fakeGitService = {
    fetchProjectBranches: async () => undefined,
    hasRemoteBranch: async () => false,
    hasChanges: async () => false,
    commitAllChanges: async () => ({ commitHash: "abc123" }),
    publishBranch: async (_worktreePath: string, branchName: string) => ({ branchName, remoteName: "origin" }),
    createGitClient: () => ({
      raw: async () => "1\n",
    }),
  } as unknown as GitService;

  const fakeForgeProvider = (): ProjectPrReviewProvider =>
    ({
      createRequest: async (input: { sourceBranch: string; targetBranch: string; title: string }) => {
        forgeState.createRequests += 1;
        return {
          provider: "github" as const,
          number: 41,
          title: input.title,
          url: "https://github.com/acme/repo/pull/41",
          state: "open",
          draft: false,
          author: "loop-bot",
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          createdAt: null,
          updatedAt: null,
        };
      },
      getRequestDetails: async () => ({
        provider: "github" as const,
        webBaseUrl: "https://github.com/acme/repo",
        repoLabel: "acme/repo",
        request: {
          provider: "github" as const,
          number: 41,
          title: "PR",
          url: "https://github.com/acme/repo/pull/41",
          state: forgeState.merged ? "merged" : "open",
          draft: false,
          author: "loop-bot",
          sourceBranch: "branch",
          targetBranch: "main",
          description: "",
          authorUser: null,
          labels: [],
          createdAt: null,
          updatedAt: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          commentCount: null,
          reviewCommentCount: null,
        },
        activity: [...forgeState.activity],
        commits: [],
        files: [],
        reviewThreads: forgeState.threads.map((thread) => ({ ...thread, comments: [...thread.comments] })),
        warnings: [],
      }),
      getRequestApprovalStatus: async () => ({ approved: false, approvedBy: [] }),
      mergeRequest: async () => {
        forgeState.merged = true;
        return { message: "merged", url: "https://github.com/acme/repo/pull/41" };
      },
      listRequests: async () => ({
        provider: "github" as const,
        webBaseUrl: "https://github.com/acme/repo",
        repoLabel: "acme/repo",
        items: [],
      }),
      replyToThread: async (input: { threadId: string; body: string }) => {
        forgeState.replies.push({ threadId: input.threadId, body: input.body });
        const thread = forgeState.threads.find((entry) => entry.providerThreadId === input.threadId);
        forgeState.commentCounter += 1;
        thread?.comments.push({
          id: `c${String(forgeState.commentCounter)}`,
          providerCommentId: `c${String(forgeState.commentCounter)}`,
          body: input.body,
          author: { username: "loop-bot", name: null, avatarUrl: null, webUrl: null },
          createdAt: null,
          updatedAt: null,
          url: null,
        });
        return { message: "ok" };
      },
      resolveThread: async (input: { threadId: string; resolved: boolean }) => {
        forgeState.resolvedThreadIds.push(input.threadId);
        const thread = forgeState.threads.find((entry) => entry.providerThreadId === input.threadId);
        if (thread) {
          thread.resolved = input.resolved;
        }
        return { message: "ok" };
      },
      postReview: async (input: { body: string }) => {
        forgeState.commentCounter += 1;
        forgeState.activity.push({
          id: `a${String(forgeState.commentCounter)}`,
          provider: "github" as const,
          kind: "comment" as const,
          title: "Comment",
          body: input.body,
          state: null,
          path: null,
          line: null,
          url: null,
          createdAt: null,
          updatedAt: null,
          author: { username: "loop-bot", name: null, avatarUrl: null, webUrl: null },
        });
        return { message: "ok" };
      },
      getRequestDiff: async () => ({
        diff: "diff --git a/src/app.ts b/src/app.ts\n+const x = 1;\n",
        provider: "github" as const,
        number: 41,
        baseRef: "main",
      }),
      submitComments: async (input: SubmitProjectPrMrCommentsInput) => {
        forgeState.submitted.push(input);
        for (const comment of input.comments) {
          forgeState.commentCounter += 1;
          const commentId = `c${String(forgeState.commentCounter)}`;
          forgeState.threads.push({
            id: `t${commentId}`,
            providerThreadId: `pt${commentId}`,
            replyToCommentId: commentId,
            provider: "github" as const,
            path: comment.newPath,
            oldPath: null,
            side: "new" as const,
            oldLineNumber: null,
            newLineNumber: comment.newLineNumber,
            commitSha: null,
            diffHunk: null,
            resolved: false,
            comments: [
              {
                id: commentId,
                providerCommentId: commentId,
                body: comment.body,
                author: { username: "loop-bot", name: null, avatarUrl: null, webUrl: null },
                createdAt: null,
                updatedAt: null,
                url: null,
              },
            ],
          });
        }
        return { message: "ok" };
      },
    }) as unknown as ProjectPrReviewProvider;

  const createCompletedIterationRun = async (input: RunInput): Promise<RunRecord> => {
    const worktreePath = mkdtempSync(join(tempRoot, "worktree-"));
    worktreeSetup?.(worktreePath);
    const run = db.createRun({
      ...input,
      branchName: `loop-branch-${String(Date.now())}`,
      worktreePath,
    });
    // The fake provider "finishes" instantly: mark the run completed before the engine waits on it.
    db.updateRunStatus(run.id, "completed", { summary: "Implemented the iteration." });
    return db.getRun(run.id);
  };

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "buildwarden-loop-test-"));
    db = new BuildWardenDatabase(join(tempRoot, "test.sqlite"));
    await db.init();
    project = db.addProject({ repoPath: join(tempRoot, "repo"), resolvedName: "Repo", defaultBranch: "main", kind: "git" });
    provider = db.addProviderAccount({
      providerType: "claude-code",
      label: "Claude",
      apiBaseUrl: null,
      apiKeyRef: "test-ref",
      configJson: "{}",
    });
    model = db.addModel({ providerAccountId: provider.id, modelId: "sonnet", displayName: "Sonnet" });
    askTextCalls = [];
    forgeState = {
      merged: false,
      createRequests: 0,
      threads: [],
      activity: [],
      submitted: [],
      replies: [],
      resolvedThreadIds: [],
      commentCounter: 0,
    };
    prReviewResponse = '{"summary":"Looks good.","findings":[]}';
    worktreeSetup = null;
    planResponse = JSON.stringify({
      summary: "One focused PR.",
      iterations: [{ title: "Implement the change", objective: "Do the whole change in one PR." }],
    });

    const deps: ProjectLoopRunnerDeps = {
      db,
      gitService: fakeGitService,
      uiReviewImageRoot: join(tempRoot, "ui-images"),
      createIterationRun: createCompletedIterationRun,
      followUpRun: async (runId) => {
        db.updateRunStatus(runId, "completed", { summary: "Applied the feedback." });
        return db.getRun(runId);
      },
      cancelRun: async () => undefined,
      deleteRun: async (runId) => {
        db.deleteRun(runId);
      },
      askModelForText: async (_cwd, _modelId, input) => {
        askTextCalls.push(input.prompt.slice(0, 60));
        if (input.prompt.includes("planning agent")) {
          return planResponse;
        }
        if (input.prompt.includes("UI review agent")) {
          return '{"verdict":"approve","feedback":""}';
        }
        if (input.prompt.includes("code review agent")) {
          return prReviewResponse;
        }
        return "Audit: everything merged cleanly.";
      },
      createForgeProvider: async () => fakeForgeProvider(),
      emitLoopChanged: () => undefined,
      logError: () => undefined,
      logWarn: () => undefined,
    };
    runner = new ProjectLoopRunner(deps);
  });

  afterEach(async () => {
    await db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("runs a full loop lifecycle: plan, implement, PR, merge, audit", async () => {
    forgeState.merged = false;
    const loop = await runner.startLoop({
      projectId: project.id,
      name: "Test loop",
      prompt: "Add a widget",
      runnerModelId: model.id,
      mergePolicy: "auto-merge",
      uiChangePolicy: "auto",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "completed");

    const detail = db.getProjectLoopDetail(loop.id);
    expect(detail.iterations).toHaveLength(1);
    expect(detail.iterations[0]?.status).toBe("merged");
    expect(detail.iterations[0]?.prUrl).toBe("https://github.com/acme/repo/pull/41");
    expect(forgeState.createRequests).toBe(1);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.kind).toBe("loop-iteration");
    expect(detail.events.some((event) => event.role === "audit")).toBe(true);
    expect(detail.loop.planSummary).toBe("One focused PR.");
  });

  it("plans multiple sequential PR iterations", async () => {
    planResponse = JSON.stringify({
      summary: "Two PRs.",
      iterations: [
        { title: "Backend", objective: "Implement the backend." },
        { title: "Frontend", objective: "Implement the frontend." },
      ],
    });
    const loop = await runner.startLoop({
      projectId: project.id,
      name: "Two PR loop",
      prompt: "Bigger feature",
      runnerModelId: model.id,
      mergePolicy: "auto-merge",
      uiChangePolicy: "auto",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "completed");
    const detail = db.getProjectLoopDetail(loop.id);
    expect(detail.iterations.map((iteration) => iteration.status)).toEqual(["merged", "merged"]);
    expect(detail.runs).toHaveLength(2);
    expect(forgeState.createRequests).toBe(2);
  });

  it("pauses for manual UI approval and resumes after the decision", async () => {
    worktreeSetup = (worktreePath) => {
      const reviewDir = join(worktreePath, ".buildwarden", "ui-review");
      mkdirSync(reviewDir, { recursive: true });
      // Minimal 1x1 PNG.
      writeFileSync(
        join(reviewDir, "dashboard.png"),
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
      );
      writeFileSync(
        join(reviewDir, "manifest.json"),
        JSON.stringify({ pages: [{ name: "Dashboard", file: "dashboard.png", description: "New chart" }] }),
      );
    };

    const loop = await runner.startLoop({
      projectId: project.id,
      name: "UI loop",
      prompt: "Change the dashboard",
      runnerModelId: model.id,
      mergePolicy: "auto-merge",
      uiChangePolicy: "manual-approval",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "awaiting-ui-approval");
    const pending = db.listProjectLoopUiReviews(loop.id).filter((review) => review.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.pageName).toBe("Dashboard");
    expect(runner.getUiReviewImageDataUrl(pending[0]!.id)).toMatch(/^data:image\/png;base64,/);

    // Approving the only page lets the loop continue to PR creation and completion.
    worktreeSetup = null;
    await runner.respondToUiReview(pending[0]!.id, { decision: "approve" });
    await waitFor(() => db.getProjectLoop(loop.id).status === "completed");
    expect(db.getProjectLoopDetail(loop.id).iterations[0]?.status).toBe("merged");
  });

  it("posts a visible AI PR review, then addresses and resolves its findings", async () => {
    prReviewResponse = JSON.stringify({
      summary: "One issue found.",
      findings: [{ path: "src/app.ts", line: 2, severity: "high", comment: "Guard against x being undefined." }],
    });

    const loop = await runner.startLoop({
      projectId: project.id,
      name: "Reviewed loop",
      prompt: "Add a guarded value",
      runnerModelId: model.id,
      mergePolicy: "auto-merge",
      uiChangePolicy: "auto",
      prReviewPolicy: "ai-review",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "completed");

    // The review was posted as an inline comment on the PR diff.
    expect(forgeState.submitted).toHaveLength(1);
    const submitted = forgeState.submitted[0]!;
    expect(submitted.comments[0]).toMatchObject({ newPath: "src/app.ts", newLineNumber: 2 });
    expect(submitted.comments[0]?.body).toContain("Guard against x being undefined.");

    // The loop then treated its own review like reviewer feedback: fixed, replied, resolved.
    expect(forgeState.replies).toHaveLength(1);
    expect(forgeState.replies[0]?.body).toContain("Addressed in the latest commit");
    expect(forgeState.resolvedThreadIds).toHaveLength(1);

    const detail = db.getProjectLoopDetail(loop.id);
    expect(detail.iterations[0]?.status).toBe("merged");
    expect(detail.iterations[0]?.aiReviewPosted).toBe(1);
    expect(detail.events.some((event) => event.label.startsWith("AI PR review posted"))).toBe(true);
    expect(detail.events.some((event) => event.label === "Review comments addressed")).toBe(true);
  });

  it("posts an informational note when the AI PR review finds nothing", async () => {
    prReviewResponse = '{"summary":"No blocking issues.","findings":[]}';
    const loop = await runner.startLoop({
      projectId: project.id,
      name: "Clean review loop",
      prompt: "Small change",
      runnerModelId: model.id,
      mergePolicy: "auto-merge",
      uiChangePolicy: "auto",
      prReviewPolicy: "ai-review",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "completed");
    // The clean-review note carries the loop marker, so it never triggers the fix cycle.
    expect(forgeState.activity).toHaveLength(1);
    expect(forgeState.activity[0]?.body).toContain("BuildWarden Loop automated reply");
    expect(forgeState.replies).toHaveLength(0);
    expect(db.getProjectLoopDetail(loop.id).iterations[0]?.status).toBe("merged");
  });

  it("rejects non-local runner models", async () => {
    const remoteProvider = db.addProviderAccount({
      providerType: "ai-sdk",
      label: "Remote",
      apiBaseUrl: null,
      apiKeyRef: "remote-ref",
      configJson: "{}",
    });
    const remoteModel = db.addModel({ providerAccountId: remoteProvider.id, modelId: "gpt-5.5", displayName: "GPT" });
    await expect(
      runner.startLoop({
        projectId: project.id,
        name: "Bad loop",
        prompt: "Nope",
        runnerModelId: remoteModel.id,
        mergePolicy: "auto-merge",
        uiChangePolicy: "auto",
      }),
    ).rejects.toThrow(/local providers/);
  });

  it("cancels an active loop and deletes it with its runs", async () => {
    forgeState.merged = false;
    // Keep the PR un-merged and block merging so the loop stays in awaiting-merge.
    const loop = await runner.startLoop({
      projectId: project.id,
      name: "Cancelled loop",
      prompt: "Cancel me",
      runnerModelId: model.id,
      mergePolicy: "wait-for-approval",
      uiChangePolicy: "auto",
    });

    await waitFor(() => db.getProjectLoop(loop.id).status === "awaiting-merge");
    await runner.cancelLoop(loop.id);
    expect(db.getProjectLoop(loop.id).status).toBe("cancelled");
    expect(db.getProjectLoopDetail(loop.id).iterations[0]?.status).toBe("cancelled");

    await runner.deleteLoop(loop.id);
    expect(() => db.getProjectLoop(loop.id)).toThrow(/not found/);
    expect(db.listRunsForProject(project.id)).toHaveLength(0);
  });
});
