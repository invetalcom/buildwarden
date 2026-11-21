import { describe, expect, it, vi } from "vitest";
import {
  PR_WATCH_MAX_WAKES,
  PR_WATCH_REPLY_MARKER,
  PR_WATCH_REPORT_REPAIR_PROMPT,
  type PrWatchRecord,
  type ProjectForgeActivityItem,
  type ProjectForgeReviewThread,
  type RunForgeCheck,
  type RunForgeRequestSummary,
  type RunRecord,
} from "@buildwarden/shared";
import { PrWatchService, type PrWatchForgeState, type PrWatchHost, type PrWatchStore, type PrWatchTurnResult } from "./pr-watch-service";

const PR_URL = "https://github.com/acme/app/pull/12";
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);

const summary = (overrides: Partial<RunForgeRequestSummary> = {}): RunForgeRequestSummary => ({
  provider: "github", number: 12, title: "Redesign cards", url: PR_URL, state: "open", readiness: "blocked", draft: false,
  mergeability: "mergeable", reviewDecision: "none", author: "dev", sourceBranch: "feat/cards", sourceRepository: "acme/app",
  targetBranch: "main", headSha: HEAD, checks: { completed: 1, total: 1, successful: 0, failed: 1, running: 0 },
  unresolvedThreadCount: 0, supportedActions: ["refresh"], supportedMergeMethods: ["merge"], updatedAt: null,
  lastSyncedAt: "2026-11-21T10:00:00.000Z", stale: false, syncError: null, ...overrides,
});

const failedCheck: RunForgeCheck = { id: "lint", name: "lint", status: "failure", url: null, description: null, startedAt: null, completedAt: null, durationMs: null };

const thread = (id: string, commentId: string, body: string): ProjectForgeReviewThread => ({
  id, providerThreadId: id, replyToCommentId: `${commentId}`, provider: "github", path: "src/card.ts", oldPath: null, side: "new",
  oldLineNumber: null, newLineNumber: 3, commitSha: null, diffHunk: null, resolved: false,
  comments: [{ id: commentId, providerCommentId: commentId, body, author: { username: "reviewer", name: null, avatarUrl: null, webUrl: null }, createdAt: null, updatedAt: null, url: null }],
});

const conversation = (id: string, body: string): ProjectForgeActivityItem => ({
  id, provider: "github", kind: "comment", title: "comment", body, state: null, path: null, line: null, url: null, createdAt: null, updatedAt: null,
  author: { username: "coderabbit[bot]", name: null, avatarUrl: null, webUrl: null },
});

const report = (entries: unknown[]) => `Done.\n\n\`\`\`pr-watch-report\n${JSON.stringify(entries)}\n\`\`\``;

class MemoryStore implements PrWatchStore {
  records = new Map<string, PrWatchRecord>();
  keys = new Map<string, Set<string>>();
  savePrWatch(record: PrWatchRecord) { this.records.set(record.runId, structuredClone(record)); }
  savePrWatches(records: readonly PrWatchRecord[]) { for (const record of records) this.savePrWatch(record); }
  getPrWatch(runId: string) { const record = this.records.get(runId); return record ? structuredClone(record) : null; }
  listPrWatchesWithStatuses(statuses: readonly PrWatchRecord["status"][]) { return [...this.records.values()].filter((record) => statuses.includes(record.status)).map((record) => structuredClone(record)); }
  listPrWatchKeys(runId: string) { return new Set(this.keys.get(runId)); }
  addPrWatchKeys(runId: string, keys: readonly string[]) { this.keys.set(runId, new Set([...(this.keys.get(runId) ?? []), ...keys])); }
}

const setup = () => {
  const store = new MemoryStore();
  let now = Date.parse("2026-11-21T10:00:00.000Z");
  const run = { id: "run-1", projectId: "project-1", kind: "standard", workspaceVcs: "git", status: "completed" } as RunRecord;
  const state: { forge: PrWatchForgeState; turn: PrWatchTurnResult; busy: boolean; dirty: boolean; pushes: boolean } = {
    forge: { summary: summary(), checks: [], reviewThreads: [], activity: [] },
    turn: { status: "completed", answer: "Fixed it.", errorMessage: null },
    busy: false,
    dirty: false,
    pushes: true,
  };
  const host = {
    getRun: vi.fn(() => run),
    isRunBusy: vi.fn(() => state.busy),
    readForge: vi.fn(async () => structuredClone(state.forge)),
    readCheckLog: vi.fn(async () => "error: unused import"),
    getInstructions: vi.fn(() => "Run pnpm lint."),
    checkWorkspace: vi.fn(async () => ({ ok: true as const })),
    startTurn: vi.fn<PrWatchHost["startTurn"]>(async () => undefined),
    readTurn: vi.fn(() => state.turn),
    hasUncommittedChanges: vi.fn(async () => state.dirty),
    pushRunBranch: vi.fn(async () => state.pushes),
    resolveCommit: vi.fn(async (_run: RunRecord, sha: string) => (/^[0-9a-f]{7,}$/.test(sha) ? sha.padEnd(40, "0") : null)),
    replyInThread: vi.fn<PrWatchHost["replyInThread"]>(async () => undefined),
    postComment: vi.fn<PrWatchHost["postComment"]>(async () => undefined),
    // Client errors are refusals; anything else, like a timeout, may have been accepted.
    isReplyRejected: vi.fn<PrWatchHost["isReplyRejected"]>((error) => /Forbidden|422/.test(String(error))),
    hasPostedReply: vi.fn<PrWatchHost["hasPostedReply"]>(async () => false),
    publish: vi.fn(),
    logError: vi.fn(),
  } satisfies PrWatchHost;
  const service = new PrWatchService(store, host, { now: () => now, pollMs: 60_000 });
  return { store, host, state, service, advance: (ms: number) => { now += ms; } };
};

/** Starts a watch and lets its first check run. */
const startWatch = async (context: ReturnType<typeof setup>) => {
  await context.service.start("run-1", { prUrl: PR_URL });
  await context.service.queueCheck("run-1");
};

describe("PrWatchService", () => {
  it("wakes the run for failed checks, pushes the fix, and does not wake again for the same failure", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    await startWatch(context);
    expect(context.host.startTurn).toHaveBeenCalledTimes(1);
    const [, prompt, wake] = context.host.startTurn.mock.calls[0]!;
    expect(prompt).toContain("error: unused import");
    expect(prompt).toContain("Run pnpm lint.");
    expect(wake).toMatchObject({ triggers: ["checks"], repair: false });
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "working", wakeCount: 1, attemptsOnHead: 1 });

    await expect(context.service.onRunTerminal("run-1")).resolves.toBe(true);
    expect(context.host.pushRunBranch).toHaveBeenCalledWith(expect.anything(), HEAD);
    const watching = context.store.getPrWatch("run-1")!;
    expect(watching).toMatchObject({ status: "watching", pending: null, lastResult: { pushed: true, triggers: ["checks"] } });

    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(1);
  });

  it("does not let a stopped watch's events hide another request's failures on the same commit", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    context.state.turn = { status: "completed", errorMessage: null, answer: "Fixed." };
    await startWatch(context);
    await context.service.onRunTerminal("run-1");
    await context.service.stop("run-1");

    const otherUrl = "https://github.com/acme/app/pull/14";
    context.state.forge.summary = summary({ number: 14, url: otherUrl });
    await context.service.start("run-1", { prUrl: otherUrl });
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
    expect(context.host.startTurn.mock.calls[1]![2]).toMatchObject({ prNumber: 14, triggers: ["checks"] });
  });

  it("answers every judged comment after pushing and leaves needs-user items for the user", async () => {
    const context = setup();
    context.state.forge.reviewThreads = [thread("t1", "c1", "This can be null.")];
    context.state.forge.activity = [conversation("a1", "Rename the prop."), conversation("a2", "LGTM")];
    await startWatch(context);
    expect(context.host.startTurn.mock.calls[0]![2]).toMatchObject({ triggers: ["feedback"] });
    context.state.turn = {
      status: "completed",
      errorMessage: null,
      answer: report([
        { item: "T1", verdict: "valid", commits: ["abc1234"], reply: "Added a null check." },
        { item: "C1", verdict: "needs-user", reply: "" },
        { item: "C2", verdict: "no-action", reply: "" },
      ]),
    };
    // No reply may start before the push finished.
    let finishPush: (pushed: boolean) => void = () => undefined;
    context.host.pushRunBranch.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishPush = resolve; }));
    const finished = context.service.onRunTerminal("run-1");
    await vi.waitFor(() => expect(context.host.pushRunBranch).toHaveBeenCalledTimes(1));
    expect(context.host.replyInThread).not.toHaveBeenCalled();
    finishPush(true);
    await finished;

    expect(context.host.replyInThread).toHaveBeenCalledTimes(1);
    const reply = context.host.replyInThread.mock.calls[0]![1]!;
    expect(reply).toMatchObject({ prUrl: PR_URL, threadId: "t1", replyToCommentId: "c1" });
    expect(reply.body).toContain("Fixed in abc1234");
    expect(reply.body).toContain(PR_WATCH_REPLY_MARKER);
    expect(context.host.postComment).not.toHaveBeenCalled();
    const record = context.store.getPrWatch("run-1")!;
    expect(record.lastResult).toMatchObject({ replies: 1, verdicts: { valid: 1, "needs-user": 1, "no-action": 1 }, needsUser: ["C1: Rename the prop."] });
    expect(record.attention?.message).toContain("1 comment needs your decision");
    expect(context.store.listPrWatchKeys("run-1")).toEqual(new Set(["comment:c1", "comment:a1", "comment:a2"]));
  });

  it("retries a reply the host rejected without resending the ones it accepted", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop."), conversation("a2", "Why a Map here?")];
    await startWatch(context);
    context.state.turn = {
      status: "completed", errorMessage: null,
      answer: report([{ item: "C1", verdict: "incorrect", reply: "Already renamed." }, { item: "C2", verdict: "intentional", reply: "Keys are objects." }]),
    };
    context.host.postComment.mockRejectedValueOnce(new Error("GitHub API 502"));
    await context.service.onRunTerminal("run-1");
    expect(context.host.postComment).toHaveBeenCalledTimes(2);
    expect(context.store.getPrWatch("run-1")!.undeliveredReplies).toMatchObject([{ ref: "C1", attempts: 1, lastError: "GitHub API 502" }]);

    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.postComment).toHaveBeenCalledTimes(3);
    expect(context.host.postComment.mock.calls[2]![1].body).toContain("Already renamed.");
    expect(context.store.getPrWatch("run-1")!.undeliveredReplies).toEqual([]);
  });

  it("does not post a reply twice when a timed-out write went through", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "incorrect", reply: "Already renamed." }]) };
    context.host.postComment.mockRejectedValueOnce(new Error("GitHub API request timed out"));
    await context.service.onRunTerminal("run-1");
    expect(context.store.getPrWatch("run-1")!.undeliveredReplies).toMatchObject([{ ref: "C1", uncertain: true }]);

    context.host.hasPostedReply.mockResolvedValueOnce(true);
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.hasPostedReply).toHaveBeenCalledWith(expect.anything(), PR_URL, expect.stringContaining("Already renamed."));
    expect(context.host.postComment).toHaveBeenCalledTimes(1);
    expect(context.store.getPrWatch("run-1")!.undeliveredReplies).toEqual([]);
  });

  it("leaves an unconfirmed reply to the user instead of reposting it", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "incorrect", reply: "Already renamed." }]) };
    context.host.postComment.mockRejectedValueOnce(new Error("socket hang up"));
    await context.service.onRunTerminal("run-1");
    context.host.hasPostedReply.mockRejectedValue(new Error("GitHub API 503"));
    for (let poll = 0; poll < 2; poll += 1) {
      context.advance(120_000);
      await context.service.queueCheck("run-1");
    }
    expect(context.host.postComment).toHaveBeenCalledTimes(1);
    expect(context.store.getPrWatch("run-1")!.attention?.message).toBe("Gave up posting 1 reply: C1: GitHub API 503");
  });

  it("sends no queued reply once the request was merged", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "incorrect", reply: "Already renamed." }]) };
    context.host.postComment.mockRejectedValueOnce(new Error("GitHub API 502"));
    await context.service.onRunTerminal("run-1");
    context.state.forge.summary = summary({ state: "merged" });
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.postComment).toHaveBeenCalledTimes(1);
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "ended", endReason: "merged" });
  });

  it("gives a reply up to the user after repeated rejections", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "incorrect", reply: "Already renamed." }]) };
    context.host.postComment.mockRejectedValue(new Error("Forbidden"));
    await context.service.onRunTerminal("run-1");
    for (let poll = 0; poll < 2; poll += 1) {
      context.advance(120_000);
      await context.service.queueCheck("run-1");
    }
    const record = context.store.getPrWatch("run-1")!;
    expect(record.undeliveredReplies).toEqual([]);
    expect(record.attention?.message).toBe("Gave up posting 1 reply: C1: Forbidden");
    expect(record.failedReplies).toEqual(["C1: Forbidden"]);

    // A later wake with nothing new to report keeps the notice and the record of the failure.
    context.host.postComment.mockResolvedValue(undefined);
    context.state.forge.checks = [failedCheck];
    context.state.turn = { status: "completed", errorMessage: null, answer: "Fixed the lint error." };
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    await context.service.onRunTerminal("run-1");
    const later = context.store.getPrWatch("run-1")!;
    expect(later.lastResult?.triggers).toEqual(["checks"]);
    expect(later.attention?.message).toBe("Gave up posting 1 reply: C1: Forbidden");
    expect(later.failedReplies).toEqual(["C1: Forbidden"]);
  });

  it("does not answer a claimed fix whose commit is not on the branch", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.host.resolveCommit.mockResolvedValue(null);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "valid", commits: ["deadbee"], reply: "Renamed it." }]) };
    await context.service.onRunTerminal("run-1");
    expect(context.host.postComment).not.toHaveBeenCalled();
    const record = context.store.getPrWatch("run-1")!;
    expect(record.lastResult?.needsUser).toEqual(["C1: Rename the prop."]);
    expect(record.attention?.message).toContain("without a commit on the branch");
  });

  it("asks once more for a missing report and posts nothing without one", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "Rename the prop.")];
    await startWatch(context);
    context.state.turn = { status: "completed", answer: "I renamed it.", errorMessage: null };
    await context.service.onRunTerminal("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
    expect(context.host.startTurn.mock.calls[1]![1]).toBe(PR_WATCH_REPORT_REPAIR_PROMPT);
    expect(context.host.pushRunBranch).not.toHaveBeenCalled();

    await context.service.onRunTerminal("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
    expect(context.host.postComment).not.toHaveBeenCalled();
    expect(context.store.getPrWatch("run-1")!.attention?.message).toContain("did not report its verdicts");
  });

  it("pauses without pushing or answering when the agent leaves uncommitted changes", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    await startWatch(context);
    context.state.dirty = true;
    await context.service.onRunTerminal("run-1");
    expect(context.host.pushRunBranch).not.toHaveBeenCalled();
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "paused", pending: null });
    // The failure stays unhandled, so a resumed watch takes it up again.
    expect(context.store.listPrWatchKeys("run-1").size).toBe(0);
  });

  it("pauses, and can resume, when the workspace cannot be inspected after the turn", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    await startWatch(context);
    context.host.hasUncommittedChanges.mockRejectedValueOnce(new Error("The workspace no longer exists."));
    await context.service.onRunTerminal("run-1");
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "paused", pending: null });
    expect(context.store.getPrWatch("run-1")!.message).toContain("The workspace no longer exists.");
    expect(context.store.listPrWatchKeys("run-1").size).toBe(0);
    await context.service.resume("run-1");
    expect(context.store.getPrWatch("run-1")!.status).not.toBe("paused");
  });

  it("leaves a wake retryable when the app restarts before its turn started", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    context.host.startTurn.mockImplementationOnce(() => new Promise(() => undefined));
    await context.service.start("run-1", { prUrl: PR_URL });
    void context.service.queueCheck("run-1");
    await vi.waitFor(() => expect(context.host.startTurn).toHaveBeenCalledTimes(1));
    const wakeId = context.host.startTurn.mock.calls[0]![2].wakeId;
    expect(context.store.getPrWatch("run-1")!.pending?.id).toBe(wakeId);

    // A fresh service after a restart, with the previous manual turn's result still on the run.
    const restarted = new PrWatchService(context.store, context.host, { now: () => Date.parse("2026-11-21T11:00:00.000Z"), pollMs: 60_000 });
    context.host.readTurn.mockReturnValueOnce({ status: "not-started", answer: "", errorMessage: null });
    await restarted.reconcileAfterRestart();
    expect(context.host.readTurn).toHaveBeenLastCalledWith("run-1", wakeId);
    expect(context.host.pushRunBranch).not.toHaveBeenCalled();
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "paused", message: expect.stringContaining("never started") });
    expect(context.store.listPrWatchKeys("run-1").size).toBe(0);
  });

  it("pauses when the agent pushes nothing for a failed check", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    context.state.pushes = false;
    await startWatch(context);
    await context.service.onRunTerminal("run-1");
    expect(context.store.getPrWatch("run-1")!.status).toBe("paused");
    expect(context.store.getPrWatch("run-1")!.message).toContain("pushed no changes");
    // The failure is still open, so resuming wakes the agent for it again.
    expect(context.store.listPrWatchKeys("run-1").size).toBe(0);
    await context.service.resume("run-1");
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
  });

  it("pauses after two attempts on the same commit, and resume gives fresh attempts", async () => {
    const context = setup();
    context.state.forge.activity = [conversation("a1", "First")];
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: report([{ item: "C1", verdict: "incorrect", reply: "Not so." }]) };
    await context.service.onRunTerminal("run-1");
    context.state.forge.activity.push(conversation("a2", "Second"));
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
    await context.service.onRunTerminal("run-1");
    context.state.forge.activity.push(conversation("a3", "Third"));
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(2);
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "paused" });

    await context.service.resume("run-1");
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(3);
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "working", wakeCount: 1, attemptsOnHead: 1 });
  });

  it("stops waking after the per-watch limit", async () => {
    const context = setup();
    await startWatch(context);
    context.state.turn = { status: "completed", errorMessage: null, answer: "ok" };
    for (let wake = 0; wake < PR_WATCH_MAX_WAKES; wake += 1) {
      context.state.forge.summary = summary({ headSha: String(wake).repeat(40) });
      context.state.forge.checks = [failedCheck];
      context.advance(120_000);
      await context.service.queueCheck("run-1");
      await context.service.onRunTerminal("run-1");
    }
    expect(context.host.startTurn).toHaveBeenCalledTimes(PR_WATCH_MAX_WAKES);
    context.state.forge.summary = summary({ headSha: NEXT_HEAD });
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.host.startTurn).toHaveBeenCalledTimes(PR_WATCH_MAX_WAKES);
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "paused" });
  });

  it("ends when the request merges and skips runs the user is working in", async () => {
    const context = setup();
    await startWatch(context);
    context.state.busy = true;
    context.state.forge.summary = summary({ state: "merged" });
    context.advance(120_000);
    await context.service.queueCheck("run-1");
    expect(context.store.getPrWatch("run-1")!.status).toBe("watching");
    context.state.busy = false;
    await context.service.queueCheck("run-1");
    expect(context.store.getPrWatch("run-1")).toMatchObject({ status: "ended", endReason: "merged" });
  });

  it("refuses a request the run is no longer linked to, and one another run watches", async () => {
    const context = setup();
    context.state.forge.summary = summary({ url: "https://github.com/acme/app/pull/13" });
    await expect(context.service.start("run-1", { prUrl: PR_URL })).rejects.toThrow("no longer linked");

    context.state.forge.summary = summary();
    context.store.savePrWatch({
      runId: "run-2", projectId: "project-1", prUrl: PR_URL, prNumber: 12, provider: "github", status: "watching",
      options: { checks: true, feedback: true, conflicts: true }, message: null, endReason: null, wakeCount: 0, attemptsOnHead: 0,
      attemptHeadSha: null, lastCheckedAt: null, lastWakeAt: null, pending: null, lastResult: null, attention: null,
      createdAt: "2026-11-21T09:00:00.000Z", updatedAt: "2026-11-21T09:00:00.000Z",
    });
    await expect(context.service.start("run-1", { prUrl: PR_URL })).rejects.toThrow("Another run already watches");
    context.host.checkWorkspace.mockResolvedValueOnce({ ok: false, message: "Wrong branch." } as never);
    await expect(context.service.start("run-1", { prUrl: PR_URL, takeOver: true })).rejects.toThrow("Wrong branch.");
    expect(context.store.getPrWatch("run-2")!.status).toBe("watching");
    // A failed save of the moved watch leaves the original one watching.
    const save = vi.spyOn(context.store, "savePrWatches").mockImplementationOnce(() => { throw new Error("database is locked"); });
    await expect(context.service.start("run-1", { prUrl: PR_URL, takeOver: true })).rejects.toThrow("database is locked");
    expect(context.store.getPrWatch("run-2")!.status).toBe("watching");
    expect(context.store.getPrWatch("run-1")).toBeNull();
    save.mockRestore();
    await context.service.start("run-1", { prUrl: PR_URL, takeOver: true });
    expect(context.store.getPrWatch("run-2")).toMatchObject({ status: "ended", endReason: "moved" });
    expect(context.store.getPrWatch("run-1")!.status).toBe("watching");
  });

  it("keeps a paused watch paused while another run watches the same request", async () => {
    const context = setup();
    const paused: PrWatchRecord = {
      runId: "run-1", projectId: "project-1", prUrl: PR_URL, prNumber: 12, provider: "github", status: "paused",
      options: { checks: true, feedback: true, conflicts: true }, message: "Push failed.", endReason: null, wakeCount: 2, attemptsOnHead: 1,
      attemptHeadSha: HEAD, lastCheckedAt: null, lastWakeAt: null, pending: null, lastResult: null, attention: null,
      createdAt: "2026-11-21T09:00:00.000Z", updatedAt: "2026-11-21T09:00:00.000Z",
    };
    context.store.savePrWatch(paused);
    context.store.savePrWatch({ ...paused, runId: "run-2", status: "watching" });
    await expect(context.service.resume("run-1")).rejects.toThrow("Another run watches this request now");
    expect(context.store.getPrWatch("run-1")!.status).toBe("paused");
  });

  it("pauses when the wake turn fails, and records a check failure without pausing", async () => {
    const context = setup();
    context.state.forge.checks = [failedCheck];
    await startWatch(context);
    context.state.turn = { status: "failed", answer: "", errorMessage: "Provider limit reached" };
    await context.service.onRunTerminal("run-1");
    expect(context.store.getPrWatch("run-1")!.message).toContain("Provider limit reached");

    const other = setup();
    await other.service.start("run-1", { prUrl: PR_URL });
    await other.service.queueCheck("run-1");
    other.host.readForge.mockRejectedValueOnce(new Error("GitHub API 502"));
    await other.service.queueCheck("run-1");
    expect(other.store.getPrWatch("run-1")).toMatchObject({ status: "watching", message: "Last check failed: GitHub API 502" });

    other.state.forge.checks = [failedCheck];
    other.host.checkWorkspace.mockRejectedValueOnce(new Error("fetch failed"));
    other.advance(120_000);
    await other.service.queueCheck("run-1");
    const waiting = other.store.getPrWatch("run-1")!;
    expect(waiting).toMatchObject({ status: "watching", message: "Could not prepare the workspace: fetch failed" });
    expect(waiting.lastCheckedAt).not.toBeNull();
    expect(other.host.startTurn).not.toHaveBeenCalled();
  });
});
