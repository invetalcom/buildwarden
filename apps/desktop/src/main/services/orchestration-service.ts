import {
  APP_SETTING_KEYS,
  buildDefaultOrchestrationTeam,
  type OrchestrationChangedPayload,
  type OrchestrationDetail,
  type OrchestrationRecord,
  type OrchestrationTaskRecord,
  OrchestrationToolError,
  parseOrchestrationTeamSettings,
  type RunRecord,
} from "@buildwarden/shared";
import { closeCoordinatorWaitDeliveries } from "../orchestration-delivery";
import { describeModelMentions } from "../orchestration-tools";
import { ORCHESTRATION_TERMINAL_TASK_STATUSES, OrchestrationRuntimeActions } from "../orchestration-runtime-actions";
import { getOrchestrationArtifactRoot } from "../orchestration-workspace";
import type { RunBudgetExhaustion } from "../run-autonomy-budget";
import { AppService } from "./app-service";
import { ORCHESTRATION_ACTIVE_TASK_STATUSES, ORCHESTRATION_CANCELLABLE_STATUSES } from "./orchestration-policy";

/** Owns orchestration records, their settings and their overall status. */
export class OrchestrationService extends AppService<
  | "activeWorkers"
  | "orchestrationCoordinator"
  | "orchestrationDispatch"
  | "orchestrationRemote"
  | "orchestrationResults"
  | "orchestrationTools"
  | "runTurns"
> {
  /** Serializes durable orchestration state transitions for each coordinator graph. */
  private readonly orchestrationMutations = new Map<string, Promise<unknown>>();

  getOrchestrationArtifactRoot(): string {
    return getOrchestrationArtifactRoot(this.db.getFilePath());
  }

  async withOrchestrationMutation<T>(orchestrationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.orchestrationMutations.get(orchestrationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.orchestrationMutations.set(orchestrationId, current);
    try {
      return await current;
    } finally {
      if (this.orchestrationMutations.get(orchestrationId) === current) {
        this.orchestrationMutations.delete(orchestrationId);
      }
    }
  }

  /**
   * The team a new orchestration freezes. Without configured roles it is the default team over
   * every enabled model, preferring `preferredModelId`; configured roles are kept as the user set
   * them, minus models that can no longer run.
   */
  resolveOrchestrationTeamSettings(preferredModelId?: string | null) {
    const configured = parseOrchestrationTeamSettings(
      this.db.getSettings()[APP_SETTING_KEYS.orchestrationTeam],
    );
    const availableModels = new Set(
      this.db.listModels().filter((model) => Boolean(model.enabled)).map((model) => model.id),
    );
    if (configured.roles.length === 0) return buildDefaultOrchestrationTeam(configured, [...availableModels], preferredModelId);
    const models = configured.models.filter((model) => model.enabled && availableModels.has(model.modelId));
    const modelIds = new Set(models.map((model) => model.modelId));
    const roles = configured.roles.flatMap((role) => {
      const eligibleModelIds = role.eligibleModelIds.filter((modelId) => modelIds.has(modelId));
      if (eligibleModelIds.length === 0 || !eligibleModelIds.includes(role.preferredModelId)) return [];
      return [{ ...role, eligibleModelIds }];
    });
    return { ...configured, models, roles };
  }

  /** How many delegations lie above a run: 0 for a top-level run, 1 for its children, and so on. */
  delegationDepth(run: Pick<RunRecord, "id">): number {
    let depth = 0;
    let runId = run.id;
    for (let task = this.db.getOrchestrationTaskByChildRunId(runId); task && depth < 16; task = this.db.getOrchestrationTaskByChildRunId(runId)) {
      depth += 1;
      runId = this.db.getOrchestration(task.orchestrationId).coordinatorRunId;
    }
    return depth;
  }

  /** Whether a child of `coordinator` may delegate in turn, within its orchestration's depth limit. */
  childMayDelegate(coordinator: RunRecord, orchestration: OrchestrationRecord): boolean {
    return this.delegationDepth(coordinator) + 1 < (orchestration.teamSnapshot.maxDelegationDepth ?? 1);
  }

  /**
   * Whether a child that coordinates its own tasks is still at it: its orchestration waits for a
   * wake, or some of its tasks are still going. Its own task publishes no result until it is done.
   */
  isStillCoordinating(runId: string): boolean {
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(runId);
    if (!orchestration || ["completed", "cancelled", "deleting", "deletion-failed"].includes(orchestration.status)) return false;
    return orchestration.status === "waiting"
      || this.db.listOrchestrationTasks(orchestration.id).some((task) => !ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status));
  }

  /** The coordinator's prompt with the models the user named with `@`, when it names any. */
  withModelMentions(run: RunRecord, prompt: string): string {
    if (!run.delegationEnabled || run.kind === "orchestration-task" || !prompt.includes("@")) return prompt;
    const team = this.db.getOrchestrationByCoordinatorRunId(run.id)?.teamSnapshot ?? this.resolveOrchestrationTeamSettings(run.modelId);
    const teamModelIds = new Set(team.models.filter((model) => model.enabled).map((model) => model.modelId));
    const providers = new Map(this.db.listProviderAccounts().map((provider) => [provider.id, provider]));
    const note = describeModelMentions(prompt, this.db.listModels().filter((model) => teamModelIds.has(model.id)).map((model) => ({
      id: model.id,
      modelId: model.modelId,
      displayName: model.displayName,
      providerLabel: providers.get(model.providerAccountId)?.label ?? "",
      providerType: providers.get(model.providerAccountId)?.providerType ?? "",
    })));
    return note ? `${prompt}\n\n${note}` : prompt;
  }

  getOrCreateOrchestration(coordinatorRun: RunRecord): OrchestrationRecord {
    const existing = this.db.getOrchestrationByCoordinatorRunId(coordinatorRun.id);
    if (existing) return existing;
    if (!coordinatorRun.delegationEnabled) {
      throw new Error("Delegation is not enabled for this run.");
    }
    const parentTask = coordinatorRun.kind === "orchestration-task" ? this.db.getOrchestrationTaskByChildRunId(coordinatorRun.id) : null;
    const parentLimit = parentTask ? this.db.getOrchestration(parentTask.orchestrationId).teamSnapshot.maxDelegationDepth ?? 1 : null;
    if (coordinatorRun.kind === "orchestration-task" && (parentLimit === null || this.delegationDepth(coordinatorRun) >= parentLimit)) {
      throw new Error("This delegated run may not delegate further: the orchestration's delegation depth is reached.");
    }
    const resolved = this.resolveOrchestrationTeamSettings(coordinatorRun.modelId);
    // A child coordinator inherits the depth limit, so a later settings change cannot deepen a running tree.
    const teamSnapshot = parentLimit === null ? resolved : { ...resolved, maxDelegationDepth: parentLimit };
    if (teamSnapshot.roles.length === 0) {
      throw new Error("Enable at least one model, or configure a valid orchestration role, before delegating.");
    }
    const orchestration = this.db.createOrchestration({
      projectId: coordinatorRun.projectId,
      coordinatorRunId: coordinatorRun.id,
      teamSnapshot,
    });
    const budgetWarning = this.services.orchestrationTools.coordinatorBudgetWarning(coordinatorRun, teamSnapshot);
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "created",
      title: "Orchestration started",
      content: [
        `Frozen team configuration with ${teamSnapshot.roles.length} role${teamSnapshot.roles.length === 1 ? "" : "s"}.`,
        budgetWarning,
      ].filter(Boolean).join(" "),
    });
    return this.db.getOrchestration(orchestration.id);
  }

  private getMutableOrchestrationByCoordinatorRunId(coordinatorRunId: string): OrchestrationRecord {
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration) throw new Error("This run has not started an orchestration.");
    if (orchestration.status === "deleting" || orchestration.status === "deletion-failed") {
      throw new Error("The orchestration is being deleted; retry or complete cleanup before changing it.");
    }
    return orchestration;
  }

  emitOrchestrationChanged(orchestrationId: string, taskId?: string | null, deletedRunIds?: string[]): void {
    const orchestration = this.db.getOrchestration(orchestrationId);
    const payload: OrchestrationChangedPayload = {
      projectId: orchestration.projectId,
      coordinatorRunId: orchestration.coordinatorRunId,
      orchestrationId: orchestration.id,
      taskId: taskId ?? null,
      status: orchestration.status,
      sequence: orchestration.lastEventSequence,
      ...(deletedRunIds ? { deletedRunIds } : {}),
    };
    this.events.publish("orchestration", payload);
  }

  onOrchestrationChanged(listener: (payload: OrchestrationChangedPayload) => void): () => void {
    return this.events.subscribe("orchestration", listener);
  }

  async getOrchestrationDetail(coordinatorRunId: string): Promise<OrchestrationDetail | null> {
    return this.db.getOrchestrationDetailByCoordinatorRunId(coordinatorRunId);
  }

  async getOrchestrationTaskDetail(taskId: string): Promise<OrchestrationTaskRecord> {
    return this.db.getOrchestrationTask(taskId);
  }

  orchestrationTaskChangedFiles(diff: string): string[] {
    const paths = new Set<string>();
    for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
      paths.add((match[2] || match[1] || "").trim());
    }
    for (const match of diff.matchAll(/^# (?:Created|Changed|Deleted) (?:text|binary|large) file: (.+)$/gm)) {
      paths.add((match[1] || "").trim());
    }
    return [...paths].filter(Boolean);
  }

  orchestrationBudgetExhaustion(orchestration: OrchestrationRecord): RunBudgetExhaustion | null {
    const limit = orchestration.teamSnapshot.maxTotalTokens ?? 0;
    if (limit <= 0) return null;
    const observed = this.db.getOrchestrationTotalTokens(orchestration.id);
    if (observed < limit) return null;
    return { kind: "tokens", limit, observed, reason: `The orchestration used ${String(observed)} of its ${String(limit)} token budget.` };
  }

  get orchestrationRuntimeActions(): OrchestrationRuntimeActions {
    return new OrchestrationRuntimeActions(this.db, (runId) => this.services.runTurns.cancelRun(runId),
      (task) => this.services.orchestrationRemote.cancelRemoteRun(task));
  }

  async cancelOrchestrationTasks(orchestration: OrchestrationRecord, taskIds: string[], cancelCoordinator = false): Promise<void> {
    const tasks = [...new Set(taskIds)].map((taskId) => {
      const task = this.db.findOrchestrationTask(taskId);
      if (!task) throw new OrchestrationToolError("task_not_found", `Task ${taskId} does not exist.`);
      if (task.orchestrationId !== orchestration.id) {
        throw new OrchestrationToolError("task_not_in_orchestration", `Task ${taskId} does not belong to this orchestration.`);
      }
      return task;
    });
    const errors: unknown[] = [];
    try {
      await this.orchestrationRuntimeActions.cancel(tasks, cancelCoordinator ? orchestration.id : undefined);
    } catch (error) {
      errors.push(error);
    }
    // Also when one child could not be cancelled: the others' own tasks must stop all the same.
    for (const task of tasks) {
      const nested = task.childRunId ? this.db.getOrchestrationByCoordinatorRunId(task.childRunId) : null;
      // A nested orchestration already marked cancelled may still hold tasks whose cancellation
      // failed, at any depth below it.
      if (!nested || (!ORCHESTRATION_CANCELLABLE_STATUSES.has(nested.status) && !(nested.status === "cancelled" && this.hasUnfinishedTasks(nested.id)))) continue;
      try {
        await this.cancelOrchestration(task.childRunId!);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestration.id);
    this.emitOrchestrationChanged(orchestration.id);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Cancellation partially failed: ${errors.map(String).join("; ")}`);
  }

  /** Whether a task of this orchestration, or of one its children coordinate, has not ended. */
  private hasUnfinishedTasks(orchestrationId: string, depth = 0): boolean {
    return this.db.listOrchestrationTasks(orchestrationId).some((task) => {
      if (!ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status)) return true;
      const nested = task.childRunId && depth < 16 ? this.db.getOrchestrationByCoordinatorRunId(task.childRunId) : null;
      return nested ? this.hasUnfinishedTasks(nested.id, depth + 1) : false;
    });
  }

  async pauseOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      this.db.updateOrchestration(orchestration.id, { status: "paused" });
      this.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "paused",
        title: "Scheduling paused",
        content: "Running child tasks may finish; queued tasks will not launch.",
      });
      await this.db.flushDurable();
      this.emitOrchestrationChanged(orchestration.id);
    });
  }

  async resumeOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      const current = this.db.getOrchestration(orchestration.id);
      const tasks = this.db.listOrchestrationTasks(current.id);
      // A coordinator stopped without a wake condition still has to hear how its tasks ended.
      const needsWakeCondition = current.status === "attention" && !current.wakeMode && tasks.length > 0 &&
        !this.services.activeWorkers.runWorkers.has(coordinatorRunId);
      const latestWave = needsWakeCondition ? this.db.listOrchestrationWaves(current.id).at(-1) : undefined;
      const wakeMode = needsWakeCondition ? "all-terminal" : current.wakeMode;
      this.db.updateOrchestration(current.id, {
        status: wakeMode ? "waiting" : "active",
        wakeMode,
        wakeTaskIds: needsWakeCondition ? tasks.filter((task) => task.waveId === latestWave?.id).map((task) => task.id) : current.wakeTaskIds,
        errorMessage: null,
      });
      this.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "resumed",
        title: "Scheduling resumed",
        content: "Eligible queued tasks can launch.",
      });
      await this.services.orchestrationDispatch.dispatchOrchestrationTasks(orchestration.id);
      await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestration.id);
      this.emitOrchestrationChanged(orchestration.id);
    });
  }

  async cancelOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    await this.withOrchestrationMutation(orchestration.id, async () => {
      closeCoordinatorWaitDeliveries(this.db, orchestration.id);
      const errors: unknown[] = [];
      // Every task, the finished ones too: a retry must still reach what an already-cancelled
      // child delegated. Tasks that already ended are not cancelled again.
      try { await this.cancelOrchestrationTasks(
        orchestration,
        this.db.listOrchestrationTasks(orchestration.id).map((task) => task.id),
        true,
      ); } catch (error) { errors.push(error); }
      try {
        if (this.services.activeWorkers.runWorkers.has(coordinatorRunId)) await this.services.activeWorkers.cancelRunWorker(coordinatorRunId);
      } catch (error) { errors.push(error); }
      this.db.appendOrchestrationEvent({
        orchestrationId: orchestration.id,
        type: "cancelled",
        title: "Orchestration cancelled",
        content: errors.length ? "Cancellation requested; some workers could not be cancelled." : "All pending and running tasks were cancelled.",
      });
      await this.db.flushDurable();
      this.emitOrchestrationChanged(orchestration.id);
      if (errors.length) throw new AggregateError(errors, `Orchestration cancellation failed: ${errors.map(String).join("; ")}`);
    });
  }

  async finishOrchestration(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    const tasks = this.db.listOrchestrationTasks(orchestration.id);
    if (tasks.some((task) => !ORCHESTRATION_TERMINAL_TASK_STATUSES.has(task.status))) {
      throw new Error("The orchestration cannot finish while tasks are still pending or running.");
    }
    if (tasks.some((task) => task.adoptionStatus === "applying")) {
      throw new Error("The orchestration cannot finish while adoption is applying.");
    }
    // A finished orchestration must not show native work as still running.
    for (const task of tasks) if (task.childRunId) this.services.orchestrationResults.closeAbandonedChildSubagents(task.childRunId);
    // Its own turn may have just received a wait's result; nothing reads that news afterwards.
    this.services.orchestrationCoordinator.settleCoordinatorWaitDeliveries(orchestration.id, { turnEnded: false });
    closeCoordinatorWaitDeliveries(this.db, orchestration.id);
    this.db.updateOrchestration(orchestration.id, {
      status: "completed",
      wakeMode: null,
      wakeTaskIds: [],
      finishedAt: new Date().toISOString(),
    });
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "completed",
      title: "Orchestration completed",
      content: `Completed with ${tasks.length} durable task${tasks.length === 1 ? "" : "s"}.`,
    });
    this.emitOrchestrationChanged(orchestration.id);
  }

  async refreshOrchestrationTeam(coordinatorRunId: string): Promise<void> {
    const orchestration = this.getMutableOrchestrationByCoordinatorRunId(coordinatorRunId);
    const tasks = this.db.listOrchestrationTasks(orchestration.id);
    if (tasks.some((task) => ORCHESTRATION_ACTIVE_TASK_STATUSES.has(task.status) || task.status === "pending")) {
      throw new Error("The frozen team can be refreshed only when no tasks are pending or running.");
    }
    const resolved = this.resolveOrchestrationTeamSettings(this.db.getRun(coordinatorRunId).modelId);
    // A nested coordinator keeps the depth limit its tree started with; a settings change must not deepen it.
    const nested = this.db.getOrchestrationTaskByChildRunId(coordinatorRunId) !== null;
    const inheritedDepth = orchestration.teamSnapshot.maxDelegationDepth;
    const team = nested ? { ...resolved, maxDelegationDepth: inheritedDepth } : resolved;
    if (nested && inheritedDepth === undefined) delete team.maxDelegationDepth;
    if (team.roles.length === 0) throw new Error("Enable at least one model, or configure a valid orchestration role.");
    this.db.updateOrchestration(orchestration.id, { teamSnapshot: team });
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      type: "team-refreshed",
      title: "Team configuration refreshed",
      content: `The frozen team now contains ${team.roles.length} role${team.roles.length === 1 ? "" : "s"}.`,
    });
    this.emitOrchestrationChanged(orchestration.id);
  }
}
