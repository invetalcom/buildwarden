import { Worker } from "node:worker_threads";
import {
  isThemeToolName,
  VISUAL_REPLY_TOOL_NAME,
  type ModelRecord,
  parseHarnessSessionCapabilities,
  type ProviderAccountRecord,
  type RunRecord,
  type RunResumeCheckpoint,
  type RunStepRecord,
  type RunTokenUsage,
  type RunToolResult,
} from "@buildwarden/shared";
import { isOrchestrationToolName, orchestrationToolFailure } from "../orchestration-tools";
import { findLatestAccountStepMetadata } from "../provider-context-handoff";
import { type RunBudgetExhaustion, tokenBudgetExhaustion } from "../run-autonomy-budget";
import { advanceUsageTracker, EMPTY_REPORTED_TOKEN_USAGE, readReportedTokenUsage, type UsageReportTracker } from "../token-usage-accounting";
import { AppService } from "./app-service";
import { runChunkEventType } from "./run-step-content";
import { resetUsageBaselineForFreshSession, type RunWorkerPayload } from "./worker-payloads";

/** Records what a run worker reports while its turn is active. */
export class RunWorkerOutput extends AppService<
  | "activeWorkers"
  | "orchestration"
  | "orchestrationTools"
  | "providerRuntime"
  | "runEvents"
  | "runWorkerHost"
  | "skills"
  | "turnState"
  | "visualReplies"
> {
  async handleRunWorkerHostToolRequest(
    runId: string,
    worker: Worker,
    payload: Extract<RunWorkerPayload, { type: "host-tool-request" }>,
  ): Promise<void> {
    try {
      if (this.services.activeWorkers.runWorkers.get(runId)?.worker !== worker || this.services.activeWorkers.runWorkers.get(runId)?.cancelled) {
        throw new Error("This run is no longer active.");
      }
      const result = payload.toolName === "buildwarden_browser"
        ? await this.lifecycle.executeBrowserTool?.(runId, payload.callId, payload.arguments)
        : payload.toolName === VISUAL_REPLY_TOOL_NAME
        ? await this.services.visualReplies.showVisual(runId, payload.callId, payload.arguments)
        : isThemeToolName(payload.toolName)
        ? this.lifecycle.executeThemeTool?.(payload.callId, payload.toolName, payload.arguments)
        : await this.services.orchestrationTools.executeOrchestrationTool(
        runId,
        payload.callId,
        payload.toolName,
        payload.arguments,
      );
      worker.postMessage({ type: "host-tool-response", callId: payload.callId, result });
    } catch (error) {
      // A rejected call is an answer the model can act on, not a transport failure.
      const result: RunToolResult = isOrchestrationToolName(payload.toolName)
        ? orchestrationToolFailure(payload.callId, payload.toolName, error)
        : {
          toolCallId: payload.callId,
          name: payload.toolName,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        };
      worker.postMessage({ type: "host-tool-response", callId: payload.callId, result });
    }
  }

  /**
   * Codex reports cumulative usage per thread, so a resumed thread continues from the last
   * totals that thread reported. Only this account's turns count: totals reported by another
   * provider in between belong to a different session.
   */
  initialUsageReportTracker(
    provider: ProviderAccountRecord,
    steps: ReadonlyArray<{ eventType: string; metadataJson: string }>,
    resumesNativeSession: boolean,
    model?: Pick<ModelRecord, "modelId">,
  ): UsageReportTracker {
    const attribution = model ? { providerType: provider.providerType, modelId: model.modelId } : undefined;
    const fresh = (): UsageReportTracker => ({ reportedUsage: { ...EMPTY_REPORTED_TOKEN_USAGE }, ...(attribution ? { attribution } : {}) });
    if (provider.providerType !== "codex-cli" || !resumesNativeSession) {
      return fresh();
    }
    const metadata = findLatestAccountStepMetadata(
      steps,
      provider.id,
      this.services.turnState.createTurnAccountResolver(),
      (candidate) => Boolean(candidate.usageTotals) && typeof candidate.usageTotals === "object" && !Array.isArray(candidate.usageTotals),
    );
    return metadata
      ? { ...fresh(), reportedUsage: readReportedTokenUsage(metadata.usageTotals as Partial<RunTokenUsage>) }
      : fresh();
  }

  applyRunWorkerUsageUpdate(
    run: RunRecord,
    usageTotals: Partial<RunTokenUsage> | null,
    maxRunTokens: number,
    exhaustBudget: (exhaustion: RunBudgetExhaustion) => void,
    tracker: UsageReportTracker,
  ): RunRecord {
    if (!usageTotals) {
      return this.db.getRun(run.id);
    }
    let updatedRun = this.db.getRun(run.id);
    for (const delta of advanceUsageTracker(tracker, usageTotals)) {
      updatedRun = this.db.recordRunTokenUsage(run.id, delta.inputTokensDelta, delta.outputTokensDelta, delta.attribution);
    }
    const orchestrationTask = run.kind === "orchestration-task" ? this.db.getOrchestrationTaskByChildRunId(run.id) : null;
    const exhaustion = tokenBudgetExhaustion(maxRunTokens, usageTotals) ??
      (orchestrationTask ? this.services.orchestration.orchestrationBudgetExhaustion(this.db.getOrchestration(orchestrationTask.orchestrationId)) : null);
    if (exhaustion) {
      exhaustBudget(exhaustion);
    }
    return updatedRun;
  }

  async handleRunWorkerChunk(
    run: RunRecord,
    _provider: ProviderAccountRecord,
    _modelId: string,
    payload: Extract<RunWorkerPayload, { type: "chunk" }>,
    maxRunTokens: number,
    exhaustBudget: (exhaustion: RunBudgetExhaustion) => void,
    streamingStepIds: Map<string, string>,
    streamingStepKinds: Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">,
    resetNarrationStreams: () => void,
    usageTracker: UsageReportTracker,
  ): Promise<void> {
    if (payload.chunk.metadata?.skillEvent === true) this.services.skills.skillService.recordEvent("run", run.id, payload.chunk.metadata);
    const sessionCapabilities = parseHarnessSessionCapabilities(payload.chunk.metadata?.sessionCapabilities);
    if (sessionCapabilities) {
      this.services.providerRuntime.runSessionCapabilities.set(run.id, sessionCapabilities);
      this.services.providerRuntime.rememberSessionCapabilities(_provider, sessionCapabilities);
    }
    const executedModel = payload.chunk.metadata?.executedModel;
    if (typeof executedModel === "string" && executedModel) this.services.runWorkerHost.runExecutedModels.set(run.id, executedModel);
    const setupStatus = payload.chunk.metadata?.setupStatus;
    if (payload.chunk.metadata?.workspaceSetup === true && (setupStatus === "running" || setupStatus === "completed" || setupStatus === "failed")) {
      const setup = this.db.getRunWorkspaceSetup(run.id);
      if (setup) this.db.saveRunWorkspaceSetup(run.id, { ...setup, status: setupStatus });
    }
    const eventType = runChunkEventType(payload.chunk.type);
    const usageTotals =
      typeof payload.chunk.metadata?.usageTotals === "object" && payload.chunk.metadata.usageTotals
        ? (payload.chunk.metadata.usageTotals as Partial<RunTokenUsage>)
        : null;
    resetUsageBaselineForFreshSession(usageTracker, payload.chunk.metadata);
    if (usageTotals) this.applyRunWorkerUsageUpdate(run, usageTotals, maxRunTokens, exhaustBudget, usageTracker);

    // Session-start chunks precede prompt acceptance; only terminal failure accounting is durable here.
    await this.services.turnState.persistFailedTurnAccounting("run", run.id, _provider, _modelId, payload.chunk.metadata);

    const streamId = typeof payload.chunk.metadata?.streamId === "string" ? payload.chunk.metadata.streamId : null;
    const shouldReplace =
      payload.chunk.metadata?.replace === true &&
      streamId &&
      (payload.chunk.type === "message" ||
        payload.chunk.type === "tool-result" ||
        payload.chunk.type === "tool-progress" ||
        payload.chunk.type === "plan-updated" ||
        payload.chunk.type === "plan-progress");
    const checkpoint =
      payload.chunk.metadata?.checkpoint === true &&
      typeof payload.chunk.metadata.resumeCheckpoint === "object" &&
      payload.chunk.metadata.resumeCheckpoint
        ? {
            ...(payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint),
            round: Number((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).round ?? 0),
            memo:
              typeof (payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo === "string"
                ? ((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo ?? "")
                : "",
          }
        : null;
    if (checkpoint) {
      this.services.turnState.setRunCheckpoint(run.id, checkpoint);
    }

    if (payload.chunk.metadata?.silent === true) {
      this.services.runEvents.emitEvent({
        runId: run.id,
        type: eventType,
        title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
        content: payload.chunk.value,
        metadata: payload.chunk.metadata,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    if (payload.chunk.type === "tool-call" || payload.chunk.type === "tool-result") {
      resetNarrationStreams();
    }

    let persistedStep: RunStepRecord;
    if (shouldReplace) {
      const existingStepId = streamingStepIds.get(streamId);
      if (existingStepId) {
        // Persist the latest type so a progress step finishing as "tool-result" stops reading as live progress.
        persistedStep = this.db.updateRunStep(existingStepId, {
          eventType,
          title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
          content: payload.chunk.value,
          metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
        });
      } else {
        persistedStep = await this.services.runEvents.appendRunEvent(
          run.id,
          eventType,
          payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
          payload.chunk.value,
          payload.chunk.metadata,
        );
        streamingStepIds.set(streamId, persistedStep.id);
        let streamingStepKind: "tool-result" | "tool-progress" | "assistant" | "reasoning" =
          payload.chunk.metadata?.assistantKind === "reasoning" ? "reasoning" : "assistant";
        if (payload.chunk.type === "tool-result" || payload.chunk.type === "tool-progress") {
          streamingStepKind = payload.chunk.type;
        }
        streamingStepKinds.set(streamId, streamingStepKind);
      }
    } else {
      persistedStep = await this.services.runEvents.appendRunEvent(
        run.id,
        eventType,
        payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
        payload.chunk.value,
        payload.chunk.metadata,
      );
    }
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: eventType,
      title: payload.chunk.title ?? this.services.runEvents.defaultRunEventTitle(eventType),
      content: payload.chunk.value,
      metadata: payload.chunk.metadata,
      createdAt: new Date().toISOString(),
      step: persistedStep,
    });
  }
}
