import { randomUUID } from "node:crypto";
import {
  COUNCIL_ACTIVE_STATUSES,
  canApplyCouncilRound,
  canReviewRunChanges,
  councilRoundSummary,
  isCouncilRoundActive,
  type CouncilApplyRecord,
  type CouncilFailureKind,
  type CouncilReview,
  type CouncilReviewerConfig,
  type CouncilRound,
  type CouncilSettings,
  type CouncilTrigger,
  type RunRecord,
} from "@buildwarden/shared";
import {
  COUNCIL_ASSESSMENT_REPAIR_PROMPT,
  COUNCIL_REPORT_REPAIR_PROMPT,
  buildCouncilApplyPrompt,
  buildCouncilAssessmentPrompt,
  buildCouncilReviewPrompt,
  buildCouncilApplyRecord,
  type CouncilSubject,
} from "./council-prompts";
import { classifyCouncilFailure, parseCouncilAssessment, parseCouncilReport, ungroupedCouncilFindings } from "./council-output";

/** Reviewers each need a workspace copy, so a large council starts in waves. */
const COUNCIL_MAX_PARALLEL_REVIEWS = 4;
const COUNCIL_MAX_ATTEMPTS = 2;
const COUNCIL_REVIEW_OUTPUT_LIMIT = 32_000;
const ELIGIBLE_RUN_KINDS: ReadonlySet<RunRecord["kind"]> = new Set(["standard", "automation"]);

export interface CouncilStore {
  saveCouncilRound(round: CouncilRound): void;
  getCouncilRound(roundId: string): CouncilRound;
  listCouncilRounds(runId: string): CouncilRound[];
  listCouncilRoundsWithStatuses(statuses: readonly CouncilRound["status"][]): CouncilRound[];
}

export interface CouncilChildResult {
  status: RunRecord["status"];
  text: string;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface CouncilHost {
  getRun(runId: string): RunRecord;
  getSettings(): CouncilSettings;
  /** Saved reviewers whose model can still run. */
  getReviewers(): CouncilReviewerConfig[];
  describeModel(modelId: string): { label: string; providerLabel: string };
  isRunBusy(runId: string): boolean;
  /** Captures what the run produced. Throws when there is nothing to validate. */
  captureSubject(run: RunRecord): Promise<CouncilSubject>;
  /** Null when the current fingerprint cannot be determined. */
  currentFingerprint(run: RunRecord, kind: CouncilRound["kind"]): Promise<string | null>;
  /** The run's conversation, for the model that assesses the findings. */
  readConversation(run: RunRecord): string;
  /** Explains why a model's account cannot run right now. Null when it may run. */
  getLimitReason(modelId: string): Promise<string | null>;
  startChild(round: CouncilRound, input: { modelId: string; effort: string | null; title: string; prompt: string }): Promise<string>;
  messageChild(childRunId: string, prompt: string): Promise<void>;
  stopChild(childRunId: string): Promise<void>;
  /** Removes a finished child's workspace copy. Its run row stays for usage history. */
  releaseChild(childRunId: string): Promise<void>;
  readChild(childRunId: string): CouncilChildResult;
  /** Starts a normal follow-up turn on the original run. */
  startApply(round: CouncilRound, prompt: string, record: CouncilApplyRecord): Promise<void>;
  appendStep(round: CouncilRound, content: string): string;
  /** Updates the round's timeline step and tells clients the round changed. */
  publish(round: CouncilRound, content: string): void;
  logError(message: string, error: unknown, context: Record<string, unknown>): void;
}

const reviewIsOpen = (review: CouncilReview): boolean => review.status === "queued" || review.status === "running";

/**
 * App-owned validation workflow. Models only supply reports and assessments; every state transition
 * is decided here, so one provider failing can never strand or abort the rest of the round.
 */
export class CouncilService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deadlines = new Map<string, NodeJS.Timeout>();
  /** Needed to restart a reviewer. Lost on restart, when open reviewers are closed instead. */
  private readonly subjects = new Map<string, CouncilSubject>();

  constructor(private readonly store: CouncilStore, private readonly host: CouncilHost) {}

  /** Serializes every round mutation, since child runs finish concurrently. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private save(round: CouncilRound): void {
    round.updatedAt = new Date().toISOString();
    this.store.saveCouncilRound(round);
    this.host.publish(round, councilRoundSummary(round));
  }

  private armDeadline(round: CouncilRound): void {
    this.clearDeadline(round.id);
    const delay = Math.max(0, Date.parse(round.deadlineAt) - Date.now());
    const timer = setTimeout(() => {
      this.deadlines.delete(round.id);
      void this.exclusive(() => this.handleDeadline(round.id)).catch((error: unknown) => {
        this.host.logError("Could not close a validation round at its deadline.", error, { roundId: round.id });
      });
    }, delay);
    timer.unref?.();
    this.deadlines.set(round.id, timer);
  }

  private clearDeadline(roundId: string): void {
    const timer = this.deadlines.get(roundId);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(roundId);
  }

  private newReview(config: CouncilReviewerConfig): CouncilReview {
    const { label, providerLabel } = this.host.describeModel(config.modelId);
    return {
      id: randomUUID(),
      modelId: config.modelId,
      modelLabel: label,
      providerLabel,
      effort: config.effort ?? null,
      status: "queued",
      childRunId: null,
      attempts: 0,
      repairRequested: false,
      failureKind: null,
      failureMessage: null,
      findingCount: 0,
      output: null,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  private assertRunEligible(run: RunRecord): void {
    if (!ELIGIBLE_RUN_KINDS.has(run.kind)) throw new Error("This kind of run cannot be validated.");
    if (this.host.isRunBusy(run.id) || !canReviewRunChanges(run)) throw new Error("Wait for the run to finish before validating it.");
    if (this.store.listCouncilRounds(run.id).some(isCouncilRoundActive)) throw new Error("This run is already being validated.");
  }

  start(runId: string, trigger: CouncilTrigger = "manual"): Promise<CouncilRound> {
    return this.exclusive(() => this.startLocked(runId, trigger));
  }

  private async startLocked(runId: string, trigger: CouncilTrigger, capturedSubject?: CouncilSubject): Promise<CouncilRound> {
    const run = this.host.getRun(runId);
    this.assertRunEligible(run);
    const reviewers = this.host.getReviewers();
    if (!reviewers.length) throw new Error("Choose at least one reviewer in Settings > Orchestration.");
    const settings = this.host.getSettings();
    const subject = capturedSubject ?? await this.host.captureSubject(run);
    const now = new Date();
    const round: CouncilRound = {
      id: randomUUID(),
      runId: run.id,
      projectId: run.projectId,
      status: "reviewing",
      kind: subject.kind,
      trigger,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      finishedAt: null,
      deadlineAt: new Date(now.getTime() + settings.timeoutMinutes * 60_000).toISOString(),
      minReviews: Math.min(settings.minReviews, reviewers.length),
      autoApply: settings.autoApply,
      authorModelId: run.modelId,
      authorModelLabel: this.host.describeModel(run.modelId).label,
      subjectFingerprint: subject.fingerprint,
      reviews: reviewers.map((reviewer) => this.newReview(reviewer)),
      assessment: null,
      assessmentError: null,
      summary: null,
      findings: [],
      groups: [],
      appliedGroupIds: [],
      error: null,
      stepId: null,
    };
    round.stepId = this.host.appendStep(round, councilRoundSummary(round));
    this.subjects.set(round.id, subject);
    this.save(round);
    this.armDeadline(round);
    await this.pumpReviews(round);
    return round;
  }

  /** Called when a run completes. Failures must never affect the finished run. */
  autoStart(runId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.host.getSettings().autoRun || !this.host.getReviewers().length) return;
      const run = this.host.getRun(runId);
      if (run.mode === "ask" || !ELIGIBLE_RUN_KINDS.has(run.kind)) return;
      if (run.status !== "completed" || this.host.isRunBusy(run.id)) return;
      const rounds = this.store.listCouncilRounds(run.id);
      if (rounds.some(isCouncilRoundActive)) return;
      const subject = await this.host.captureSubject(run).catch(() => null);
      if (!subject || (run.mode === "code" && subject.kind !== "code")) return;
      // A turn that changed nothing has already been reviewed.
      if (rounds.at(-1)?.subjectFingerprint === subject.fingerprint) return;
      await this.startLocked(run.id, "auto", subject);
    });
  }

  private async pumpReviews(round: CouncilRound): Promise<void> {
    const subject = this.subjects.get(round.id);
    for (const review of round.reviews) {
      if (round.status !== "reviewing") return;
      if (review.status !== "queued") continue;
      if (round.reviews.filter((entry) => entry.status === "running").length >= COUNCIL_MAX_PARALLEL_REVIEWS) break;
      if (!subject) {
        this.closeReview(review, "failed", "interrupted", "The app restarted before this review could start.");
        continue;
      }
      const limitReason = await this.host.getLimitReason(review.modelId).catch(() => null);
      if (limitReason) {
        this.closeReview(review, "skipped", "limit", limitReason);
        continue;
      }
      await this.launchReview(round, review, subject);
    }
    this.save(round);
    await this.finishReviewsIfSettled(round);
  }

  private async launchReview(round: CouncilRound, review: CouncilReview, subject: CouncilSubject): Promise<void> {
    review.attempts += 1;
    review.status = "running";
    this.save(round);
    try {
      review.childRunId = await this.host.startChild(round, {
        modelId: review.modelId,
        effort: review.effort,
        title: `Review by ${review.modelLabel}`,
        prompt: buildCouncilReviewPrompt(subject),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closeReview(review, "failed", classifyCouncilFailure(message), message);
    }
  }

  private closeReview(review: CouncilReview, status: CouncilReview["status"], failureKind: CouncilFailureKind | null, failureMessage: string | null): void {
    review.status = status;
    review.failureKind = failureKind;
    review.failureMessage = failureMessage;
  }

  private async releaseChild(review: CouncilReview): Promise<void> {
    if (!review.childRunId) return;
    await this.host.releaseChild(review.childRunId).catch((error: unknown) => {
      this.host.logError("Could not remove a validation workspace.", error, { childRunId: review.childRunId });
    });
  }

  private recordChildUsage(review: CouncilReview, result: CouncilChildResult): void {
    // Run totals are cumulative, so a repair turn must replace rather than add.
    review.inputTokens = result.inputTokens;
    review.outputTokens = result.outputTokens;
    review.output = result.text ? result.text.slice(0, COUNCIL_REVIEW_OUTPUT_LIMIT) : review.output;
  }

  /** Called whenever a council child run stops, for any reason. */
  onChildTerminal(childRunId: string): Promise<void> {
    return this.exclusive(async () => {
      const round = this.store.listCouncilRoundsWithStatuses(["reviewing", "assessing"]).find((candidate) =>
        candidate.assessment?.childRunId === childRunId || candidate.reviews.some((review) => review.childRunId === childRunId));
      if (!round) return;
      if (round.status === "assessing" && round.assessment?.childRunId === childRunId) {
        await this.handleAssessmentTerminal(round, round.assessment);
        return;
      }
      const review = round.reviews.find((entry) => entry.childRunId === childRunId);
      if (round.status === "reviewing" && review?.status === "running") await this.handleReviewTerminal(round, review);
    });
  }

  private async handleReviewTerminal(round: CouncilRound, review: CouncilReview): Promise<void> {
    const result = this.host.readChild(review.childRunId!);
    if (result.status === "completed") {
      try {
        const parsed = parseCouncilReport(result.text, round.kind);
        this.recordChildUsage(review, result);
        for (const finding of parsed) {
          round.findings.push({ ...finding, id: `F${String(round.findings.length + 1)}`, reviewId: review.id });
        }
        review.findingCount = parsed.length;
        this.closeReview(review, "completed", null, null);
      } catch {
        this.recordChildUsage(review, result);
        if (!review.repairRequested) {
          review.repairRequested = true;
          this.save(round);
          try {
            await this.host.messageChild(review.childRunId!, COUNCIL_REPORT_REPAIR_PROMPT);
            return;
          } catch {
            /* Fall through and count this reviewer as failed. */
          }
        }
        this.closeReview(review, "failed", "output", "The reviewer did not return a readable report.");
      }
    } else {
      const message = result.errorMessage || `The review ended with status ${result.status}.`;
      this.recordChildUsage(review, result);
      const kind = classifyCouncilFailure(message);
      if (kind === "transient" && review.attempts < COUNCIL_MAX_ATTEMPTS && this.subjects.has(round.id)) {
        await this.releaseChild(review);
        review.childRunId = null;
        review.status = "queued";
        await this.pumpReviews(round);
        return;
      }
      this.closeReview(review, "failed", kind, message);
    }
    await this.releaseChild(review);
    await this.pumpReviews(round);
  }

  private async finishReviewsIfSettled(round: CouncilRound): Promise<void> {
    if (round.status !== "reviewing" || round.reviews.some(reviewIsOpen)) return;
    this.subjects.delete(round.id);
    const usable = round.reviews.filter((review) => review.status === "completed").length;
    if (usable < round.minReviews) {
      this.finish(round, "failed");
      round.error = usable === 0
        ? "No reviewer produced a report."
        : `Only ${String(usable)} of the ${String(round.minReviews)} required reviews finished.`;
      this.save(round);
      return;
    }
    if (!round.findings.length) {
      this.finish(round, "ready");
      this.save(round);
      return;
    }
    await this.startAssessment(round);
  }

  private finish(round: CouncilRound, status: CouncilRound["status"]): void {
    this.clearDeadline(round.id);
    round.status = status;
    round.finishedAt = new Date().toISOString();
  }

  private async startAssessment(round: CouncilRound): Promise<void> {
    const assessment = this.newReview({ modelId: round.authorModelId });
    assessment.status = "running";
    assessment.attempts = 1;
    round.assessment = assessment;
    round.status = "assessing";
    const settings = this.host.getSettings();
    round.deadlineAt = new Date(Date.now() + settings.timeoutMinutes * 60_000).toISOString();
    this.save(round);
    this.armDeadline(round);
    try {
      const run = this.host.getRun(round.runId);
      assessment.childRunId = await this.host.startChild(round, {
        modelId: round.authorModelId,
        effort: null,
        title: "Assessment of the review findings",
        prompt: buildCouncilAssessmentPrompt({ kind: round.kind, conversation: this.host.readConversation(run), findings: round.findings }),
      });
      this.save(round);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.closeReview(assessment, "failed", classifyCouncilFailure(message), message);
      await this.completeWithoutAssessment(round, message);
    }
  }

  private async handleAssessmentTerminal(round: CouncilRound, assessment: CouncilReview): Promise<void> {
    const result = this.host.readChild(assessment.childRunId!);
    this.recordChildUsage(assessment, result);
    if (result.status !== "completed") {
      const message = result.errorMessage || `The assessment ended with status ${result.status}.`;
      this.closeReview(assessment, "failed", classifyCouncilFailure(message), message);
      await this.completeWithoutAssessment(round, message);
      return;
    }
    let parsed: ReturnType<typeof parseCouncilAssessment>;
    try {
      parsed = parseCouncilAssessment(result.text, round.findings);
    } catch {
      if (!assessment.repairRequested) {
        assessment.repairRequested = true;
        this.save(round);
        try {
          await this.host.messageChild(assessment.childRunId!, COUNCIL_ASSESSMENT_REPAIR_PROMPT);
          return;
        } catch {
          /* Fall through and show the findings unassessed. */
        }
      }
      this.closeReview(assessment, "failed", "output", "The assessment could not be read.");
      await this.completeWithoutAssessment(round, "The assessment could not be read.");
      return;
    }
    this.closeReview(assessment, "completed", null, null);
    round.summary = parsed.summary;
    round.groups = parsed.groups;
    await this.releaseChild(assessment);
    await this.completeAssessed(round);
  }

  /** The findings are still worth having, so a failed assessment shows them ungrouped. */
  private async completeWithoutAssessment(round: CouncilRound, reason: string): Promise<void> {
    round.assessmentError = reason;
    round.groups = ungroupedCouncilFindings(round.findings);
    if (round.assessment) await this.releaseChild(round.assessment);
    this.finish(round, "ready");
    this.save(round);
  }

  private async isStale(round: CouncilRound): Promise<boolean> {
    try {
      const current = await this.host.currentFingerprint(this.host.getRun(round.runId), round.kind);
      return current !== null && current !== round.subjectFingerprint;
    } catch {
      return false;
    }
  }

  private async completeAssessed(round: CouncilRound): Promise<void> {
    this.finish(round, "ready");
    this.save(round);
    if (!round.autoApply) return;
    const recommended = round.groups.filter((group) => group.decision === "recommended").map((group) => group.id);
    // Never apply on top of work the reviewers did not see, or into a turn the user started.
    if (!recommended.length || this.host.isRunBusy(round.runId) || await this.isStale(round)) return;
    await this.applyLocked(round, recommended, false).catch((error: unknown) => {
      this.host.logError("Automatic validation fix could not start.", error, { roundId: round.id });
    });
  }

  applyFindings(roundId: string, groupIds: readonly string[]): Promise<CouncilRound> {
    return this.exclusive(async () => {
      const round = this.store.getCouncilRound(roundId);
      if (!canApplyCouncilRound(round)) throw new Error("These findings cannot be applied right now.");
      if (this.host.isRunBusy(round.runId) || ["queued", "preparing", "running"].includes(this.host.getRun(round.runId).status)) {
        throw new Error("Wait for the run to finish before applying findings.");
      }
      await this.applyLocked(round, groupIds, await this.isStale(round));
      return round;
    });
  }

  private async applyLocked(round: CouncilRound, groupIds: readonly string[], stale: boolean): Promise<void> {
    const groups = round.groups.filter((group) => groupIds.includes(group.id));
    if (!groups.length) throw new Error("Select at least one finding.");
    const previousStatus = round.status;
    round.status = "applying";
    round.appliedGroupIds = groups.map((group) => group.id);
    round.error = null;
    round.finishedAt = null;
    this.save(round);
    try {
      await this.host.startApply(
        round,
        buildCouncilApplyPrompt({ kind: round.kind, groups, findings: round.findings, stale }),
        buildCouncilApplyRecord(round, groups),
      );
    } catch (error) {
      round.status = previousStatus;
      round.appliedGroupIds = [];
      round.finishedAt = new Date().toISOString();
      round.error = error instanceof Error ? error.message : String(error);
      this.save(round);
      throw error;
    }
  }

  /** Reports whether the finished turn was a validation fix, which must not start another round. */
  onRunTerminal(runId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const round = this.store.listCouncilRounds(runId).find((candidate) => candidate.status === "applying");
      if (!round) return false;
      const run = this.host.getRun(runId);
      this.finish(round, run.status === "completed" ? "applied" : "apply-failed");
      round.error = run.status === "completed" ? null : run.errorMessage || "The turn did not finish.";
      this.save(round);
      return true;
    });
  }

  private async handleDeadline(roundId: string): Promise<void> {
    const round = this.store.getCouncilRound(roundId);
    if (round.status === "reviewing") {
      for (const review of round.reviews.filter(reviewIsOpen)) {
        this.closeReview(review, "failed", "timeout", "The reviewer did not finish in time.");
        if (review.childRunId) {
          await this.host.stopChild(review.childRunId).catch(() => undefined);
          await this.releaseChild(review);
        }
      }
      this.save(round);
      await this.finishReviewsIfSettled(round);
    } else if (round.status === "assessing" && round.assessment) {
      const { childRunId } = round.assessment;
      this.closeReview(round.assessment, "failed", "timeout", "The assessment did not finish in time.");
      if (childRunId) await this.host.stopChild(childRunId).catch(() => undefined);
      await this.completeWithoutAssessment(round, "The assessment did not finish in time.");
    }
  }

  cancel(roundId: string): Promise<CouncilRound> {
    return this.exclusive(async () => {
      const round = this.store.getCouncilRound(roundId);
      if (round.status === "applying") throw new Error("Stop the run to cancel applying these findings.");
      if (!isCouncilRoundActive(round)) return round;
      const children = [...round.reviews, ...(round.assessment ? [round.assessment] : [])];
      for (const review of children.filter(reviewIsOpen)) this.closeReview(review, "cancelled", null, null);
      this.subjects.delete(round.id);
      this.finish(round, "cancelled");
      this.save(round);
      for (const child of children) {
        if (!child.childRunId) continue;
        await this.host.stopChild(child.childRunId).catch(() => undefined);
        await this.releaseChild(child);
      }
      return round;
    });
  }

  /** Stops a run's validation before the run itself is deleted. */
  async stopForRun(runId: string): Promise<void> {
    for (const round of this.store.listCouncilRounds(runId)) {
      if (round.status === "reviewing" || round.status === "assessing") await this.cancel(round.id);
      this.clearDeadline(round.id);
      this.subjects.delete(round.id);
    }
  }

  /** Workers do not survive a restart, so close open work and keep whatever was collected. */
  reconcileAfterRestart(): Promise<void> {
    return this.exclusive(async () => {
      for (const round of this.store.listCouncilRoundsWithStatuses(COUNCIL_ACTIVE_STATUSES)) {
        if (round.status === "reviewing") {
          for (const review of round.reviews.filter(reviewIsOpen)) {
            this.closeReview(review, "failed", "interrupted", "The app restarted during this review.");
            await this.releaseChild(review);
          }
          this.save(round);
          await this.finishReviewsIfSettled(round);
        } else if (round.status === "assessing") {
          if (round.assessment) this.closeReview(round.assessment, "failed", "interrupted", "The app restarted during the assessment.");
          await this.completeWithoutAssessment(round, "The app restarted during the assessment.");
        } else {
          this.finish(round, "apply-failed");
          round.error = "The app restarted before this finished.";
          this.save(round);
        }
      }
    });
  }

  dispose(): void {
    for (const roundId of [...this.deadlines.keys()]) this.clearDeadline(roundId);
  }
}
