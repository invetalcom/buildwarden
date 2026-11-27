import {
  type AutomationTrigger,
  type AutomationWorkflowRun,
  type AutomationWorkflowTriggerInfo,
  type ProjectAutomationRecord,
} from "@buildwarden/shared";
import { handledMissingFromPass, planForgeIssueAutomation } from "../forge-issues/forge-issue-automation";
import { AppService } from "./app-service";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";
import { latestRunAnswerText } from "./run-step-content";

/** Git host lists are read this often per automation. */
const FORGE_TRIGGER_INTERVAL_MS = 2 * 60_000;
/** A mass labelling or a burst of pull requests starts a few runs per check, not dozens. */
const MAX_STARTS_PER_CHECK = 3;
const MAX_UPSTREAM_ANSWER_CHARS = 6_000;

interface IssueTriggerState {
  kind: "issue-labelled";
  label: string;
  /** Issues already started for, or already labelled when the trigger was saved. */
  handled: number[];
  listReadAt: string | null;
  /** Still recording the issues that carried the label before the trigger existed. */
  baselining: boolean;
}

interface PullRequestTriggerState {
  kind: "pr-opened";
  /** Highest request number seen; only newer ones start the automation. */
  highest: number;
}

interface FinishedTriggerState {
  kind: "automation-finished";
  /** The upstream run or workflow that started this automation last, so one finish starts it once. */
  lastUpstreamKey: string;
}

type TriggerState = IssueTriggerState | PullRequestTriggerState | FinishedTriggerState;

const emptyTriggerInfo = (kind: AutomationWorkflowTriggerInfo["kind"], label: string): AutomationWorkflowTriggerInfo => ({
  kind, label, context: null, issueNumber: null, prUrl: null, prNumber: null, upstreamAutomationId: null, upstreamRunId: null, untrusted: false,
});

export const automationTriggerInfo = emptyTriggerInfo;

/** Starts automations when an issue gets a label, a pull request opens, or another automation finishes. */
export class AutomationTriggerService extends AppService<"activeWorkers" | "automations" | "automationWorkflows" | "forgeIssueActions" | "forgeRequests">
  implements RunEndedListener {
  private tickActive = false;
  private readonly checkedAt = new Map<string, number>();

  private readState(automation: ProjectAutomationRecord): TriggerState | null {
    const stored = this.db.getProjectAutomationTriggerState(automation.id);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as TriggerState;
      return parsed.kind === automation.trigger.kind ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeState(automationId: string, state: TriggerState): void {
    this.db.setProjectAutomationTriggerState(automationId, JSON.stringify(state));
  }

  async runTriggerTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.tickActive || this.services.automations.startupReviewPending) return;
    this.tickActive = true;
    try {
      const now = Date.now();
      for (const automation of this.db.listProjectAutomations()) {
        if (this.services.activeWorkers.agentWorkersStopping) break;
        const { trigger } = automation;
        if (!automation.enabled || (trigger.kind !== "issue-labelled" && trigger.kind !== "pr-opened")) continue;
        if (now - (this.checkedAt.get(automation.id) ?? 0) < FORGE_TRIGGER_INTERVAL_MS) continue;
        this.checkedAt.set(automation.id, now);
        try {
          if (trigger.kind === "issue-labelled") await this.checkLabelledIssues(automation, trigger.label);
          else await this.checkOpenedPullRequests(automation, trigger.targetBranch);
        } catch (error) {
          this.logControllerWarn("Could not check an automation's trigger.", { automationId: automation.id, error });
          this.db.setProjectAutomationError(automation.id, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      // Nobody awaits the tick, so a rejection would end the app. The next tick tries again.
      this.logControllerError("Could not read the automation triggers.", error);
    } finally {
      this.tickActive = false;
    }
  }

  private async checkLabelledIssues(automation: ProjectAutomationRecord, label: string): Promise<void> {
    if (this.db.getProject(automation.projectId).kind !== "git" || !label.trim()) return;
    const forgeIssues = this.services.forgeIssueActions.forgeIssues;
    const { issues, pass } = await forgeIssues.listOpenIssuesWithLabel(automation.projectId, label);
    const labelled = issues.map((issue) => issue.number);
    const stored = this.readState(automation);
    const state: IssueTriggerState = stored?.kind === "issue-labelled" && stored.label === label
      ? stored
      : { kind: "issue-labelled", label, handled: [], listReadAt: null, baselining: true };
    if (state.baselining) {
      // Issues that carried the label before the trigger was saved do not start it.
      state.handled = [...new Set([...state.handled, ...labelled])];
      state.baselining = pass === null;
      state.listReadAt = pass ? new Date(pass.startedAt).toISOString() : state.listReadAt;
      this.writeState(automation.id, state);
      return;
    }
    const missing = handledMissingFromPass(state.handled, pass);
    const confirmedUnlabelled = missing.length ? await forgeIssues.confirmLabelRemoved(automation.projectId, label, missing) : [];
    const plan = planForgeIssueAutomation({
      labelled,
      pass: pass ? { labelled: pass.labelled, startedAt: new Date(pass.startedAt).toISOString() } : null,
      confirmedUnlabelled,
      runs: this.db.listAutomationWorkflowRuns({ automationId: automation.id, limit: 200 })
        .filter((workflow) => workflow.trigger.issueNumber !== null)
        .map((workflow) => ({ issueNumber: workflow.trigger.issueNumber ?? 0, createdAt: workflow.createdAt })),
      handled: state.handled,
      listReadAt: state.listReadAt,
    });
    state.handled = plan.handled;
    state.listReadAt = plan.listReadAt;
    this.writeState(automation.id, state);
    for (const issueNumber of plan.pending.slice(0, MAX_STARTS_PER_CHECK)) {
      if (this.services.activeWorkers.agentWorkersStopping) return;
      const issue = issues.find((entry) => entry.number === issueNumber);
      // Remembered before the start, so a failing start cannot start it twice.
      state.handled.push(issueNumber);
      this.writeState(automation.id, state);
      await this.services.automations.startTriggeredAutomation(automation.id, {
        ...emptyTriggerInfo("issue-labelled", `Issue #${String(issueNumber)} got "${label}"`),
        issueNumber,
        context: issue ? `This automation started because issue #${String(issueNumber)} "${issue.title}" got the label "${label}".` : null,
        untrusted: true,
      });
    }
  }

  private async checkOpenedPullRequests(automation: ProjectAutomationRecord, targetBranch: string | null): Promise<void> {
    if (this.db.getProject(automation.projectId).kind !== "git") return;
    const { items } = await this.services.forgeRequests.listProjectForgeRequests(automation.projectId, { state: "open" });
    const stored = this.readState(automation);
    const highestOpen = items.reduce((highest, item) => Math.max(highest, item.number), 0);
    if (stored?.kind !== "pr-opened") {
      // Requests that were open before the trigger was saved do not start it.
      this.writeState(automation.id, { kind: "pr-opened", highest: highestOpen });
      return;
    }
    const fresh = items.filter((item) => item.number > stored.highest).sort((left, right) => left.number - right.number);
    let started = 0;
    for (const request of fresh) {
      if (started >= MAX_STARTS_PER_CHECK || this.services.activeWorkers.agentWorkersStopping) return;
      // Remembered before the start, so a failing start cannot start it twice.
      this.writeState(automation.id, { kind: "pr-opened", highest: request.number });
      if (targetBranch && request.targetBranch !== targetBranch) continue;
      started += 1;
      await this.services.automations.startTriggeredAutomation(automation.id, {
        ...emptyTriggerInfo("pr-opened", `Pull request #${String(request.number)} opened`),
        prUrl: request.url,
        prNumber: request.number,
        context: [
          `This automation started because pull request #${String(request.number)} was opened.`,
          `Title: ${request.title}`,
          `URL: ${request.url}`,
          request.author ? `Author: ${request.author}` : "",
          `Branches: ${request.sourceBranch} into ${request.targetBranch}`,
          "Fetch the pull request's branch yourself if you need its changes; your workspace starts from the automation's branch.",
        ].filter(Boolean).join("\n"),
        untrusted: true,
      });
    }
  }

  /** A run of an automation without steps finished its turn. */
  onRunEnded({ run, status, waitingForSubagents }: RunEnded): void {
    if (waitingForSubagents || run.kind !== "automation" || !run.automationId) return;
    if (this.services.automationWorkflows.ownsRun(run)) return;
    let answer = "";
    try { answer = latestRunAnswerText(this.db.getRunSteps(run.id)); } catch { /* the run was deleted */ }
    this.startDownstream(run.projectId, run.automationId, status === "completed" ? "completed" : "failed", `run:${run.id}`, run.id, answer);
  }

  handleWorkflowFinished(workflow: AutomationWorkflowRun): void {
    const lastRunId = [...workflow.steps].reverse().find((step) => step.runId)?.runId ?? null;
    let answer = "";
    if (lastRunId) {
      try { answer = latestRunAnswerText(this.db.getRunSteps(lastRunId)); } catch { /* the run was deleted */ }
    }
    this.startDownstream(
      workflow.projectId,
      workflow.automationId,
      workflow.status === "completed" ? "completed" : "failed",
      `workflow:${workflow.id}`,
      lastRunId,
      answer,
    );
  }

  private startDownstream(projectId: string, upstreamId: string, outcome: "completed" | "failed", key: string, runId: string | null, answer: string): void {
    let upstreamName = "another automation";
    try { upstreamName = `"${this.db.getProjectAutomation(upstreamId).name}"`; } catch { /* deleted meanwhile */ }
    const downstream = this.db.listProjectAutomations(projectId).filter((automation) => {
      const trigger: AutomationTrigger = automation.trigger;
      return Boolean(automation.enabled) && trigger.kind === "automation-finished" && trigger.automationId === upstreamId &&
        (trigger.outcome === "any" || trigger.outcome === outcome);
    });
    for (const automation of downstream) {
      const stored = this.readState(automation);
      if (stored?.kind === "automation-finished" && stored.lastUpstreamKey === key) continue;
      this.writeState(automation.id, { kind: "automation-finished", lastUpstreamKey: key });
      const clipped = answer.length > MAX_UPSTREAM_ANSWER_CHARS ? `${answer.slice(0, MAX_UPSTREAM_ANSWER_CHARS)}\n[…]` : answer;
      void this.services.automations.startTriggeredAutomation(automation.id, {
        ...emptyTriggerInfo("automation-finished", `After ${upstreamName} ${outcome === "completed" ? "completed" : "failed"}`),
        upstreamAutomationId: upstreamId,
        upstreamRunId: runId,
        context: [
          `This automation started because the automation ${upstreamName} ${outcome === "completed" ? "completed" : "failed or was stopped"}.`,
          clipped ? `Its final answer:\n${clipped}` : "",
        ].filter(Boolean).join("\n\n"),
      }).catch((error: unknown) => {
        this.logControllerWarn("Could not start an automation after another one finished.", { automationId: automation.id, error });
      });
    }
  }
}
