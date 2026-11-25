import type { Worker } from "node:worker_threads";
import {
  APP_SETTING_KEYS,
  type ModelRecord,
  parseProjectRunDefaultsSetting,
  type ProviderAccountRecord,
  RUN_VERIFICATION_FAILURE_PREFIX,
  type RunRecord,
} from "@buildwarden/shared";
import type { ProjectVerificationResult } from "../project-verification";
import { createResponseImageEmbedder } from "../response-images";
import { type RunBudgetExhaustion, timeBudgetExhaustion, tokenBudgetExhaustion } from "../run-autonomy-budget";
import type { UsageReportTracker } from "../token-usage-accounting";
import { AppService, type AppServiceContext } from "./app-service";
import { AZURE_LEGACY_AUTO_RECOVERY_KIND } from "./app-service-constants";
import type { AppServices } from "./app-services";
import { isTurnStartMetadata, normalizeAssistantOutputText, parseMetadataRecord } from "./run-step-content";
import type { RunEnded } from "./run-ended-notifier";
import type { ActiveWorker, RunWorkerPayload, WorkerDoneResult } from "./worker-payloads";

const AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE = "The run exceeded the maximum number of tool rounds (Azure Legacy).";

const AZURE_LEGACY_AUTO_RECOVERY_PROMPT =
  "Go ahead. The last session was interrupted. Trigger a full build or test first to see if you are done or not. If it fails, go ahead and fix the issues.";

type RunTerminalOutcome = {
  title: string;
  content: string;
  status: "cancelled" | "failed" | "completed";
  errorMessage: string | null;
};

const buildRunTerminalOutcome = (input: {
  wasCancelled: boolean;
  budgetExhaustion: RunBudgetExhaustion | undefined;
  failedVerificationResult: ProjectVerificationResult | undefined;
  waitingForSubagents: boolean;
  inputTokens: number;
  outputTokens: number;
}): RunTerminalOutcome => {
  const usage = `Input tokens: ${input.inputTokens}\nOutput tokens: ${input.outputTokens}`;
  if (input.wasCancelled) {
    return {
      title: "Run cancelled",
      content: `Run cancellation finished cleanup.\n${usage}`,
      status: "cancelled",
      errorMessage: "Run cancelled by user.",
    };
  }
  if (input.budgetExhaustion) {
    return {
      title: "Autonomy budget exhausted",
      content: `${input.budgetExhaustion.reason}\n${usage}`,
      status: "failed",
      errorMessage: input.budgetExhaustion.reason,
    };
  }
  if (input.failedVerificationResult) {
    return {
      title: "Verification gate failed",
      content: `The agent turn finished, but the verification gate failed at: ${input.failedVerificationResult.command}.\n${usage}`,
      status: "failed",
      errorMessage: `${RUN_VERIFICATION_FAILURE_PREFIX}${input.failedVerificationResult.command}`,
    };
  }
  if (input.waitingForSubagents) {
    return {
      title: "Waiting for subagents to complete",
      content: `The coordinator turn completed and is waiting for delegated subagents.\n${usage}`,
      status: "completed",
      errorMessage: null,
    };
  }
  return {
    title: "Run completed",
    content: `Run completed successfully.\n${usage}`,
    status: "completed",
    errorMessage: null,
  };
};

export interface RunWorkerTurnInput {
  run: RunRecord;
  provider: ProviderAccountRecord;
  model: ModelRecord;
  worker: Worker;
  maxRunMinutes: number;
  maxRunTokens: number;
  usageTracker: UsageReportTracker;
}

export type RunWorkerTurnDependencies =
  | "activeWorkers"
  | "followUps"
  | "processes"
  | "runEnded"
  | "runEvents"
  | "runInteractions"
  | "runTurns"
  | "runWorkerOutput"
  | "turnState"
  | "verification"
  | "workspaceGuard";

/** One turn of a run in its worker thread: follows its messages and settles the run when it ends. */
export class RunWorkerTurn extends AppService<RunWorkerTurnDependencies> {
  private readonly streamingStepIds = new Map<string, string>();
  private readonly streamingStepKinds = new Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">();
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the turn's result is being handled, so a later crash or exit cannot settle it again. */
  private settling = false;

  constructor(context: AppServiceContext, services: Pick<AppServices, RunWorkerTurnDependencies>, private readonly turn: RunWorkerTurnInput) {
    super(context, services);
  }

  /** Marks the run as running and follows its worker until the turn ends. */
  begin(): void {
    const { run, worker, maxRunMinutes } = this.turn;
    this.lifecycle.onRunBrowserActive?.(run.id, true);
    worker.once("exit", (code) => {
      const active = this.services.activeWorkers.runWorkers.get(run.id);
      if (!active || active.worker === worker) this.lifecycle.onRunBrowserActive?.(run.id, false);
      if (this.settling || !this.isCurrent()) return;
      void this.fail(`The agent worker exited with code ${String(code)} before it reported a result.`)
        .catch((error) => this.logControllerError("Could not settle a run whose worker exited.", error, { runId: run.id }));
    });
    if (maxRunMinutes > 0) {
      this.budgetTimer = setTimeout(() => this.exhaustBudget(timeBudgetExhaustion(maxRunMinutes)), maxRunMinutes * 60_000);
    }

    const runningRun = this.db.updateRunStatus(run.id, "running");
    this.services.workspaceGuard.updateWorktreeStatus(run, "busy");
    // Step events intentionally omit their full run row on the remote wire. Publish the status
    // transition separately so every client observes preparing -> running without bloating chunks.
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run started",
      content: "The agent is running.",
      createdAt: new Date().toISOString(),
      run: runningRun,
    });

    worker.on("message", (message: unknown) => this.handleMessage(message as RunWorkerPayload));
    worker.on("error", async (error) => {
      this.clearBudgetTimer();
      if (!this.isCurrent()) return;
      this.logControllerError("Run worker emitted a thread error.", error, { runId: run.id });
      await this.fail(error.message);
    });
  }

  private get activeWorker(): ActiveWorker | undefined {
    return this.services.activeWorkers.runWorkers.get(this.turn.run.id);
  }

  /** Worker identity is the turn generation: a replaced or cancelled worker is no longer current. */
  private isCurrent(): boolean {
    return this.activeWorker?.worker === this.turn.worker;
  }

  private clearBudgetTimer(): void {
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
  }

  private readonly resetNarrationStreams = (): void => {
    for (const [streamId, kind] of this.streamingStepKinds.entries()) {
      if (kind === "assistant" || kind === "reasoning") {
        this.streamingStepKinds.delete(streamId);
        this.streamingStepIds.delete(streamId);
      }
    }
  };

  private readonly exhaustBudget = (exhaustion: RunBudgetExhaustion): void => {
    const { run, worker } = this.turn;
    const active = this.activeWorker;
    if (!active || active.worker !== worker || active.cancelled || active.budgetExhaustion) return;
    active.budgetExhaustion = exhaustion;
    this.lifecycle.onRunBrowserActive?.(run.id, false);
    worker.postMessage({ type: "cancel" });
    const metadata = {
      autonomyBudget: true,
      budgetKind: exhaustion.kind,
      limit: exhaustion.limit,
      observed: exhaustion.observed,
    };
    void this.services.runEvents.appendRunEvent(run.id, "status", "Autonomy budget exhausted", exhaustion.reason, metadata)
      .then((step) => {
        this.services.runEvents.emitEvent({
          runId: run.id,
          type: "status",
          title: "Autonomy budget exhausted",
          content: exhaustion.reason,
          metadata,
          createdAt: new Date().toISOString(),
          step,
        });
      })
      .catch((error) => {
        this.logControllerError("Could not persist the autonomy budget event.", error, { runId: run.id });
      });
  };

  private async handleMessage(payload: RunWorkerPayload): Promise<void> {
    const { run, provider, model, worker, maxRunTokens, usageTracker } = this.turn;
    if (payload.type === "steer-result") {
      this.services.followUps.settleFollowUpSteer(payload);
      return;
    }
    // Even a replaced turn's processes belong to this run, so record them before the stale check.
    if (payload.type === "process-spawned") {
      this.services.processes.registerRunWorkerProcess(run, payload);
      return;
    }

    // Ignore late messages from a cancelled/replaced worker so stale turns cannot invoke host
    // tools or overwrite the state of a newer continuation.
    if (!this.isCurrent()) {
      if (payload.type === "chunk") this.acknowledgeChunk(payload);
      return;
    }

    switch (payload.type) {
      case "host-tool-request":
        await this.services.runWorkerOutput.handleRunWorkerHostToolRequest(run.id, worker, payload);
        return;
      case "shell-approval-request":
        await this.services.runInteractions.handleRunWorkerShellApprovalRequest(run, payload);
        return;
      case "user-input-request":
        await this.services.runInteractions.handleRunWorkerUserInputRequest(run, payload);
        return;
      case "chunk":
        try {
          await this.services.runWorkerOutput.handleRunWorkerChunk(
            run,
            provider,
            model.modelId,
            payload,
            maxRunTokens,
            this.exhaustBudget,
            this.streamingStepIds,
            this.streamingStepKinds,
            this.resetNarrationStreams,
            usageTracker,
          );
        } finally {
          this.acknowledgeChunk(payload);
        }
        return;
      case "done":
        await this.finish(payload.result);
        return;
      case "error":
        await this.fail(payload.error);
        return;
    }
  }

  private acknowledgeChunk(payload: Extract<RunWorkerPayload, { type: "chunk" }>): void {
    if (payload.deliveryId !== undefined) this.turn.worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
  }

  /** Settles a turn whose worker finished, including turns that stopped on a cancel or a budget. */
  private async finish(result: WorkerDoneResult): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    this.clearBudgetTimer();
    let ended: RunEnded;
    try {
      ended = await this.settleResult(result);
    } catch (error) {
      // Nothing else settles this turn any more, so the run must not stay active with a worker that is done.
      this.logControllerError("Could not settle a finished run turn.", error, { runId: this.turn.run.id });
      await this.settleFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    await this.releaseWorker();
    await this.services.runEnded.notify(ended);
  }

  private async settleResult(result: WorkerDoneResult): Promise<RunEnded> {
    const { run, provider, model, maxRunTokens, usageTracker } = this.turn;
    const active = this.activeWorker;
    const cancelledBeforeVerification = active?.cancelled === true;
    const currentRun = this.services.runWorkerOutput.applyRunWorkerUsageUpdate(run, result.usage, maxRunTokens, this.exhaustBudget, usageTracker);
    const { inputTokens, outputTokens } = currentRun;
    const finalTokenExhaustion = tokenBudgetExhaustion(maxRunTokens, result.usage);
    if (active && !active.budgetExhaustion && finalTokenExhaustion) {
      active.budgetExhaustion = finalTokenExhaustion;
    }
    const budgetExhaustion = active?.budgetExhaustion;
    if (result.providerSessionRuntime && !cancelledBeforeVerification) {
      this.services.turnState.upsertProviderSessionRuntime("run", run.id, provider, model.modelId, result.providerSessionRuntime);
    }
    if (!cancelledBeforeVerification) await this.recordFinalSummary(result.summary.trim());

    const orchestration = run.delegationEnabled ? this.db.getOrchestrationByCoordinatorRunId(run.id) : null;
    const waitingForSubagents = !cancelledBeforeVerification && orchestration?.status === "waiting";
    const verificationCommands = parseProjectRunDefaultsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults],
    )[run.projectId]?.verificationCommands ?? [];
    const verifies = !cancelledBeforeVerification && !budgetExhaustion && !waitingForSubagents && run.mode === "code" && verificationCommands.length > 0;
    const verificationResults = verifies ? await this.runVerificationGate(verificationCommands, active) : [];
    const wasCancelled = cancelledBeforeVerification || active?.cancelled === true;
    const failedVerificationResult = verificationResults.find((entry) => !entry.ok);
    const failedVerification = !wasCancelled && failedVerificationResult !== undefined;
    const outcome = buildRunTerminalOutcome({
      wasCancelled,
      budgetExhaustion,
      failedVerificationResult,
      waitingForSubagents,
      inputTokens,
      outputTokens,
    });
    this.db.updateRunStatus(run.id, outcome.status, {
      summary: wasCancelled ? currentRun.summary : result.summary,
      errorMessage: outcome.errorMessage,
      lastProviderResponseId: result.responseId,
      inputTokens,
      outputTokens,
    });
    this.services.turnState.clearRunCheckpoint(run.id);
    this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
    const metadata = {
      inputTokens,
      outputTokens,
      usageTotals: result.usage,
      cancelled: wasCancelled,
      waitingForSubagents,
      verificationGate: verificationCommands.length > 0,
      verificationPassed: verificationResults.length > 0 && failedVerificationResult === undefined,
      autonomyBudgetExhausted: Boolean(budgetExhaustion),
      budgetKind: budgetExhaustion?.kind,
    };
    await this.saveFinalEvent("status", outcome.title, outcome.content, metadata);
    this.services.runEvents.emitEvent({ runId: run.id, type: "status", title: outcome.title, content: outcome.content, metadata, createdAt: new Date().toISOString() });
    return {
      run,
      status: outcome.status,
      turnFinished: true,
      waitingForSubagents,
      failureReason: budgetExhaustion?.reason
        ?? (failedVerification ? "The implementation did not pass its project verification gate." : null),
    };
  }

  /** The run's status is already saved, so a timeline entry that cannot be saved must not stop the settlement. */
  private async saveFinalEvent(type: "status" | "error", title: string, content: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.services.runEvents.appendRunEvent(this.turn.run.id, type, title, content, metadata);
    } catch (error) {
      this.logControllerError("Could not save the final event of a run.", error, { runId: this.turn.run.id });
    }
  }

  /** Adds the turn's summary to the timeline unless the agent's last message already says it. */
  private async recordFinalSummary(summary: string): Promise<void> {
    const { run, provider } = this.turn;
    if (provider.providerType === "azure-legacy" || !summary || summary === "No output returned from the provider.") return;
    const steps = this.db.getRunSteps(run.id);
    const turnStart = steps.findLastIndex((step) => step.eventType === "log" && isTurnStartMetadata(parseMetadataRecord(step.metadataJson)));
    const latestOutput = steps.slice(turnStart + 1).findLast((step) => {
      if (step.eventType !== "output") return false;
      const { assistantKind } = parseMetadataRecord(step.metadataJson);
      return assistantKind !== "reasoning" && assistantKind !== "image";
    });
    const sourceText = latestOutput ? parseMetadataRecord(latestOutput.metadataJson).responseSourceText : undefined;
    const latestText = latestOutput ? normalizeAssistantOutputText(typeof sourceText === "string" ? sourceText : latestOutput.content) : "";
    if (normalizeAssistantOutputText(summary) === latestText) return;
    const content = createResponseImageEmbedder(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run))(summary);
    await this.services.runEvents.recordRunEvent(run.id, "output", "Final summary", content, {
      assistantKind: "final-summary",
      ...(content !== summary ? { responseSourceText: summary } : {}),
    });
  }

  private async runVerificationGate(commands: string[], active: ActiveWorker | undefined): Promise<ProjectVerificationResult[]> {
    const { run } = this.turn;
    const abort = new AbortController();
    if (active) active.verificationAbortController = abort;
    await this.services.runEvents.recordRunEvent(run.id, "status", "Verification started", commands.join("\n"), {
      verificationGate: true,
      commandCount: commands.length,
    });
    const evidence = await this.services.verification.executeRevisionCheck(run, commands, abort.signal);
    const results = [...evidence.results];
    if (evidence.status !== "passed" && !results.some((result) => !result.ok)) {
      results.push({ command: "Revision verification", ok: false, exitCode: null, durationMs: 0, timedOut: false, output: evidence.error ?? evidence.status });
    }
    if (active) active.verificationAbortController = undefined;
    if (active?.cancelled) return results;
    for (const result of results) {
      const title = result.ok ? "Verification passed" : "Verification failed";
      await this.services.runEvents.recordRunEvent(run.id, result.ok ? "tool-result" : "error", title, `$ ${result.command}\n${result.output}`, {
        verificationGate: true,
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        ok: result.ok,
      });
    }
    return results;
  }

  /** Settles a failed turn, whether the worker reported the error or its thread crashed. */
  private async fail(error: string): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    this.clearBudgetTimer();
    await this.settleFailure(error);
  }

  private async settleFailure(error: string): Promise<void> {
    const { run, provider } = this.turn;
    const active = this.activeWorker;
    const status = active?.cancelled ? "cancelled" : "failed";
    const errorMessage = active?.budgetExhaustion?.reason ?? error;
    const shouldAutoRecover =
      !active?.budgetExhaustion && status === "failed" && this.shouldAutoRecoverAzureLegacyToolRoundLimit(run.id, provider.providerType, error);
    this.logControllerError("Run worker reported an error payload.", errorMessage, {
      runId: run.id,
      status,
    });
    try {
      this.db.updateRunStatus(run.id, status, { errorMessage });
      this.services.turnState.clearRunCheckpoint(run.id);
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      let title = "Run failed";
      if (status === "cancelled") title = "Run cancelled";
      else if (active?.budgetExhaustion) title = "Autonomy budget exhausted";
      await this.saveFinalEvent("error", title, errorMessage, {
        autonomyBudgetExhausted: Boolean(active?.budgetExhaustion),
        budgetKind: active?.budgetExhaustion?.kind,
      });
      this.services.runEvents.emitEvent({ runId: run.id, type: "error", title, content: errorMessage, createdAt: new Date().toISOString() });
    } finally {
      await this.releaseWorker();
    }
    await this.services.runEnded.notify({
      run,
      status,
      turnFinished: false,
      waitingForSubagents: false,
      failureReason: status === "cancelled" ? null : errorMessage,
    });
    if (shouldAutoRecover) await this.startAutoRecovery();
  }

  private async releaseWorker(): Promise<void> {
    this.services.runInteractions.clearRunRequestStepIds(this.turn.run.id);
    this.services.activeWorkers.runWorkers.delete(this.turn.run.id);
    await this.turn.worker.terminate();
  }

  private async startAutoRecovery(): Promise<void> {
    const { run } = this.turn;
    const metadata = { autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND };
    await this.services.runEvents.recordRunEvent(
      run.id,
      "status",
      "Automatic follow-up queued",
      "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
      metadata,
    );
    try {
      await this.services.runTurns.followUpRunInternal(run.id, AZURE_LEGACY_AUTO_RECOVERY_PROMPT, { mode: run.mode, modelId: run.modelId }, metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the automatic follow-up.";
      this.logControllerError("Automatic Azure Legacy recovery follow-up failed to start.", error, { runId: run.id });
      await this.services.runEvents.recordRunEvent(run.id, "error", "Automatic follow-up failed", message, metadata);
    }
  }

  private shouldAutoRecoverAzureLegacyToolRoundLimit(runId: string, providerType: ProviderAccountRecord["providerType"], errorMessage: string): boolean {
    if (providerType !== "azure-legacy" || errorMessage.trim() !== AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE) {
      return false;
    }
    const latestUserCommand = [...this.db.getRunSteps(runId)]
      .reverse()
      .find((step) => step.eventType === "log" && parseMetadataRecord(step.metadataJson).source === "user");
    return !latestUserCommand || parseMetadataRecord(latestUserCommand.metadataJson).autoRecoveryKind !== AZURE_LEGACY_AUTO_RECOVERY_KIND;
  }
}
