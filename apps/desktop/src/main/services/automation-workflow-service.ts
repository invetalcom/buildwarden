import { randomUUID } from "node:crypto";
import {
  ACTIVE_AUTOMATION_WORKFLOW_STATUSES,
  APP_SETTING_KEYS,
  AUTOMATION_STEP_LABELS,
  automationStepConditionHolds,
  automationWorkflowStepAt,
  createAutomationStepState,
  isAutomationWorkflowRunActive,
  parseAttentionInboxSettings,
  type AnswerAutomationQuestionInput,
  type AttentionItem,
  type AutomationWorkflowChangedPayload,
  type AutomationWorkflowRun,
  type AutomationWorkflowTriggerInfo,
  type ProjectAutomationRecord,
  type RunRecord,
} from "@buildwarden/shared";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";
import type { AutomationStepContext, AutomationStepProgress } from "./automation-step-service";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";

/** Lets other listeners, such as a council that starts on its own, act on a finished turn first. */
const RUN_ENDED_ADVANCE_DELAY_MS = 1_500;
/** More than a workflow can have, so a step that keeps finishing instantly cannot loop forever. */
const MAX_STEPS_PER_ADVANCE = 40;
const WAITING_STEP_KINDS = new Set(["ask", "wait", "wait-pr"]);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs automation workflows step by step. Progress is saved after every step, so restarts continue where they stopped. */
export class AutomationWorkflowService extends AppService<"activeWorkers" | "automationSteps" | "automationTriggers" | "runTurns">
  implements RunEndedListener {
  /** Advances in progress. A request that arrives meanwhile runs once more afterwards. */
  private readonly advancing = new Map<string, Promise<void>>();
  private readonly advanceAgain = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  async startWorkflow(automation: ProjectAutomationRecord, trigger: AutomationWorkflowTriggerInfo): Promise<AutomationWorkflowRun> {
    const now = new Date().toISOString();
    const definition = structuredClone(automation.workflow);
    const record: AutomationWorkflowRun = {
      id: randomUUID(),
      automationId: automation.id,
      projectId: automation.projectId,
      automationName: automation.name,
      status: "running",
      trigger,
      definition,
      steps: [createAutomationStepState("prompt", "agent"), ...definition.steps.map((step) => createAutomationStepState(step.id, step.kind))],
      currentIndex: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.save(record);
    await this.advance(record.id);
    return this.db.getAutomationWorkflowRun(record.id);
  }

  /** Workflow runs of an automation that are still going. Paused ones wait for a person and do not count. */
  hasActiveWorkflowRun(automationId: string): boolean {
    return this.db.listAutomationWorkflowRuns({ automationId, statuses: ACTIVE_AUTOMATION_WORKFLOW_STATUSES, limit: 1 }).length > 0;
  }

  /** True when a workflow started or used this run, so its end belongs to that workflow. */
  ownsRun(run: Pick<RunRecord, "id" | "automationId">): boolean {
    if (!run.automationId) return false;
    return this.db.listAutomationWorkflowRuns({ automationId: run.automationId, limit: 200 })
      .some((workflow) => workflow.steps.some((step) => step.runId === run.id));
  }

  advance(workflowRunId: string): Promise<void> {
    const current = this.advancing.get(workflowRunId);
    if (current) {
      this.advanceAgain.add(workflowRunId);
      return current;
    }
    const pending = (async () => {
      try {
        do {
          this.advanceAgain.delete(workflowRunId);
          await this.advanceOnce(workflowRunId);
        } while (this.advanceAgain.has(workflowRunId) && !this.services.activeWorkers.agentWorkersStopping);
      } catch (error) {
        this.logControllerError("Could not advance an automation workflow.", error, { workflowRunId });
      } finally {
        this.advancing.delete(workflowRunId);
      }
    })();
    this.advancing.set(workflowRunId, pending);
    return pending;
  }

  /** Checks every workflow that is still going: waits that ended, answers, finished runs. Never awaited by the scheduler. */
  runWorkflowTick(): void {
    if (this.services.activeWorkers.agentWorkersStopping) return;
    let active: AutomationWorkflowRun[];
    try {
      active = this.db.listAutomationWorkflowRuns({ statuses: ACTIVE_AUTOMATION_WORKFLOW_STATUSES });
    } catch (error) {
      this.logControllerError("Could not read the automation workflows.", error);
      return;
    }
    for (const workflow of active) void this.advance(workflow.id);
  }

  private async advanceOnce(workflowRunId: string): Promise<void> {
    for (let guard = 0; guard < MAX_STEPS_PER_ADVANCE; guard += 1) {
      if (this.services.activeWorkers.agentWorkersStopping) return;
      const workflow = this.db.getAutomationWorkflowRun(workflowRunId);
      if (!isAutomationWorkflowRunActive(workflow.status)) return;
      // A check that changes nothing is not saved, so waiting workflows do not refresh every window each tick.
      const unchanged = JSON.stringify(workflow);
      const index = workflow.currentIndex;
      const step = automationWorkflowStepAt(workflow.definition, index);
      const state = workflow.steps[index];
      if (!step || !state) {
        this.finish(workflow, "completed", null);
        return;
      }
      let automation: ProjectAutomationRecord;
      try {
        automation = this.db.getProjectAutomation(workflow.automationId);
      } catch {
        this.pause(workflow, "The automation no longer exists.");
        return;
      }
      if (state.status === "pending" && !automationStepConditionHolds(step.when, workflow.steps)) {
        state.status = "skipped";
        state.finishedAt = new Date().toISOString();
        workflow.currentIndex += 1;
        this.save(workflow);
        continue;
      }
      const starting = state.status === "pending";
      if (starting) {
        state.status = "running";
        state.startedAt = new Date().toISOString();
        state.error = null;
        this.save(workflow);
      }
      const context: AutomationStepContext = {
        workflow, state, step, index, automation,
        save: () => this.saveIfActive(workflow),
        isActive: () => this.isStillActive(workflow.id),
      };
      let progress: AutomationStepProgress;
      try {
        progress = starting ? await this.services.automationSteps.begin(context) : await this.services.automationSteps.check(context);
      } catch (error) {
        if (!this.isStillActive(workflow.id)) return;
        state.status = "failed";
        state.error = errorMessage(error);
        state.finishedAt = new Date().toISOString();
        this.pause(workflow, `${AUTOMATION_STEP_LABELS[step.kind]} (step ${String(index + 1)}): ${state.error}`);
        return;
      }
      // A person may have stopped the workflow while the step was working.
      if (!this.isStillActive(workflow.id)) return;
      if (progress.kind === "pending") {
        state.status = "pending";
        state.startedAt = null;
        workflow.status = "running";
        // The step was saved as running before it began, so the revert has to be saved too.
        this.save(workflow);
        return;
      }
      if (progress.kind === "waiting") {
        state.status = "waiting";
        workflow.status = WAITING_STEP_KINDS.has(step.kind) ? "waiting" : "running";
        if (JSON.stringify(workflow) !== unchanged) this.save(workflow);
        return;
      }
      if (progress.kind === "stop") {
        state.status = "done";
        state.finishedAt = new Date().toISOString();
        state.note = progress.reason;
        this.finish(workflow, "cancelled", progress.reason);
        return;
      }
      state.status = "done";
      state.value = progress.value;
      state.note = progress.note ?? state.note;
      state.finishedAt = new Date().toISOString();
      workflow.currentIndex += 1;
      workflow.status = "running";
      this.save(workflow);
    }
  }

  private isStillActive(workflowRunId: string): boolean {
    try {
      return isAutomationWorkflowRunActive(this.db.getAutomationWorkflowRun(workflowRunId).status);
    } catch {
      return false;
    }
  }

  private saveIfActive(workflow: AutomationWorkflowRun): void {
    if (this.isStillActive(workflow.id)) this.save(workflow);
  }

  private save(workflow: AutomationWorkflowRun): void {
    workflow.updatedAt = new Date().toISOString();
    this.db.saveAutomationWorkflowRun(workflow);
    this.events.publish("automation", { projectId: workflow.projectId, automationId: workflow.automationId, workflowRunId: workflow.id });
  }

  private pause(workflow: AutomationWorkflowRun, reason: string): void {
    workflow.status = "paused";
    workflow.error = reason;
    this.save(workflow);
  }

  private finish(workflow: AutomationWorkflowRun, status: "completed" | "cancelled", reason: string | null): void {
    workflow.status = status;
    workflow.error = reason;
    workflow.finishedAt = new Date().toISOString();
    this.save(workflow);
    this.services.automationTriggers.handleWorkflowFinished(workflow);
  }

  async answerQuestion(input: AnswerAutomationQuestionInput): Promise<AutomationWorkflowRun> {
    const workflow = this.db.getAutomationWorkflowRun(input.workflowRunId);
    const state = workflow.steps[workflow.currentIndex];
    const question = state?.question;
    if (!isAutomationWorkflowRunActive(workflow.status) || !state || state.stepId !== input.stepId || state.status !== "waiting" || !question) {
      throw new Error("This question was already answered or is no longer open.");
    }
    if (question.answer) throw new Error("This question was already answered.");
    const choice = typeof input.choice === "string" ? input.choice.trim() : "";
    if (!question.choices.includes(choice)) throw new Error("Choose one of the offered answers.");
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2_000) : "";
    if (question.requireReason && !reason) throw new Error("This question needs a reason with the answer.");
    question.answer = { choice, reason: reason || null, answeredAt: new Date().toISOString(), timedOut: false };
    this.save(workflow);
    await this.advance(workflow.id);
    return this.db.getAutomationWorkflowRun(workflow.id);
  }

  /** Runs the failed step of a paused workflow again. */
  async retryWorkflowRun(workflowRunId: string): Promise<AutomationWorkflowRun> {
    const workflow = this.db.getAutomationWorkflowRun(workflowRunId);
    if (workflow.status !== "paused") throw new Error("Only a paused workflow can be retried.");
    const state = workflow.steps[workflow.currentIndex];
    if (state) {
      // A failed agent step starts a fresh turn; a run it already finished is kept for later steps.
      const keepRun = state.kind !== "agent" ? state.runId : null;
      workflow.steps[workflow.currentIndex] = { ...createAutomationStepState(state.stepId, state.kind), runId: keepRun, prUrl: state.prUrl };
    }
    workflow.status = "running";
    workflow.error = null;
    this.save(workflow);
    await this.advance(workflow.id);
    return this.db.getAutomationWorkflowRun(workflow.id);
  }

  async cancelWorkflowRun(workflowRunId: string): Promise<AutomationWorkflowRun> {
    const workflow = this.db.getAutomationWorkflowRun(workflowRunId);
    if (workflow.status === "completed" || workflow.status === "cancelled") return workflow;
    const runId = workflow.steps[workflow.currentIndex]?.runId;
    this.finish(workflow, "cancelled", "Stopped by you.");
    if (runId) {
      try {
        if (ACTIVE_RUN_STATUSES.has(this.db.getRun(runId).status)) await this.services.runTurns.cancelRun(runId);
      } catch (error) {
        this.logControllerWarn("Could not stop the run of a cancelled automation workflow.", { workflowRunId, runId, error });
      }
    }
    return this.db.getAutomationWorkflowRun(workflowRunId);
  }

  onRunEnded({ run, waitingForSubagents }: RunEnded): void {
    if (waitingForSubagents || run.kind !== "automation" || !run.automationId) return;
    const owners = this.db.listAutomationWorkflowRuns({ automationId: run.automationId, statuses: ACTIVE_AUTOMATION_WORKFLOW_STATUSES })
      .filter((workflow) => workflow.steps[workflow.currentIndex]?.runId === run.id);
    if (!owners.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (const workflow of owners) void this.advance(workflow.id);
    }, RUN_ENDED_ADVANCE_DELAY_MS);
    timer.unref?.();
    this.timers.add(timer);
  }

  stopWorkflowTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Open questions and paused workflows, for the attention inbox. */
  attentionItems(): AttentionItem[] {
    const settings = parseAttentionInboxSettings(this.db.getSettings()[APP_SETTING_KEYS.attentionInbox]);
    if (!settings.enabled || (!settings.kinds.approval && !settings.kinds.blocked)) return [];
    const workflows = this.db.listAutomationWorkflowRuns({ statuses: ["waiting", "paused"] });
    const projectNames = new Map<string, string | null>();
    const projectName = (projectId: string): string | null => {
      if (!projectNames.has(projectId)) {
        try { projectNames.set(projectId, this.db.getProject(projectId).name); } catch { projectNames.set(projectId, null); }
      }
      return projectNames.get(projectId) ?? null;
    };
    const items: AttentionItem[] = [];
    for (const workflow of workflows) {
      const state = workflow.steps[workflow.currentIndex];
      const runId = workflow.steps.slice(0, workflow.currentIndex + 1).reverse().find((step) => step.runId)?.runId ?? null;
      if (workflow.status === "waiting" && settings.kinds.approval && state?.status === "waiting" && state.question && !state.question.answer) {
        items.push({
          id: `automation-question:${workflow.id}:${state.stepId}`,
          kind: "approval",
          projectId: workflow.projectId,
          projectName: projectName(workflow.projectId),
          runId,
          title: `${workflow.automationName}: ${state.question.title}`,
          detail: state.question.detail || "Answer to let the automation continue.",
          createdAt: state.question.askedAt,
          dismissible: false,
          automationQuestion: {
            workflowRunId: workflow.id,
            automationId: workflow.automationId,
            stepId: state.stepId,
            choices: state.question.choices,
            requireReason: state.question.requireReason,
          },
        });
      } else if (workflow.status === "paused" && settings.kinds.blocked) {
        items.push({
          id: `automation-paused:${workflow.id}:${workflow.updatedAt}`,
          kind: "blocked",
          projectId: workflow.projectId,
          projectName: projectName(workflow.projectId),
          runId,
          title: `${workflow.automationName} is paused`,
          detail: workflow.error ?? "Retry the step or stop the workflow on the Automations page.",
          createdAt: workflow.updatedAt,
          dismissible: false,
        });
      }
    }
    return items;
  }

  onAutomationWorkflowChanged(listener: (payload: AutomationWorkflowChangedPayload) => void): () => void {
    return this.events.subscribe("automation", listener);
  }
}
