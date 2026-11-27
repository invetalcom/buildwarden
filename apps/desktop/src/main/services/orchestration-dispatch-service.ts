import {
  APP_SETTING_KEYS,
  type ModelRecord,
  type OrchestrationRecord,
  type OrchestrationTaskRecord,
  OrchestrationToolError,
  type ProviderAccountRecord,
  type RunRecord,
} from "@buildwarden/shared";
import { classifyCouncilFailure } from "../council-output";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES } from "../orchestration-runtime-actions";
import { DEFERRED_CHILD_RESUME_PROMPT } from "../orchestration-tools";
import { captureOrchestrationBaseline, restoreOrchestrationBaseline } from "../orchestration-workspace";
import { AppService } from "./app-service";
import { parseDelegatedTasks } from "./orchestration-task-parsing";
import { buildDelegatedTaskPrompt, ORCHESTRATION_ACTIVE_TASK_STATUSES, ORCHESTRATION_CANCELLABLE_STATUSES } from "./orchestration-policy";
import { providerAllowsMissingApiKey, type ProviderLimitState } from "./provider-model-support";
import {
  applyTaskExecutionOptions,
  latestRunExecutionSettings,
  latestUserTurnUsedFullAccess,
  mergeOrchestrationExecutionOptions,
  resolveOrchestrationChildFullAccess,
  resolveProviderExecutionOptions,
} from "./run-execution-settings";

/** Longer waits and repeated limits go to the coordinator instead of holding the wave. */
const ORCHESTRATION_MAX_DEFER_MS = 8 * 24 * 60 * 60 * 1_000;

const ORCHESTRATION_MAX_DEFERRALS = 3;

/** Accepts delegated tasks and starts, defers and retries their child runs. */
export class OrchestrationDispatchService extends AppService<
  | "activeWorkers"
  | "orchestration"
  | "orchestrationCoordinator"
  | "orchestrationMessages"
  | "orchestrationRemote"
  | "orchestrationResults"
  | "orchestrationTools"
  | "providerRuntime"
  | "runEvents"
  | "runLifecycle"
  | "runTurns"
  | "runWorkerHost"
  | "settings"
  | "skills"
  | "turnState"
> {
  private deferredOrchestrationTickActive = false;

  /** Apart from automations: their startup review must not hold up work that already started. */
  async runDeferredOrchestrationTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.deferredOrchestrationTickActive) return;
    this.deferredOrchestrationTickActive = true;
    try {
      await this.dispatchDueDeferredOrchestrationTasks();
    } catch (error) {
      this.logControllerError("Could not start deferred orchestration tasks.", error);
    } finally {
      this.deferredOrchestrationTickActive = false;
    }
  }

  private async createOrchestrationChildRun(
    coordinator: RunRecord,
    task: OrchestrationTaskRecord,
    effort?: string,
  ): Promise<RunRecord> {
    const project = this.db.getProject(coordinator.projectId);
    const model = this.db.getModel(task.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    this.services.providerRuntime.requireProjectMcpSupported(project.id, provider);
    using _providerCliStart = this.services.providerRuntime.reserveProviderCliStart(provider.providerType);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new OrchestrationToolError("model_unavailable", `Credentials are unavailable for ${provider.label}.`);
    }
    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    // Until the child run exists, nothing else owns this workspace. The effect is recorded before
    // anything is created, so if the app stops at any point before the run exists, startup finds
    // it and removes whatever part of the workspace was made before requeueing the task.
    const workspaceId = crypto.randomUUID();
    const plannedWorkspace = this.services.runLifecycle.planContinuationWorkspace(coordinator, project, true, configuredWorktreeRoot, workspaceId);
    let launch = this.db.createOrchestrationEffect({
      orchestrationId: task.orchestrationId, taskId: task.id, kind: "launch-child",
      payload: { workspace: plannedWorkspace, phase: "preparing" },
    });
    await this.db.flushDurable();
    let workspace: Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">;
    try {
      workspace = await this.services.runLifecycle.prepareContinuationWorkspace(
        coordinator,
        project,
        true,
        configuredWorktreeRoot,
        workspaceSetupProfile?.dependencies !== "isolated",
        workspaceId,
      );
      launch = this.db.updateOrchestrationEffect(launch.id, { payload: { workspace, phase: "prepared" } });
      await this.db.flushDurable();
    } catch (error) {
      await this.services.orchestrationResults.closeFailedChildLaunch(launch, project.repoPath, plannedWorkspace, error);
      throw error;
    }
    const wave = this.db.getOrchestrationWave(task.waveId);
    let child: RunRecord;
    try {
      if (wave.baselinePath && wave.baselineState === "ready") {
        await restoreOrchestrationBaseline({ baselinePath: wave.baselinePath, workspacePath: workspace.worktreePath });
      }
      child = this.db.createRun({
        projectId: coordinator.projectId,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: getHarnessTypeForProvider(provider.providerType),
        mode: task.intent === "inspect" ? "ask" : "code",
        workspaceType: workspace.workspaceType,
        workspaceVcs: workspace.workspaceVcs,
        prompt: task.prompt,
        goalText: coordinator.goalText,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        kind: "orchestration-task",
        parentRunId: coordinator.id,
        rootRunId: coordinator.id,
        lineageTitle: task.title,
        orchestrationTaskId: task.id,
        workspaceSetupProfile,
        delegationEnabled: false,
      });
    } catch (error) {
      await this.services.orchestrationResults.closeFailedChildLaunch(launch, project.repoPath, workspace, error);
      throw error;
    }
    // The run now owns the workspace; task reconciliation handles anything that follows.
    this.db.updateOrchestrationEffect(launch.id, { status: "completed", payload: { workspace, childRunId: child.id }, incrementAttempts: true });
    this.db.upsertWorktree({
      id: child.id,
      projectId: child.projectId,
      runId: child.id,
      branchName: child.branchName,
      worktreePath: child.worktreePath,
      status: "ready",
    });
    const coordinatorSteps = this.db.getRunSteps(coordinator.id);
    const inheritedFullAccess = task.permissionMode !== "supervised" && latestUserTurnUsedFullAccess(coordinatorSteps);
    const inheritedExecutionOptions = this.services.turnState.getLatestRunExecutionOptions(coordinator.id, provider);
    const childExecutionOptions = resolveProviderExecutionOptions(provider, {
      executionOptions: applyTaskExecutionOptions(
        mergeOrchestrationExecutionOptions(inheritedExecutionOptions, effort),
        this.db.getOrchestrationTaskExecutionOptions(task.id),
      ),
    });
    await this.services.runEvents.appendRunEvent(child.id, "log", "Delegated task", task.prompt, {
      source: "orchestration",
      commandType: "initial",
      orchestrationId: task.orchestrationId,
      orchestrationTaskId: task.id,
      coordinatorRunId: coordinator.id,
      roleId: task.roleId,
      intent: task.intent,
      modelId: task.modelId,
      effort,
      yoloMode: inheritedFullAccess,
      reasoningEffort: childExecutionOptions?.reasoningEffort,
      anthropicEffort: childExecutionOptions?.anthropicEffort,
      executionOptions: childExecutionOptions,
    });
    child = this.db.updateRunStatus(child.id, "preparing");
    await this.services.runLifecycle.captureFolderBaselineSnapshotOrFail(child, project);
    await this.services.turnState.capturePromptRestorePoint(child.id, "initial");

    const role = this.db.getOrchestration(task.orchestrationId).teamSnapshot.roles.find(
      (entry) => entry.id === task.roleId,
    );
    const prompt = buildDelegatedTaskPrompt({
      roleName: role?.name ?? task.roleId, roleDescription: role?.description, intent: task.intent, task: task.prompt, goalText: coordinator.goalText,
    });
    this.services.skills.skillService.inheritSelection("run", child.id, coordinator.id);
    const worker = await this.services.runWorkerHost.startWorker(
      child,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: prompt,
        providerOptions: childExecutionOptions,
        yoloMode: inheritedFullAccess,
      },
    );
    this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
    this.db.updateOrchestrationTask(task.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      attentionReason: null,
      errorMessage: null,
    });
    return this.db.getRun(child.id);
  }

  /** No await between counting and reserving: all coordinators share this admission point. */
  reserveOrchestrationTask(task: OrchestrationTaskRecord): boolean {
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    if (!["active", "waiting", "attention"].includes(orchestration.status)) return false;
    const current = this.db.getOrchestrationTask(task.id);
    if (current.status !== task.status || ORCHESTRATION_ACTIVE_TASK_STATUSES.has(current.status)) return false;
    const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
    const model = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId && entry.enabled);
    if (!role || !model || this.services.orchestration.orchestrationBudgetExhaustion(orchestration)) return false;
    const active = this.db.listOrchestrationsWithStatuses(["active", "waiting", "attention", "paused"])
      .flatMap((entry) => this.db.listOrchestrationTasks(entry.id))
      .filter((entry) => ORCHESTRATION_ACTIVE_TASK_STATUSES.has(entry.status) && !entry.remote);
    if (active.length >= orchestration.teamSnapshot.maxConcurrentTasks
      || active.filter((entry) => entry.roleId === task.roleId).length >= role.maxConcurrent
      || active.filter((entry) => entry.modelId === task.modelId).length >= model.maxConcurrent) return false;
    this.db.updateOrchestrationTask(task.id, { status: "provisioning", deferredUntil: null });
    return true;
  }

  async dispatchOrchestrationTasks(orchestrationId: string): Promise<void> {
    const orchestration = this.db.getOrchestration(orchestrationId);
    if (orchestration.status !== "active" && orchestration.status !== "waiting") return;
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
    const limits = new Map<string, Promise<ProviderLimitState | null>>();
    const limitFor = (modelId: string): Promise<ProviderLimitState | null> => {
      const known = limits.get(modelId);
      if (known) return known;
      const pending = this.services.providerRuntime.getProviderLimitState(modelId);
      limits.set(modelId, pending);
      return pending;
    };
    for (const task of this.db.listOrchestrationTasks(orchestrationId).filter((entry) => entry.status === "pending" && !entry.remote)) {
      if (task.deferredUntil && Date.parse(task.deferredUntil) > Date.now()) continue;
      const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
      const modelProfile = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId && entry.enabled);
      if (!role || !modelProfile) {
        this.db.updateOrchestrationTask(task.id, {
          status: "blocked",
          attentionReason: "The frozen role or model configuration is unavailable.",
          finishedAt: new Date().toISOString(),
        });
        this.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "attention",
          title: "Task blocked",
          content: "The frozen role or model configuration is unavailable. BuildWarden will not substitute another provider.",
        });
        continue;
      }
      // Running children keep using tokens while this pass waits on each launch.
      const budget = this.services.orchestration.orchestrationBudgetExhaustion(orchestration);
      if (budget) {
        this.blockOrchestrationTask(task, "Task blocked by the token budget", budget.reason);
        continue;
      }
      const limit = await limitFor(task.modelId);
      if (limit) {
        if (!this.deferOrchestrationTask(task, limit)) this.blockOrchestrationTask(task, "Task blocked by a usage limit", limit.reason);
        continue;
      }

      if (!this.reserveOrchestrationTask(task)) continue;
      try {
        await this.db.flushDurable();
        this.db.getModel(task.modelId);
        const effort = role.effortOverride ?? modelProfile.defaultEffort;
        if (task.childRunId && this.db.listOrchestrationTaskMessages(orchestrationId).some((message) => message.taskId === task.id && message.status === "queued")) {
          if (!(await this.services.orchestrationMessages.deliverQueuedOrchestrationMessages(task, true))) {
            if (this.db.getOrchestrationTask(task.id).status === "provisioning") {
              // A live child still occupies capacity even though no new turn started.
              this.db.updateOrchestrationTask(task.id, { status: this.services.activeWorkers.runWorkers.has(task.childRunId) ? "running" : "pending" });
            }
            continue;
          }
        } else if (task.childRunId) await this.continueDeferredOrchestrationChild(task);
        else await this.createOrchestrationChildRun(coordinator, task, effort);
        this.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "task-started",
          title: task.title,
          content: `Started ${role.name} with model ${this.db.getModel(task.modelId).displayName}.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.updateOrchestrationTask(task.id, {
          status: "blocked",
          errorMessage: message,
          attentionReason: message,
          finishedAt: new Date().toISOString(),
        });
        this.db.appendOrchestrationEvent({
          orchestrationId,
          taskId: task.id,
          type: "attention",
          title: "Task could not start",
          content: message,
        });
      }
    }
    this.services.orchestration.emitOrchestrationChanged(orchestrationId);
  }

  blockOrchestrationTask(task: OrchestrationTaskRecord, title: string, reason: string): void {
    this.db.updateOrchestrationTask(task.id, {
      status: "blocked",
      deferredUntil: null,
      attentionReason: reason,
      finishedAt: new Date().toISOString(),
    });
    this.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "attention",
      title,
      content: reason,
    });
  }

  /**
   * Holds a task until its provider's usage window resets. Returns false when that cannot help,
   * so the caller reports the limit and the coordinator can choose another model.
   */
  private deferOrchestrationTask(task: OrchestrationTaskRecord, limit: ProviderLimitState): boolean {
    const waitMs = limit.resetsAt ? Date.parse(limit.resetsAt) - Date.now() : Number.NaN;
    const deferrals = this.db.listOrchestrationEvents(task.orchestrationId)
      .filter((event) => event.taskId === task.id && event.metadata.kind === "deferred").length;
    if (!(waitMs > 0) || waitMs > ORCHESTRATION_MAX_DEFER_MS || deferrals >= ORCHESTRATION_MAX_DEFERRALS) return false;
    const reason = `${limit.reason}. BuildWarden continues this task after the reset.`;
    this.db.updateOrchestrationTask(task.id, {
      status: "pending",
      deferredUntil: limit.resetsAt,
      attentionReason: reason,
      errorMessage: null,
      finishedAt: null,
    });
    this.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "attention",
      title: "Task deferred by a usage limit",
      content: reason,
      metadata: { kind: "deferred", deferredUntil: limit.resetsAt },
    });
    return true;
  }

  /** A child stopped by its provider's usage limit keeps its workspace and conversation. */
  async deferChildAfterUsageLimit(task: OrchestrationTaskRecord, run: RunRecord): Promise<boolean> {
    if (!run.errorMessage || classifyCouncilFailure(run.errorMessage) !== "limit") return false;
    const limit = await this.services.providerRuntime.getProviderLimitState(task.modelId, true);
    if (!limit) return false;
    this.db.updateOrchestrationTask(task.id, { inputTokens: run.inputTokens, outputTokens: run.outputTokens });
    return this.deferOrchestrationTask(task, limit);
  }

  private async continueDeferredOrchestrationChild(task: OrchestrationTaskRecord): Promise<void> {
    const child = this.db.getRun(task.childRunId ?? "");
    const settings = latestRunExecutionSettings(this.db.getRunSteps(child.id));
    await this.services.runTurns.followUpRunInternal(
      child.id,
      DEFERRED_CHILD_RESUME_PROMPT,
      { mode: child.mode, modelId: child.modelId, yoloMode: task.permissionMode !== "supervised" && settings?.yoloMode === true },
      { orchestrationTaskId: task.id, orchestrationResume: true },
      { background: true },
    );
    this.db.updateOrchestrationTask(task.id, {
      status: "running",
      attentionReason: null,
      errorMessage: null,
      finishedAt: null,
      startedAt: task.startedAt ?? new Date().toISOString(),
    });
  }

  /** Starts deferred tasks whose usage window has reset. */
  private async dispatchDueDeferredOrchestrationTasks(): Promise<void> {
    for (const orchestration of this.db.listOrchestrationsWithStatuses(["active", "waiting"])) {
      const due = this.db.listOrchestrationTasks(orchestration.id).some((task) =>
        task.status === "pending" && task.deferredUntil !== null && Date.parse(task.deferredUntil) <= Date.now());
      if (!due) continue;
      await this.services.orchestration.withOrchestrationMutation(orchestration.id, async () => {
        await this.dispatchOrchestrationTasks(orchestration.id);
        await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestration.id);
      });
    }
  }

  async dispatchOtherOrchestrationTasks(excludingOrchestrationId: string): Promise<void> {
    for (const orchestration of this.db.listOrchestrationsWithStatuses(["active", "waiting"])) {
      if (orchestration.id === excludingOrchestrationId) continue;
      await this.services.orchestration.withOrchestrationMutation(orchestration.id, () => this.dispatchOrchestrationTasks(orchestration.id));
    }
  }

  async delegateOrchestrationTasks(
    coordinator: RunRecord,
    rawTasks: unknown,
  ): Promise<OrchestrationTaskRecord[]> {
    const orchestration = this.services.orchestration.getOrCreateOrchestration(coordinator);
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new OrchestrationToolError("invalid_arguments", "Delegate at least one task.");
    }
    if (orchestration.status === "paused") throw new OrchestrationToolError("orchestration_not_active", "Resume the orchestration before delegating more work.");
    if (!["active", "waiting", "attention"].includes(orchestration.status)) {
      throw new OrchestrationToolError("orchestration_not_active", `Tasks cannot be delegated while the orchestration is ${orchestration.status}.`);
    }
    const exhausted = this.services.orchestration.orchestrationBudgetExhaustion(orchestration);
    if (exhausted) throw new OrchestrationToolError("budget_exhausted", exhausted.reason);
    const existing = this.db.listOrchestrationTasks(orchestration.id);
    if (existing.length + rawTasks.length > orchestration.teamSnapshot.maxTasksPerOrchestration) {
      throw new OrchestrationToolError("task_limit_reached", `This orchestration is limited to ${orchestration.teamSnapshot.maxTasksPerOrchestration} tasks.`);
    }
    const parsed = parseDelegatedTasks(rawTasks, {
      orchestration, coordinator,
      clientTaskIdExists: (clientTaskId) => Boolean(this.db.getOrchestrationTaskByClientTaskId(orchestration.id, clientTaskId)),
      modelReportsNoUsage: (modelId) => this.services.orchestrationTools.modelReportsNoUsage(modelId),
      validateExecutionOptions: (modelId, raw, index) => this.services.orchestrationTools.validateTaskExecutionOptions(modelId, raw, index),
      readRemotePlacement: (entry, index) => this.services.orchestrationRemote.readRemotePlacement(entry, index),
    });

    const wave = this.db.createOrchestrationWave(orchestration.id);
    await this.db.flushDurable();
    try {
      const baselinePath = await captureOrchestrationBaseline({
        workspacePath: coordinator.worktreePath,
        workspaceVcs: coordinator.workspaceVcs,
        artifactRoot: this.services.orchestration.getOrchestrationArtifactRoot(),
        orchestrationId: orchestration.id,
        waveId: wave.id,
      });
      this.db.updateOrchestrationWave(wave.id, { baselinePath, baselineState: "ready" });
    } catch (error) {
      this.db.updateOrchestrationWave(wave.id, { baselineState: "failed" });
      throw error;
    }
    const tasks = parsed.map((task) => this.db.createOrchestrationTask({
      orchestrationId: orchestration.id,
      waveId: wave.id,
      ...task,
    }));
    this.db.updateOrchestration(orchestration.id, { status: "active", errorMessage: null });
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "wave-created",
      title: `Wave ${wave.waveIndex + 1}`,
      content: `Delegated ${tasks.length} durable task${tasks.length === 1 ? "" : "s"}.`,
      metadata: { taskIds: tasks.map((task) => task.id) },
    });
    await this.db.flushDurable();
    await this.dispatchOrchestrationTasks(orchestration.id);
    // Started after the caller's mutation lock, which starting a remote task takes itself.
    for (const task of tasks) if (task.remote) void this.services.orchestrationRemote.startRemoteTask(task.id);
    return tasks.map((task) => this.db.getOrchestrationTask(task.id));
  }

  async retryOrchestrationTask(taskId: string): Promise<OrchestrationTaskRecord> {
    const { orchestrationId } = this.db.getOrchestrationTask(taskId);
    // Another dispatch could otherwise read the same pending task and start it a second time.
    return this.services.orchestration.withOrchestrationMutation(orchestrationId, async () => {
      const source = this.db.getOrchestrationTask(taskId);
      if (!ORCHESTRATION_TERMINAL_TASK_STATUSES.has(source.status)) {
        throw new Error("Only a terminal task can be retried.");
      }
      const orchestration = this.db.getOrchestration(source.orchestrationId);
      if (!ORCHESTRATION_CANCELLABLE_STATUSES.has(orchestration.status)) {
        throw new Error(`Tasks cannot be retried while the orchestration is ${orchestration.status}.`);
      }
      const tasks = this.db.listOrchestrationTasks(orchestration.id);
      if (tasks.length >= orchestration.teamSnapshot.maxTasksPerOrchestration) {
        throw new Error("The orchestration task cap has been reached.");
      }
      const replacement = this.db.createOrchestrationTask({
        orchestrationId: orchestration.id,
        waveId: source.waveId,
        clientTaskId: `${source.clientTaskId}-retry-${tasks.filter((task) => task.retryOfTaskId === source.id).length + 1}`,
        title: `${source.title} (retry)`,
        prompt: source.prompt,
        roleId: source.roleId,
        modelId: source.modelId,
        intent: source.intent,
        permissionMode: source.permissionMode,
        executionOptions: this.db.getOrchestrationTaskExecutionOptions(source.id),
        retryOfTaskId: source.id,
        remote: source.remote ? { ...source.remote, runId: null, waitingFor: null } : null,
      });
      this.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        taskId: replacement.id,
        type: "task-retried",
        title: replacement.title,
        content: `Retry of ${source.id}.`,
      });
      await this.dispatchOrchestrationTasks(orchestration.id);
      if (replacement.remote) void this.services.orchestrationRemote.startRemoteTask(replacement.id);
      return this.db.getOrchestrationTask(replacement.id);
    });
  }

  async restartOrchestrationChildFromBeginning(
    orchestration: OrchestrationRecord,
    task: OrchestrationTaskRecord,
    child: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
  ): Promise<void> {
    this.services.providerRuntime.requireProjectMcpSupported(child.projectId, provider);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new OrchestrationToolError("model_unavailable", `Credentials are unavailable for ${provider.label}.`);
    }
    const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
    const modelProfile = orchestration.teamSnapshot.models.find((entry) => entry.modelId === task.modelId);
    const effort = role?.effortOverride ?? modelProfile?.defaultEffort;
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
    const childSteps = this.db.getRunSteps(child.id);
    const inheritedFullAccess = task.permissionMode !== "supervised" && resolveOrchestrationChildFullAccess(
      task.intent,
      childSteps,
      this.db.getRunSteps(coordinator.id),
    );
    const childExecutionOptions = this.services.turnState.getLatestRunExecutionOptions(child.id, provider) ??
      resolveProviderExecutionOptions(provider, {
        executionOptions: applyTaskExecutionOptions(
          mergeOrchestrationExecutionOptions(undefined, effort),
          this.db.getOrchestrationTaskExecutionOptions(task.id),
        ),
      });
    const prompt = buildDelegatedTaskPrompt({
      roleName: role?.name ?? task.roleId, roleDescription: role?.description, intent: task.intent, task: task.prompt, goalText: coordinator.goalText,
    });
    this.db.updateRunStatus(child.id, "preparing", { errorMessage: null });
    this.services.skills.skillService.inheritSelection("run", child.id, coordinator.id);
    const worker = await this.services.runWorkerHost.startWorker(
      child,
      provider,
      model,
      apiKey ?? "",
      await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: prompt,
        providerOptions: childExecutionOptions,
        yoloMode: inheritedFullAccess,
      },
    );
    this.services.activeWorkers.runWorkers.set(child.id, { worker, cancelled: false, providerType: provider.providerType });
  }
}
