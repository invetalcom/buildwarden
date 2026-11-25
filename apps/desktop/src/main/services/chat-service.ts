import {
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatHistoryPage,
  type ChatInput,
  type ChatRecord,
  type ChatSearchDetail,
  type ChatStepRecord,
  type FollowUpChatOptions,
  isSkillSelection,
  type ModelRecord,
  previewLargeStepContents,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  RUN_CHAT_CONTEXT_SOURCE,
  type RunChatInput,
  type UserAnchoredHistoryPageRequest,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { removeChatWorkspace } from "../chat-workspace";
import { providerUsesNativeSession, selectHandoffAttachments } from "../provider-context-handoff";
import { buildRunChatContext, buildRunChatFirstTurnPrompt, buildRunChatUpdateTurnPrompt, providerReplaysChatHistory } from "../run-chat-context";
import { stopWorkerAfterCleanup } from "../worker-shutdown";
import { AppService } from "./app-service";
import { SELECTED_CHAT_KEY } from "./app-service-constants";
import { assertModelBelongsToProvider, providerAllowsMissingApiKey } from "./provider-model-support";
import { resolveProviderExecutionOptions } from "./run-execution-settings";
import { mergeProjectTaskRunAttachments, parseMetadataRecord } from "./run-step-content";
import type { ActiveWorker } from "./worker-payloads";

/** Creates, continues and deletes chats, including the chats that belong to a run. */
export class ChatService extends AppService<
  | "activeWorkers"
  | "chatWorkerHost"
  | "followUps"
  | "forgeIssueActions"
  | "processes"
  | "providerRuntime"
  | "runDetails"
  | "runEvents"
  | "settings"
  | "skills"
  | "titles"
  | "turnState"
> {
  /** In-flight run-chat creations by run id; serializes concurrent first sends for the same run. */
  private readonly runChatCreations = new Map<string, Promise<ChatRecord>>();
  /** Chats whose next turn is being prepared and has no worker yet. */
  private readonly startingChats = new Map<string, { cancelled: boolean; settled: Promise<void> }>();

  /** Reserves a chat until its turn's worker is registered or its start fails. */
  private async withStartingChat<T>(chatId: string, start: () => Promise<T>): Promise<T> {
    if (this.services.activeWorkers.chatWorkers.has(chatId) || this.startingChats.has(chatId)) {
      throw new Error("This chat is already active. Wait for it to finish before sending a follow-up.");
    }
    let settle: () => void = () => undefined;
    this.startingChats.set(chatId, { cancelled: false, settled: new Promise<void>((resolve) => { settle = resolve; }) });
    try {
      return await start();
    } finally {
      this.startingChats.delete(chatId);
      settle();
    }
  }

  /** Cancels a turn that is still being prepared, and returns when its start has ended. */
  async cancelStartingChat(chatId: string): Promise<void> {
    const starting = this.startingChats.get(chatId);
    if (!starting) return;
    starting.cancelled = true;
    await starting.settled;
  }

  async createChat(input: ChatInput): Promise<ChatRecord> {
    if (input.skillIds !== undefined && !isSkillSelection(input.skillIds)) throw new Error("Invalid chat skill selection.");
    const provider = this.db.getProviderAccount(input.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const model = this.db.getModel(input.modelId);
    assertModelBelongsToProvider(model, provider);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const displayPrompt =
      userText ||
      (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    const chat = this.db.createChat(input.providerAccountId, input.modelId, displayPrompt);
    if (input.skillIds !== undefined) this.services.skills.skillService.setSelection("chat", chat.id, input.skillIds);
    this.db.setSetting(SELECTED_CHAT_KEY, chat.id);
    this.services.forgeIssueActions.recordForgeIssueLink(input.forgeIssue, input.forgeIssue?.projectId ?? "", "chat", chat.id);

    return this.withStartingChat(chat.id, async () => {
      await this.recordInitialMessage(chat, userText, input, executionOptions);
      await this.startTurn(chat, provider, model, apiKey ?? "", userText, input.attachments, executionOptions, userText);
      return this.db.getChat(chat.id);
    });
  }

  private async recordInitialMessage(
    chat: ChatRecord,
    userText: string,
    input: ChatInput | RunChatInput,
    executionOptions: ProviderExecutionOptions | undefined,
  ): Promise<void> {
    await this.services.runEvents.appendChatEvent(chat.id, "log", "Initial message", userText || "(no text)", {
      source: "user",
      commandType: "initial",
      modelId: chat.modelId,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(input.attachments),
    });
    this.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });
    this.services.runEvents.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat starting",
      content: "Starting chat...",
      createdAt: new Date().toISOString(),
    });
  }

  /** Starts a worker for a chat's turn. A turn that failed to start or was cancelled must not leave the chat looking active. */
  private async startTurn(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    ...turn: [prompt: string, attachments: ChatAttachmentPayload[] | undefined, options: ProviderExecutionOptions | undefined, skillPrompt: string]
  ): Promise<void> {
    const isCancelled = () => this.startingChats.get(chat.id)?.cancelled === true;
    try {
      const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
      if (!isCancelled()) {
        const worker = await this.services.chatWorkerHost.startChatWorker(chat, provider, model, apiKey, networkProxy, ...turn);
        this.services.activeWorkers.chatWorkers.set(chat.id, { worker, cancelled: false, providerType: provider.providerType });
      }
    } catch (error) {
      if (!this.services.activeWorkers.chatWorkers.has(chat.id) && !isCancelled()) {
        this.db.updateChatStatus(chat.id, "failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      }
      if (!isCancelled()) throw error;
    }
    if (!isCancelled()) return;
    const active = this.services.activeWorkers.chatWorkers.get(chat.id);
    await (active ? this.stopChatWorker(chat.id, active) : this.recordChatCancelled(chat.id));
  }

  async getChatDetail(chatId: string): Promise<ChatDetail> {
    const history = this.db.getInitialChatHistory(chatId);
    return {
      chat: this.db.getChat(chatId),
      steps: previewLargeStepContents(history.steps),
      queuedFollowUps: this.db.listQueuedFollowUps("chat", chatId),
      historyPage: history.page,
    };
  }

  async getEarlierChatHistory(chatId: string, request: UserAnchoredHistoryPageRequest): Promise<ChatHistoryPage> {
    const history = this.db.getEarlierChatHistory(chatId, request);
    return { ...history, steps: previewLargeStepContents(history.steps) };
  }

  async getRunChat(runId: string): Promise<ChatDetail | null> {
    const chat = this.db.getLatestChatForRun(runId);
    if (!chat) return null;
    const detail = this.db.getChatDetail(chat.id);
    return { ...detail, steps: previewLargeStepContents(detail.steps) };
  }

  private async buildRunChatContextForRun(runId: string): Promise<string> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const diffResult = await this.services.runDetails.getRunWorktreeDiff(runId);
    return buildRunChatContext({
      run,
      steps: this.db.getRunSteps(runId),
      projectName: project.name,
      diff: diffResult.diff,
      diffUnavailableReason: diffResult.diffUnavailableReason ?? null,
    });
  }

  /**
   * Syncs the hidden run-context step with the run's latest steps and diff before a
   * follow-up turn. History-replaying providers pick the new content up automatically
   * on the next turn; for session-based providers the caller re-sends the context in
   * the prompt until a finished turn has delivered it. Returns null when the refresh failed (the chat then
   * continues with the previous context).
   */
  private async refreshRunChatContext(chat: ChatRecord): Promise<{ context: string; undelivered: boolean } | null> {
    if (!chat.runId) {
      return null;
    }
    try {
      const context = await this.buildRunChatContextForRun(chat.runId);
      const contextStep = this.findRunContextStep(chat.id);
      if (!contextStep) {
        await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", context, {
          source: RUN_CHAT_CONTEXT_SOURCE,
          hidden: true,
          runId: chat.runId,
          undelivered: true,
        });
        return { context, undelivered: true };
      }
      const metadata = parseMetadataRecord(contextStep.metadataJson);
      if (contextStep.content === context) {
        return { context, undelivered: metadata.undelivered === true };
      }
      this.db.updateChatStep(contextStep.id, { content: context, metadataJson: JSON.stringify({ ...metadata, undelivered: true }) });
      return { context, undelivered: true };
    } catch (error) {
      this.logControllerWarn("Could not refresh the run chat context; continuing with the previous context.", {
        chatId: chat.id,
        runId: chat.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private findRunContextStep(chatId: string): ChatStepRecord | undefined {
    return this.db.getChatSteps(chatId).find((step) => parseMetadataRecord(step.metadataJson).source === RUN_CHAT_CONTEXT_SOURCE);
  }

  /** A finished turn proves that the provider session holds the context its prompt carried. */
  markRunContextDelivered(chat: ChatRecord, providerType: ProviderAccountRecord["providerType"]): void {
    if (!chat.runId || providerReplaysChatHistory(providerType)) return;
    const contextStep = this.findRunContextStep(chat.id);
    const metadata = contextStep ? parseMetadataRecord(contextStep.metadataJson) : {};
    if (!contextStep || metadata.undelivered !== true) return;
    this.db.updateChatStep(contextStep.id, { metadataJson: JSON.stringify({ ...metadata, undelivered: false }) });
  }

  /**
   * Starts (or continues) the run-scoped Q&A chat for a run. The first turn seeds the
   * conversation with a hidden context step holding the run's prompts, output, and diff.
   */
  async createRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    // Creation awaits the worktree diff, which can take seconds; serialize with any
    // in-flight creation for the same run so a concurrent send cannot slip past the
    // existence check and create a duplicate chat.
    // After a failed creation only one waiting caller may retry, so check again after each wait.
    for (let pending = this.runChatCreations.get(runId); pending; pending = this.runChatCreations.get(runId)) {
      await pending.catch(() => undefined);
    }

    const existing = this.db.getLatestChatForRun(runId);
    if (existing) {
      return this.followUpChat(existing.id, input.prompt, {
        modelId: input.modelId !== existing.modelId ? input.modelId : undefined,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
        anthropicEffort: input.anthropicEffort,
        executionOptions: input.executionOptions,
      });
    }

    const creation = this.startNewRunChat(runId, input);
    this.runChatCreations.set(runId, creation);
    try {
      return await creation;
    } finally {
      if (this.runChatCreations.get(runId) === creation) this.runChatCreations.delete(runId);
    }
  }

  private async startNewRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    this.db.getRun(runId); // validate the run exists before creating the chat
    const model = this.db.getModel(input.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, input);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const contextBlock = await this.buildRunChatContextForRun(runId);

    const displayPrompt =
      userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    // Run chats intentionally skip SELECTED_CHAT_KEY: they live in the run detail
    // panel and must not hijack the Chats page selection.
    const chat = this.db.createChat(provider.id, model.id, displayPrompt, runId);

    // History-replaying providers receive the context through prior messages (the hidden
    // step maps to a user turn); session-based CLI providers only see what is in the
    // prompt, so the context must ride along on the first turn.
    const firstTurnPrompt = providerReplaysChatHistory(provider.providerType)
      ? userText
      : buildRunChatFirstTurnPrompt(contextBlock, userText);

    return this.withStartingChat(chat.id, async () => {
      await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", contextBlock, {
        source: RUN_CHAT_CONTEXT_SOURCE,
        hidden: true,
        runId,
      });
      await this.recordInitialMessage(chat, userText, input, executionOptions);
      await this.startTurn(chat, provider, model, apiKey ?? "", firstTurnPrompt, input.attachments, executionOptions, userText);
      return this.db.getChat(chat.id);
    });
  }

  async followUpChat(
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<ChatRecord> {
    const model = this.db.getModel(options?.modelId ?? this.db.getChat(chatId).modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const executionOptions = resolveProviderExecutionOptions(provider, options) ?? this.services.turnState.getLatestChatExecutionOptions(chatId, provider);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    return this.withStartingChat(chatId, () => this.startFollowUp(chatId, provider, model, apiKey ?? "", userText, executionOptions, options, extraLogMetadata));
  }

  private async startFollowUp(
    chatId: string,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    userText: string,
    executionOptions: ProviderExecutionOptions | undefined,
    options: FollowUpChatOptions | undefined,
    extraLogMetadata: Record<string, unknown> | undefined,
  ): Promise<ChatRecord> {
    let chat = this.db.getChat(chatId);
    if (!chat.runId) {
      this.db.setSetting(SELECTED_CHAT_KEY, chatId);
    }
    if (options?.modelId) {
      this.db.updateChatConfiguration(chatId, options.modelId);
      chat = this.db.getChat(chatId);
    }

    // Run chats see the run's latest steps and diff on every turn: the hidden context
    // step is refreshed in place, and session-based providers get the updated context
    // re-sent with the prompt (their session still holds the stale version).
    let workerPrompt = userText;
    if (chat.runId) {
      const refreshed = await this.refreshRunChatContext(chat);
      if (refreshed?.undelivered && !providerReplaysChatHistory(provider.providerType)) {
        workerPrompt = buildRunChatUpdateTurnPrompt(refreshed.context, userText);
      }
    }

    const logContent = userText || "(no text)";

    const chatHistory = this.db.getChatSteps(chat.id);
    const freshNativeSession = providerUsesNativeSession(provider.providerType) &&
      !this.services.turnState.resolveChatNativeSession(chat, provider, chatHistory).session;
    // A fresh native session gets the prior conversation in its prompt (chat worker); send the
    // files attached in those turns along, within the attachment limits.
    const handoffAttachments = freshNativeSession
      ? selectHandoffAttachments(chatHistory, { strategy: "full", fromStepIndex: 0, turnCount: 0 }, options?.attachments, this.db.resolveAttachmentBlob).attachments
      : [];
    const workerAttachments = mergeProjectTaskRunAttachments(handoffAttachments, options?.attachments);
    validateChatAttachmentPayloads(workerAttachments);
    const chatTurnMarker = this.services.turnState.buildTurnSettingsMarker(
      chatHistory,
      model,
      provider,
      !providerUsesNativeSession(provider.providerType) ? "replay" : freshNativeSession ? "history" : "session",
      { reasoningEffort: options?.reasoningEffort, anthropicEffort: options?.anthropicEffort, executionOptions },
      extraLogMetadata?.queuedFollowUpId,
    );
    if (chatTurnMarker) {
      await this.services.runEvents.appendChatEvent(chat.id, "status", chatTurnMarker.title, chatTurnMarker.content, {
        ...chatTurnMarker.metadata,
        userFacing: true,
      });
    }
    await this.services.runEvents.appendChatEvent(chat.id, "log", "Follow-up", logContent, {
      ...extraLogMetadata,
      source: "user",
      commandType: "follow-up",
      modelId: model.id,
      providerAccountId: provider.id,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      executionOptions,
      ...this.services.runEvents.buildStoredAttachmentMetadata(options?.attachments),
    });
    this.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });

    await this.startTurn(chat, provider, model, apiKey, workerPrompt, workerAttachments, executionOptions, userText);
    this.services.followUps.acceptQueuedFollowUp(extraLogMetadata);

    return this.db.getChat(chat.id);
  }

  async listChats(): Promise<ChatRecord[]> {
    return this.db.listChats().map((s) => this.db.getChat(s.id));
  }

  async listChatsWithSteps(): Promise<ChatSearchDetail[]> {
    return this.db.listChatsWithSteps();
  }

  async deleteChat(chatId: string): Promise<void> {
    this.services.titles.sessionTitleServiceInstance?.cancel("chat", chatId);
    await this.cancelStartingChat(chatId);
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    if (active) {
      active.cancelled = true;
      const stopped = stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }));
      this.services.activeWorkers.chatWorkers.delete(chatId);
      this.services.chatWorkerHost.chatUserInputRequests.delete(chatId);
      this.db.closeChatUserInputRequests(chatId);
      await stopped;
    }
    const isRunChat = Boolean(this.db.getChat(chatId).runId);
    await this.removeChatWorkspaceBestEffort(chatId);
    this.db.deleteProviderSessionRuntime(chatId, "chat");
    this.db.deleteChat(chatId);
    this.services.processes.ownedProcessRegistryInstance?.forgetOwner({ kind: "chat", id: chatId });
    if (!isRunChat && this.db.getSettings()[SELECTED_CHAT_KEY] === chatId) {
      this.db.deleteSetting(SELECTED_CHAT_KEY);
    }
  }

  async removeChatWorkspaceBestEffort(chatId: string): Promise<void> {
    await this.services.processes.stopOwnedProcessesForRemoval({ kind: "chat", id: chatId });
    try {
      await removeChatWorkspace(this.db.getFilePath(), chatId);
    } catch (error) {
      this.logControllerWarn("Could not remove the chat workspace; continuing deletion.", { chatId, error });
    }
  }

  async cancelChat(chatId: string): Promise<void> {
    const active = this.services.activeWorkers.chatWorkers.get(chatId);
    if (active) await this.stopChatWorker(chatId, active);
    else await this.cancelStartingChat(chatId);
  }

  private async stopChatWorker(chatId: string, active: ActiveWorker): Promise<void> {
    active.cancelled = true;
    const stopped = stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }));
    await this.recordChatCancelled(chatId);
    this.services.chatWorkerHost.chatUserInputRequests.delete(chatId);
    this.db.closeChatUserInputRequests(chatId);
    await stopped;
    if (this.services.activeWorkers.chatWorkers.get(chatId) === active) this.services.activeWorkers.chatWorkers.delete(chatId);
  }

  private async recordChatCancelled(chatId: string): Promise<void> {
    this.db.updateChatStatus(chatId, "cancelled", {
      errorMessage: "Chat cancelled by user.",
      finishedAt: new Date().toISOString(),
    });
    await this.services.runEvents.appendChatEvent(chatId, "status", "Chat cancelled", "Cancellation requested.", { userFacing: true });
    this.services.runEvents.emitChatEvent(chatId, {
      runId: chatId,
      type: "status",
      title: "Chat cancelled",
      content: "Cancellation requested.",
      metadata: { userFacing: true },
      createdAt: new Date().toISOString(),
    });
  }
}
