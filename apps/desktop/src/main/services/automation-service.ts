import { setTimeout as delay } from "node:timers/promises";
import {
  automationLocalDateTimeToUtc,
  type AutomationTrigger,
  type AutomationWorkflowTriggerInfo,
  DEFAULT_AUTOMATION_TRIGGER,
  formatAutomationLocalDateTime,
  isAutomationWorkflow,
  parseAutomationTrigger,
  parseAutomationWorkflow,
  validateAutomationWorkflow,
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
import { automationTriggerInfo } from "./automation-trigger-service";

/** Covers a restart or update of a headless host. */
const UNATTENDED_AUTOMATION_GRACE_MS = 15 * 60_000;
const UNATTENDED_AUTOMATION_RETRY_MS = 30_000;
const automationOccurrenceKey = (automationId: string, scheduledAt: string): string => `${automationId} ${scheduledAt}`;

/** Stored for automations that do not start on a schedule, so a later switch to one has a valid start. */
const FALLBACK_CRON_EXPRESSION = "0 9 * * 1-5";

const resolveAutomationTimeZone = (timeZone: string | undefined): string =>
  timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** True when nothing, the scheduler included, wrote to the automation between the two reads. */
const isSameProjectAutomationRevision = (current: ProjectAutomationRecord, previous: ProjectAutomationRecord): boolean =>
  current.updatedAt === previous.updatedAt &&
  current.enabled === previous.enabled &&
  current.nextRunAt === previous.nextRunAt &&
  current.lastScheduledAt === previous.lastScheduledAt;

/** Schedules and starts project automations. */
export class AutomationService extends AppService<
  | "activeWorkers"
  | "automationTriggers"
  | "automationWorkflows"
  | "forgeIssueActions"
  | "orchestrationDispatch"
  | "projects"
  | "runDeletion"
  | "runLifecycle"
> {
  automationSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private automationSchedulerBlockedForStartup = true;
  /** Missed occurrences that were not selected but could not be consumed yet. The scheduler must not start them. */
  private readonly skippedAutomationOccurrences = new Set<string>();
  /** A startup decision that could not be applied. The scheduler applies it to everything due until then. */
  private unappliedCatchUp: { selected: ReadonlySet<string>; decidedAt: number } | null = null;
  private automationSchedulerTickActive = false;
  /** Automations whose runs are being deleted. They must not start another one. */
  private readonly automationsBeingDeleted = new Set<string>();
  /** Launches whose run may not be saved yet, so no run shows them as active. */
  private readonly automationLaunches = new Set<{ automationId: string }>();

  private async validateProjectAutomationInput(
    projectId: string,
    input: ProjectAutomationInput,
    options?: {
      /** The automation being changed, so its own trigger is not mistaken for a loop. */
      automationId?: string;
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
    const trigger = parseAutomationTrigger(input.trigger ?? DEFAULT_AUTOMATION_TRIGGER);
    this.validateAutomationTrigger(project.id, trigger, options?.automationId ?? null);
    const workflow = parseAutomationWorkflow(input.workflow ?? { check: null, steps: [] });
    const workflowProblem = validateAutomationWorkflow(workflow, { gitProject: project.kind === "git" });
    if (workflowProblem) throw new Error(workflowProblem);
    const scheduled = trigger.kind === "schedule";
    const scheduleKind = scheduled ? input.scheduleKind ?? "cron" : "cron";
    let cronExpression = scheduleKind === "cron" ? input.cronExpression.trim() : "";
    if (scheduled && scheduleKind === "cron") parseAutomationCron(cronExpression);
    if (!scheduled) {
      try { parseAutomationCron(cronExpression); } catch { cronExpression = FALLBACK_CRON_EXPRESSION; }
    }
    const timeZone = validateAutomationTimeZone(resolveAutomationTimeZone(input.timeZone));
    const runAtLocal = scheduled && scheduleKind === "once" ? input.runAtLocal?.trim() ?? "" : undefined;
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
      input: { ...input, name, prompt, scheduleKind, cronExpression, runAtLocal, workspaceType, baseBranch, trigger, workflow },
      timeZone,
      nextRunAt,
    };
  }

  private validateAutomationTrigger(projectId: string, trigger: AutomationTrigger, automationId: string | null): void {
    const gitProject = this.db.getProject(projectId).kind === "git";
    if (trigger.kind === "issue-labelled") {
      if (!gitProject) throw new Error("Issue labels need a Git project with a hosted remote.");
      if (!trigger.label) throw new Error("Enter the label that starts this automation.");
    }
    if (trigger.kind === "pr-opened" && !gitProject) throw new Error("Pull requests need a Git project with a hosted remote.");
    if (trigger.kind !== "automation-finished") return;
    if (!trigger.automationId) throw new Error("Choose the automation this one follows.");
    if (trigger.automationId === automationId) throw new Error("An automation cannot start after itself.");
    // Each automation follows at most one other, so following the chain upwards finds every loop.
    const seen = new Set<string>(automationId ? [automationId] : []);
    let upstreamId: string | null = trigger.automationId;
    while (upstreamId) {
      if (seen.has(upstreamId)) throw new Error("These automations would start each other in a loop.");
      seen.add(upstreamId);
      const upstream = this.db.getProjectAutomation(upstreamId);
      if (upstream.projectId !== projectId) throw new Error("Choose an automation of the same project.");
      upstreamId = upstream.trigger.kind === "automation-finished" ? upstream.trigger.automationId : null;
    }
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
        // Another automation may have started following this one while Git was read; a loop is checked again here.
        this.validateAutomationTrigger(current.projectId, parseAutomationTrigger(update.input.trigger), automationId);
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
      // Trimmed like the stored values, so spaces alone do not count as a schedule change.
      cronExpression: scheduleKind === "cron" ? (input.cronExpression ?? existing.cronExpression).trim() : "",
      runAtLocal: scheduleKind === "once" ? (input.runAtLocal ?? existingRunAtLocal)?.trim() : undefined,
      timeZone: resolveAutomationTimeZone(input.timeZone ?? existing.timeZone),
      modelId: input.modelId ?? existing.modelId,
      effort: input.effort ?? existing.effort,
      executionOptions: input.executionOptions ?? existing.executionOptions,
      workspaceType: input.workspaceType ?? existing.workspaceType,
      baseBranch: input.baseBranch === undefined ? existing.baseBranch : input.baseBranch,
      onlyIfPreviousFinished: input.onlyIfPreviousFinished ?? Boolean(existing.onlyIfPreviousFinished),
      enabled: input.enabled ?? Boolean(existing.enabled),
      trigger: input.trigger ?? existing.trigger,
      workflow: input.workflow ?? existing.workflow,
    };
    const triggerKind = parseAutomationTrigger(merged.trigger).kind;
    const disablingOnly = input.enabled === false && Object.keys(input).every((key) => key === "enabled");
    // Re-enabling counts as a schedule change, so a one-time automation that already fired
    // (and disabled itself) can only be switched back on with a new start in the future.
    const scheduleChanged = scheduleKind !== existing.scheduleKind || merged.timeZone !== existing.timeZone ||
      (scheduleKind === "once" ? merged.runAtLocal !== existingRunAtLocal : merged.cronExpression !== existing.cronExpression) ||
      (!existing.enabled && merged.enabled !== false) ||
      // Switching to a schedule arms it from now.
      (triggerKind === "schedule" && existing.trigger.kind !== "schedule");
    const validated = await this.validateProjectAutomationInput(existing.projectId, merged, {
      automationId: existing.id,
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
    this.requireAutomationNotBeingDeleted(automationId);
    const runs = this.db.listRunsForProject(automation.projectId).filter((run) => run.automationId === automationId);
    const isLaunching = [...this.automationLaunches].some((launch) => launch.automationId === automationId);
    if (isLaunching || runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
      throw new Error("Wait for this automation's active run to finish before deleting it.");
    }
    if (this.services.automationWorkflows.hasActiveWorkflowRun(automationId)) {
      throw new Error("Stop this automation's running workflow before deleting it.");
    }
    this.automationsBeingDeleted.add(automationId);
    try {
      for (const run of runs) await this.services.runDeletion.deleteRun(run.id);
      this.db.deleteProjectAutomation(automationId);
    } finally {
      this.automationsBeingDeleted.delete(automationId);
    }
  }

  /** True until the missed automations of this launch were reviewed; nothing starts automations before that. */
  get startupReviewPending(): boolean {
    return this.automationSchedulerBlockedForStartup;
  }

  private requireAutomationNotBeingDeleted(automationId: string): void {
    if (this.automationsBeingDeleted.has(automationId)) throw new Error("This automation is being deleted.");
  }

  private async executeProjectAutomation(
    automation: ProjectAutomationRecord,
    trigger: AutomationWorkflowTriggerInfo = automationTriggerInfo("schedule", "Scheduled start"),
  ): Promise<RunRecord | null> {
    this.requireAutomationNotBeingDeleted(automation.id);
    const launch = { automationId: automation.id };
    this.automationLaunches.add(launch);
    try {
      return await this.launchProjectAutomation(automation, trigger);
    } finally {
      this.automationLaunches.delete(launch);
    }
  }

  /**
   * Starts an automation for a trigger other than its schedule. Issue and pull request triggers start one run
   * per item; an automation that follows another one waits for its previous run like a schedule does.
   */
  async startTriggeredAutomation(automationId: string, trigger: AutomationWorkflowTriggerInfo): Promise<RunRecord | null> {
    const automation = this.db.getProjectAutomation(automationId);
    if (!automation.enabled || this.automationsBeingDeleted.has(automationId)) return null;
    try {
      const run = await this.executeProjectAutomation(automation, trigger);
      if (run) this.db.setProjectAutomationError(automationId, null);
      return run;
    } catch (error) {
      this.db.setProjectAutomationError(automationId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async launchProjectAutomation(automation: ProjectAutomationRecord, trigger: AutomationWorkflowTriggerInfo): Promise<RunRecord | null> {
    const previousActive = this.db.listRunsForProject(automation.projectId).some(
      (run) => run.automationId === automation.id && ACTIVE_RUN_STATUSES.has(run.status),
    ) || this.services.automationWorkflows.hasActiveWorkflowRun(automation.id);
    // A one-time automation has a single occurrence; skipping it would silently lose the run.
    // Issue and pull request triggers start once per item, so they never wait either.
    const waitsForPrevious = trigger.kind === "automation-finished" || (trigger.kind === "schedule" && automation.scheduleKind === "cron");
    if (waitsForPrevious && automation.onlyIfPreviousFinished && previousActive) return null;
    if (isAutomationWorkflow(automation.workflow) || trigger.kind === "issue-labelled" || trigger.kind === "pr-opened" ||
      trigger.kind === "automation-finished") {
      const workflow = await this.services.automationWorkflows.startWorkflow(automation, trigger);
      const runId = workflow.steps[0]?.runId;
      if (!runId) throw new Error(workflow.error ?? "The automation could not start.");
      return this.db.getRun(runId);
    }
    const model = this.db.getModel(automation.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const project = this.db.getProject(automation.projectId);
    const hasExecutionOptions = Object.keys(automation.executionOptions).length > 0;
    const run = await this.services.runLifecycle.createRun({
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
    }, { background: true });
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
    const run = await this.executeProjectAutomation(automation, automationTriggerInfo("now", "Started by hand"));
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
      .filter((automation) => automation.trigger.kind === "schedule" && Boolean(automation.enabled) && Date.parse(automation.nextRunAt) <= now)
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
    let missed: StartupAutomationCatchUpItem[];
    try {
      missed = this.offeredCatchUp ?? await this.getStartupAutomationCatchUp();
    } catch (error) {
      if (this.automationSchedulerBlockedForStartup) this.unappliedCatchUp = { selected, decidedAt: Date.now() };
      this.releaseAutomationScheduler();
      throw error;
    }
    return this.resolveMissedAutomations(missed, (item) => selected.has(item.automationId));
  }

  private releaseAutomationScheduler(): void {
    this.automationSchedulerBlockedForStartup = false;
    void this.runAutomationSchedulerTick();
  }

  private wasSkippedAtStartup(automation: ProjectAutomationRecord): boolean {
    if (this.skippedAutomationOccurrences.delete(automationOccurrenceKey(automation.id, automation.nextRunAt))) return true;
    const decision = this.unappliedCatchUp;
    return decision !== null && !decision.selected.has(automation.id) && Date.parse(automation.nextRunAt) <= decision.decidedAt;
  }

  /** Occurrences that are not in `missed` because they came due later are left to the scheduler. */
  private async resolveMissedAutomations(
    missed: StartupAutomationCatchUpItem[],
    isSelected: (item: StartupAutomationCatchUpItem) => boolean,
  ): Promise<RunRecord[]> {
    this.offeredCatchUp = null;
    this.unappliedCatchUp = null;
    const started: RunRecord[] = [];
    try {
      const now = new Date();
      for (const item of missed) {
        try {
          const automation = this.db.getProjectAutomation(item.automationId);
          // Earlier launches in this loop can take a while; an automation rescheduled meanwhile
          // keeps its new start and is left to the scheduler.
          if (!automation.enabled || automation.trigger.kind !== "schedule" || automation.nextRunAt !== item.scheduledAt ||
            Date.parse(automation.nextRunAt) > now.getTime()) continue;
          // A deletion that fails must find the occurrence due and the decision kept. The scheduler then
          // starts a selected one and consumes a skipped one without starting it.
          if (this.automationsBeingDeleted.has(automation.id)) {
            if (!isSelected(item)) this.skippedAutomationOccurrences.add(automationOccurrenceKey(item.automationId, item.scheduledAt));
            continue;
          }
          // Skipped one-time automations are consumed too and then show as missed.
          this.consumeDueAutomationOccurrence(automation, item.scheduledAt, now);
          if (!isSelected(item)) continue;
          const run = await this.executeProjectAutomation(automation);
          if (run) started.push(run);
        } catch (error) {
          // Waiting here until it can be consumed would let one broken schedule hold up all automations.
          if (!isSelected(item)) this.skippedAutomationOccurrences.add(automationOccurrenceKey(item.automationId, item.scheduledAt));
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
      this.releaseAutomationScheduler();
    }
  }

  /**
   * A headless host has nobody to review missed automations. It skips them like an unanswered review
   * would, except those that came due during a short restart, and lets the scheduler start. The scheduler
   * starts everything that is due, so it stays blocked while the missed automations cannot be read.
   */
  async resolveStartupAutomationsUnattended(runAllMissed: boolean, retryDelayMs = UNATTENDED_AUTOMATION_RETRY_MS): Promise<void> {
    const oldest = runAllMissed ? Number.NEGATIVE_INFINITY : Date.now() - UNATTENDED_AUTOMATION_GRACE_MS;
    while (!this.services.activeWorkers.agentWorkersStopping) {
      let missed: StartupAutomationCatchUpItem[];
      try {
        missed = await this.getStartupAutomationCatchUp();
      } catch (error) {
        this.logControllerError("Could not read missed automations at startup. Scheduled automations wait for the next attempt.", error);
        await delay(retryDelayMs, undefined, { ref: false });
        continue;
      }
      await this.resolveMissedAutomations(missed, (item) => Date.parse(item.scheduledAt) >= oldest);
      return;
    }
  }

  startAutomationScheduler(): void {
    if (this.services.activeWorkers.agentWorkersStopping || this.automationSchedulerTimer) return;
    this.automationSchedulerTimer = setInterval(() => {
      void this.services.orchestrationDispatch.runDeferredOrchestrationTick();
      void this.runAutomationSchedulerTick();
      void this.services.forgeIssueActions.runForgeIssueAutomationTick();
      void this.services.automationTriggers.runTriggerTick();
      this.services.automationWorkflows.runWorkflowTick();
    }, 30_000);
    // Workflows that were waiting when the app closed continue without waiting for the first interval.
    this.services.automationWorkflows.runWorkflowTick();
  }

  private async runAutomationSchedulerTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.automationSchedulerBlockedForStartup || this.automationSchedulerTickActive) return;
    this.automationSchedulerTickActive = true;
    try {
      const now = new Date();
      const due = this.db.listProjectAutomations().filter(
        (automation) => automation.trigger.kind === "schedule" && Boolean(automation.enabled) && Date.parse(automation.nextRunAt) <= now.getTime(),
      );
      for (const automation of due) {
        if (this.services.activeWorkers.agentWorkersStopping) break;
        try {
          const current = this.db.getProjectAutomation(automation.id);
          // A deletion that fails leaves the occurrence for a later tick.
          if (!current.enabled || current.trigger.kind !== "schedule" || Date.parse(current.nextRunAt) > now.getTime() ||
            this.automationsBeingDeleted.has(current.id)) continue;
          this.consumeDueAutomationOccurrence(current, current.nextRunAt, now);
          if (this.wasSkippedAtStartup(current)) continue;
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
    } catch (error) {
      // Nobody awaits the tick, so a rejection would end the app. The next tick tries again.
      this.logControllerError("Could not read the scheduled automations.", error);
    } finally {
      this.automationSchedulerTickActive = false;
    }
  }

  onAutomationStarted(listener: (payload: import("@buildwarden/shared").AutomationStartedNotificationPayload) => void): () => void {
    return this.events.subscribe("automationStarted", listener);
  }
}
