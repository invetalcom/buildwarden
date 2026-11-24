import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  APP_SETTING_KEYS,
  type ChatAttachmentPayload,
  getHarnessCapabilities,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  parseProjectRunDefaultsSetting,
  parseShellAllowlistExtraSetting,
  parseToolApprovalAllowlistSetting,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  RUN_VERIFICATION_FAILURE_PREFIX,
  type RunRecord,
} from "@buildwarden/shared";
import { getCompileCacheWorkerData } from "../compile-cache";
import { resolveMcpServerRuntimeConfigs } from "../mcp-server-registry";
import { ORCHESTRATION_TOOL_DEFINITIONS } from "../orchestration-tools";
import type { ProjectVerificationResult } from "../project-verification";
import { createResponseImageEmbedder } from "../response-images";
import { type RunBudgetExhaustion, timeBudgetExhaustion, tokenBudgetExhaustion } from "../run-autonomy-budget";
import { AppService } from "./app-service";
import { AZURE_LEGACY_AUTO_RECOVERY_KIND } from "./app-service-constants";
import { normalizeAssistantOutputText, parseMetadataRecord } from "./run-step-content";
import type { RunWorkerPayload } from "./worker-payloads";

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

/** Runs a turn in a worker thread and settles the run when the turn ends. */
export class RunWorkerHost extends AppService<
  | "activeWorkers"
  | "council"
  | "followUps"
  | "orchestrationCoordinator"
  | "orchestrationResults"
  | "prWatch"
  | "processes"
  | "projectLab"
  | "projectLoops"
  | "providerRuntime"
  | "runEvents"
  | "runForge"
  | "runInteractions"
  | "runTurns"
  | "runWorkerOutput"
  | "skills"
  | "turnState"
  | "verification"
  | "workspaceGuard"
> {
  /**
   * The model each live run's provider last said served it. The reports are silent chunks, which
   * are not saved as steps, so publication copies the value into its durable effect.
   */
  readonly runExecutedModels = new Map<string, string>();

  async startWorker(
    run: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    options?: {
      promptOverride?: string;
      skillPrompt?: string;
      attachments?: ChatAttachmentPayload[];
      recoverSkills?: boolean;
      providerOptions?: ProviderExecutionOptions;
      yoloMode?: boolean;
      isOrchestrationUpdate?: boolean;
      /** Full conversation for a fresh session when the expected session resume fails. */
      resumeFallbackContext?: string;
    },
  ): Promise<Worker> {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    this.services.workspaceGuard.requireWorkspaceNotRestoring(run.worktreePath);
    const settings = this.db.getSettings();
    try {
      // Recheck after asynchronous workspace preparation, using the worker's settings snapshot.
      this.services.providerRuntime.requireProjectMcpSupported(run.projectId, provider, settings[APP_SETTING_KEYS.projectRunDefaults]);
    } catch (error) {
      this.db.updateRunStatus(run.id, "failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (run.kind === "orchestration-task" && this.db.getOrchestrationTaskByChildRunId(run.id)?.permissionMode === "supervised") {
      options = { ...options, yoloMode: false };
    }
    const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
    const savedSkills = checkpoint?.skills ?? (checkpoint || options?.recoverSkills ? this.db.getSessionSkills("run", run.id) ?? undefined : undefined);
    const skills = {
      snapshot: await this.services.skills.prepareSessionSkills("run", run.id, options?.skillPrompt ?? run.prompt, run.projectId, savedSkills),
      storePath: this.services.skills.skillService.storePath,
      recovering: Boolean(checkpoint || options?.recoverSkills),
    };
    const workspaceSetup = this.db.getRunWorkspaceSetup(run.id, true);
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
    const streamingStepIds = new Map<string, string>();
    const streamingStepKinds = new Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">();
    const nativeSession = this.services.turnState.resolveRunNativeSession(run, provider);
    // Every resume needs it, including recovery and orchestration wakes, not only follow-ups.
    const resumeFallbackContext = nativeSession.session
      ? options?.resumeFallbackContext ?? this.services.turnState.buildResumeFallbackContext(this.db.getRunSteps(run.id), provider)
      : undefined;
    const usageTracker = this.services.runWorkerOutput.initialUsageReportTracker(provider, this.db.getRunSteps(run.id), nativeSession.session !== null, model);
    if (this.services.workspaceGuard.manualVerifications.has(run.id)) throw new Error("Wait for verification to finish or cancel it first.");
    const resetNarrationStreams = () => {
      for (const [streamId, kind] of streamingStepKinds.entries()) {
        if (kind === "assistant" || kind === "reasoning") {
          streamingStepKinds.delete(streamId);
          streamingStepIds.delete(streamId);
        }
      }
    };
    const shellAllowlistExtra = parseShellAllowlistExtraSetting(settings[APP_SETTING_KEYS.shellAllowlistExtra]);
    const toolApprovalAllowlist = parseToolApprovalAllowlistSetting(settings[APP_SETTING_KEYS.toolApprovalAllowlist])[run.projectId] ?? [];
    const runDefaults = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults])[run.projectId];
    const maxRunMinutes = runDefaults?.maxRunMinutes ?? 0;
    const maxRunTokens = runDefaults?.maxRunTokens ?? 0;
    const projectMcpSupported = getHarnessCapabilities(provider.providerType).projectMcp !== "unsupported";
    const mcpServers = projectMcpSupported
      ? resolveMcpServerRuntimeConfigs(runDefaults?.mcpServers ?? [])
      : [];
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.logDirPath, { recursive: true });
    }

    // A report belongs to the worker that made it. A new turn that reports no model (an ACP agent
    // whose reloaded session omits it, a provider that never reports) must not inherit the last one.
    this.runExecutedModels.delete(run.id);
    const worker = new Worker(workerPath, {
      workerData: {
        ...getCompileCacheWorkerData(),
        acknowledgeChunks: true,
        request: {
          ...(workspaceSetup && workspaceSetup.status !== "completed" ? { workspaceSetup: {
            profile: workspaceSetup.profile, sourcePath: this.db.getProject(run.projectId).repoPath,
          } } : {}),
          runId: run.id,
          providerAccountId: provider.id,
          worktreePath: run.worktreePath,
          browserToolsEnabled: Boolean(this.lifecycle.executeBrowserTool),
          // Delegated children and council reviewers work on the repository, never on the app's look.
          themeToolsEnabled: Boolean(this.lifecycle.executeThemeTool) && run.kind !== "orchestration-task" && run.kind !== "council-review",
          workspaceVcs: run.workspaceVcs,
          mode: run.mode,
          yoloMode: options?.yoloMode === true,
          prompt: options?.promptOverride ?? run.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: nativeSession.previousResponseId,
          providerSessionRuntime: nativeSession.session,
          priorMessages: this.services.turnState.buildPriorRunMessagesFromSteps(run.id),
          skills,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          modelCapabilities: parseMetadataRecord(model.capabilitiesJson),
          providerOptions: options?.providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          shellAllowlistExtra,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...(toolApprovalAllowlist.length > 0 ? { toolApprovalAllowlist } : {}),
          ...(resumeFallbackContext ? { resumeFallbackContext } : {}),
          ...(run.kind === "orchestration-task" && run.mode !== "code" ? { requireReadOnly: true } : {}),
          resumeCheckpoint: this.services.turnState.getRunCheckpoint(run.id),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.logDirPath } } : {}),
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          ...(Boolean(run.delegationEnabled) && run.kind !== "orchestration-task"
            ? { orchestrationTools: ORCHESTRATION_TOOL_DEFINITIONS }
            : {}),
          ...(options?.isOrchestrationUpdate ? { isOrchestrationUpdate: true } : {}),
        },
      },
    });

    this.lifecycle.onRunBrowserActive?.(run.id, true);
    worker.once("exit", () => {
      if (!this.services.activeWorkers.runWorkers.has(run.id) || this.services.activeWorkers.runWorkers.get(run.id)?.worker === worker) {
        this.lifecycle.onRunBrowserActive?.(run.id, false);
      }
    });
    const exhaustBudget = (exhaustion: RunBudgetExhaustion) => {
      const active = this.services.activeWorkers.runWorkers.get(run.id);
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
    const budgetTimer = maxRunMinutes > 0
      ? setTimeout(() => {
          exhaustBudget(timeBudgetExhaustion(maxRunMinutes));
        }, maxRunMinutes * 60_000)
      : null;
    const clearBudgetTimer = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
    };

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

    /** Settles a failed turn, whether the worker reported the error or its thread crashed. */
    const handleError = async (error: string): Promise<void> => {
      clearBudgetTimer();
      const active = this.services.activeWorkers.runWorkers.get(run.id);
      const status = active?.cancelled ? "cancelled" : "failed";
      const errorMessage = active?.budgetExhaustion?.reason ?? error;
      const shouldAutoRecover =
        !active?.budgetExhaustion && status === "failed" && this.shouldAutoRecoverAzureLegacyToolRoundLimit(run.id, provider.providerType, error);
      this.logControllerError("Run worker reported an error payload.", errorMessage, {
        runId: run.id,
        status,
      });
      this.db.updateRunStatus(run.id, status, { errorMessage });
      this.services.turnState.clearRunCheckpoint(run.id);
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      let eventTitle = "Run failed";
      if (status === "cancelled") eventTitle = "Run cancelled";
      else if (active?.budgetExhaustion) eventTitle = "Autonomy budget exhausted";
      await this.services.runEvents.appendRunEvent(run.id, "error", eventTitle, errorMessage, {
        autonomyBudgetExhausted: Boolean(active?.budgetExhaustion),
        budgetKind: active?.budgetExhaustion?.kind,
      });
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: "error",
        title: eventTitle,
        content: errorMessage,
        createdAt: new Date().toISOString(),
      });
      this.services.runInteractions.clearRunRequestStepIds(run.id);
      this.services.activeWorkers.runWorkers.delete(run.id);
      await worker.terminate();
      if (run.kind === "lab-implementation") {
        if (status === "cancelled") {
          this.services.projectLab.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        } else {
          await this.services.projectLab.failProjectLabImplementation(run, errorMessage);
        }
      }
      if (run.kind === "loop-iteration") {
        this.services.projectLoops.loopRunner.handleRunTerminal(run.id);
      }
      if (run.kind === "orchestration-task") {
        await this.services.orchestrationResults.handleOrchestrationChildTerminal(run.id).catch((error) => {
          this.logControllerError("Could not finalize a failed orchestration child.", error, { runId: run.id });
        });
      }
      if (run.kind === "council-review") this.services.council.handleCouncilChildTerminal(run.id);
      else this.services.council.handleCouncilRunTerminal(run.id, false);
      void this.services.prWatch.handlePrWatchRunTerminal(run.id);
      if (shouldAutoRecover) {
        await this.services.runEvents.appendRunEvent(
          run.id,
          "status",
          "Automatic follow-up queued",
          "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
          {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          },
        );
        this.services.runEvents.emitEvent({
          runId: run.id,
          type: "status",
          title: "Automatic follow-up queued",
          content:
            "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
          metadata: {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          },
          createdAt: new Date().toISOString(),
        });
        try {
          await this.services.runTurns.followUpRunInternal(
            run.id,
            AZURE_LEGACY_AUTO_RECOVERY_PROMPT,
            {
              mode: run.mode,
              modelId: run.modelId,
            },
            {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
          );
        } catch (autoRecoveryError) {
          const message =
            autoRecoveryError instanceof Error ? autoRecoveryError.message : "Could not start the automatic follow-up.";
          this.logControllerError("Automatic Azure Legacy recovery follow-up failed to start.", autoRecoveryError, {
            runId: run.id,
          });
          await this.services.runEvents.appendRunEvent(run.id, "error", "Automatic follow-up failed", message, {
            autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
          });
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "error",
            title: "Automatic follow-up failed",
            content: message,
            metadata: {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
            createdAt: new Date().toISOString(),
          });
        }
      }
    };

    worker.on("message", async (message: unknown) => {
      const payload = message as RunWorkerPayload;
      if (payload.type === "steer-result") {
        this.services.followUps.settleFollowUpSteer(payload);
        return;
      }
      // Even a replaced turn's processes belong to this run, so record them before the stale check.
      if (payload.type === "process-spawned") {
        this.services.processes.registerRunWorkerProcess(run, payload);
        return;
      }

      // Worker identity is the turn generation. Ignore late messages from a
      // cancelled/replaced worker so stale turns cannot invoke host tools or
      // overwrite the state of a newer continuation.
      if (this.services.activeWorkers.runWorkers.get(run.id)?.worker !== worker) {
        if (payload.type === "chunk" && payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        return;
      }

      if (payload.type === "host-tool-request") {
        await this.services.runWorkerOutput.handleRunWorkerHostToolRequest(run.id, worker, payload);
        return;
      }

      if (payload.type === "shell-approval-request") {
        await this.services.runInteractions.handleRunWorkerShellApprovalRequest(run, payload);
        return;
      }

      if (payload.type === "user-input-request") {
        await this.services.runInteractions.handleRunWorkerUserInputRequest(run, payload);
        return;
      }

      if (payload.type === "chunk") {
        try {
          await this.services.runWorkerOutput.handleRunWorkerChunk(
            run,
            provider,
            model.modelId,
            payload,
            maxRunTokens,
            exhaustBudget,
            streamingStepIds,
            streamingStepKinds,
            resetNarrationStreams,
            usageTracker,
          );
        } finally {
          if (payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        }
        return;
      }

      const handleDone = async (donePayload: Extract<RunWorkerPayload, { type: "done" }>): Promise<void> => {
        const payload = donePayload;
        clearBudgetTimer();
        const active = this.services.activeWorkers.runWorkers.get(run.id);
        let wasCancelled = active?.cancelled === true;
        const currentRun = this.services.runWorkerOutput.applyRunWorkerUsageUpdate(
          run,
          payload.result.usage,
          maxRunTokens,
          exhaustBudget,
          usageTracker,
        );
        const nextInputTokens = currentRun.inputTokens;
        const nextOutputTokens = currentRun.outputTokens;
        const finalTokenExhaustion = tokenBudgetExhaustion(maxRunTokens, payload.result.usage);
        if (active && !active.budgetExhaustion && finalTokenExhaustion) {
          active.budgetExhaustion = finalTokenExhaustion;
        }
        const budgetExhaustion = active?.budgetExhaustion;
        if (payload.result.providerSessionRuntime && !wasCancelled) {
          this.services.turnState.upsertProviderSessionRuntime("run", run.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        const trimmedSummary = payload.result.summary.trim();
        const latestAssistantOutput = [...this.db.getRunSteps(run.id)]
          .reverse()
          .find((step) => {
            if (step.eventType !== "output") {
              return false;
            }
            let metadata: Record<string, unknown> = {};
            try {
              metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
            } catch {
              /* ignore malformed legacy metadata */
            }
            return metadata.assistantKind !== "reasoning" && metadata.assistantKind !== "image";
          });
        const latestAssistantSource = latestAssistantOutput ? parseMetadataRecord(latestAssistantOutput.metadataJson).responseSourceText : undefined;
        const latestAssistantOutputText = latestAssistantOutput ? normalizeAssistantOutputText(typeof latestAssistantSource === "string" ? latestAssistantSource : latestAssistantOutput.content) : "";
        const shouldAppendFinalSummary =
          !wasCancelled &&
          provider.providerType !== "azure-legacy" &&
          trimmedSummary &&
          trimmedSummary !== "No output returned from the provider." &&
          normalizeAssistantOutputText(trimmedSummary) !== latestAssistantOutputText;
        if (shouldAppendFinalSummary) {
          const summaryContent = createResponseImageEmbedder(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run))(trimmedSummary);
          const summaryMetadata = {
            assistantKind: "final-summary",
            ...(summaryContent !== trimmedSummary ? { responseSourceText: trimmedSummary } : {}),
          };
          await this.services.runEvents.appendRunEvent(run.id, "output", "Final summary", summaryContent, summaryMetadata);
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "output",
            title: "Final summary",
            content: summaryContent,
            metadata: summaryMetadata,
            createdAt: new Date().toISOString(),
          });
        }

        const orchestration = run.delegationEnabled
          ? this.db.getOrchestrationByCoordinatorRunId(run.id)
          : null;
        const waitingForSubagents = !wasCancelled && orchestration?.status === "waiting";
        const configuredVerificationCommands = parseProjectRunDefaultsSetting(
          this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults],
        )[run.projectId]?.verificationCommands ?? [];
        let verificationResults: ProjectVerificationResult[] = [];
        const runVerificationGate = async (): Promise<void> => {
          if (!wasCancelled && !budgetExhaustion && !waitingForSubagents && run.mode === "code" && configuredVerificationCommands.length > 0) {
          const verificationAbortController = new AbortController();
          if (active) active.verificationAbortController = verificationAbortController;
          const verificationStartedContent = configuredVerificationCommands.join("\n");
          await this.services.runEvents.appendRunEvent(
            run.id,
            "status",
            "Verification started",
            verificationStartedContent,
            { verificationGate: true, commandCount: configuredVerificationCommands.length },
          );
          this.services.runEvents.emitEvent({
            runId: run.id,
            type: "status",
            title: "Verification started",
            content: verificationStartedContent,
            metadata: { verificationGate: true, commandCount: configuredVerificationCommands.length },
            createdAt: new Date().toISOString(),
          });
          const evidence = await this.services.verification.executeRevisionCheck(run, configuredVerificationCommands, verificationAbortController.signal);
          verificationResults = [...evidence.results];
          if (evidence.status !== "passed" && !verificationResults.some((result) => !result.ok)) {
            verificationResults.push({ command: "Revision verification", ok: false, exitCode: null, durationMs: 0, timedOut: false, output: evidence.error ?? evidence.status });
          }
          if (active) active.verificationAbortController = undefined;
          wasCancelled = active?.cancelled === true;
          if (!wasCancelled) {
            for (const result of verificationResults) {
              const title = result.ok ? "Verification passed" : "Verification failed";
              const content = `$ ${result.command}\n${result.output}`;
              const metadata = {
                verificationGate: true,
                command: result.command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                timedOut: result.timedOut,
                ok: result.ok,
              };
              await this.services.runEvents.appendRunEvent(run.id, result.ok ? "tool-result" : "error", title, content, metadata);
              this.services.runEvents.emitEvent({
                runId: run.id,
                type: result.ok ? "tool-result" : "error",
                title,
                content,
                metadata,
                createdAt: new Date().toISOString(),
              });
            }
          }
          }
        };
        await runVerificationGate();
        const failedVerification = !wasCancelled && verificationResults.some((result) => !result.ok);
        const failedVerificationResult = verificationResults.find((result) => !result.ok);
        const terminalOutcome = buildRunTerminalOutcome({
          wasCancelled,
          budgetExhaustion,
          failedVerificationResult,
          waitingForSubagents,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
        });
        this.db.updateRunStatus(run.id, terminalOutcome.status, {
          summary: wasCancelled ? currentRun.summary : payload.result.summary,
          errorMessage: terminalOutcome.errorMessage,
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
        });
        this.services.turnState.clearRunCheckpoint(run.id);
        this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
        await this.services.runEvents.appendRunEvent(
          run.id,
          "status",
          terminalOutcome.title,
          terminalOutcome.content,
          {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
            waitingForSubagents,
            verificationGate: configuredVerificationCommands.length > 0,
            verificationPassed: verificationResults.length > 0 && !failedVerification,
            autonomyBudgetExhausted: Boolean(budgetExhaustion),
            budgetKind: budgetExhaustion?.kind,
          },
        );
        this.services.runEvents.emitEvent({
          runId: run.id,
          type: "status",
          title: terminalOutcome.title,
          content: terminalOutcome.content,
          metadata: {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
            waitingForSubagents,
            verificationGate: configuredVerificationCommands.length > 0,
            verificationPassed: verificationResults.length > 0 && !failedVerification,
            autonomyBudgetExhausted: Boolean(budgetExhaustion),
            budgetKind: budgetExhaustion?.kind,
          },
          createdAt: new Date().toISOString(),
        });
        this.services.runInteractions.clearRunRequestStepIds(run.id);
        this.services.activeWorkers.runWorkers.delete(run.id);
        await worker.terminate();
        if (!wasCancelled && !budgetExhaustion && !failedVerification) this.services.runForge.syncRunForgeRequestInBackground(run.id, true);
        if (!wasCancelled && !budgetExhaustion && !failedVerification && run.kind === "lab-implementation") {
          try {
            await this.services.projectLab.reviewCompletedProjectLabImplementation(this.db.getRun(run.id));
          } catch (labReviewError) {
            this.logControllerError("Project Lab implementation review failed.", labReviewError, { runId: run.id });
          }
        } else if ((budgetExhaustion || failedVerification) && run.kind === "lab-implementation") {
          await this.services.projectLab.failProjectLabImplementation(
            run,
            budgetExhaustion?.reason ?? "The implementation did not pass its project verification gate.",
          );
        } else if (wasCancelled && run.kind === "lab-implementation") {
          this.services.projectLab.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        }
        if (run.kind === "loop-iteration") {
          this.services.projectLoops.loopRunner.handleRunTerminal(run.id);
        }
        if (run.kind === "orchestration-task") {
          await this.services.orchestrationResults.handleOrchestrationChildTerminal(run.id).catch((error) => {
            this.logControllerError("Could not finalize an orchestration child.", error, { runId: run.id });
          });
        } else if (run.delegationEnabled) {
          await this.services.orchestrationCoordinator.handleOrchestrationCoordinatorTurnTerminal(run.id).catch((error) => {
            this.logControllerError("Could not persist the coordinator wake state.", error, { runId: run.id });
          });
        }
        if (run.kind === "council-review") this.services.council.handleCouncilChildTerminal(run.id);
        else this.services.council.handleCouncilRunTerminal(run.id, terminalOutcome.status === "completed" && !waitingForSubagents);
        const prWatchTurn = this.services.prWatch.handlePrWatchRunTerminal(run.id);
        // Cancelled or failed turns hold the queue until the user resumes it or sends another follow-up.
        if (terminalOutcome.status === "completed") void prWatchTurn.then(() => this.services.followUps.dispatchQueuedFollowUpsInBackground("run", run.id));
      };

      if (payload.type === "done") {
        await handleDone(payload);
        return;
      }

      if (payload.type === "error") {
        await handleError(payload.error);
      }
    });

    worker.on("error", async (error) => {
      clearBudgetTimer();
      if (this.services.activeWorkers.runWorkers.get(run.id)?.worker !== worker) return;
      this.logControllerError("Run worker emitted a thread error.", error, { runId: run.id });
      await handleError(error.message);
    });

    return worker;
  }

  private shouldAutoRecoverAzureLegacyToolRoundLimit(runId: string, providerType: ProviderAccountRecord["providerType"], errorMessage: string): boolean {
    if (providerType !== "azure-legacy" || errorMessage.trim() !== AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE) {
      return false;
    }

    const latestUserCommand = [...this.db.getRunSteps(runId)]
      .reverse()
      .find((step) => {
        if (step.eventType !== "log") {
          return false;
        }
        try {
          const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
          return metadata.source === "user";
        } catch {
          return false;
        }
      });

    if (!latestUserCommand) {
      return true;
    }

    try {
      const metadata = JSON.parse(latestUserCommand.metadataJson || "{}") as Record<string, unknown>;
      return metadata.autoRecoveryKind !== AZURE_LEGACY_AUTO_RECOVERY_KIND;
    } catch {
      return true;
    }
  }
}
