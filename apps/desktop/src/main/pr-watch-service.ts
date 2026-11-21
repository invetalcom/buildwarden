import { randomUUID } from "node:crypto";
import {
  DEFAULT_PR_WATCH_OPTIONS,
  PR_WATCH_MAX_ATTEMPTS_PER_HEAD,
  PR_WATCH_MAX_WAKES,
  PR_WATCH_REPORT_REPAIR_PROMPT,
  buildPrWatchPrompt,
  describePrWatchWake,
  formatPrWatchReply,
  isPrWatchActive,
  parsePrWatchReport,
  prWatchRequestLabel,
  scanPrWatchTriggers,
  type PrWatchEndReason,
  type PrWatchFeedbackItem,
  type PrWatchRecord,
  type PrWatchReportEntry,
  type PrWatchTriggerKind,
  type PrWatchVerdict,
  type ProjectForgeActivityItem,
  type ProjectForgeReviewThread,
  type RunForgeCheck,
  type RunForgeRequestSummary,
  type RunRecord,
  type StartPrWatchInput,
} from "@buildwarden/shared";

/** How often a watched request is read. */
const PR_WATCH_POLL_MS = 2 * 60_000;
/** Comments only change what a full read returns, so they are re-read at least this often. */
const PR_WATCH_DETAILS_MAX_AGE_MS = 6 * 60_000;
const PR_WATCH_TICK_MS = 30_000;
/** Failed checks whose logs are read into one wake prompt. */
const PR_WATCH_LOG_CHECK_LIMIT = 3;
const PR_WATCH_SUMMARY_CHARS = 1_200;
const ELIGIBLE_RUN_KINDS: ReadonlySet<RunRecord["kind"]> = new Set(["standard", "automation"]);
const ACTIVE_STATUSES = ["watching", "working"] as const;

export interface PrWatchStore {
  savePrWatch(record: PrWatchRecord): void;
  getPrWatch(runId: string): PrWatchRecord | null;
  listPrWatchesWithStatuses(statuses: readonly PrWatchRecord["status"][]): PrWatchRecord[];
  listPrWatchKeys(runId: string): Set<string>;
  addPrWatchKeys(runId: string, keys: readonly string[]): void;
}

export interface PrWatchForgeState {
  summary: RunForgeRequestSummary;
  checks: RunForgeCheck[];
  /** Null until the request's comments were read once. */
  reviewThreads: ProjectForgeReviewThread[] | null;
  activity: ProjectForgeActivityItem[] | null;
}

export type PrWatchWorkspaceCheck = { ok: true } | { ok: false; message: string };

export interface PrWatchTurnResult {
  status: RunRecord["status"];
  answer: string;
  errorMessage: string | null;
}

interface PrWatchWakeMetadata {
  label: string;
  prUrl: string;
  prNumber: number;
  triggers: PrWatchTriggerKind[];
  repair: boolean;
}

export interface PrWatchHost {
  /** Throws when the run was deleted. */
  getRun(runId: string): RunRecord;
  isRunBusy(runId: string): boolean;
  /** Re-reads the watched request and returns it. `includeDetails` also re-reads its comments. Throws on host errors. */
  readForge(run: RunRecord, prUrl: string, includeDetails: boolean): Promise<PrWatchForgeState | null>;
  readCheckLog(run: RunRecord, prUrl: string, check: RunForgeCheck): Promise<string | null>;
  getInstructions(projectId: string): string;
  /** "start" checks the workspace is on the request branch; "wake" also needs it clean and up to date. */
  checkWorkspace(run: RunRecord, summary: RunForgeRequestSummary, mode: "start" | "wake"): Promise<PrWatchWorkspaceCheck>;
  /** Starts a follow-up turn on the run. */
  startTurn(run: RunRecord, prompt: string, wake: PrWatchWakeMetadata): Promise<void>;
  readTurn(runId: string): PrWatchTurnResult;
  hasUncommittedChanges(run: RunRecord): Promise<boolean>;
  /** Pushes the run branch when it has commits the request head lacks. Returns whether it pushed. */
  pushRunBranch(run: RunRecord, remoteHeadSha: string | null): Promise<boolean>;
  /** Full SHA of a commit on the run branch, or null for anything else. */
  resolveCommit(run: RunRecord, sha: string): Promise<string | null>;
  replyInThread(run: RunRecord, input: { prUrl: string; threadId: string; replyToCommentId: string | null; body: string }): Promise<void>;
  postComment(run: RunRecord, input: { prUrl: string; body: string }): Promise<void>;
  /** Saved state changed in a way clients should see. */
  publish(record: PrWatchRecord): void;
  logError(message: string, error: unknown, context: Record<string, unknown>): void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const signatureOf = (summary: RunForgeRequestSummary) => JSON.stringify([
  summary.state, summary.headSha, summary.mergeability, summary.reviewDecision, summary.unresolvedThreadCount,
  summary.checks.completed, summary.checks.failed, summary.checks.total, summary.updatedAt,
]);

const shorten = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * Watches a run's PR/MR and wakes the run when checks fail, reviewers comment, or the request
 * conflicts. The app decides every transition; the agent only fixes, commits, and reports.
 */
export class PrWatchService {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly queuedChecks = new Set<string>();
  private readonly detailsReadAt = new Map<string, number>();
  private readonly signatures = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly store: PrWatchStore,
    private readonly host: PrWatchHost,
    private readonly clock: { now: () => number; pollMs: number } = { now: () => Date.now(), pollMs: PR_WATCH_POLL_MS },
  ) {}

  /** Serializes every watch mutation: polls, user actions, and finished turns interleave. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private save(record: PrWatchRecord, publish = true): void {
    // A read in flight can outlast the run's deletion; saving then would leave an orphaned watch.
    try {
      this.host.getRun(record.runId);
    } catch {
      return;
    }
    record.updatedAt = this.nowIso();
    this.store.savePrWatch(record);
    if (publish) this.host.publish(record);
  }

  startPolling(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.tick(), PR_WATCH_TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queues a read of every watch that is due. */
  tick(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    for (const record of this.store.listPrWatchesWithStatuses(["watching"])) {
      const last = record.lastCheckedAt ? Date.parse(record.lastCheckedAt) : 0;
      if (now - last >= this.clock.pollMs) this.queueCheck(record.runId);
    }
  }

  queueCheck(runId: string): Promise<void> {
    if (this.queuedChecks.has(runId)) return Promise.resolve();
    this.queuedChecks.add(runId);
    return this.exclusive(async () => {
      this.queuedChecks.delete(runId);
      await this.checkLocked(runId);
    }).catch((error: unknown) => {
      this.host.logError("Could not check a watched pull request.", error, { runId });
    });
  }

  async start(runId: string, input: StartPrWatchInput): Promise<PrWatchRecord> {
    const record = await this.exclusive(() => this.startLocked(runId, input));
    void this.queueCheck(runId);
    return record;
  }

  private async startLocked(runId: string, input: StartPrWatchInput): Promise<PrWatchRecord> {
    const run = this.host.getRun(runId);
    if (!ELIGIBLE_RUN_KINDS.has(run.kind) || run.workspaceVcs !== "git") throw new Error("This run cannot watch a pull request.");
    const prUrl = input.prUrl.trim();
    const existing = this.store.getPrWatch(runId);
    if (isPrWatchActive(existing)) {
      if (existing!.prUrl === prUrl) return existing!;
      throw new Error("Stop the current watch before watching another request.");
    }
    const other = this.store.listPrWatchesWithStatuses(ACTIVE_STATUSES).find((watch) => watch.prUrl === prUrl && watch.runId !== runId);
    if (other) {
      if (!input.takeOver) throw new Error("Another run already watches this request.");
      if (other.status === "working") throw new Error("The other run is working on this request. Try again when it finishes.");
    }
    const state = await this.host.readForge(run, prUrl, false);
    if (!state || state.summary.url !== prUrl) throw new Error("This run is no longer linked to that request. Check the link and try again.");
    if (state.summary.state !== "open") throw new Error("Only open requests can be watched.");
    const workspace = await this.host.checkWorkspace(run, state.summary, "start");
    if (!workspace.ok) throw new Error(workspace.message);
    // Only now: a takeover that fails validation must leave the other run watching.
    if (other) this.end(other, "moved", "Another run took over this watch.");
    const now = this.nowIso();
    const record: PrWatchRecord = {
      runId,
      projectId: run.projectId,
      prUrl,
      prNumber: state.summary.number,
      provider: state.summary.provider,
      status: "watching",
      options: { ...DEFAULT_PR_WATCH_OPTIONS, ...input.options },
      message: null,
      endReason: null,
      wakeCount: 0,
      attemptsOnHead: 0,
      attemptHeadSha: null,
      lastCheckedAt: null,
      lastWakeAt: null,
      pending: null,
      lastResult: existing?.lastResult ?? null,
      attention: null,
      createdAt: now,
      updatedAt: now,
    };
    this.detailsReadAt.delete(runId);
    this.signatures.delete(runId);
    this.save(record);
    return record;
  }

  stop(runId: string): Promise<PrWatchRecord | null> {
    return this.exclusive(async () => {
      const record = this.store.getPrWatch(runId);
      if (!record || record.status === "ended") return record;
      this.end(record, "stopped", null);
      return record;
    });
  }

  async resume(runId: string): Promise<PrWatchRecord> {
    const record = await this.exclusive(async () => {
      const current = this.store.getPrWatch(runId);
      if (!current) throw new Error("This run is not watching a request.");
      if (current.status !== "paused") return current;
      // Another run may have started watching the request while this one was paused.
      if (this.store.listPrWatchesWithStatuses(ACTIVE_STATUSES).some((watch) => watch.prUrl === current.prUrl && watch.runId !== runId)) {
        throw new Error("Another run watches this request now. Start the watch here and move it to take it back.");
      }
      Object.assign(current, {
        status: "watching", message: null, wakeCount: 0, attemptsOnHead: 0, attemptHeadSha: null,
        lastCheckedAt: null, pending: null, attention: null,
      } satisfies Partial<PrWatchRecord>);
      this.save(current);
      return current;
    });
    void this.queueCheck(runId);
    return record;
  }

  private end(record: PrWatchRecord, reason: PrWatchEndReason, message: string | null): void {
    record.status = "ended";
    record.endReason = reason;
    record.message = message;
    record.pending = null;
    this.save(record);
  }

  private pause(record: PrWatchRecord, message: string): void {
    record.status = "paused";
    record.message = message;
    record.pending = null;
    record.attention = { id: randomUUID(), message, createdAt: this.nowIso() };
    this.save(record);
  }

  private async readState(record: PrWatchRecord, run: RunRecord): Promise<PrWatchForgeState | null> {
    const now = this.clock.now();
    const detailsDue = record.options.feedback && now - (this.detailsReadAt.get(record.runId) ?? 0) >= PR_WATCH_DETAILS_MAX_AGE_MS;
    let state = await this.host.readForge(run, record.prUrl, detailsDue);
    if (detailsDue) this.detailsReadAt.set(record.runId, now);
    const signature = state ? signatureOf(state.summary) : null;
    const changed = signature !== null && signature !== this.signatures.get(record.runId);
    if (signature) this.signatures.set(record.runId, signature);
    if (state && changed && !detailsDue && record.options.feedback) {
      state = await this.host.readForge(run, record.prUrl, true);
      this.detailsReadAt.set(record.runId, now);
    }
    return state;
  }

  private async checkLocked(runId: string): Promise<void> {
    const record = this.store.getPrWatch(runId);
    if (record?.status !== "watching") return;
    let run: RunRecord;
    try {
      run = this.host.getRun(runId);
    } catch {
      return;
    }
    // A turn the user started has the workspace; look again on the next tick.
    if (this.host.isRunBusy(runId)) return;

    let state: PrWatchForgeState | null;
    try {
      state = await this.readState(record, run);
    } catch (error) {
      const message = `Last check failed: ${errorMessage(error)}`;
      const changed = record.message !== message;
      record.message = message;
      record.lastCheckedAt = this.nowIso();
      this.save(record, changed);
      return;
    }
    const label = prWatchRequestLabel(record.provider);
    if (!state || state.summary.url !== record.prUrl) {
      this.end(record, "unlinked", `The run is no longer linked to ${label} #${String(record.prNumber)}.`);
      return;
    }
    const { summary } = state;
    if (summary.state === "merged" || summary.state === "closed") {
      this.end(record, summary.state, `${label} #${String(record.prNumber)} was ${summary.state}.`);
      return;
    }
    const hadMessage = record.message !== null;
    record.lastCheckedAt = this.nowIso();
    record.message = null;

    const scan = scanPrWatchTriggers({
      options: record.options,
      summary,
      checks: state.checks,
      reviewThreads: state.reviewThreads,
      activity: state.activity,
      handled: this.store.listPrWatchKeys(runId),
    });
    if (!scan.triggers.length) {
      this.save(record, hadMessage);
      return;
    }

    const sameHead = record.attemptHeadSha !== null && record.attemptHeadSha === summary.headSha;
    if (sameHead && record.attemptsOnHead >= PR_WATCH_MAX_ATTEMPTS_PER_HEAD) {
      this.pause(record, `Paused after ${String(PR_WATCH_MAX_ATTEMPTS_PER_HEAD)} attempts on the same commit. Look at ${label} #${String(record.prNumber)}, then resume.`);
      return;
    }
    if (record.wakeCount >= PR_WATCH_MAX_WAKES) {
      this.pause(record, `Paused after ${String(PR_WATCH_MAX_WAKES)} wakes. Resume to allow more.`);
      return;
    }
    const workspace = await this.host.checkWorkspace(run, summary, "wake");
    if (!workspace.ok) {
      this.pause(record, workspace.message);
      return;
    }

    const failedChecks = await Promise.all(scan.failedChecks.map(async (check, index) => ({
      name: check.name,
      url: check.url,
      log: index < PR_WATCH_LOG_CHECK_LIMIT
        ? await this.host.readCheckLog(run, record.prUrl, check).catch((error: unknown) => {
          this.host.logError("Could not read a failed check's log.", error, { runId, check: check.name });
          return null;
        })
        : null,
    })));
    const content = {
      provider: summary.provider,
      number: summary.number,
      failedChecks,
      conflicts: scan.conflicts,
      feedback: scan.feedback,
    };
    const prompt = buildPrWatchPrompt({
      ...content,
      title: summary.title,
      sourceBranch: summary.sourceBranch,
      targetBranch: summary.targetBranch,
      headSha: summary.headSha,
      instructions: this.host.getInstructions(run.projectId),
    });
    const description = describePrWatchWake(content);
    record.status = "working";
    record.pending = {
      id: randomUUID(),
      triggers: scan.triggers,
      headSha: summary.headSha,
      handledKeys: scan.handledKeys,
      feedback: scan.feedback.map((source) => source.item),
      repairRequested: false,
      startedAt: this.nowIso(),
    };
    record.wakeCount += 1;
    record.attemptsOnHead = sameHead ? record.attemptsOnHead + 1 : 1;
    record.attemptHeadSha = summary.headSha;
    record.lastWakeAt = record.pending.startedAt;
    record.message = description;
    record.attention = null;
    // Saved before the turn starts, so a turn that ends at once still finds its wake.
    this.save(record);
    try {
      await this.host.startTurn(run, prompt, {
        label: description, prUrl: record.prUrl, prNumber: record.prNumber, triggers: scan.triggers, repair: false,
      });
    } catch (error) {
      this.pause(record, `Could not wake the run: ${errorMessage(error)}`);
    }
  }

  /**
   * Called whenever a turn of a run ends. Reports whether the turn belonged to a watch, which
   * then pushes the agent's commits and answers the reviewers before the run's queue continues.
   */
  onRunTerminal(runId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const record = this.store.getPrWatch(runId);
      if (record?.status !== "working" || !record.pending) return false;
      await this.finishWakeLocked(record);
      return true;
    });
  }

  private async finishWakeLocked(record: PrWatchRecord): Promise<void> {
    const pending = record.pending!;
    let run: RunRecord;
    try {
      run = this.host.getRun(record.runId);
    } catch {
      return;
    }
    const turn = this.host.readTurn(record.runId);
    if (turn.status !== "completed") {
      let message = "The app restarted during the watch turn. Resume to let the agent try again.";
      if (turn.status === "cancelled") message = "The watch turn was stopped. Resume to let the agent try again.";
      else if (turn.status === "failed") message = `The watch turn failed: ${turn.errorMessage || "no reason was given"}.`;
      this.pause(record, message);
      return;
    }

    const refs = pending.feedback.map((item) => item.ref);
    const report = refs.length ? parsePrWatchReport(turn.answer, refs) : [];
    if (report === null && !pending.repairRequested) {
      pending.repairRequested = true;
      this.save(record, false);
      try {
        await this.host.startTurn(run, PR_WATCH_REPORT_REPAIR_PROMPT, {
          label: "Asked the agent for its review report again.", prUrl: record.prUrl, prNumber: record.prNumber, triggers: pending.triggers, repair: true,
        });
        return;
      } catch (error) {
        this.host.logError("Could not ask for the PR watch report again.", error, { runId: record.runId });
      }
    }

    if (await this.host.hasUncommittedChanges(run)) {
      this.pause(record, "The agent left uncommitted changes, so nothing was pushed or answered. Commit or discard them, then resume.");
      return;
    }
    let pushed: boolean;
    try {
      pushed = await this.host.pushRunBranch(run, pending.headSha);
    } catch (error) {
      this.pause(record, `Pushing the agent's commits failed, so no replies were posted: ${errorMessage(error)}`);
      return;
    }

    const replies = await this.postReplies(record, run, report ?? []);
    // Marked only now: a wake that failed earlier leaves its events to be picked up again.
    this.store.addPrWatchKeys(record.runId, pending.handledKeys);

    const reported = new Set((report ?? []).map((entry) => entry.item));
    const needsUser = [
      ...(report ?? []).filter((entry) => entry.verdict === "needs-user").map((entry) => entry.item),
      ...(report ? refs.filter((ref) => !reported.has(ref)) : []),
    ].map((ref) => {
      const item = pending.feedback.find((candidate) => candidate.ref === ref);
      return `${ref}: ${item?.excerpt ?? ""}`;
    });
    const verdicts: Partial<Record<PrWatchVerdict, number>> = {};
    for (const entry of report ?? []) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
    record.lastResult = {
      finishedAt: this.nowIso(),
      triggers: pending.triggers,
      pushed,
      replies: replies.posted,
      replyErrors: replies.errors,
      verdicts,
      needsUser,
      summary: turn.answer.trim() ? shorten(turn.answer.trim(), PR_WATCH_SUMMARY_CHARS) : null,
    };
    record.pending = null;
    record.lastCheckedAt = null;

    const label = prWatchRequestLabel(record.provider);
    const notes: string[] = [];
    if (report === null && refs.length) notes.push("The agent did not report its verdicts, so no replies were posted.");
    if (needsUser.length) notes.push(`${String(needsUser.length)} comment${needsUser.length === 1 ? " needs" : "s need"} your decision.`);
    if (replies.errors.length) notes.push(`${String(replies.errors.length)} repl${replies.errors.length === 1 ? "y" : "ies"} could not be posted.`);
    const fixedNothing = !pushed && pending.triggers.some((trigger) => trigger === "checks" || trigger === "conflicts");
    if (fixedNothing) {
      this.pause(record, [`The agent pushed no changes for ${label} #${String(record.prNumber)}'s failed checks or conflicts. Read its answer, then resume.`, ...notes].join(" "));
      return;
    }
    record.status = "watching";
    record.message = pushed ? `Pushed fixes${replies.posted ? ` and posted ${String(replies.posted)} repl${replies.posted === 1 ? "y" : "ies"}` : ""}.` : null;
    record.attention = notes.length ? { id: randomUUID(), message: notes.join(" "), createdAt: this.nowIso() } : null;
    this.save(record);
  }

  private async postReplies(record: PrWatchRecord, run: RunRecord, report: readonly PrWatchReportEntry[]): Promise<{ posted: number; errors: string[] }> {
    const items = new Map<string, PrWatchFeedbackItem>(record.pending!.feedback.map((item) => [item.ref, item]));
    let posted = 0;
    const errors: string[] = [];
    for (const entry of report) {
      const item = items.get(entry.item);
      if (!item) continue;
      const commits = entry.verdict === "valid"
        ? (await Promise.all(entry.commits.map((sha) => this.host.resolveCommit(run, sha).catch(() => null)))).filter((sha): sha is string => Boolean(sha))
        : [];
      const body = formatPrWatchReply(entry, item, [...new Set(commits)]);
      if (!body) continue;
      try {
        if (item.kind === "thread" && item.threadId) {
          await this.host.replyInThread(run, { prUrl: record.prUrl, threadId: item.threadId, replyToCommentId: item.replyToCommentId, body });
        } else {
          await this.host.postComment(run, { prUrl: record.prUrl, body });
        }
        posted += 1;
      } catch (error) {
        errors.push(`${item.ref}: ${errorMessage(error)}`);
      }
    }
    return { posted, errors };
  }

  /** Workers do not survive a restart. A wake whose turn already ended is finished now. */
  reconcileAfterRestart(): Promise<void> {
    return this.exclusive(async () => {
      for (const record of this.store.listPrWatchesWithStatuses(["working"])) {
        if (this.host.isRunBusy(record.runId)) continue;
        if (!record.pending) {
          record.status = "watching";
          this.save(record);
          continue;
        }
        await this.finishWakeLocked(record).catch((error: unknown) => {
          this.pause(record, `The app restarted during the watch turn: ${errorMessage(error)}`);
        });
      }
    });
  }
}
