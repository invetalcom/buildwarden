import {
  automationLocalDateTimeToUtc,
  formatAutomationLocalDateTime,
  nextAutomationRunAt,
  oneTimeAutomationRunAt,
  parseAutomationCron,
  type ProjectAutomationInput,
  type ProjectAutomationRecord,
  type RunRecord,
  type StartupAutomationCatchUpItem,
  type UpdateProjectAutomationInput,
  validateAutomationTimeZone,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";

/** True when nothing, the scheduler included, wrote to the automation between the two reads. */
const isSameProjectAutomationRevision = (current: ProjectAutomationRecord, previous: ProjectAutomationRecord): boolean =>
  current.updatedAt === previous.updatedAt &&
  current.enabled === previous.enabled &&
  current.nextRunAt === previous.nextRunAt &&
  current.lastScheduledAt === previous.lastScheduledAt;

/** Schedules and starts project automations. */
export class AutomationService extends AppService<
  | "activeWorkers"
  | "appState"
  | "forgeIssueActions"
  | "orchestrationDispatch"
  | "projects"
  | "runDeletion"
  | "runLifecycle"
> {
  automationSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private automationSchedulerBlockedForStartup = true;
  private automationSchedulerTickActive = false;

  private async validateProjectAutomationInput(
    projectId: string,
    input: ProjectAutomationInput,
    options?: {
      skipBranchExistenceCheck?: boolean;
      /** Keeps an unchanged one-time start that already lies in the past (e.g. renaming a finished automation). */
      allowPastRunAt?: boolean;
    },
  ): Promise<{ input: ProjectAutomationInput; timeZone: string; nextRunAt: string }> {
    const project = this.db.getProject(projectId);
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error("Enter an automation name.");
    if (!prompt && (input.attachments?.length ?? 0) === 0) {
      throw new Error("Enter a prompt or attach at least one file.");
    }
    validateChatAttachmentPayloads(input.attachments);
    const scheduleKind = input.scheduleKind ?? "cron";
    const cronExpression = scheduleKind === "cron" ? input.cronExpression.trim() : "";
    if (scheduleKind === "cron") parseAutomationCron(cronExpression);
    const timeZone = validateAutomationTimeZone(
      input.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    const runAtLocal = scheduleKind === "once" ? input.runAtLocal?.trim() ?? "" : undefined;
    let nextRunAt: string;
    if (runAtLocal === undefined) {
      nextRunAt = nextAutomationRunAt(cronExpression, timeZone, new Date());
    } else {
      if (!runAtLocal) throw new Error("Choose when this one-time automation should run.");
      nextRunAt = options?.allowPastRunAt
        ? automationLocalDateTimeToUtc(runAtLocal, timeZone)
        : oneTimeAutomationRunAt(runAtLocal, timeZone, new Date());
    }
    this.db.getModel(input.modelId);
    const workspaceType = project.kind === "git" ? "worktree" as const : "copy" as const;
    const baseBranch = project.kind === "git" ? input.baseBranch?.trim() || project.baseBranch : null;
    if (project.kind === "git" && !options?.skipBranchExistenceCheck) {
      const availableBranches = await this.services.projects.getProjectBranches(project.id);
      if (!baseBranch || !availableBranches.includes(baseBranch)) {
        throw new Error(`Automation branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
    }
    return {
      input: { ...input, name, prompt, scheduleKind, cronExpression, runAtLocal, workspaceType, baseBranch },
      timeZone,
      nextRunAt,
    };
  }

  async createProjectAutomation(projectId: string, input: ProjectAutomationInput): Promise<ProjectAutomationRecord> {
    const validated = await this.validateProjectAutomationInput(projectId, input);
    return this.db.createProjectAutomation(projectId, validated.input, validated.nextRunAt, validated.timeZone);
  }

  async getProjectAutomation(automationId: string): Promise<ProjectAutomationRecord> {
    return this.db.getProjectAutomation(automationId);
  }

  async updateProjectAutomation(automationId: string, input: UpdateProjectAutomationInput): Promise<ProjectAutomationRecord> {
    let existing = this.db.getProjectAutomation(automationId);
    let pending = input;
    for (let attempt = 1; ; attempt += 1) {
      const update = await this.prepareProjectAutomationUpdate(existing, pending);
      // Validation awaits Git, so the scheduler may have consumed an occurrence in the meantime.
      // The check and the write below run without yielding, so nothing can slip in between them.
      const current = this.db.getProjectAutomation(automationId);
      if (isSameProjectAutomationRevision(current, existing)) {
        return this.db.updateProjectAutomation(automationId, update.input, update.nextRunAt, update.timeZone);
      }
      if (attempt >= 3) throw new Error("This automation changed while it was being saved. Try again.");
      // Re-merge over the current record. When the edit keeps the occurrence, an enabled flag it did
      // not change follows the stored record, so a one-time occurrence the scheduler just fired stays
      // disabled instead of re-arming. An edit that replaces the occurrence (a new start, time zone,
      // or schedule) keeps its enabled flag, so the new start it asked for is actually scheduled.
      const replacesOccurrence = update.nextRunAt !== undefined;
      if (!replacesOccurrence && pending.enabled !== undefined && pending.enabled === Boolean(existing.enabled)) {
        const rebased = { ...pending };
        delete rebased.enabled;
        pending = rebased;
      }
      existing = current;
    }
  }

  private async prepareProjectAutomationUpdate(
    existing: ProjectAutomationRecord,
    input: UpdateProjectAutomationInput,
  ): Promise<{ input: ProjectAutomationInput; nextRunAt: string | undefined; timeZone: string }> {
    const scheduleKind = input.scheduleKind ?? existing.scheduleKind;
    const existingRunAtLocal = existing.scheduleKind === "once"
      ? formatAutomationLocalDateTime(existing.nextRunAt, existing.timeZone)
      : undefined;
    const merged: ProjectAutomationInput = {
      name: input.name ?? existing.name,
      prompt: input.prompt ?? existing.prompt,
      attachments: input.attachments ?? existing.attachments,
      scheduleKind,
      cronExpression: scheduleKind === "cron" ? input.cronExpression ?? existing.cronExpression : "",
      runAtLocal: scheduleKind === "once" ? input.runAtLocal ?? existingRunAtLocal : undefined,
      timeZone: input.timeZone ?? existing.timeZone,
      modelId: input.modelId ?? existing.modelId,
      effort: input.effort ?? existing.effort,
      executionOptions: input.executionOptions ?? existing.executionOptions,
      workspaceType: input.workspaceType ?? existing.workspaceType,
      baseBranch: input.baseBranch === undefined ? existing.baseBranch : input.baseBranch,
      onlyIfPreviousFinished: input.onlyIfPreviousFinished ?? Boolean(existing.onlyIfPreviousFinished),
      enabled: input.enabled ?? Boolean(existing.enabled),
    };
    const disablingOnly = input.enabled === false && Object.keys(input).every((key) => key === "enabled");
    // Re-enabling counts as a schedule change, so a one-time automation that already fired
    // (and disabled itself) can only be switched back on with a new start in the future.
    const scheduleChanged = scheduleKind !== existing.scheduleKind || merged.timeZone !== existing.timeZone ||
      (scheduleKind === "once" ? merged.runAtLocal !== existingRunAtLocal : merged.cronExpression !== existing.cronExpression) ||
      (!existing.enabled && merged.enabled !== false);
    const validated = await this.validateProjectAutomationInput(existing.projectId, merged, {
      skipBranchExistenceCheck: disablingOnly,
      allowPastRunAt: !scheduleChanged,
    });
    return {
      input: validated.input,
      nextRunAt: scheduleChanged ? validated.nextRunAt : undefined,
      timeZone: validated.timeZone,
    };
  }

  async deleteProjectAutomation(automationId: string): Promise<void> {
    const automation = this.db.getProjectAutomation(automationId);
    const runs = this.db.listRunsForProject(automation.projectId).filter((run) => run.automationId === automationId);
    if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
      throw new Error("Wait for this automation's active run to finish before deleting it.");
    }
    for (const run of runs) await this.services.runDeletion.deleteRun(run.id);
    this.db.deleteProjectAutomation(automationId);
  }

  private async executeProjectAutomation(automation: ProjectAutomationRecord): Promise<RunRecord | null> {
    const previousActive = this.db.listRunsForProject(automation.projectId).some(
      (run) => run.automationId === automation.id && ACTIVE_RUN_STATUSES.has(run.status),
    );
    // A one-time automation has a single occurrence; skipping it would silently lose the run.
    if (automation.scheduleKind === "cron" && automation.onlyIfPreviousFinished && previousActive) return null;
    const model = this.db.getModel(automation.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const project = this.db.getProject(automation.projectId);
    const hasExecutionOptions = Object.keys(automation.executionOptions).length > 0;
    const run = await this.services.appState.withPreservedRunSelection(() => this.services.runLifecycle.createRun({
      projectId: automation.projectId,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: getHarnessTypeForProvider(provider.providerType),
      mode: "code",
      // Keep the unattended-run invariant explicit at the automation launch
      // site as well as in createRun's normalization boundary.
      yoloMode: true,
      workspaceType: project.kind === "git" ? "worktree" : "copy",
      baseBranch: project.kind === "git" ? automation.baseBranch ?? project.baseBranch : undefined,
      prompt: automation.prompt,
      attachments: automation.attachments,
      reasoningEffort: hasExecutionOptions ? automation.executionOptions.reasoningEffort : automation.effort,
      anthropicEffort: hasExecutionOptions ? automation.executionOptions.anthropicEffort : automation.effort,
      executionOptions: hasExecutionOptions ? automation.executionOptions : undefined,
      kind: "automation",
      automationId: automation.id,
    }));
    this.events.publish("automationStarted", {
      automationId: automation.id,
      automationName: automation.name,
      projectId: project.id,
      projectName: project.name,
      runId: run.id,
      startedAt: run.startedAt ?? run.createdAt,
    });
    return run;
  }

  async runProjectAutomationNow(automationId: string): Promise<RunRecord> {
    const automation = this.db.getProjectAutomation(automationId);
    const run = await this.executeProjectAutomation(automation);
    if (!run) throw new Error("The previous automation run is still active.");
    this.db.setProjectAutomationError(automationId, null);
    return run;
  }

  async getStartupAutomationCatchUp(): Promise<StartupAutomationCatchUpItem[]> {
    this.offeredCatchUp = this.listDueAutomations();
    return this.offeredCatchUp;
  }

  private listDueAutomations(): StartupAutomationCatchUpItem[] {
    const now = Date.now();
    return this.db.listProjectAutomations()
      .filter((automation) => Boolean(automation.enabled) && Date.parse(automation.nextRunAt) <= now)
      .map((automation) => ({
        automationId: automation.id,
        automationName: automation.name,
        projectId: automation.projectId,
        projectName: this.db.getProject(automation.projectId).name,
        scheduledAt: automation.nextRunAt,
        scheduleKind: automation.scheduleKind,
      }));
  }

  /**
   * Persists that a due occurrence was consumed before anything starts, so a crash or overlapping
   * tick cannot start it twice: repeating schedules advance, one-time schedules disable themselves.
   */
  private consumeDueAutomationOccurrence(automation: ProjectAutomationRecord, scheduledAt: string, now: Date): void {
    if (automation.scheduleKind === "once") {
      this.db.markProjectAutomationFired(automation.id, scheduledAt);
      return;
    }
    this.db.markProjectAutomationScheduled(
      automation.id,
      scheduledAt,
      nextAutomationRunAt(automation.cronExpression, automation.timeZone, now),
    );
  }

  /** The occurrences the startup prompt showed, until it is answered. */
  private offeredCatchUp: StartupAutomationCatchUpItem[] | null = null;

  async resolveStartupAutomationCatchUp(automationIds: string[]): Promise<RunRecord[]> {
    const selected = new Set(automationIds);
    const started: RunRecord[] = [];
    try {
      // Automations that became due after the prompt opened are left to the scheduler.
      const due = this.offeredCatchUp ?? this.listDueAutomations();
      this.offeredCatchUp = null;
      const now = new Date();
      for (const item of due) {
        try {
          const automation = this.db.getProjectAutomation(item.automationId);
          // Earlier launches in this loop can take a while; an automation rescheduled meanwhile
          // keeps its new start and is left to the scheduler.
          if (!automation.enabled || automation.nextRunAt !== item.scheduledAt || Date.parse(automation.nextRunAt) > now.getTime()) continue;
          // Skipped one-time automations are consumed too and then show as missed.
          this.consumeDueAutomationOccurrence(automation, item.scheduledAt, now);
          if (!selected.has(automation.id)) continue;
          const run = await this.executeProjectAutomation(automation);
          if (run) started.push(run);
        } catch (error) {
          try {
            this.db.setProjectAutomationError(item.automationId, error instanceof Error ? error.message : String(error));
          } catch (recordError) {
            this.logControllerError("Could not record a startup automation failure.", recordError, { automationId: item.automationId });
          }
          this.logControllerError("Could not resolve a startup project automation.", error, { automationId: item.automationId });
        }
      }
      return started;
    } finally {
      this.automationSchedulerBlockedForStartup = false;
      void this.runAutomationSchedulerTick();
    }
  }

  startAutomationScheduler(): void {
    if (this.services.activeWorkers.agentWorkersStopping || this.automationSchedulerTimer) return;
    this.automationSchedulerTimer = setInterval(() => {
      void this.services.orchestrationDispatch.runDeferredOrchestrationTick();
      void this.runAutomationSchedulerTick();
      void this.services.forgeIssueActions.runForgeIssueAutomationTick();
    }, 30_000);
  }

  private async runAutomationSchedulerTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.automationSchedulerBlockedForStartup || this.automationSchedulerTickActive) return;
    this.automationSchedulerTickActive = true;
    try {
      const now = new Date();
      const due = this.db.listProjectAutomations().filter(
        (automation) => Boolean(automation.enabled) && Date.parse(automation.nextRunAt) <= now.getTime(),
      );
      for (const automation of due) {
        if (this.services.activeWorkers.agentWorkersStopping) break;
        try {
          const current = this.db.getProjectAutomation(automation.id);
          if (!current.enabled || Date.parse(current.nextRunAt) > now.getTime()) continue;
          this.consumeDueAutomationOccurrence(current, current.nextRunAt, now);
          await this.executeProjectAutomation(current);
        } catch (error) {
          try {
            this.db.setProjectAutomationError(automation.id, error instanceof Error ? error.message : String(error));
          } catch (recordError) {
            this.logControllerError("Could not record a scheduled automation failure.", recordError, { automationId: automation.id });
          }
          this.logControllerError("Could not start a scheduled project automation.", error, { automationId: automation.id });
        }
      }
    } finally {
      this.automationSchedulerTickActive = false;
    }
  }

  onAutomationStarted(listener: (payload: import("@buildwarden/shared").AutomationStartedNotificationPayload) => void): () => void {
    return this.events.subscribe("automationStarted", listener);
  }
}
