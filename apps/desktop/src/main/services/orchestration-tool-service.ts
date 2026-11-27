import {
  APP_SETTING_KEYS,
  effectiveHarnessCapabilities,
  getAiSdkProviderFamilyFromConfigJson,
  getHarnessCapabilities,
  type ModelExecutionControlId,
  type ModelRecord,
  type OrchestrationChangedPayload,
  type OrchestrationMessageDelivery,
  type OrchestrationRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTeamSettings,
  OrchestrationToolError,
  type OrchestrationToolName,
  type OrchestrationWakeMode,
  parseProjectRunDefaultsSetting,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  resolveModelExecutionProfile,
  type RunRecord,
  type RunToolResult,
  type RunUserInputAnswers,
  validateUserInputAnswers,
} from "@buildwarden/shared";
import { recordCoordinatorWaitDelivery } from "../orchestration-delivery";
import { readOrchestrationHistory } from "../orchestration-history";
import { describeChildPendingWork } from "../orchestration-native-work";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES } from "../orchestration-runtime-actions";
import { buildOrchestrationTaskRead, ORCHESTRATION_TASK_READ_MAX_EVENTS, ORCHESTRATION_TASK_READ_MESSAGES_PAGE } from "../orchestration-task-read";
import {
  classifyOrchestrationToolError,
  compactOrchestrationTask,
  isOrchestrationToolName,
  ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS,
  ORCHESTRATION_WAIT_MAX_TIMEOUT_MS,
  parseChildQuestionAnswers,
  truncateForCoordinator,
  wrapOrchestrationUpdate,
} from "../orchestration-tools";
import { AppService } from "./app-service";
import { ORCHESTRATION_ACTIVE_TASK_STATUSES, ORCHESTRATION_PENDING_ADOPTION_STATUSES, orchestrationRequestHash } from "./orchestration-policy";
import { providerAllowsMissingApiKey } from "./provider-model-support";

/** buildwarden_tasks_read output goes straight into the coordinator's context; keep it bounded. */
const ORCHESTRATION_TASK_READ_DEFAULT_STEPS = 8;

const ORCHESTRATION_TASK_READ_MAX_STEPS = 50;
const ORCHESTRATION_TASK_READ_MAX_STEP_CHARS = 2_000;
const ORCHESTRATION_TASK_READ_MAX_FILES = 100;
const ORCHESTRATION_TASK_READ_MAX_DIFF_CHARS = 60_000;
const ORCHESTRATION_TASK_READ_MAX_SUMMARY_CHARS = 32_000;
const ORCHESTRATION_TASK_READ_MAX_PROMPT_CHARS = 4_000;

/** How often a blocking coordinator wait rechecks state that publishes no event. */
const ORCHESTRATION_WAIT_POLL_MS = 1_000;

/** Executes the tools a coordinator agent calls. */
export class OrchestrationToolService extends AppService<
  | "activeWorkers"
  | "orchestration"
  | "orchestrationAdoption"
  | "orchestrationCoordinator"
  | "orchestrationDispatch"
  | "orchestrationMessages"
  | "linkedHosts"
  | "providerRuntime"
  | "runDetails"
  | "runInteractions"
> {
  private async buildOrchestrationChildRunSummary(childRunId: string, args: Record<string, unknown>) {
    const run = this.db.getRun(childRunId);
    const requestedSteps = Number(args.recentSteps ?? ORCHESTRATION_TASK_READ_DEFAULT_STEPS);
    const stepLimit = Number.isInteger(requestedSteps)
      ? Math.min(Math.max(requestedSteps, 0), ORCHESTRATION_TASK_READ_MAX_STEPS)
      : ORCHESTRATION_TASK_READ_DEFAULT_STEPS;
    const recentSteps = this.db.listRecentRunStepPreviews(childRunId, stepLimit, ORCHESTRATION_TASK_READ_MAX_STEP_CHARS)
      // SQLite length()/substr() count code points, not UTF-16 units.
      .map((step) => step.contentChars > Array.from(step.content).length
        ? { ...step, content: `${step.content}\n... truncated (${String(step.contentChars)} chars total) ...` }
        : step);
    const { summary, worktreeUnavailable } = await this.services.runDetails.getRunWorktreeDiffSummary(childRunId);
    const diff = args.includeDiff === true && !worktreeUnavailable
      ? truncateForCoordinator((await this.services.runDetails.getRunWorktreeDiff(childRunId)).diff, ORCHESTRATION_TASK_READ_MAX_DIFF_CHARS)
      : undefined;
    return {
      id: run.id,
      status: run.status,
      mode: run.mode,
      workspaceType: run.workspaceType,
      branchName: run.branchName,
      errorMessage: run.errorMessage,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      changedFiles: {
        ...summary,
        files: summary.files.slice(0, ORCHESTRATION_TASK_READ_MAX_FILES),
        worktreeUnavailable,
      },
      recentSteps,
      ...(diff !== undefined ? { diff } : {}),
    };
  }

  /** What a coordinator needs to choose models: identity, availability, and current limits. */
  private async describeOrchestrationModels(team: OrchestrationTeamSettings, projectId: string) {
    const projectDefaults = parseProjectRunDefaultsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults])[projectId];
    const requiresProjectMcp = projectDefaults?.mcpServers.some((server) => server.enabled && server.required === true) === true;
    return Promise.all(team.models.filter((profile) => profile.enabled).map(async (profile) => {
      const base = { modelId: profile.modelId, maxConcurrent: profile.maxConcurrent, ...(profile.defaultEffort ? { defaultEffort: profile.defaultEffort } : {}) };
      try {
        const model = this.db.getModel(profile.modelId);
        const provider = this.db.getProviderAccount(model.providerAccountId);
        const hasCredentials = providerAllowsMissingApiKey(provider) || await this.secrets.readSecret(provider.apiKeyRef) !== null;
        const limit = hasCredentials ? await this.services.providerRuntime.getProviderLimitState(model.id) : null;
        const reported = this.services.providerRuntime.sessionCapabilityReport(provider) ?? null;
        const unmetered = Boolean(team.maxTotalTokens) && getHarnessCapabilities(provider.providerType).usageReporting === "unavailable";
        const capabilities = effectiveHarnessCapabilities(provider.providerType, reported);
        const unavailableReason = !hasCredentials ? `Credentials are unavailable for ${provider.label}.`
          : requiresProjectMcp && capabilities.projectMcp === "unsupported"
            ? "This integration cannot use the project's required MCP servers."
            : unmetered
              ? "This integration reports no token usage, so the orchestration's token budget cannot limit it. Remove the token budget from the team to use it."
              : limit?.reason;
        const executionOptions = this.taskExecutionOptionChoices(model, provider);
        return {
          ...base,
          name: model.displayName,
          provider: provider.label,
          providerType: provider.providerType,
          steering: capabilities.liveSteering,
          capabilities,
          ...(reported ? { sessionCapabilities: reported } : {}),
          ...(Object.keys(executionOptions).length > 0 ? { executionOptions } : {}),
          available: !unavailableReason,
          ...(unavailableReason ? { unavailableReason } : {}),
          ...(limit?.resetsAt ? { availableAfter: limit.resetsAt } : {}),
        };
      } catch {
        return { ...base, available: false, unavailableReason: "This model is no longer configured." };
      }
    }));
  }

  /**
   * Settings a delegated task may set for this model: the model's own controls, limited to
   * those the integration can apply per task. Values exclude "auto", which means "omit".
   */
  private taskExecutionOptionChoices(model: ModelRecord, provider: ProviderAccountRecord): Partial<Record<ModelExecutionControlId, string[]>> {
    const allowed = new Set(getHarnessCapabilities(provider.providerType).taskExecutionOptions);
    const family = provider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : null;
    const profile = resolveModelExecutionProfile(provider.providerType, family, model.modelId, model.configJson);
    const choices: Partial<Record<ModelExecutionControlId, string[]>> = {};
    for (const control of profile.controls) {
      if (!allowed.has(control.id)) continue;
      const values = control.options.map((option) => option.value).filter((value) => value !== "auto");
      if (values.length > 0) choices[control.id] = values;
    }
    return choices;
  }

  validateTaskExecutionOptions(modelId: string, raw: unknown, index: number): ProviderExecutionOptions | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1} executionOptions must be an object.`);
    }
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const choices = this.taskExecutionOptionChoices(model, provider);
    const describe = () => Object.entries(choices).map(([key, values]) => `${key} (${values.join(", ")})`).join("; ") || "none";
    const options: ProviderExecutionOptions = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "auto") continue;
      // Own keys only: "constructor" or "__proto__" would otherwise find inherited values and throw.
      const allowedValues = Object.hasOwn(choices, key) ? choices[key as ModelExecutionControlId] : undefined;
      if (!allowedValues) {
        throw new OrchestrationToolError("execution_option_unsupported",
          `Task ${index + 1}: ${model.displayName} does not accept ${key} per task. It accepts: ${describe()}.`);
      }
      if (typeof value !== "string" || !allowedValues.includes(value)) {
        throw new OrchestrationToolError("execution_option_unsupported",
          `Task ${index + 1}: ${key} for ${model.displayName} must be one of ${allowedValues.join(", ")}.`);
      }
      (options as Record<string, string>)[key] = value;
    }
    return Object.keys(options).length > 0 ? options : null;
  }

  private async buildOrchestrationCoordinatorView(coordinatorRunId: string) {
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    const team = orchestration?.teamSnapshot ?? this.services.orchestration.resolveOrchestrationTeamSettings(this.db.getRun(coordinatorRunId).modelId);
    const totalTokens = orchestration ? this.db.getOrchestrationTotalTokens(orchestration.id) : 0;
    const coordinator = this.db.getRun(coordinatorRunId);
    const budgetWarning = this.coordinatorBudgetWarning(coordinator, team);
    return {
      delegationEnabled: true,
      orchestration: orchestration
        ? {
            id: orchestration.id,
            status: orchestration.status,
            wakeMode: orchestration.wakeMode,
            wakeTaskIds: orchestration.wakeTaskIds,
            errorMessage: orchestration.errorMessage,
          }
        : null,
      limits: {
        maxConcurrentTasks: team.maxConcurrentTasks,
        maxTasksPerOrchestration: team.maxTasksPerOrchestration,
        ...(team.maxTotalTokens ? { maxTotalTokens: team.maxTotalTokens } : {}),
        ...(budgetWarning ? { budgetCoverage: "children-only", budgetWarning } : {}),
      },
      totalTokens,
      models: await this.describeOrchestrationModels(team, coordinator.projectId),
      roles: team.roles,
      // Other BuildWarden hosts a task may run on (hostId); their own models and projects apply there.
      linkedHosts: this.services.linkedHosts.listLinkedHosts().map(({ id, label }) => ({ id, label })),
      tasks: orchestration ? this.listCompactOrchestrationTasks(orchestration.id) : [],
    };
  }

  /**
   * Children on integrations without usage reports are refused under a token budget, but the
   * coordinator itself is already running. Its own tokens then go uncounted, so say so.
   */
  coordinatorBudgetWarning(coordinator: RunRecord, team: OrchestrationTeamSettings): string | null {
    if (!team.maxTotalTokens || !this.modelReportsNoUsage(coordinator.modelId)) return null;
    return "The coordinator runs on an integration that reports no token usage, so the token budget counts only the delegated tasks, not the coordinator's own turns.";
  }

  /** Whether the model's integration reports no token usage, so budgets cannot measure it. */
  modelReportsNoUsage(modelId: string): boolean {
    try {
      const provider = this.db.getProviderAccount(this.db.getModel(modelId).providerAccountId);
      return getHarnessCapabilities(provider.providerType).usageReporting === "unavailable";
    } catch {
      return false;
    }
  }

  /** A task of this coordinator's orchestration, or a coded rejection. */
  private requireCoordinatorTask(coordinatorRunId: string, rawTaskId: unknown): OrchestrationTaskRecord {
    const taskId = typeof rawTaskId === "string" ? rawTaskId.trim() : "";
    if (!taskId) throw new OrchestrationToolError("invalid_arguments", "taskId is required.");
    const task = this.db.findOrchestrationTask(taskId);
    if (!task) throw new OrchestrationToolError("task_not_found", `Task ${taskId} does not exist.`);
    if (this.db.getOrchestration(task.orchestrationId).coordinatorRunId !== coordinatorRunId) {
      throw new OrchestrationToolError("task_not_in_orchestration", "Task does not belong to this coordinator.");
    }
    return task;
  }

  /** Where a task stands beyond its status (see orchestration-native-work). */
  private describeChildPendingWork(task: OrchestrationTaskRecord) {
    return describeChildPendingWork(this.db, task, {
      childRunning: Boolean(task.childRunId && this.services.activeWorkers.runWorkers.has(task.childRunId)),
      taskActive: ORCHESTRATION_ACTIVE_TASK_STATUSES.has(task.status),
    });
  }

  /**
   * Blocks a coordinator tool call until the selected tasks meet `mode`, a child asks a
   * question, or the timeout passes. It then reports like a wake. The delivery cursor moves once
   * the coordinator shows it received the result, so the next wake neither repeats it nor, after
   * a crash, loses it. Children keep running on timeout.
   */
  private async waitForOrchestrationTasks(coordinatorRunId: string, args: Record<string, unknown>, toolCallId: string) {
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration) throw new OrchestrationToolError("orchestration_not_active", "Nothing has been delegated yet.");
    const mode = args.mode;
    if (mode !== "all-terminal" && mode !== "any-terminal" && mode !== "attention") {
      throw new OrchestrationToolError("invalid_arguments", "mode must be all-terminal, any-terminal, or attention.");
    }
    const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
    const known = new Set(this.db.listOrchestrationTasks(orchestration.id).map((task) => task.id));
    const unknownTaskId = taskIds.find((taskId) => !known.has(taskId));
    if (unknownTaskId !== undefined) throw new OrchestrationToolError("task_not_in_orchestration", `Task ${unknownTaskId} does not belong to this orchestration.`);
    const requested = Number.isSafeInteger(args.timeoutMs) ? Number(args.timeoutMs) : ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requested, 1_000), ORCHESTRATION_WAIT_MAX_TIMEOUT_MS);
    const satisfied = (): boolean => {
      const current = this.db.getOrchestration(orchestration.id);
      return this.services.orchestrationCoordinator.orchestrationWakeSatisfied(
        { ...current, wakeMode: mode, wakeTaskIds: taskIds },
        this.db.listOrchestrationTasks(orchestration.id),
        this.services.orchestrationCoordinator.undeliveredOrchestrationTaskIds(current),
        this.services.orchestrationCoordinator.undeliveredQuestionTaskIds(current),
      );
    };
    // A replacement worker belongs to another turn, which never receives this tool call's result.
    const waitingWorker = this.services.activeWorkers.runWorkers.get(coordinatorRunId);
    const coordinatorActive = () =>
      waitingWorker !== undefined && !waitingWorker.cancelled && this.services.activeWorkers.runWorkers.get(coordinatorRunId) === waitingWorker;
    const startedAt = Date.now();
    const outcome = await new Promise<"satisfied" | "timeout" | "ended">((resolve) => {
      if (satisfied()) {
        resolve("satisfied");
        return;
      }
      let settled = false;
      const finish = (value: "satisfied" | "timeout" | "ended") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        resolve(value);
      };
      const check = () => {
        if (!coordinatorActive()) finish("ended");
        else if (satisfied()) finish("satisfied");
      };
      const unsubscribe = this.events.subscribe("orchestration", (payload: OrchestrationChangedPayload) => {
        if (payload.orchestrationId === orchestration.id) check();
      });
      // Not every state change publishes an event; a slow poll covers the rest and a stopped turn.
      const poll = setInterval(check, ORCHESTRATION_WAIT_POLL_MS);
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
    if (outcome === "ended") throw new OrchestrationToolError("coordinator_inactive", "This coordinator turn is no longer active.");
    return this.services.orchestration.withOrchestrationMutation(orchestration.id, async () => {
      // The turn may have stopped while this waited behind another mutation.
      if (!coordinatorActive()) throw new OrchestrationToolError("coordinator_inactive", "This coordinator turn is no longer active.");
      const current = this.db.getOrchestration(orchestration.id);
      const lines = this.services.orchestrationCoordinator.buildOrchestrationNews(current);
      this.db.transaction(() => {
        this.db.appendOrchestrationEvent({
          orchestrationId: current.id, type: "coordinator-waited", title: "Coordinator waited",
          content: outcome === "satisfied" ? `The ${mode} condition was met.` : `Stopped waiting after ${String(timeoutMs)} ms.`,
          metadata: { mode, taskIds, timedOut: outcome === "timeout" },
        });
        // The waited event is the coordinator's own action, not news, so it is covered too.
        recordCoordinatorWaitDelivery(this.db, current.id, coordinatorRunId, toolCallId);
      });
      await this.db.flushDurable();
      return {
        satisfied: outcome === "satisfied",
        timedOut: outcome === "timeout",
        waitedMs: Date.now() - startedAt,
        mode,
        taskIds,
        ...(outcome === "timeout" ? { next: "Children keep running. Yield with buildwarden_orchestration_yield and end the turn, or continue other work." } : {}),
        update: wrapOrchestrationUpdate(lines),
      };
    });
  }

  private listCompactOrchestrationTasks(orchestrationId: string) {
    return this.db.listOrchestrationTasks(orchestrationId)
      .map((task) => compactOrchestrationTask(task, this.services.orchestrationCoordinator.orchestrationTaskModelName(task)));
  }

  private async executeIdempotentOrchestrationMutation<T>(
    orchestration: OrchestrationRecord,
    toolName: OrchestrationToolName,
    args: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
    if (requestId.length < 8) throw new OrchestrationToolError("invalid_arguments", "A stable requestId of at least 8 characters is required.");
    const requestHash = orchestrationRequestHash({ toolName, args });
    return this.services.orchestration.withOrchestrationMutation(orchestration.id, async () => {
      const existing = this.db.getOrchestrationOperation(orchestration.id, requestId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new OrchestrationToolError("request_id_conflict", "This requestId was already used with a different payload.");
        }
        if (existing.status === "completed") {
          // The first attempt may have failed because this receipt could not be made durable.
          await this.db.flushDurable();
          return JSON.parse(existing.responseJson || "null") as T;
        }
        if (existing.status === "failed") {
          throw new OrchestrationToolError(
            existing.errorCode === "operation_interrupted" ? "operation_interrupted" : "operation_failed_previously",
            existing.errorMessage || "The previous identical operation failed.",
          );
        }
        throw new OrchestrationToolError("operation_in_progress", "The identical operation is already running.");
      }
      this.db.createOrchestrationOperation({
        orchestrationId: orchestration.id,
        requestId,
        toolName,
        requestHash,
      });
      await this.db.flushDurable();
      try {
        const response = await operation();
        this.db.completeOrchestrationOperation(orchestration.id, requestId, "completed", response);
        await this.db.flushDurable();
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.completeOrchestrationOperation(orchestration.id, requestId, "failed", null, message, classifyOrchestrationToolError(error).code);
        await this.db.flushDurable();
        throw error;
      }
    });
  }

  async executeOrchestrationTool(
    coordinatorRunId: string,
    toolCallId: string,
    toolName: OrchestrationToolName,
    args: Record<string, unknown>,
  ): Promise<RunToolResult> {
    if (!isOrchestrationToolName(toolName)) throw new OrchestrationToolError("invalid_arguments", `Unsupported orchestration tool: ${toolName}`);
    const coordinator = this.db.getRun(coordinatorRunId);
    if (!coordinator.delegationEnabled) {
      throw new OrchestrationToolError("not_authorized", "This worker is not authorized to use durable orchestration tools.");
    }
    if (!this.services.activeWorkers.runWorkers.has(coordinatorRunId)) {
      throw new OrchestrationToolError("coordinator_inactive", "This coordinator turn is no longer active.");
    }
    const existingOrchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (existingOrchestration) this.services.orchestrationCoordinator.settleCoordinatorWaitDeliveries(existingOrchestration.id, { turnEnded: false });
    let response: unknown;
    if (toolName === "buildwarden_history_search" || toolName === "buildwarden_history_read") {
      response = readOrchestrationHistory(this.db, coordinator.projectId, toolName === "buildwarden_history_search" ? "search" : "read", args);
    } else if (toolName === "buildwarden_orchestration_get") {
      response = await this.buildOrchestrationCoordinatorView(coordinatorRunId);
    } else if (toolName === "buildwarden_tasks_list") {
      const orchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
      response = orchestration ? this.listCompactOrchestrationTasks(orchestration.id) : [];
    } else if (toolName === "buildwarden_tasks_read") {
      const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
      const results = this.db.listOrchestrationTaskResults(task.id).reverse();
      if (args.resultId !== undefined && !results.some((result) => result.id === args.resultId)) {
        throw new OrchestrationToolError("invalid_arguments", "Published result does not belong to this task.");
      }
      const messagesOffset = Number.isSafeInteger(args.messagesOffset) && Number(args.messagesOffset) >= 0 ? Number(args.messagesOffset) : 0;
      response = buildOrchestrationTaskRead({
        task,
        args,
        results,
        pendingQuestions: task.status === "waiting-input" && task.childRunId ? this.services.orchestrationCoordinator.pendingChildQuestions(task.childRunId) : [],
        events: this.db.listOrchestrationTaskEvents(task.id, ORCHESTRATION_TASK_READ_MAX_EVENTS),
        messages: this.db.listOrchestrationTaskMessagesPage(task.id, messagesOffset, ORCHESTRATION_TASK_READ_MESSAGES_PAGE),
        childRun: task.childRunId ? await this.buildOrchestrationChildRunSummary(task.childRunId, args) : null,
        pendingWork: task.childRunId ? this.describeChildPendingWork(task) : null,
        maxSummaryChars: ORCHESTRATION_TASK_READ_MAX_SUMMARY_CHARS,
        maxPromptChars: ORCHESTRATION_TASK_READ_MAX_PROMPT_CHARS,
      }).response;
    } else if (toolName === "buildwarden_orchestration_wait") {
      response = await this.waitForOrchestrationTasks(coordinatorRunId, args, toolCallId);
    } else {
      const orchestration = this.services.orchestration.getOrCreateOrchestration(coordinator);
      response = await this.executeIdempotentOrchestrationMutation(orchestration, toolName, args, async () => {
        switch (toolName) {
          case "buildwarden_tasks_delegate":
            return this.services.orchestrationDispatch.delegateOrchestrationTasks(coordinator, args.tasks);
          case "buildwarden_tasks_send_message": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            const delivery = (args.delivery ?? "auto") as OrchestrationMessageDelivery;
            if (!["auto", "queue", "steer", "restart"].includes(delivery)) throw new OrchestrationToolError("invalid_arguments", "Invalid message delivery.");
            return this.services.orchestrationMessages.queueOrchestrationTaskMessage({
              taskId: task.id,
              content: String(args.content ?? ""),
            }, "coordinator", delivery);
          }
          case "buildwarden_tasks_respond": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            const inputRequestId = String(args.inputRequestId ?? "");
            const request = task.childRunId && this.services.activeWorkers.runWorkers.has(task.childRunId)
              ? this.services.orchestrationCoordinator.pendingChildQuestions(task.childRunId).find((entry) => entry.inputRequestId === inputRequestId)
              : undefined;
            if (!task.childRunId || !request) {
              throw new OrchestrationToolError("question_not_pending", "That question is no longer pending. The user may have answered it.");
            }
            let answers: RunUserInputAnswers;
            try {
              answers = parseChildQuestionAnswers(args.answers, request.questions);
              validateUserInputAnswers(request.questions, answers);
            } catch (error) {
              throw new OrchestrationToolError("answer_invalid", error instanceof Error ? error.message : String(error));
            }
            await this.services.runInteractions.respondToRunUserInput(task.childRunId, inputRequestId, answers, "coordinator");
            return { taskId: task.id, answered: true };
          }
          case "buildwarden_tasks_cancel": {
            const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
            await this.services.orchestration.cancelOrchestrationTasks(orchestration, taskIds);
            return { taskIds, cancelled: true };
          }
          case "buildwarden_orchestration_yield": {
            const mode = args.mode as OrchestrationWakeMode;
            if (!["all-terminal", "any-terminal", "attention", "adoption-decided"].includes(mode)) throw new OrchestrationToolError("invalid_arguments", "Invalid wake mode.");
            const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
            const tasks = this.db.listOrchestrationTasks(orchestration.id);
            const unknownTaskId = taskIds.find((taskId) => !tasks.some((task) => task.id === taskId));
            if (unknownTaskId !== undefined) throw new OrchestrationToolError("task_not_in_orchestration", `Task ${unknownTaskId} does not belong to this orchestration.`);
            const selected = taskIds.length > 0 ? tasks.filter((task) => taskIds.includes(task.id)) : tasks;
            if (mode === "adoption-decided" && !selected.some((task) => ORCHESTRATION_PENDING_ADOPTION_STATUSES.has(task.adoptionStatus))) {
              return { waiting: false, mode, taskIds, reason: "No selected task has changes waiting for a decision." };
            }
            const undelivered = this.services.orchestrationCoordinator.undeliveredOrchestrationTaskIds(this.db.getOrchestration(orchestration.id));
            if (mode !== "adoption-decided" && selected.every((task) => ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status) && !undelivered.has(task.id))) {
              // Parking here would wake at once, and a coordinator that yields again would loop.
              return {
                waiting: false,
                mode,
                taskIds,
                reason: "Every selected task already finished and you have its result. Continue instead of waiting.",
              };
            }
            this.db.updateOrchestration(orchestration.id, {
              status: "waiting",
              wakeMode: mode,
              wakeTaskIds: taskIds,
            });
            this.db.appendOrchestrationEvent({
              orchestrationId: orchestration.id,
              type: "yield",
              title: "Coordinator yielded",
              content: `Waiting for ${mode}.`,
              metadata: { mode, taskIds },
            });
            await this.db.flushDurable();
            this.services.orchestration.emitOrchestrationChanged(orchestration.id);
            return { waiting: true, mode, taskIds };
          }
          case "buildwarden_adoption_propose": {
            const task = this.requireCoordinatorTask(coordinatorRunId, args.taskId);
            if (task.intent !== "implement" || task.status !== "completed") {
              throw new OrchestrationToolError("adoption_not_allowed", "Only a completed implementation task can be proposed for adoption.");
            }
            if (task.remote) {
              throw new OrchestrationToolError("adoption_not_allowed", `The changes of task ${task.id} stay in its run on ${task.remote.hostLabel}; they cannot be adopted here.`);
            }
            const preview = await this.services.orchestrationAdoption.getOrchestrationAdoptionPreview(task.id);
            this.db.updateOrchestrationTask(task.id, {
              adoptionStatus: preview.conflicts.length || preview.unsupportedPaths.length ? "conflict" : "proposed",
            });
            this.db.upsertOrchestrationAdoption({
              orchestrationId: orchestration.id,
              taskId: task.id,
              status: preview.conflicts.length || preview.unsupportedPaths.length ? "conflict" : "proposed",
              manifest: { ...this.db.getOrchestrationAdoption(task.id)?.manifest,
                changedFiles: preview.changedFiles, conflicts: preview.conflicts, unsupportedPaths: preview.unsupportedPaths },
            });
            this.db.appendOrchestrationEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              type: "adoption-proposed",
              title: "Changes proposed for adoption",
              content: `${preview.changedFiles.length} changed file${preview.changedFiles.length === 1 ? "" : "s"}.`,
            });
            this.services.orchestration.emitOrchestrationChanged(orchestration.id, task.id);
            return preview;
          }
          case "buildwarden_orchestration_finish":
            await this.services.orchestration.finishOrchestration(coordinatorRunId);
            return { finished: true };
          default:
            throw new OrchestrationToolError("invalid_arguments", `Unsupported mutating orchestration tool: ${toolName}`);
        }
      });
    }
    return {
      toolCallId,
      name: toolName,
      ok: true,
      content: JSON.stringify(response),
      metadata: { orchestration: true },
    };
  }
}
