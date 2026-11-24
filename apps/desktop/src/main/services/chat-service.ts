import {
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatHistoryPage,
  type ChatInput,
  type ChatRecord,
  type ChatSearchDetail,
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
import { mergeProjectTaskRunAttachments } from "./run-step-content";

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

    const logContent = userText || "(no text)";

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Initial message", logContent, {
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

    await this.startTurn(chat, provider, model, apiKey ?? "", userText, input.attachments, executionOptions, userText);

    return this.db.getChat(chat.id);
  }

  /** Starts a worker for a chat's turn. A turn that never started must not leave the chat looking active. */
  private async startTurn(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    ...turn: [prompt: string, attachments: ChatAttachmentPayload[] | undefined, options: ProviderExecutionOptions | undefined, skillPrompt: string]
  ): Promise<void> {
    try {
      const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
      const worker = await this.services.chatWorkerHost.startChatWorker(chat, provider, model, apiKey, networkProxy, ...turn);
      this.services.activeWorkers.chatWorkers.set(chat.id, { worker, cancelled: false, providerType: provider.providerType });
    } catch (error) {
      if (!this.services.activeWorkers.chatWorkers.has(chat.id)) {
        this.db.updateChatStatus(chat.id, "failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
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
   * the prompt when it changed. Returns null when the refresh failed (the chat then
   * continues with the previous context).
   */
  private async refreshRunChatContext(chat: ChatRecord): Promise<{ context: string; changed: boolean } | null> {
    if (!chat.runId) {
      return null;
    }
    try {
      const context = await this.buildRunChatContextForRun(chat.runId);
      const contextStep = this.db.getChatSteps(chat.id).find((step) => {
        try {
          return (JSON.parse(step.metadataJson || "{}") as Record<string, unknown>).source === RUN_CHAT_CONTEXT_SOURCE;
        } catch {
          return false;
        }
      });
      if (!contextStep) {
        await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", context, {
          source: RUN_CHAT_CONTEXT_SOURCE,
          hidden: true,
          runId: chat.runId,
        });
        return { context, changed: true };
      }
      if (contextStep.content === context) {
        return { context, changed: false };
      }
      this.db.updateChatStep(contextStep.id, { content: context });
      return { context, changed: true };
    } catch (error) {
      this.logControllerWarn("Could not refresh the run chat context; continuing with the previous context.", {
        chatId: chat.id,
        runId: chat.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Starts (or continues) the run-scoped Q&A chat for a run. The first turn seeds the
   * conversation with a hidden context step holding the run's prompts, output, and diff.
   */
  async createRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    // Creation awaits the worktree diff, which can take seconds; serialize with any
    // in-flight creation for the same run so a concurrent send cannot slip past the
    // existence check and create a duplicate chat.
    const pending = this.runChatCreations.get(runId);
    if (pending) {
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
      this.runChatCreations.delete(runId);
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

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Run context", contextBlock, {
      source: RUN_CHAT_CONTEXT_SOURCE,
      hidden: true,
      runId,
    });

    const logContent = userText || "(no text)";

    await this.services.runEvents.appendChatEvent(chat.id, "log", "Initial message", logContent, {
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

    // History-replaying providers receive the context through prior messages (the hidden
    // step maps to a user turn); session-based CLI providers only see what is in the
    // prompt, so the context must ride along on the first turn.
    const firstTurnPrompt = providerReplaysChatHistory(provider.providerType)
      ? userText
      : buildRunChatFirstTurnPrompt(contextBlock, userText);

    await this.startTurn(chat, provider, model, apiKey ?? "", firstTurnPrompt, input.attachments, executionOptions, userText);

    return this.db.getChat(chat.id);
  }

  async followUpChat(
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<ChatRecord> {
    let chat = this.db.getChat(chatId);
    const model = this.db.getModel(options?.modelId ?? chat.modelId);
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

    if (this.services.activeWorkers.chatWorkers.has(chatId)) {
      throw new Error("This chat is already active. Wait for it to finish before sending a follow-up.");
    }

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
      if (refreshed?.changed && !providerReplaysChatHistory(provider.providerType)) {
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

    await this.startTurn(chat, provider, model, apiKey ?? "", workerPrompt, workerAttachments, executionOptions, userText);
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
    if (!isRunChat) {
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
    if (!active) return;
    active.cancelled = true;
    const stopped = stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }));
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
    this.services.chatWorkerHost.chatUserInputRequests.delete(chatId);
    this.db.closeChatUserInputRequests(chatId);
    await stopped;
    if (this.services.activeWorkers.chatWorkers.get(chatId) === active) this.services.activeWorkers.chatWorkers.delete(chatId);
  }
}
