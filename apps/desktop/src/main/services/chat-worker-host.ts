import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  APP_SETTING_KEYS,
  buildPriorChatCompletionMessagesFromSteps,
  type ChatAttachmentPayload,
  type ChatRecord,
  type ChatStepRecord,
  extractAttachmentPayloadsFromMetadata,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  RUN_CHAT_CONTEXT_SOURCE,
  type RunTokenUsage,
  type RunUserInputAnswers,
} from "@buildwarden/shared";
import { getChatWorkspacePath } from "../chat-workspace";
import { getCompileCacheWorkerData } from "../compile-cache";
import { stepsBeforeLatestTurn } from "../provider-context-handoff";
import { advanceUsageTracker, type UsageReportTracker } from "../token-usage-accounting";
import { AppService } from "./app-service";
import { parseMetadataRecord, runChunkEventType } from "./run-step-content";
import { type ChatWorkerChunkPayload, type ChatWorkerPayload, resetUsageBaselineForFreshSession } from "./worker-payloads";

/** Runs a chat turn in a worker thread and records its output. */
export class ChatWorkerHost extends AppService<
  | "activeWorkers"
  | "followUps"
  | "processes"
  | "runEvents"
  | "runWorkerOutput"
  | "skills"
  | "turnState"
  | "workspaceGuard"
> {
  readonly chatUserInputRequests = new Map<string, Set<string>>();

  async respondToChatUserInput(chatId: string, requestId: string, answers: RunUserInputAnswers): Promise<void> {
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    const pending = this.chatUserInputRequests.get(chatId);
    if (!active || active.cancelled || !pending?.has(requestId)) throw new Error("This question is no longer active.");
    const step = this.db.resolveChatUserInput(chatId, requestId, answers);
    pending.delete(requestId);
    active.worker.postMessage({ type: "user-input-response", requestId, answers });
    this.services.runEvents.emitChatEvent(chatId, {
      runId: chatId, type: "user-input-requested", title: step.title, content: step.content,
      metadata: JSON.parse(step.metadataJson) as Record<string, unknown>, createdAt: new Date().toISOString(), step,
    });
  }

  private buildPriorChatMessages(chatId: string): Array<Record<string, unknown>> {
    const messages = this.db
      .getChatSteps(chatId)
      .flatMap((step) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }

        if (step.eventType === "log" && (metadata.source === "user" || metadata.source === RUN_CHAT_CONTEXT_SOURCE)) {
          const attachments = extractAttachmentPayloadsFromMetadata(metadata, this.db.resolveAttachmentBlob);
          return [{
            role: "user",
            content: step.content,
            ...(attachments.length > 0 ? { attachments } : {}),
          }];
        }

        if (step.eventType === "user-input-requested" && metadata.requestStatus === "resolved") {
          return [{ role: "user", content: `Answers to the assistant's questions: ${JSON.stringify({ questions: metadata.userInputQuestions, answers: metadata.userInputAnswers })}` }];
        }

        if (step.eventType === "output") {
          if (metadata.assistantKind === "reasoning" || metadata.assistantKind === "image" || step.title === "Reasoning") {
            return [];
          }
          return [{ role: "assistant", content: typeof metadata.responseSourceText === "string" ? metadata.responseSourceText : step.content }];
        }

        return [];
      });
    if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
      messages.pop();
    }
    return messages;
  }

  private async handleChatWorkerChunk(
    chat: ChatRecord,
    _provider: ProviderAccountRecord,
    _model: ModelRecord,
    payload: ChatWorkerChunkPayload,
    streamingStepIds: Map<string, string>,
    usageTracker: UsageReportTracker,
  ): Promise<void> {
    if (payload.chunk.metadata?.skillEvent === true) this.services.skills.skillService.recordEvent("chat", chat.id, payload.chunk.metadata);
    const eventType = runChunkEventType(payload.chunk.type);
    const usageTotals =
      typeof payload.chunk.metadata?.usageTotals === "object" && payload.chunk.metadata.usageTotals
        ? (payload.chunk.metadata.usageTotals as Partial<RunTokenUsage>)
        : null;
    resetUsageBaselineForFreshSession(usageTracker, payload.chunk.metadata);
    if (usageTotals) this.applyChatWorkerUsageUpdate(chat, usageTotals, usageTracker);
    await this.services.turnState.persistFailedTurnAccounting("chat", chat.id, _provider, _model.modelId, payload.chunk.metadata);
    const replaceableChunk =
      payload.chunk.type === "message" ||
      payload.chunk.type === "tool-result" ||
      payload.chunk.type === "tool-progress";
    const streamId = replaceableChunk && typeof payload.chunk.metadata?.streamId === "string"
      ? payload.chunk.metadata.streamId
      : null;
    const shouldReplace = replaceableChunk && payload.chunk.metadata?.replace === true && streamId;

    let persistedStep: ChatStepRecord;
    if (shouldReplace) {
      const existingStepId = streamingStepIds.get(streamId);
      if (existingStepId) {
        persistedStep = this.db.updateChatStep(existingStepId, {
          title: payload.chunk.title ?? "Agent output",
          content: payload.chunk.value,
          metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
        });
      } else {
        const step = await this.services.runEvents.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
        streamingStepIds.set(streamId, step.id);
        persistedStep = step;
      }
    } else {
      persistedStep = await this.services.runEvents.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
    }
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: eventType,
      title: payload.chunk.title ?? "Agent output",
      content: payload.chunk.value,
      metadata: payload.chunk.metadata,
      createdAt: new Date().toISOString(),
      step: persistedStep,
    });
  }

  private applyChatWorkerUsageUpdate(
    chat: ChatRecord,
    usageTotals: Partial<RunTokenUsage> | null,
    tracker: UsageReportTracker,
  ): ChatRecord {
    if (!usageTotals) return this.db.getChat(chat.id);
    let currentChat = this.db.getChat(chat.id);
    const projectId = currentChat.runId ? this.db.getRun(currentChat.runId).projectId : null;
    for (const delta of advanceUsageTracker(tracker, usageTotals)) {
      currentChat = this.db.recordChatTokenUsage(currentChat.id, projectId, delta.inputTokensDelta, delta.outputTokensDelta, delta.attribution);
    }
    return currentChat;
  }

  async startChatWorker(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    promptOverride?: string,
    attachments?: ChatAttachmentPayload[],
    providerOptions?: ProviderExecutionOptions,
    skillPrompt?: string,
  ): Promise<Worker> {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const parentRun = chat.runId ? this.db.getRun(chat.runId) : undefined;
    if (parentRun) this.services.skills.skillService.inheritSelection("chat", chat.id, parentRun.id);
    const skills = {
      snapshot: await this.services.skills.prepareSessionSkills("chat", chat.id, skillPrompt ?? chat.prompt, parentRun?.projectId),
      storePath: this.services.skills.skillService.storePath,
      recovering: false,
    };
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "chat-worker.js");
    // Only this app-owned directory is eligible for inline local chat images.
    const chatWorkspace = getChatWorkspacePath(this.db.getFilePath(), chat.id);
    this.services.workspaceGuard.requireWorkspaceNotRestoring(chatWorkspace);
    mkdirSync(chatWorkspace, { recursive: true });
    this.db.closeChatUserInputRequests(chat.id);
    const pendingInputs = new Set<string>();
    this.chatUserInputRequests.set(chat.id, pendingInputs);
    const streamingStepIds = new Map<string, string>();
    const chatSteps = this.db.getChatSteps(chat.id);
    // The worker starts after the current user turn was persisted; judge the session on the history before it.
    const nativeSession = this.services.turnState.resolveChatNativeSession(chat, provider, stepsBeforeLatestTurn(chatSteps));
    const usageTracker = this.services.runWorkerOutput.initialUsageReportTracker(provider, chatSteps, nativeSession.session !== null, model);
    const settings = this.db.getSettings();
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.logDirPath, { recursive: true });
    }
    const worker = new Worker(workerPath, {
      workerData: {
        ...getCompileCacheWorkerData(),
        acknowledgeChunks: true,
        request: {
          runId: chat.id,
          worktreePath: chatWorkspace,
          mode: "ask" as const,
          prompt: promptOverride ?? chat.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: nativeSession.previousResponseId,
          providerSessionRuntime: nativeSession.session,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          modelCapabilities: parseMetadataRecord(model.capabilitiesJson),
          providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          skills,
          isChat: true,
          attachments: attachments ?? [],
          priorMessages: this.buildPriorChatMessages(chat.id),
          priorChatMessages: buildPriorChatCompletionMessagesFromSteps(chatSteps),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.logDirPath } } : {}),
        },
      },
    });

    this.db.updateChatStatus(chat.id, "running");
    // As with runs, keep streamed steps slim while sending the authoritative status transition once.
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat started",
      content: "The assistant is responding.",
      createdAt: new Date().toISOString(),
    });

    worker.on("message", async (message: unknown) => {
      const payload = message as ChatWorkerPayload;
      if (payload.type === "steer-result") {
        this.services.followUps.settleFollowUpSteer(payload);
        return;
      }
      if (payload.type === "process-spawned") {
        this.services.processes.ownedProcesses.registerSpawn({ kind: "chat", id: chat.id }, payload, chatWorkspace);
        return;
      }

      if (this.services.activeWorkers.chatWorkers.get(chat.id)?.worker !== worker || this.services.activeWorkers.chatWorkers.get(chat.id)?.cancelled) {
        if (payload.type === "chunk" && payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        return;
      }

      if (payload.type === "user-input-request") {
        if (this.services.activeWorkers.chatWorkers.get(chat.id)?.worker !== worker) return;
        const metadata = {
          ...payload.metadata, requestKind: "user-input", requestStatus: "opened",
          userInputRequestId: payload.requestId, userInputQuestions: payload.questions ?? [],
        };
        const step = await this.services.runEvents.appendChatEvent(chat.id, "user-input-requested", payload.title || "Question",
          payload.content || "", metadata);
        pendingInputs.add(payload.requestId);
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id, type: "user-input-requested", title: step.title, content: step.content,
          metadata, createdAt: step.createdAt, step,
        });
        return;
      }

      if (payload.type === "chunk") {
        try {
          await this.handleChatWorkerChunk(chat, provider, model, payload, streamingStepIds, usageTracker);
        } finally {
          if (payload.deliveryId !== undefined) worker.postMessage({ type: "chunk-ack", deliveryId: payload.deliveryId });
        }
        return;
      }

      if (payload.type === "done") {
        const currentChat = this.applyChatWorkerUsageUpdate(chat, payload.result.usage, usageTracker);
        const nextInputTokens = currentChat.inputTokens;
        const nextOutputTokens = currentChat.outputTokens;
        if (payload.result.providerSessionRuntime) {
          this.services.turnState.upsertProviderSessionRuntime("chat", chat.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        this.db.updateChatStatus(chat.id, "completed", {
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          finishedAt: new Date().toISOString(),
        });
        await this.services.runEvents.appendChatEvent(chat.id, "status", "Chat completed", "Chat completed successfully.", {
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          usageTotals: payload.result.usage,
        });
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "status",
          title: "Chat completed",
          content: "Chat completed successfully.",
          metadata: { inputTokens: nextInputTokens, outputTokens: nextOutputTokens, usageTotals: payload.result.usage },
          createdAt: new Date().toISOString(),
        });
        this.services.activeWorkers.chatWorkers.delete(chat.id);
        this.chatUserInputRequests.delete(chat.id);
        this.db.closeChatUserInputRequests(chat.id);
        await worker.terminate();
        this.services.followUps.dispatchQueuedFollowUpsInBackground("chat", chat.id);
        return;
      }

      if (payload.type === "error") {
        const active = this.services.activeWorkers.chatWorkers.get(chat.id);
        const status = active?.cancelled ? "cancelled" : "failed";
        this.logControllerError("Chat worker reported an error payload.", payload.error, {
          chatId: chat.id,
          status,
        });
        this.db.updateChatStatus(chat.id, status, {
          errorMessage: payload.error,
          finishedAt: new Date().toISOString(),
        });
        await this.services.runEvents.appendChatEvent(chat.id, "error", "Chat failed", payload.error);
        this.services.runEvents.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "error",
          title: status === "cancelled" ? "Chat cancelled" : "Chat failed",
          content: payload.error,
          createdAt: new Date().toISOString(),
        });
        this.services.activeWorkers.chatWorkers.delete(chat.id);
        this.chatUserInputRequests.delete(chat.id);
        this.db.closeChatUserInputRequests(chat.id);
        await worker.terminate();
      }
    });

    worker.on("error", async (error) => {
      this.logControllerError("Chat worker emitted a thread error.", error, { chatId: chat.id });
      const active = this.services.activeWorkers.chatWorkers.get(chat.id);
      if (active?.worker !== worker || active.cancelled) return;
      this.db.updateChatStatus(chat.id, "failed", { errorMessage: error.message, finishedAt: new Date().toISOString() });
      await this.services.runEvents.appendChatEvent(chat.id, "error", "Worker error", error.message);
      this.services.activeWorkers.chatWorkers.delete(chat.id);
      this.chatUserInputRequests.delete(chat.id);
      this.db.closeChatUserInputRequests(chat.id);
    });

    return worker;
  }
}
