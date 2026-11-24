import { Worker } from "node:worker_threads";
import { type RunFollowUpOptions, type RunRecord, validateChatAttachmentPayloads } from "@buildwarden/shared";
import {
  buildContextHandoffBlock,
  modelHandoffContextFor,
  planContextHandoff,
  selectHandoffAttachments,
  withContextHandoff,
} from "../provider-context-handoff";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";
import { ORCHESTRATION_CANCELLABLE_STATUSES } from "./orchestration-policy";
import { providerAllowsMissingApiKey } from "./provider-model-support";
import { resolveProviderExecutionOptions } from "./run-execution-settings";
import { buildPromptWithRunGoal, mergeProjectTaskRunAttachments, normalizeRunGoalText } from "./run-step-content";

/** Starts follow-up turns on existing runs and cancels active ones. */
export class RunTurnService extends AppService<
  | "activeWorkers"
  | "followUps"
  | "orchestration"
  | "orchestrationCoordinator"
  | "providerRuntime"
  | "runEvents"
  | "runWorkerHost"
  | "settings"
  | "turnState"
  | "workspaceGuard"
> {
  async followUpRun(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (this.services.workspaceGuard.manualVerifications.has(runId)) throw new Error("Wait for verification to finish or cancel it first.");
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(runId);
    const hasUserTurn = Boolean(prompt.trim() || options?.attachments?.length);
    if (!orchestration || !hasUserTurn || !["waiting", "attention"].includes(orchestration.status)) {
      return this.followUpRunInternal(runId, prompt, options, extraLogMetadata);
    }
    if (this.services.orchestrationCoordinator.orchestrationWakeLocks.has(orchestration.id)) {
      throw new Error("A coordinator continuation is already starting. Retry after it becomes active.");
    }
    this.services.orchestrationCoordinator.orchestrationWakeLocks.add(orchestration.id);
    try {
      const durableContext = this.services.orchestrationCoordinator.buildOrchestrationResumePrompt(orchestration);
      const combinedPrompt = [
        durableContext,
        prompt.trim() ? `<user_request>\n${prompt.trim()}\n</user_request>` : "",
      ].filter(Boolean).join("\n\n");
      return await this.services.orchestrationCoordinator.deliverOrchestrationUpdate(orchestration, (deliveryMetadata) => {
        this.db.appendOrchestrationEvent({
          orchestrationId: orchestration.id,
          type: "user-wake",
          title: "Coordinator resumed by user",
          content: "A user follow-up superseded the persisted automatic wake condition.",
        });
        return this.followUpRunInternal(runId, combinedPrompt, options, {
          ...extraLogMetadata,
          ...deliveryMetadata,
          source: "user",
          orchestrationResume: true,
          userWake: true,
          displayPrompt: prompt.trim(),
        });
      }, { userWake: true });
    } finally {
      this.services.orchestrationCoordinator.orchestrationWakeLocks.delete(orchestration.id);
    }
  }

  async followUpRunInternal(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    return this.services.workspaceGuard.serializeRunStart(runId, () => this.followUpRunUnlocked(runId, prompt, options, extraLogMetadata));
  }

  private async followUpRunUnlocked(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    let run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const model = this.db.getModel(options?.modelId ?? run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, options) ?? this.services.turnState.getLatestRunExecutionOptions(runId, provider);

    if (this.services.activeWorkers.runWorkers.has(runId)) {
      throw new Error("This run is already active. Wait for it to finish before sending a follow-up.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    const hasGoalUpdate = options ? Object.prototype.hasOwnProperty.call(options, "goalText") : false;
    const nextGoalText = hasGoalUpdate ? normalizeRunGoalText(options?.goalText) : run.goalText;
    if (!userText && attachmentNames.length === 0 && !hasGoalUpdate) {
      throw new Error("Enter a follow-up command or attach at least one file.");
    }
    if (userText || attachmentNames.length > 0) {
      this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    }

    // Internal turns send a generated prompt but record a readable version of it in the run.
    const { displayPrompt, ...followUpLogMetadata } = extraLogMetadata ?? {};
    const isOrchestrationUpdate = followUpLogMetadata.orchestrationResume === true;
    const followUpLogContent = (typeof displayPrompt === "string" ? displayPrompt : userText) || "(no text)";

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
    run = this.db.updateRunConfiguration(run.id, {
      providerAccountId: provider.id,
      modelId: model.id,
      mode: options?.mode ?? run.mode,
      ...(hasGoalUpdate ? { goalText: nextGoalText } : {}),
      ...(options?.delegationEnabled !== undefined ? { delegationEnabled: options.delegationEnabled } : {}),
    });
    const resumableSession = this.services.turnState.resolveRunNativeSession(run, provider).session;
    // Hand over the conversation the target provider has not seen: everything for a fresh
    // session, or only the turns it missed since its last delivered turn.
    const historySteps = this.db.getRunSteps(run.id);
    const contextHandoff = planContextHandoff({
      steps: historySteps,
      targetProviderType: provider.providerType,
      targetProviderAccountId: provider.id,
      resumesNativeSession: resumableSession !== null,
      sessionSeenAt: resumableSession?.lastSeenAt ?? null,
      resolveTurnAccount: this.services.turnState.createTurnAccountResolver(),
    });
    // The delta above assumes the saved session reloads. ACP agents may fail to reload it and
    // start fresh, so they also get the full handoff to send in that case.
    const resumeFallbackContext = resumableSession !== null ? this.services.turnState.buildResumeFallbackContext(historySteps, provider) : undefined;
    // Files attached in the handed-over turns travel along, within the attachment limits.
    const handoffAttachments = selectHandoffAttachments(historySteps, contextHandoff, options?.attachments, this.db.resolveAttachmentBlob);
    const workerAttachments = mergeProjectTaskRunAttachments(handoffAttachments.attachments, options?.attachments);
    validateChatAttachmentPayloads(workerAttachments);
    if (hasGoalUpdate && !userText && attachmentNames.length === 0) {
      await this.services.runEvents.appendRunEvent(run.id, "log", "Run goal updated", run.goalText ?? "No run goal set.", {
        source: "user",
        commandType: "goal",
        mode: run.mode,
        modelId: run.modelId,
        goalText: run.goalText,
      });
      return this.db.getRun(run.id);
    }

    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const followUpPromptForHarness =
      [
        withContextHandoff(
          buildContextHandoffBlock(historySteps, contextHandoff, { attachments: handoffAttachments.note }),
          buildPromptWithRunGoal(
            userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : ""),
            run.goalText,
            isOrchestrationUpdate ? "Update:" : undefined,
          ),
        ),
        this.services.turnState.buildRunFollowUpMemo(run.id),
      ]
        .filter(Boolean)
        .join("\n\n");
    const turnMarker = this.services.turnState.buildTurnSettingsMarker(
      historySteps,
      model,
      provider,
      modelHandoffContextFor(provider.providerType, contextHandoff, resumableSession !== null),
      { reasoningEffort: options?.reasoningEffort, anthropicEffort: options?.anthropicEffort, executionOptions },
      followUpLogMetadata.queuedFollowUpId,
    );
    if (turnMarker) {
      await this.services.runEvents.appendRunEvent(run.id, "status", turnMarker.title, turnMarker.content, turnMarker.metadata);
    }
    await this.services.runEvents.appendRunEvent(run.id, "log", "Follow-up command", followUpLogContent, {
      source: "user",
      commandType: "follow-up",
      mode: run.mode,
      modelId: run.modelId,
      providerAccountId: provider.id,
      ...(contextHandoff.strategy !== "none"
        ? { contextHandoff: { strategy: contextHandoff.strategy, turnCount: contextHandoff.turnCount } }
        : {}),
      goalText: run.goalText,
      yoloMode: options?.yoloMode === true,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      executionOptions,
      ...followUpLogMetadata,
      ...this.services.runEvents.buildStoredAttachmentMetadata(options?.attachments),
    });
    // Published task results retain prior reports; the live summary belongs to this turn.
    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null,
      ...(run.kind === "orchestration-task" ? { summary: "" } : {}),
    });
    await this.db.flushDurable();
    this.services.turnState.clearRunCheckpoint(run.id);
    let worker: Worker;
    try {
      await this.services.turnState.capturePromptRestorePoint(run.id, "follow-up");
      worker = await this.services.runWorkerHost.startWorker(
        run,
        provider,
        model,
        apiKey ?? "",
        await this.services.settings.resolveNetworkProxyRuntimeConfig(),
        {
          promptOverride: followUpPromptForHarness,
          attachments: workerAttachments,
          skillPrompt: userText,
          providerOptions: executionOptions,
          yoloMode: options?.yoloMode === true,
          isOrchestrationUpdate,
          ...(resumeFallbackContext ? { resumeFallbackContext } : {}),
        },
      );
    } catch (error) {
      // A turn that never started must not leave the run looking active.
      if (!this.services.activeWorkers.runWorkers.has(run.id)) {
        this.db.updateRunStatus(run.id, "failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
    this.services.activeWorkers.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
    this.services.followUps.acceptQueuedFollowUp(extraLogMetadata);

    return this.db.getRun(run.id);
  }

  async cancelRun(runId: string): Promise<void> {
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(runId);
    if (orchestration && ORCHESTRATION_CANCELLABLE_STATUSES.has(orchestration.status)) {
      await this.services.orchestration.cancelOrchestration(runId);
      return;
    }

    await this.services.activeWorkers.cancelRunWorker(runId);
  }
}
