import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  APP_SETTING_KEYS,
  COUNCIL_REVIEW_EVENT_TITLE,
  type CouncilApplyRecord,
  type CouncilRound,
  parseCouncilSettings,
  type ProjectRecord,
  resolveCouncilReviewers,
  type RunRecord,
} from "@buildwarden/shared";
import type { AppController } from "../app-controller";
import { councilApplyStepContent, type CouncilSubject } from "../council-prompts";
import { CouncilService } from "../council-service";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { buildContextHandoffBlock } from "../provider-context-handoff";
import { captureWorkspaceRevision } from "../workspace-revision";
import { AppService } from "./app-service";
import { FOLDER_BASELINE_MISSING_REASON, MAX_DIFF_CHARS_FOR_REVIEW } from "./app-service-constants";
import { providerAllowsMissingApiKey } from "./provider-model-support";
import { latestUserTurnUsedFullAccess, mergeOrchestrationExecutionOptions, resolveProviderExecutionOptions } from "./run-execution-settings";
import { latestRunAnswerText, parseMetadataRecord, runUserRequests } from "./run-step-content";

const councilCodeFingerprint = (revision: { fingerprint: string }): string => `code:${revision.fingerprint}`;
const councilTextFingerprint = (answer: string): string => `text:${createHash("sha256").update(answer).digest("hex")}`;

/**
 * Where a run's committed work begins: the head recorded when it started. A worktree run from before
 * that record uses its base branch. A local run has no branch of its own, so it gets null and its
 * start has to be found in history.
 */
export const councilCommittedBaseRef = (
  run: Pick<RunRecord, "workspaceType">,
  baseBranch: string,
  reviewBaseline: string | null,
): string | null => reviewBaseline ?? (run.workspaceType === "worktree" ? baseBranch : null);

/** Connects council validation rounds with runs, workspaces and workers. */
export class CouncilRunService extends AppService<
  | "activeWorkers"
  | "appState"
  | "controller"
  | "processes"
  | "providerRuntime"
  | "runDeletion"
  | "runDetails"
  | "runEvents"
  | "settings"
  | "turnState"
  | "workspaceGuard"
> {
  isCouncilReviewRun(runId: string): boolean {
    try {
      return this.db.getRun(runId).kind === "council-review";
    } catch {
      return false;
    }
  }

  async deleteCouncilChildren(run: RunRecord): Promise<void> {
    await this.getCouncilService().stopForRun(run.id);
    for (const childRunId of this.db.listCouncilChildRunIds(run.id)) await this.deleteCouncilChildRun(childRunId);
  }

  async deleteCouncilChildRun(childRunId: string): Promise<void> {
    await this.services.processes.stopRunOwnedProcesses(childRunId);
    await this.releaseCouncilChildWorkspace(this.db.getRun(childRunId));
    this.db.deleteProviderSessionRuntime(childRunId, "run");
    this.db.deleteRun(childRunId);
  }

  private councilService?: CouncilService;

  getCouncilService(): CouncilService {
    return this.councilService ??= new CouncilService(this.db, {
      getRun: (runId) => this.db.getRun(runId),
      getSettings: () => parseCouncilSettings(this.db.getSettings()[APP_SETTING_KEYS.council]),
      getReviewers: () => resolveCouncilReviewers(parseCouncilSettings(this.db.getSettings()[APP_SETTING_KEYS.council]), this.db.listModels()),
      describeModel: (modelId) => {
        const model = this.db.getModel(modelId);
        return { label: model.displayName, providerLabel: this.db.getProviderAccount(model.providerAccountId).label };
      },
      isRunBusy: (runId) => this.services.activeWorkers.runWorkers.has(runId) || ["queued", "preparing", "running"].includes(this.db.getRun(runId).status),
      captureSubject: (run) => this.captureCouncilSubject(run),
      currentFingerprint: async (run, kind) => {
        if (kind === "code") return councilCodeFingerprint(await this.captureCouncilRevision(run));
        const answer = latestRunAnswerText(this.db.getRunSteps(run.id));
        return answer ? councilTextFingerprint(answer) : null;
      },
      readConversation: (run) => {
        // The progress card is noise here, but the fix turns that carry earlier findings are history.
        const steps = this.db.getRunSteps(run.id).filter((step) => step.eventType !== "status" || !parseMetadataRecord(step.metadataJson).councilRoundId);
        return buildContextHandoffBlock(steps, { strategy: "full", fromStepIndex: 0, turnCount: 1 });
      },
      getLimitReason: (modelId) => this.getCouncilLimitReason(modelId),
      startChild: (round, input) => this.startCouncilChild(round, input),
      messageChild: async (childRunId, prompt) => {
        const child = this.db.getRun(childRunId);
        await this.services.appState.withPreservedRunSelection(() => this.services.controller.followUpRunInternal(childRunId, prompt, { mode: "ask", modelId: child.modelId, yoloMode: false }, { source: "council" }));
      },
      stopChild: async (childRunId) => {
        await this.services.processes.stopRunOwnedProcesses(childRunId);
        const child = this.db.getRun(childRunId);
        if (["queued", "preparing", "running"].includes(child.status)) this.db.updateRunStatus(childRunId, "cancelled", { errorMessage: "Stopped by validation." });
      },
      releaseChild: (childRunId) => this.releaseCouncilChildWorkspace(this.db.getRun(childRunId)),
      readChild: (childRunId) => {
        const child = this.db.getRun(childRunId);
        return {
          status: child.status,
          text: latestRunAnswerText(this.db.getRunSteps(childRunId)) || child.summary?.trim() || "",
          errorMessage: child.errorMessage,
          inputTokens: child.inputTokens,
          outputTokens: child.outputTokens,
        };
      },
      startApply: (round, prompt, record) => this.startCouncilApply(round, prompt, record),
      setRunMode: (runId, mode) => { this.db.updateRunConfiguration(runId, { mode }); },
      appendStep: (round, content) => this.db.appendRunStep(round.runId, "status", COUNCIL_REVIEW_EVENT_TITLE, content, JSON.stringify({ councilRoundId: round.id })).id,
      publish: (round, content) => {
        const metadata = { councilRoundId: round.id, councilStatus: round.status };
        const step = round.stepId ? this.db.updateRunStep(round.stepId, { content, metadataJson: JSON.stringify(metadata) }) : undefined;
        this.services.runEvents.emitEvent({ runId: round.runId, type: "status", title: COUNCIL_REVIEW_EVENT_TITLE, content, metadata, createdAt: new Date().toISOString(), ...(step ? { step } : {}) });
      },
      logError: (message, error, context) => this.logControllerError(message, error, context),
    });
  }

  async startCouncil(runId: string): Promise<CouncilRound> {
    return this.getCouncilService().start(runId);
  }

  async getCouncilRounds(runId: string): Promise<CouncilRound[]> {
    const rounds = this.db.listCouncilRounds(runId);
    const latest = rounds.at(-1);
    if (!latest || latest.status !== "ready") return rounds;
    const run = this.db.getRun(runId);
    const current = await (latest.kind === "code"
      ? this.captureCouncilRevision(run).then(councilCodeFingerprint)
      : Promise.resolve(councilTextFingerprint(latestRunAnswerText(this.db.getRunSteps(runId))))).catch(() => null);
    return rounds.map((round) => (round === latest ? { ...round, stale: current !== null && current !== round.subjectFingerprint } : round));
  }

  async cancelCouncil(roundId: string): Promise<CouncilRound> {
    return this.getCouncilService().cancel(roundId);
  }

  async applyCouncilFindings(roundId: string, groupIds: string[]): Promise<CouncilRound> {
    return this.getCouncilService().applyFindings(roundId, groupIds);
  }

  async reconcileCouncilAfterRestart(): Promise<void> {
    await this.getCouncilService().reconcileAfterRestart();
  }

  /** Runs after a turn ends. Validation problems are logged and never touch the finished run. */
  handleCouncilRunTerminal(runId: string, startEligible: boolean): void {
    const service = this.getCouncilService();
    service.restoreRunMode(runId);
    void service.onRunTerminal(runId)
      .then((wasApplyTurn) => (wasApplyTurn || !startEligible ? undefined : service.autoStart(runId)))
      .catch((error: unknown) => this.logControllerError("Could not update validation after a run finished.", error, { runId }));
  }

  handleCouncilChildTerminal(childRunId: string): void {
    void this.getCouncilService().onChildTerminal(childRunId)
      .catch((error: unknown) => this.logControllerError("Could not record a validation result.", error, { childRunId }));
  }

  private captureCouncilRevision(run: RunRecord) {
    return captureWorkspaceRevision(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId)), run.workspaceVcs);
  }

  private async readCouncilDiff(run: RunRecord): Promise<string> {
    const project = this.db.getProject(run.projectId);
    const { diff, worktreeUnavailable, diffUnavailableReason } = await this.services.runDetails.readRunWorktreeDiff(run.id);
    // A deleted workspace leaves only the answer to review, but this folder still holds unknown changes.
    if (diffUnavailableReason === FOLDER_BASELINE_MISSING_REASON) {
      throw new Error("This run's folder baseline is missing, so its changes cannot be reviewed.");
    }
    if (worktreeUnavailable) return "";
    if (run.workspaceVcs !== "git") return diff;
    // A committed run has a clean working tree, so its work has to be read from history.
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    const onRunBranch = !run.branchName.trim() || (run.workspaceType === "worktree"
      ? await this.gitService.isWorktreeOnBranch(workspacePath, run.branchName)
      : await this.gitService.getCurrentBranch(workspacePath) === run.branchName);
    if (!onRunBranch) throw new Error(`Check out the run branch "${run.branchName}" before validating it.`);
    const readCommits = async (): Promise<string> => {
      const baseRef = councilCommittedBaseRef(run, project.baseBranch, this.db.getRunReviewBaseline(run.id))
        ?? await this.gitService.findCommitAtTime(workspacePath, run.createdAt);
      return baseRef ? this.gitService.getCommittedDiffSince(workspacePath, baseRef) : "";
    };
    // Carrying on without them would pass a partial review off as a complete one.
    const committed = await readCommits().catch((error: unknown) => {
      throw new Error("Could not read this run's commits, so its changes cannot be reviewed.", { cause: error });
    });
    return [committed, diff].filter((part) => part.trim()).join("\n");
  }

  private async captureCouncilSubject(run: RunRecord): Promise<CouncilSubject> {
    const steps = this.db.getRunSteps(run.id);
    const requests = runUserRequests(run, steps);
    const before = await this.captureCouncilRevision(run).catch(() => null);
    const diff = await this.readCouncilDiff(run);
    const after = before && await this.captureCouncilRevision(run).catch(() => null);
    // A change mid-read leaves a subject that mixes two states, and the fingerprint can't reveal it later.
    if (before && (before.fingerprint !== after?.fingerprint || before.head !== after.head)) {
      throw new Error("This run's workspace changed while it was being read. Validate it again.");
    }
    if (diff.trim()) {
      const clipped = diff.length > MAX_DIFF_CHARS_FOR_REVIEW
        ? `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated. Read the changed files directly.]`
        : diff;
      return { kind: "code", requests, diff: clipped, answer: null, fingerprint: councilCodeFingerprint(before ?? await this.captureCouncilRevision(run)) };
    }
    const answer = latestRunAnswerText(steps);
    if (!answer) throw new Error("This run has no changes or answer to validate.");
    return { kind: "text", requests, diff: null, answer, fingerprint: councilTextFingerprint(answer) };
  }

  /** Best effort: an unknown limit never blocks a reviewer, which would simply fail on its own. */
  private async getCouncilLimitReason(modelId: string): Promise<string | null> {
    return (await this.services.providerRuntime.getProviderLimitState(modelId))?.reason ?? null;
  }

  /** Every child gets its own copy, so nothing it does can reach the user's workspace. */
  private async prepareCouncilWorkspace(
    round: CouncilRound,
    parent: RunRecord,
    project: ProjectRecord,
    configuredWorktreeRoot: string | undefined,
  ): ReturnType<AppController["prepareContinuationWorkspace"]> {
    const source = { ...parent, worktreePath: this.services.workspaceGuard.getEffectiveRunWorkspacePath(parent, project) };
    if (round.kind === "code" || existsSync(source.worktreePath)) {
      return this.services.controller.prepareContinuationWorkspace(source, project, true, configuredWorktreeRoot, true);
    }
    // The run's workspace is gone, and its branch may be too. A text review only needs the project.
    const branchName = parent.workspaceVcs === "git" ? await this.services.controller.resolveWorktreeStartPoint(project, project.baseBranch) : parent.branchName;
    return this.services.controller.prepareContinuationWorkspace({ ...source, branchName }, project, false, configuredWorktreeRoot, true);
  }

  private async startCouncilChild(
    round: CouncilRound,
    input: { modelId: string; effort: string | null; title: string; prompt: string },
  ): Promise<string> {
    const parent = this.db.getRun(round.runId);
    const project = this.db.getProject(parent.projectId);
    const model = this.db.getModel(input.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error(`Credentials are unavailable for ${provider.label}.`);
    }
    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    const workspace = await this.prepareCouncilWorkspace(round, parent, project, configuredWorktreeRoot);
    let child: RunRecord;
    try {
      child = this.db.createRun({
        projectId: parent.projectId,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: getHarnessTypeForProvider(provider.providerType),
        mode: "ask",
        workspaceType: workspace.workspaceType,
        workspaceVcs: workspace.workspaceVcs,
        prompt: input.title,
        goalText: parent.goalText,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        kind: "council-review",
        parentRunId: parent.id,
        rootRunId: parent.rootRunId ?? parent.id,
        lineageTitle: input.title,
        workspaceSetupProfile: null,
        delegationEnabled: false,
      });
    } catch (error) {
      await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, workspace);
      throw error;
    }
    this.db.upsertWorktree({ id: child.id, projectId: child.projectId, runId: child.id, branchName: child.branchName, worktreePath: child.worktreePath, status: "ready" });
    const inherited = input.modelId === parent.modelId ? this.services.turnState.getLatestRunExecutionOptions(parent.id, provider) : undefined;
    const executionOptions = resolveProviderExecutionOptions(provider, {
      executionOptions: mergeOrchestrationExecutionOptions(inherited, input.effort ?? undefined),
    });
    await this.services.runEvents.appendRunEvent(child.id, "log", "Validation task", input.title, {
      source: "council",
      commandType: "initial",
      councilRoundId: round.id,
      modelId: model.id,
      yoloMode: false,
      executionOptions,
    });
    child = this.db.updateRunStatus(child.id, "preparing");
    try {
      const worker = await this.services.controller.startWorker(child, provider, model, apiKey ?? "", await this.services.settings.resolveNetworkProxyRuntimeConfig(), {
        promptOverride: input.prompt,
        providerOptions: executionOptions,
        yoloMode: false,
      });
      this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
    } catch (error) {
      this.db.updateRunStatus(child.id, "failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      await this.releaseCouncilChildWorkspace(child);
      throw error;
    }
    return child.id;
  }

  private async releaseCouncilChildWorkspace(child: RunRecord): Promise<void> {
    if (!existsSync(child.worktreePath)) return;
    const project = this.db.getProject(child.projectId);
    await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, child);
    this.db.deleteProviderSessionRuntime(child.id, "run");
    this.services.turnState.clearRunCheckpoint(child.id);
  }

  private async startCouncilApply(round: CouncilRound, prompt: string, record: CouncilApplyRecord): Promise<void> {
    const run = this.db.getRun(round.runId);
    let mode: RunRecord["mode"] = run.mode;
    if (round.kind === "code") mode = "code";
    else if (round.restoreMode) mode = "ask";
    await this.services.appState.withPreservedRunSelection(() => this.services.controller.followUpRunInternal(
      run.id,
      prompt,
      { mode, modelId: run.modelId, yoloMode: round.kind === "code" && latestUserTurnUsedFullAccess(this.db.getRunSteps(run.id)) },
      { councilRoundId: round.id, councilApply: record, displayPrompt: councilApplyStepContent(record) },
    ));
  }
}
