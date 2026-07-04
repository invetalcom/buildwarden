import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CreateProjectLoopInput,
  ProjectLoopChangedPayload,
  ProjectLoopIterationRecord,
  ProjectLoopRecord,
  ProjectLoopUiReviewDecisionInput,
  ProjectLoopUiReviewRecord,
  RunFollowUpOptions,
  RunInput,
  RunRecord,
} from "@buildwarden/shared";
import { ACTIVE_PROJECT_LOOP_STATUSES, isActiveProjectLoopStatus, isLoopCapableProviderType } from "@buildwarden/shared";
import type { BuildWardenDatabase } from "@buildwarden/db";
import type { GitService } from "@buildwarden/git-service";
import type { ProjectPrReviewProvider } from "../pr-review/pr-review-types";
import {
  LOOP_COMMENT_MARKER,
  LOOP_MAX_AI_UI_REVIEW_ROUNDS,
  LOOP_MAX_COMMENT_ROUNDS,
  LOOP_MAX_MANUAL_UI_REVIEW_ROUNDS,
  LOOP_PR_REVIEW_DIFF_CHAR_LIMIT,
  LOOP_UI_REVIEW_DIR,
  LOOP_UI_REVIEW_MANIFEST,
  buildLoopAiUiReviewPrompt,
  buildLoopAuditPrompt,
  buildLoopCommentsFixPrompt,
  buildLoopIterationPrompt,
  buildLoopPlanPrompt,
  buildLoopPrReviewPrompt,
  buildLoopUiFixPrompt,
  extractLoopActionableFeedback,
  normalizeForgeRequestState,
  parseLoopAiUiVerdict,
  parseLoopPlan,
  parseLoopPrReviewResult,
  parseLoopUiManifest,
  parseProcessedCommentIds,
  serializeProcessedCommentIds,
} from "./loop-helpers";

const ACTIVE_RUN_STATUSES = new Set<RunRecord["status"]>(["queued", "preparing", "running"]);
const PR_POLL_INTERVAL_MS = 45_000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

class LoopCancelledError extends Error {
  constructor() {
    super("The loop was cancelled.");
    this.name = "LoopCancelledError";
  }
}

interface LoopRuntimeState {
  driverActive: boolean;
  cancelled: boolean;
  cancelInProgress: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollWake: (() => void) | null;
  runWaiters: Map<string, (run: RunRecord) => void>;
  uiReviewWaiter: (() => void) | null;
}

export interface ProjectLoopAskTextInput {
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  usageProjectId?: string;
}

export interface ProjectLoopRunnerDeps {
  db: BuildWardenDatabase;
  gitService: GitService;
  /** Directory where UI review screenshots are copied so they survive worktree cleanup. */
  uiReviewImageRoot: string;
  /** Creates a loop iteration run without hijacking the renderer's run selection. */
  createIterationRun(input: RunInput): Promise<RunRecord>;
  followUpRun(runId: string, prompt: string, options?: RunFollowUpOptions): Promise<RunRecord>;
  cancelRun(runId: string): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  askModelForText(cwd: string, modelId: string, input: ProjectLoopAskTextInput): Promise<string>;
  createForgeProvider(projectId: string): Promise<ProjectPrReviewProvider>;
  emitLoopChanged(payload: ProjectLoopChangedPayload): void;
  logError(message: string, error: unknown, metadata?: Record<string, unknown>): void;
  logWarn(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Drives Project Loops: plan -> implement (per PR) -> UI screenshot gate -> commit/push/PR ->
 * wait for merge while addressing review comments -> next iteration -> final audit.
 *
 * All progress is persisted, so {@link resumeActiveLoops} can re-enter the state machine
 * after an app restart at the exact stage a loop was in.
 */
export class ProjectLoopRunner {
  private readonly states = new Map<string, LoopRuntimeState>();

  constructor(private readonly deps: ProjectLoopRunnerDeps) {}

  private state(loopId: string): LoopRuntimeState {
    let state = this.states.get(loopId);
    if (!state) {
      state = {
        driverActive: false,
        cancelled: false,
        cancelInProgress: false,
        pollTimer: null,
        pollWake: null,
        runWaiters: new Map(),
        uiReviewWaiter: null,
      };
      this.states.set(loopId, state);
    }
    return state;
  }

  private emit(loop: Pick<ProjectLoopRecord, "id" | "projectId">): void {
    this.deps.emitLoopChanged({ loopId: loop.id, projectId: loop.projectId });
  }

  private appendEvent(
    loop: Pick<ProjectLoopRecord, "id" | "projectId">,
    role: "system" | "planner" | "runner" | "ui-review" | "forge" | "audit" | "user",
    label: string,
    content: string,
    iterationId?: string | null,
  ): void {
    this.deps.db.appendProjectLoopEvent({ loopId: loop.id, iterationId: iterationId ?? null, role, label, content });
    this.emit(loop);
  }

  private assertNotCancelled(state: LoopRuntimeState): void {
    if (state.cancelled) {
      throw new LoopCancelledError();
    }
  }

  private sleep(state: LoopRuntimeState, ms: number): Promise<void> {
    if (state.cancelled) {
      // A cancel that lands between two poll steps must not leave a dangling timer.
      return Promise.resolve();
    }
    return new Promise((resolveSleep) => {
      state.pollWake = () => {
        state.pollWake = null;
        if (state.pollTimer) {
          clearTimeout(state.pollTimer);
          state.pollTimer = null;
        }
        resolveSleep();
      };
      state.pollTimer = setTimeout(() => {
        state.pollTimer = null;
        state.pollWake = null;
        resolveSleep();
      }, ms);
    });
  }

  /** Called by the app controller whenever a run with kind "loop-iteration" reaches a terminal state. */
  handleRunTerminal(runId: string): void {
    for (const state of this.states.values()) {
      const waiter = state.runWaiters.get(runId);
      if (waiter) {
        state.runWaiters.delete(runId);
        try {
          waiter(this.deps.db.getRun(runId));
        } catch (error) {
          this.deps.logError("Loop run waiter failed.", error, { runId });
        }
      }
    }
  }

  private waitForRunCompletion(state: LoopRuntimeState, runId: string): Promise<RunRecord> {
    const current = this.deps.db.getRun(runId);
    if (!ACTIVE_RUN_STATUSES.has(current.status)) {
      return Promise.resolve(current);
    }
    return new Promise((resolveRun) => {
      state.runWaiters.set(runId, resolveRun);
    });
  }

  async startLoop(input: CreateProjectLoopInput): Promise<ProjectLoopRecord> {
    const project = this.deps.db.getProject(input.projectId);
    if (project.kind !== "git") {
      throw new Error("Loops are only available for Git projects.");
    }
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Describe the feature or fix this loop should implement.");
    }
    const runnerModel = this.deps.db.getModel(input.runnerModelId);
    const runnerProvider = this.deps.db.getProviderAccount(runnerModel.providerAccountId);
    if (!isLoopCapableProviderType(runnerProvider.providerType)) {
      throw new Error("Loops only work with models from local providers (Codex CLI or Claude Code).");
    }
    if (input.reviewModelId?.trim()) {
      const reviewModel = this.deps.db.getModel(input.reviewModelId.trim());
      const reviewProvider = this.deps.db.getProviderAccount(reviewModel.providerAccountId);
      if (!isLoopCapableProviderType(reviewProvider.providerType)) {
        throw new Error("Loop review models must also come from local providers (Codex CLI or Claude Code).");
      }
    }
    // Fails fast when no forge token / unsupported remote is configured.
    await this.deps.createForgeProvider(project.id);

    const baseBranch = input.baseBranch?.trim() || project.defaultBranch;
    const loop = this.deps.db.createProjectLoop({
      projectId: project.id,
      name: input.name.trim() || prompt.slice(0, 80),
      prompt,
      runnerModelId: input.runnerModelId,
      reviewModelId: input.reviewModelId?.trim() || null,
      mergePolicy: input.mergePolicy,
      uiChangePolicy: input.uiChangePolicy,
      prReviewPolicy: input.prReviewPolicy ?? "none",
      uiReviewInstructions: input.uiReviewInstructions?.trim() || null,
      baseBranch,
      status: "planning",
    });
    this.appendEvent(
      loop,
      "system",
      "Loop started",
      [
        `Target branch: ${baseBranch}`,
        `Merge policy: ${loop.mergePolicy === "auto-merge" ? "merge automatically" : "wait for approval / manual merge"}`,
        `UI changes: ${
          loop.uiChangePolicy === "auto"
            ? "merged without review"
            : loop.uiChangePolicy === "manual-approval"
              ? "each affected page needs your approval"
              : "each affected page is reviewed by an AI model"
        }`,
        `PR review: ${
          loop.prReviewPolicy === "ai-review"
            ? "the review model posts a visible code review on each PR/MR, and the loop then addresses its findings"
            : "no automatic review is posted"
        }`,
        "Implementation runs execute with auto-approved shell commands so the loop can work unattended.",
      ].join("\n"),
    );
    void this.driveLoop(loop.id);
    return this.deps.db.getProjectLoop(loop.id);
  }

  resumeActiveLoops(): void {
    const loops = this.deps.db.listProjectLoopsWithStatuses([...ACTIVE_PROJECT_LOOP_STATUSES]);
    for (const loop of loops) {
      this.appendEvent(loop, "system", "Loop resumed", "BuildWarden restarted and resumed this loop where it left off.");
      void this.driveLoop(loop.id);
    }
  }

  async resumeLoop(loopId: string): Promise<void> {
    const loop = this.deps.db.getProjectLoop(loopId);
    const state = this.state(loopId);
    if (state.driverActive) {
      return;
    }
    if (loop.status === "completed") {
      throw new Error("This loop already completed.");
    }
    state.cancelled = false;
    if (loop.status === "failed" || loop.status === "cancelled") {
      this.deps.db.updateProjectLoop(loopId, { status: "implementing", errorMessage: null, finishedAt: null });
      const iterations = this.deps.db.listProjectLoopIterations(loopId);
      for (const iteration of iterations) {
        if (iteration.status === "failed" || iteration.status === "cancelled") {
          this.deps.db.updateProjectLoopIteration(iteration.id, { status: "pending", errorMessage: null });
        }
      }
      this.appendEvent(loop, "system", "Loop resumed", "The loop was resumed manually and continues with its next open iteration.");
    }
    void this.driveLoop(loopId);
  }

  async cancelLoop(loopId: string): Promise<void> {
    const loop = this.deps.db.getProjectLoop(loopId);
    const state = this.state(loopId);
    if (state.cancelInProgress) {
      return;
    }
    state.cancelInProgress = true;
    try {
      await this.cancelLoopInternal(loop, state);
    } finally {
      state.cancelInProgress = false;
    }
  }

  private async cancelLoopInternal(loop: ProjectLoopRecord, state: LoopRuntimeState): Promise<void> {
    const loopId = loop.id;
    state.cancelled = true;
    if (state.pollWake) {
      state.pollWake();
    }
    if (state.uiReviewWaiter) {
      const waiter = state.uiReviewWaiter;
      state.uiReviewWaiter = null;
      waiter();
    }
    const iterations = this.deps.db.listProjectLoopIterations(loopId);
    for (const iteration of iterations) {
      if (iteration.runId) {
        let run: RunRecord | null = null;
        try {
          run = this.deps.db.getRun(iteration.runId);
        } catch {
          run = null;
        }
        if (run && ACTIVE_RUN_STATUSES.has(run.status)) {
          await this.deps.cancelRun(iteration.runId).catch((error) => {
            this.deps.logWarn("Could not cancel the active loop iteration run.", { loopId, runId: iteration.runId, error });
          });
        }
      }
      if (!["merged", "skipped", "failed", "cancelled"].includes(iteration.status)) {
        this.deps.db.updateProjectLoopIteration(iteration.id, { status: "cancelled" });
      }
    }
    if (isActiveProjectLoopStatus(loop.status)) {
      this.deps.db.updateProjectLoop(loopId, { status: "cancelled", finishedAt: new Date().toISOString() });
      this.appendEvent(loop, "system", "Loop cancelled", "The loop was cancelled. Already-created PRs/MRs stay open on the Git host.");
    }
    this.emit(loop);
  }

  async deleteLoop(loopId: string): Promise<void> {
    const loop = this.deps.db.getProjectLoop(loopId);
    if (isActiveProjectLoopStatus(loop.status)) {
      await this.cancelLoop(loopId);
    }
    const detail = this.deps.db.getProjectLoopDetail(loopId);
    for (const iteration of detail.iterations) {
      if (!iteration.runId) {
        continue;
      }
      try {
        this.deps.db.getRun(iteration.runId);
      } catch {
        continue;
      }
      await this.deps.deleteRun(iteration.runId).catch((error) => {
        this.deps.logWarn("Could not delete a loop iteration run while deleting the loop.", {
          loopId,
          runId: iteration.runId,
          error,
        });
      });
    }
    for (const review of detail.uiReviews) {
      try {
        rmSync(review.imagePath, { force: true });
      } catch {
        /* screenshot may already be gone */
      }
    }
    this.deps.db.deleteProjectLoop(loopId);
    this.states.delete(loopId);
    this.deps.emitLoopChanged({ loopId, projectId: loop.projectId });
  }

  async respondToUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput): Promise<void> {
    const review = this.deps.db.getProjectLoopUiReview(reviewId);
    if (review.status !== "pending") {
      throw new Error("This screenshot was already reviewed.");
    }
    const feedback = input.feedback?.trim() || null;
    if (input.decision === "request-changes" && !feedback) {
      throw new Error("Describe what should change on this page before requesting changes.");
    }
    this.deps.db.updateProjectLoopUiReview(reviewId, {
      status: input.decision === "approve" ? "approved" : "changes-requested",
      feedback,
    });
    const loop = this.deps.db.getProjectLoop(review.loopId);
    this.appendEvent(
      loop,
      "user",
      input.decision === "approve" ? "Page approved" : "Page changes requested",
      input.decision === "approve" ? `Approved: ${review.pageName}` : `${review.pageName}: ${feedback ?? ""}`,
      review.iterationId,
    );

    const state = this.state(review.loopId);
    if (!this.hasPendingUiReviews(review.loopId)) {
      if (state.uiReviewWaiter) {
        const waiter = state.uiReviewWaiter;
        state.uiReviewWaiter = null;
        waiter();
      } else if (!state.driverActive && isActiveProjectLoopStatus(loop.status)) {
        // The driver died with the app; all decisions are in, so re-enter the state machine.
        void this.driveLoop(review.loopId);
      }
    }
  }

  getUiReviewImageDataUrl(reviewId: string): string | null {
    const review = this.deps.db.getProjectLoopUiReview(reviewId);
    if (!existsSync(review.imagePath)) {
      return null;
    }
    const ext = extname(review.imagePath).toLowerCase();
    const mime =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
    const bytes = readFileSync(review.imagePath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  private hasPendingUiReviews(loopId: string): boolean {
    return this.deps.db.listProjectLoopUiReviews(loopId).some((review) => review.status === "pending");
  }

  private async driveLoop(loopId: string): Promise<void> {
    const state = this.state(loopId);
    if (state.driverActive) {
      return;
    }
    state.driverActive = true;
    try {
      let loop = this.deps.db.getProjectLoop(loopId);
      if (!isActiveProjectLoopStatus(loop.status)) {
        return;
      }

      let iterations = this.deps.db.listProjectLoopIterations(loopId);
      if (iterations.length === 0) {
        await this.runPlanning(state, loop);
        iterations = this.deps.db.listProjectLoopIterations(loopId);
      }

      for (const iteration of iterations) {
        this.assertNotCancelled(state);
        const current = this.deps.db.getProjectLoopIteration(iteration.id);
        if (current.status === "merged" || current.status === "skipped") {
          continue;
        }
        if (current.status === "failed" || current.status === "cancelled") {
          throw new Error(`Iteration "${current.title}" is ${current.status}. Resume the loop to retry it.`);
        }
        await this.runIteration(state, loopId, iteration.id);
      }

      loop = this.deps.db.getProjectLoop(loopId);
      if (isActiveProjectLoopStatus(loop.status)) {
        await this.runAudit(state, loop);
      }
    } catch (error) {
      if (error instanceof LoopCancelledError) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logError("Project loop failed.", error, { loopId });
      try {
        const loop = this.deps.db.getProjectLoop(loopId);
        if (isActiveProjectLoopStatus(loop.status)) {
          this.deps.db.updateProjectLoop(loopId, {
            status: "failed",
            errorMessage: message,
            finishedAt: new Date().toISOString(),
          });
          this.appendEvent(loop, "system", "Loop failed", message);
        }
      } catch {
        /* the loop may have been deleted while failing */
      }
    } finally {
      state.driverActive = false;
    }
  }

  private async runPlanning(state: LoopRuntimeState, loop: ProjectLoopRecord): Promise<void> {
    const project = this.deps.db.getProject(loop.projectId);
    this.deps.db.updateProjectLoop(loop.id, { status: "planning" });
    this.appendEvent(loop, "planner", "Planning", "The planning agent is inspecting the repository and splitting the request into PR-sized iterations.");

    let plan = null;
    try {
      const raw = await this.deps.askModelForText(project.repoPath, loop.runnerModelId, {
        prompt: buildLoopPlanPrompt(project, loop),
        systemPrompt: "You are a pragmatic software delivery planner. Return strict JSON only, with no markdown fences or commentary.",
        maxTokens: 2_000,
        temperature: 0.2,
        usageProjectId: project.id,
      });
      plan = parseLoopPlan(raw);
    } catch (error) {
      this.deps.logWarn("Loop planning model call failed; falling back to a single iteration.", { loopId: loop.id, error });
    }
    this.assertNotCancelled(state);

    if (!plan) {
      plan = {
        summary: "The plan could not be generated as structured output, so the request is implemented as a single PR.",
        iterations: [{ title: loop.name.slice(0, 160), objective: loop.prompt }],
      };
      this.appendEvent(loop, "planner", "Plan fallback", "The planner did not return a parseable plan. The request will be implemented as one PR.");
    }

    for (const [index, entry] of plan.iterations.entries()) {
      this.deps.db.createProjectLoopIteration({
        loopId: loop.id,
        iterationIndex: index,
        title: entry.title,
        objective: entry.objective,
        targetBranch: loop.baseBranch,
      });
    }
    this.deps.db.updateProjectLoop(loop.id, { status: "implementing", planSummary: plan.summary || null });
    this.appendEvent(
      loop,
      "planner",
      `Plan ready (${String(plan.iterations.length)} PR${plan.iterations.length === 1 ? "" : "s"})`,
      [
        ...(plan.summary ? [plan.summary, ""] : []),
        ...plan.iterations.map((entry, index) => `${String(index + 1)}. ${entry.title}\n   ${entry.objective.split(/\r?\n/)[0] ?? ""}`),
      ].join("\n"),
    );
  }

  private async runIteration(state: LoopRuntimeState, loopId: string, iterationId: string): Promise<void> {
    let loop = this.deps.db.getProjectLoop(loopId);
    let iteration = this.deps.db.getProjectLoopIteration(iterationId);

    if (iteration.status === "pending") {
      iteration = await this.startImplementationRun(state, loop, iteration);
    }

    // Ensure the implementation run reached a successful completion (also recovers interrupted runs).
    if (!iteration.prUrl) {
      iteration = await this.ensureImplementationCompleted(state, loop, iteration);
      loop = this.deps.db.getProjectLoop(loopId);
      const run = iteration.runId ? this.deps.db.getRun(iteration.runId) : null;
      if (run && !["awaiting-merge", "addressing-comments"].includes(iteration.status)) {
        await this.runUiGate(state, loop, iteration, run);
        this.assertNotCancelled(state);
      }
      iteration = this.deps.db.getProjectLoopIteration(iterationId);
      if (!iteration.prUrl) {
        const created = await this.ensurePullRequestCreated(state, loop, iteration);
        if (!created) {
          return; // Iteration produced no commits and was marked skipped.
        }
        iteration = this.deps.db.getProjectLoopIteration(iterationId);
      }
    }

    await this.monitorUntilMerged(state, loopId, iterationId);
  }

  private async startImplementationRun(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
  ): Promise<ProjectLoopIterationRecord> {
    this.assertNotCancelled(state);
    const project = this.deps.db.getProject(loop.projectId);
    const model = this.deps.db.getModel(loop.runnerModelId);
    const provider = this.deps.db.getProviderAccount(model.providerAccountId);
    const harnessType = provider.providerType === "codex-cli" ? "codex-app-server" : "claude-code";
    const targetBranch = iteration.targetBranch ?? loop.baseBranch;

    // Base the new worktree on the freshest available state of the target branch so
    // follow-up iterations include the previously merged PRs.
    try {
      await this.deps.gitService.fetchProjectBranches(project.repoPath);
    } catch (error) {
      this.deps.logWarn("Could not fetch the project remote before starting a loop iteration.", { loopId: loop.id, error });
    }
    let baseRef = targetBranch;
    try {
      if (await this.deps.gitService.hasRemoteBranch(project.repoPath, targetBranch)) {
        baseRef = `origin/${targetBranch}`;
      }
    } catch {
      /* fall back to the local branch name */
    }

    this.deps.db.updateProjectLoop(loop.id, { status: "implementing" });
    const allIterations = this.deps.db.listProjectLoopIterations(loop.id);
    const run = await this.deps.createIterationRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType,
      mode: "code",
      yoloMode: true,
      workspaceType: "worktree",
      baseBranch: baseRef,
      prompt: buildLoopIterationPrompt({
        project,
        loop,
        iteration,
        allIterations,
        planSummary: loop.planSummary,
      }),
      kind: "loop-iteration",
    });
    const updated = this.deps.db.updateProjectLoopIteration(iteration.id, {
      status: "implementing",
      runId: run.id,
      branchName: run.branchName,
      targetBranch,
    });
    this.appendEvent(
      loop,
      "runner",
      `Iteration ${String(iteration.iterationIndex + 1)} started`,
      `Implementing "${iteration.title}" in worktree branch \`${run.branchName}\` (based on ${baseRef}).`,
      iteration.id,
    );
    return updated;
  }

  private async ensureImplementationCompleted(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
  ): Promise<ProjectLoopIterationRecord> {
    if (!iteration.runId) {
      throw new Error(`Iteration "${iteration.title}" has no implementation run.`);
    }
    let run = await this.waitForRunCompletion(state, iteration.runId);
    this.assertNotCancelled(state);

    if (run.status === "failed") {
      throw new Error(`The implementation run for "${iteration.title}" failed: ${run.errorMessage ?? "unknown error"}`);
    }
    if (run.status === "cancelled") {
      // Typically an app restart interrupted the session; continue in the same worktree.
      if (!existsSync(run.worktreePath)) {
        throw new Error(`The workspace of iteration "${iteration.title}" is no longer available.`);
      }
      this.appendEvent(
        loop,
        "runner",
        "Continuing interrupted run",
        "The implementation session was interrupted. The loop sent a follow-up asking the agent to verify and finish the iteration objective.",
        iteration.id,
      );
      await this.deps.followUpRun(
        run.id,
        [
          "Your previous session on this iteration was interrupted.",
          "Check what is already implemented in this workspace, then finish the iteration objective completely (including validation and the UI screenshot manifest described in the initial instructions).",
        ].join("\n"),
        { yoloMode: true },
      );
      run = await this.waitForRunCompletion(state, run.id);
      this.assertNotCancelled(state);
      if (run.status !== "completed") {
        throw new Error(`The implementation run for "${iteration.title}" could not be recovered (status: ${run.status}).`);
      }
    }

    this.appendEvent(
      loop,
      "runner",
      `Iteration ${String(iteration.iterationIndex + 1)} implemented`,
      run.summary?.trim() || "The implementation run completed.",
      iteration.id,
    );
    return this.deps.db.getProjectLoopIteration(iteration.id);
  }

  // --- UI screenshot gate -------------------------------------------------

  private readUiManifestPages(run: RunRecord): Array<{ name: string; description: string | null; absPath: string; relPath: string }> {
    const manifestPath = join(run.worktreePath, LOOP_UI_REVIEW_MANIFEST);
    if (!existsSync(manifestPath)) {
      return [];
    }
    let pages;
    try {
      pages = parseLoopUiManifest(readFileSync(manifestPath, "utf8"));
    } catch {
      return [];
    }
    if (!pages) {
      return [];
    }
    const reviewDir = resolve(run.worktreePath, LOOP_UI_REVIEW_DIR);
    return pages.flatMap((page) => {
      const candidate = isAbsolute(page.file) ? page.file : resolve(reviewDir, page.file);
      const rel = relative(reviewDir, candidate);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return [];
      }
      if (!existsSync(candidate) || !IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
        return [];
      }
      return [
        {
          name: page.name,
          description: page.description,
          absPath: candidate,
          relPath: `${LOOP_UI_REVIEW_DIR}/${rel.replaceAll("\\", "/")}`,
        },
      ];
    });
  }

  private cleanupWorkspaceUiDir(run: RunRecord): void {
    try {
      rmSync(join(run.worktreePath, ".buildwarden"), { recursive: true, force: true });
    } catch {
      /* best effort; an uncommitted leftover directory is harmless */
    }
  }

  private storeUiImage(loopId: string, iterationId: string, round: number, index: number, sourcePath: string): string {
    mkdirSync(this.deps.uiReviewImageRoot, { recursive: true });
    const target = join(
      this.deps.uiReviewImageRoot,
      `${loopId}-${iterationId.slice(0, 8)}-r${String(round)}-${String(index)}${extname(sourcePath).toLowerCase() || ".png"}`,
    );
    copyFileSync(sourcePath, target);
    return target;
  }

  private latestUiReviewRound(loopId: string, iterationId: string): number {
    const rounds = this.deps.db
      .listProjectLoopUiReviews(loopId)
      .filter((review) => review.iterationId === iterationId)
      .map((review) => review.round);
    return rounds.length > 0 ? Math.max(...rounds) : 0;
  }

  private waitForUiDecisions(state: LoopRuntimeState, loopId: string): Promise<void> {
    if (!this.hasPendingUiReviews(loopId)) {
      return Promise.resolve();
    }
    return new Promise((resolveWait) => {
      state.uiReviewWaiter = resolveWait;
    });
  }

  private async runUiGate(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
    run: RunRecord,
  ): Promise<void> {
    if (loop.uiChangePolicy === "auto") {
      const pages = this.readUiManifestPages(run);
      if (pages.length > 0) {
        this.appendEvent(
          loop,
          "ui-review",
          "UI changes accepted",
          `${String(pages.length)} affected UI page${pages.length === 1 ? "" : "s"} reported; the loop is configured to merge UI changes without review.`,
          iteration.id,
        );
      }
      this.cleanupWorkspaceUiDir(run);
      return;
    }

    let round = this.latestUiReviewRound(loop.id, iteration.id);
    for (;;) {
      this.assertNotCancelled(state);
      const rows = this.deps.db
        .listProjectLoopUiReviews(loop.id)
        .filter((review) => review.iterationId === iteration.id && review.round === round);
      const pending = rows.filter((review) => review.status === "pending");

      if (pending.length > 0) {
        this.deps.db.updateProjectLoop(loop.id, { status: "awaiting-ui-approval" });
        this.deps.db.updateProjectLoopIteration(iteration.id, { status: "awaiting-ui-approval" });
        this.emit(loop);
        await this.waitForUiDecisions(state, loop.id);
        continue;
      }

      if (round > 0 && rows.length > 0) {
        const changeRequests = rows.filter(
          (review) => review.status === "changes-requested" || review.status === "ai-changes-requested",
        );
        if (changeRequests.length === 0) {
          this.appendEvent(
            loop,
            "ui-review",
            "UI approved",
            `All ${String(rows.length)} page screenshot${rows.length === 1 ? "" : "s"} of round ${String(round)} were approved.`,
            iteration.id,
          );
          this.cleanupWorkspaceUiDir(run);
          return;
        }
        await this.applyUiFeedback(state, loop, iteration, run, changeRequests);
      }

      const pages = this.readUiManifestPages(run);
      if (pages.length === 0) {
        this.appendEvent(
          loop,
          "ui-review",
          "No UI changes reported",
          round === 0
            ? "The implementation reported no affected UI pages, so no screenshot approval is required."
            : "After applying the feedback, the implementation reported no remaining affected UI pages.",
          iteration.id,
        );
        this.cleanupWorkspaceUiDir(run);
        return;
      }

      round += 1;
      if (round > LOOP_MAX_MANUAL_UI_REVIEW_ROUNDS) {
        throw new Error(`The UI review cycle for "${iteration.title}" exceeded ${String(LOOP_MAX_MANUAL_UI_REVIEW_ROUNDS)} rounds.`);
      }

      const useAiReview = loop.uiChangePolicy === "ai-review" && round <= LOOP_MAX_AI_UI_REVIEW_ROUNDS;
      if (useAiReview) {
        await this.runAiUiReviewRound(state, loop, iteration, run, pages, round);
        continue;
      }

      if (loop.uiChangePolicy === "ai-review") {
        this.appendEvent(
          loop,
          "ui-review",
          "Falling back to manual approval",
          `The AI reviewer still requested changes after ${String(LOOP_MAX_AI_UI_REVIEW_ROUNDS)} rounds. Approve or reject the current screenshots yourself.`,
          iteration.id,
        );
      }
      for (const [index, page] of pages.entries()) {
        const imagePath = this.storeUiImage(loop.id, iteration.id, round, index, page.absPath);
        this.deps.db.createProjectLoopUiReview({
          loopId: loop.id,
          iterationId: iteration.id,
          round,
          pageName: page.name,
          description: page.description,
          imagePath,
        });
      }
      this.deps.db.updateProjectLoop(loop.id, { status: "awaiting-ui-approval" });
      this.deps.db.updateProjectLoopIteration(iteration.id, { status: "awaiting-ui-approval" });
      this.appendEvent(
        loop,
        "ui-review",
        "UI approval required",
        `${String(pages.length)} affected page${pages.length === 1 ? "" : "s"} captured. Review each screenshot in the loop detail page and approve or request changes.`,
        iteration.id,
      );
    }
  }

  private async runAiUiReviewRound(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
    run: RunRecord,
    pages: Array<{ name: string; description: string | null; absPath: string; relPath: string }>,
    round: number,
  ): Promise<void> {
    this.deps.db.updateProjectLoop(loop.id, { status: "reviewing-ui" });
    this.deps.db.updateProjectLoopIteration(iteration.id, { status: "reviewing-ui" });
    this.appendEvent(
      loop,
      "ui-review",
      "AI UI review started",
      `The review model is checking ${String(pages.length)} affected page${pages.length === 1 ? "" : "s"} (round ${String(round)}).`,
      iteration.id,
    );
    const reviewModelId = loop.reviewModelId ?? loop.runnerModelId;

    let diffExcerpt = "";
    try {
      const git = this.deps.gitService.createGitClient(run.worktreePath);
      const targetBranch = iteration.targetBranch ?? loop.baseBranch;
      diffExcerpt = String(await git.raw(["diff", `${targetBranch}...HEAD`, "--unified=2"])).slice(0, 12_000);
    } catch {
      diffExcerpt = "";
    }

    for (const [index, page] of pages.entries()) {
      this.assertNotCancelled(state);
      const imagePath = this.storeUiImage(loop.id, iteration.id, round, index, page.absPath);
      let verdict = null;
      try {
        const raw = await this.deps.askModelForText(run.worktreePath, reviewModelId, {
          prompt: buildLoopAiUiReviewPrompt({
            loop,
            iteration,
            page: { name: page.name, description: page.description, relativeImagePath: page.relPath },
            diffExcerpt,
          }),
          systemPrompt: "You are a meticulous UI reviewer. Open the referenced screenshot image and judge it. Return strict JSON only.",
          maxTokens: 700,
          temperature: 0.2,
          usageProjectId: loop.projectId,
        });
        verdict = parseLoopAiUiVerdict(raw);
      } catch (error) {
        this.deps.logWarn("AI UI review call failed for a page.", { loopId: loop.id, pageName: page.name, error });
      }
      if (!verdict) {
        // Never auto-approve an ambiguous or unparseable verdict; escalate the page
        // to a manual (pending) review so the user decides.
        this.deps.db.createProjectLoopUiReview({
          loopId: loop.id,
          iterationId: iteration.id,
          round,
          pageName: page.name,
          description: page.description,
          imagePath,
        });
        this.appendEvent(
          loop,
          "ui-review",
          "AI verdict unavailable",
          `The reviewer did not return a clear verdict for "${page.name}". Approve or reject this page yourself in the loop detail page.`,
          iteration.id,
        );
        continue;
      }
      this.deps.db.createProjectLoopUiReview({
        loopId: loop.id,
        iterationId: iteration.id,
        round,
        pageName: page.name,
        description: page.description,
        imagePath,
        status: verdict.verdict === "approve" ? "ai-approved" : "ai-changes-requested",
        feedback: verdict.feedback || null,
      });
      this.appendEvent(
        loop,
        "ui-review",
        verdict.verdict === "approve" ? `AI approved: ${page.name}` : `AI requested changes: ${page.name}`,
        verdict.verdict === "approve" ? (verdict.feedback || "The page looks good.") : verdict.feedback,
        iteration.id,
      );
    }
  }

  private async applyUiFeedback(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
    run: RunRecord,
    changeRequests: ProjectLoopUiReviewRecord[],
  ): Promise<void> {
    this.deps.db.updateProjectLoop(loop.id, { status: "implementing" });
    this.deps.db.updateProjectLoopIteration(iteration.id, { status: "implementing" });
    this.appendEvent(
      loop,
      "runner",
      "Applying UI feedback",
      changeRequests.map((review) => `- ${review.pageName}: ${review.feedback ?? "changes requested"}`).join("\n"),
      iteration.id,
    );
    await this.deps.followUpRun(
      run.id,
      buildLoopUiFixPrompt(
        loop,
        changeRequests.map((review) => ({ pageName: review.pageName, feedback: review.feedback ?? "Changes were requested." })),
      ),
      { yoloMode: true },
    );
    const finished = await this.waitForRunCompletion(state, run.id);
    this.assertNotCancelled(state);
    if (finished.status !== "completed") {
      throw new Error(`The UI feedback follow-up for "${iteration.title}" did not complete (status: ${finished.status}).`);
    }
  }

  // --- Commit / push / PR -------------------------------------------------

  private async countCommitsAhead(run: RunRecord, targetBranch: string): Promise<number> {
    const git = this.deps.gitService.createGitClient(run.worktreePath);
    for (const ref of [`origin/${targetBranch}`, targetBranch]) {
      try {
        const raw = await git.raw(["rev-list", "--count", `${ref}..HEAD`]);
        const count = Number(String(raw).trim());
        if (Number.isFinite(count)) {
          return count;
        }
      } catch {
        /* try the next ref */
      }
    }
    return 1;
  }

  /** @returns false when the iteration produced no commits and was skipped. */
  private async ensurePullRequestCreated(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
  ): Promise<boolean> {
    this.assertNotCancelled(state);
    if (!iteration.runId || !iteration.branchName) {
      throw new Error(`Iteration "${iteration.title}" has no implementation branch.`);
    }
    const run = this.deps.db.getRun(iteration.runId);
    const targetBranch = iteration.targetBranch ?? loop.baseBranch;
    this.deps.db.updateProjectLoop(loop.id, { status: "creating-pr" });
    this.deps.db.updateProjectLoopIteration(iteration.id, { status: "creating-pr" });
    this.emit(loop);

    this.cleanupWorkspaceUiDir(run);
    if (await this.deps.gitService.hasChanges(run.worktreePath)) {
      await this.deps.gitService.commitAllChanges(run.worktreePath, iteration.title);
    }
    const commitsAhead = await this.countCommitsAhead(run, targetBranch);
    if (commitsAhead === 0) {
      this.deps.db.updateProjectLoopIteration(iteration.id, { status: "skipped" });
      this.appendEvent(
        loop,
        "system",
        `Iteration ${String(iteration.iterationIndex + 1)} skipped`,
        `"${iteration.title}" produced no commits, so no PR/MR was created.`,
        iteration.id,
      );
      return false;
    }

    await this.deps.gitService.publishBranch(run.worktreePath, iteration.branchName);

    const forge = await this.deps.createForgeProvider(loop.projectId);
    const description = [
      iteration.objective,
      "",
      "---",
      `Created automatically by BuildWarden Loop "${loop.name}" (iteration ${String(iteration.iterationIndex + 1)}).`,
    ].join("\n");
    let summary;
    try {
      summary = await forge.createRequest({
        sourceBranch: iteration.branchName,
        targetBranch,
        title: iteration.title,
        description,
      });
    } catch (error) {
      // The PR may already exist from an interrupted earlier attempt.
      const existing = (await forge.listRequests({ state: "open" })).items.find(
        (item) => item.sourceBranch === iteration.branchName,
      );
      if (!existing) {
        throw error;
      }
      summary = existing;
    }
    this.deps.db.updateProjectLoopIteration(iteration.id, {
      status: "awaiting-merge",
      prUrl: summary.url,
      prNumber: summary.number,
    });
    this.deps.db.updateProjectLoop(loop.id, { status: "awaiting-merge" });
    this.appendEvent(
      loop,
      "forge",
      summary.provider === "gitlab" ? "Merge request created" : "Pull request created",
      `${summary.url}\nSource: ${iteration.branchName} -> ${targetBranch}${
        loop.mergePolicy === "auto-merge"
          ? "\nThe loop merges this request automatically once it is mergeable and has no unaddressed review comments."
          : "\nThe loop waits until this request is approved or merged, addressing review comments in the meantime."
      }`,
      iteration.id,
    );
    return true;
  }

  // --- Merge monitoring ----------------------------------------------------

  private async monitorUntilMerged(state: LoopRuntimeState, loopId: string, iterationId: string): Promise<void> {
    const loop = this.deps.db.getProjectLoop(loopId);
    const forge = await this.deps.createForgeProvider(loop.projectId);
    let commentRounds = 0;
    let lastMergeError: string | null = null;

    for (;;) {
      this.assertNotCancelled(state);
      const iteration = this.deps.db.getProjectLoopIteration(iterationId);
      if (!iteration.prUrl) {
        throw new Error(`Iteration "${iteration.title}" lost its PR/MR reference.`);
      }

      let details;
      try {
        details = await forge.getRequestDetails({ prUrl: iteration.prUrl });
      } catch (error) {
        this.deps.logWarn("Could not poll the loop PR/MR state; retrying.", { loopId, prUrl: iteration.prUrl, error });
        await this.sleep(state, PR_POLL_INTERVAL_MS);
        continue;
      }

      const requestState = normalizeForgeRequestState(details.request.state);
      if (requestState === "merged") {
        this.deps.db.updateProjectLoopIteration(iterationId, { status: "merged" });
        this.appendEvent(
          loop,
          "forge",
          `Iteration ${String(iteration.iterationIndex + 1)} merged`,
          `${iteration.prUrl} was merged into ${iteration.targetBranch ?? loop.baseBranch}.`,
          iterationId,
        );
        return;
      }
      if (requestState === "closed") {
        throw new Error(`${iteration.prUrl} was closed without merging. Resume the loop to retry this iteration.`);
      }

      if (loop.prReviewPolicy === "ai-review" && !iteration.aiReviewPosted) {
        await this.runAiPrReview(state, loop, iteration, forge);
        // The next cycle picks the posted review comments up as actionable feedback.
        continue;
      }

      const processedIds = parseProcessedCommentIds(iteration.processedCommentIdsJson);
      const feedback = extractLoopActionableFeedback(details.reviewThreads, details.activity, processedIds);

      if (feedback.threads.length > 0 || feedback.generalComments.length > 0) {
        commentRounds += 1;
        if (commentRounds > LOOP_MAX_COMMENT_ROUNDS) {
          throw new Error(`The loop addressed review comments ${String(LOOP_MAX_COMMENT_ROUNDS)} times on ${iteration.prUrl} without reaching a merge. It stopped to avoid an endless cycle.`);
        }
        await this.addressReviewFeedback(state, loop, iteration, forge, feedback, processedIds);
        continue;
      }

      // No open feedback: merge if the policy allows it.
      const unresolvedThreads = details.reviewThreads.filter((thread) => thread.resolved === false).length;
      let shouldMerge = false;
      if (loop.mergePolicy === "auto-merge") {
        shouldMerge = unresolvedThreads === 0;
      } else {
        try {
          const approval = await forge.getRequestApprovalStatus({ prUrl: iteration.prUrl });
          shouldMerge = approval.approved;
        } catch (error) {
          this.deps.logWarn("Could not read the PR/MR approval status.", { loopId, prUrl: iteration.prUrl, error });
        }
      }
      if (shouldMerge) {
        try {
          await forge.mergeRequest({ prUrl: iteration.prUrl });
          // The merged state is confirmed on the next poll cycle (no sleep needed).
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastMergeError) {
            lastMergeError = message;
            this.appendEvent(
              loop,
              "forge",
              "Merge attempt failed",
              `${message}\nThe loop keeps retrying while waiting for the request to become mergeable.`,
              iterationId,
            );
          }
        }
      }

      await this.sleep(state, PR_POLL_INTERVAL_MS);
    }
  }

  /**
   * Posts the loop's own AI code review on the freshly created PR/MR so it is visible on the
   * Git host. The findings are posted WITHOUT the loop marker on purpose: the regular
   * comment-addressing cycle then treats them like human feedback, fixes them, replies, and
   * resolves the threads. Runs exactly once per PR (also on failure, to avoid retry storms).
   */
  private async runAiPrReview(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
    forge: ProjectPrReviewProvider,
  ): Promise<void> {
    this.assertNotCancelled(state);
    if (!iteration.prUrl) {
      return;
    }
    try {
      const reviewModelId = loop.reviewModelId ?? loop.runnerModelId;
      const run = iteration.runId ? this.deps.db.getRun(iteration.runId) : null;
      const cwd =
        run && existsSync(run.worktreePath) ? run.worktreePath : this.deps.db.getProject(loop.projectId).repoPath;

      let diff = "";
      try {
        diff = (await forge.getRequestDiff({ prUrl: iteration.prUrl })).diff;
      } catch (error) {
        this.deps.logWarn("Could not load the PR diff for the AI review.", { loopId: loop.id, prUrl: iteration.prUrl, error });
      }
      if (!diff.trim()) {
        this.appendEvent(
          loop,
          "forge",
          "AI PR review skipped",
          "The PR/MR diff could not be loaded, so no automatic review was posted.",
          iteration.id,
        );
        return;
      }
      if (diff.length > LOOP_PR_REVIEW_DIFF_CHAR_LIMIT) {
        diff = `${diff.slice(0, LOOP_PR_REVIEW_DIFF_CHAR_LIMIT)}\n\n[Diff truncated for review - focus on the highest-risk changes.]`;
      }

      this.assertNotCancelled(state);
      const raw = await this.deps.askModelForText(cwd, reviewModelId, {
        prompt: buildLoopPrReviewPrompt({ loop, iteration, prUrl: iteration.prUrl, diff }),
        systemPrompt: "You are a meticulous code reviewer. Return strict JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_600,
        temperature: 0.2,
        usageProjectId: loop.projectId,
      });
      this.assertNotCancelled(state);
      const review = parseLoopPrReviewResult(raw);
      if (!review) {
        this.appendEvent(
          loop,
          "forge",
          "AI PR review skipped",
          "The review model did not return a parseable review, so no automatic review was posted.",
          iteration.id,
        );
        return;
      }

      const severityLabel = { high: "High", medium: "Medium", low: "Low" } as const;
      const inlineFindings = review.findings.filter((finding) => finding.line !== null);
      const generalFindings = review.findings.filter((finding) => finding.line === null);

      if (review.findings.length === 0) {
        // A clean review is informational only; the marker keeps it out of the feedback cycle.
        await forge.postReview({
          prUrl: iteration.prUrl,
          body: [
            "### BuildWarden Loop AI review",
            review.summary || "The automatic review found no blocking issues.",
            "",
            LOOP_COMMENT_MARKER,
          ].join("\n"),
          event: "comment",
        });
        this.appendEvent(loop, "forge", "AI PR review posted", "The automatic review found no blocking issues.", iteration.id);
        return;
      }

      const findingBody = (finding: (typeof review.findings)[number]) =>
        `**AI review - ${severityLabel[finding.severity]}:** ${finding.comment}`;
      let postedInline = 0;
      if (inlineFindings.length > 0) {
        try {
          await forge.submitComments({
            prUrl: iteration.prUrl,
            mode: "review",
            body: [
              "### BuildWarden Loop AI review",
              review.summary || `${String(review.findings.length)} finding(s).`,
              "",
              LOOP_COMMENT_MARKER,
            ].join("\n"),
            comments: inlineFindings.map((finding) => ({
              oldPath: finding.path,
              newPath: finding.path,
              side: "new" as const,
              oldLineNumber: null,
              newLineNumber: finding.line,
              changeType: "insert" as const,
              body: findingBody(finding),
            })),
          });
          postedInline = inlineFindings.length;
        } catch (error) {
          this.deps.logWarn("Could not post inline AI review comments; falling back to a summary comment.", {
            loopId: loop.id,
            prUrl: iteration.prUrl,
            error,
          });
        }
      }

      const leftoverFindings = postedInline > 0 ? generalFindings : review.findings;
      if (leftoverFindings.length > 0) {
        // Posted WITHOUT the marker so the addressing cycle treats it as actionable feedback.
        await forge.postReview({
          prUrl: iteration.prUrl,
          body: [
            "### BuildWarden Loop AI review",
            review.summary,
            "",
            ...leftoverFindings.map((finding) => `- \`${finding.path}\`${finding.line ? `:${String(finding.line)}` : ""} - ${findingBody(finding)}`),
          ]
            .filter(Boolean)
            .join("\n"),
          event: "comment",
        });
      }

      this.appendEvent(
        loop,
        "forge",
        `AI PR review posted (${String(review.findings.length)} finding${review.findings.length === 1 ? "" : "s"})`,
        [
          review.summary,
          postedInline > 0 ? `${String(postedInline)} inline comment${postedInline === 1 ? "" : "s"} posted on the diff.` : null,
          leftoverFindings.length > 0 ? `${String(leftoverFindings.length)} finding(s) posted as a PR comment.` : null,
          "The loop now addresses these findings like regular review comments.",
        ]
          .filter(Boolean)
          .join("\n"),
        iteration.id,
      );
    } catch (error) {
      if (error instanceof LoopCancelledError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logError("The AI PR review failed; the loop continues without it.", error, { loopId: loop.id, iterationId: iteration.id });
      this.appendEvent(loop, "forge", "AI PR review failed", `${message}\nThe loop continues waiting for the merge without an automatic review.`, iteration.id);
    } finally {
      if (!state.cancelled) {
        this.deps.db.updateProjectLoopIteration(iteration.id, { aiReviewPosted: true });
      }
    }
  }

  private async addressReviewFeedback(
    state: LoopRuntimeState,
    loop: ProjectLoopRecord,
    iteration: ProjectLoopIterationRecord,
    forge: ProjectPrReviewProvider,
    feedback: ReturnType<typeof extractLoopActionableFeedback>,
    processedIds: Set<string>,
  ): Promise<void> {
    if (!iteration.runId || !iteration.prUrl || !iteration.branchName) {
      throw new Error(`Iteration "${iteration.title}" cannot address comments without a run and PR.`);
    }
    const run = this.deps.db.getRun(iteration.runId);
    if (!existsSync(run.worktreePath)) {
      throw new Error(`The workspace of iteration "${iteration.title}" is no longer available to address review comments.`);
    }
    this.deps.db.updateProjectLoop(loop.id, { status: "addressing-comments" });
    this.deps.db.updateProjectLoopIteration(iteration.id, { status: "addressing-comments" });
    const totalComments =
      feedback.threads.reduce((sum, entry) => sum + entry.newComments.length, 0) + feedback.generalComments.length;
    this.appendEvent(
      loop,
      "forge",
      "New review comments",
      `${String(totalComments)} new comment${totalComments === 1 ? "" : "s"} on ${iteration.prUrl}. The loop is addressing them.`,
      iteration.id,
    );

    await this.deps.followUpRun(
      run.id,
      buildLoopCommentsFixPrompt({
        loop,
        iteration,
        prUrl: iteration.prUrl,
        threads: feedback.threads.map((entry) => ({
          path: entry.thread.path || null,
          line: entry.thread.newLineNumber ?? entry.thread.oldLineNumber,
          comments: entry.thread.comments.map((comment) => ({
            author: comment.author?.username ?? null,
            body: comment.body,
          })),
        })),
        generalComments: feedback.generalComments.map((item) => ({
          author: item.author?.username ?? null,
          body: item.body ?? "",
        })),
      }),
      { yoloMode: true },
    );
    const finished = await this.waitForRunCompletion(state, run.id);
    this.assertNotCancelled(state);
    if (finished.status !== "completed") {
      throw new Error(`The comment-addressing run for "${iteration.title}" did not complete (status: ${finished.status}).`);
    }

    this.cleanupWorkspaceUiDir(run);
    if (await this.deps.gitService.hasChanges(run.worktreePath)) {
      await this.deps.gitService.commitAllChanges(run.worktreePath, `Address review comments on ${iteration.title}`);
    }
    // Push before replying: never claim comments were addressed while the fixes are local-only.
    await this.deps.gitService.publishBranch(run.worktreePath, iteration.branchName);

    const replyBody = [
      "Addressed in the latest commit on this branch.",
      finished.summary?.trim() ? `\n${finished.summary.trim().slice(0, 1_500)}` : "",
      `\n\n${LOOP_COMMENT_MARKER}`,
    ].join("");
    for (const entry of feedback.threads) {
      try {
        await forge.replyToThread({
          prUrl: iteration.prUrl,
          threadId: entry.thread.providerThreadId,
          replyToCommentId: entry.thread.replyToCommentId,
          body: replyBody,
        });
      } catch (error) {
        this.deps.logWarn("Could not reply to a review thread.", { loopId: loop.id, threadId: entry.thread.providerThreadId, error });
      }
      try {
        await forge.resolveThread({ prUrl: iteration.prUrl, threadId: entry.thread.providerThreadId, resolved: true });
      } catch (error) {
        this.deps.logWarn("Could not resolve a review thread.", { loopId: loop.id, threadId: entry.thread.providerThreadId, error });
      }
    }
    if (feedback.generalComments.length > 0) {
      try {
        await forge.postReview({
          prUrl: iteration.prUrl,
          body: replyBody,
          event: "comment",
        });
      } catch (error) {
        this.deps.logWarn("Could not post the loop's comment reply.", { loopId: loop.id, error });
      }
    }

    for (const id of feedback.seenCommentIds) {
      processedIds.add(id);
    }
    this.deps.db.updateProjectLoopIteration(iteration.id, {
      status: "awaiting-merge",
      processedCommentIdsJson: serializeProcessedCommentIds(processedIds),
    });
    this.deps.db.updateProjectLoop(loop.id, { status: "awaiting-merge" });
    this.appendEvent(
      loop,
      "forge",
      "Review comments addressed",
      "The fixes were committed and pushed; the addressed threads were answered and resolved.",
      iteration.id,
    );
  }

  // --- Audit ----------------------------------------------------------------

  private async runAudit(state: LoopRuntimeState, loop: ProjectLoopRecord): Promise<void> {
    this.assertNotCancelled(state);
    const project = this.deps.db.getProject(loop.projectId);
    const iterations = this.deps.db.listProjectLoopIterations(loop.id);
    this.deps.db.updateProjectLoop(loop.id, { status: "auditing" });
    this.emit(loop);
    try {
      const auditModelId = loop.reviewModelId ?? loop.runnerModelId;
      const audit = await this.deps.askModelForText(project.repoPath, auditModelId, {
        prompt: buildLoopAuditPrompt({ project, loop, iterations }),
        systemPrompt: "You audit completed software changes. Be direct, concrete, and brief.",
        maxTokens: 900,
        temperature: 0.2,
        usageProjectId: project.id,
      });
      this.assertNotCancelled(state);
      this.appendEvent(loop, "audit", "Final audit", audit.trim() || "The audit returned no findings.");
    } catch (error) {
      this.deps.logWarn("The final loop audit failed; the loop still completes.", { loopId: loop.id, error });
      this.appendEvent(
        loop,
        "audit",
        "Audit skipped",
        `The final audit could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const merged = this.deps.db.listProjectLoopIterations(loop.id).filter((iteration) => iteration.status === "merged").length;
    this.deps.db.updateProjectLoop(loop.id, { status: "completed", finishedAt: new Date().toISOString() });
    this.appendEvent(
      loop,
      "system",
      "Loop completed",
      `${String(merged)} PR${merged === 1 ? "" : "s"} merged into ${loop.baseBranch}.`,
    );
  }
}
