import {
  AUTOMATION_PROMPT_STEP_ID,
  AUTOMATION_STEP_LABELS,
  automationCheckInstruction,
  automationStepValueLabel,
  isCouncilRoundActive,
  parseAutomationCheckAnswer,
  type AutomationStepDefinition,
  type AutomationWorkflowRun,
  type AutomationWorkflowStepState,
  type ProjectAutomationRecord,
  type ProjectForgeRequestSummary,
  type RunFollowUpOptions,
  type RunRecord,
} from "@buildwarden/shared";
import { randomUUID } from "node:crypto";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { resolveRunForgeSourceRepository } from "../run-forge-source";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";
import { latestRunAnswerText, parseMetadataRecord } from "./run-step-content";

/** The prompt step as the engine sees it: an agent step whose prompt is the automation's own. */
type AutomationPromptStep = { id: typeof AUTOMATION_PROMPT_STEP_ID; kind: "agent"; when: null; check: string | null };
type AutomationResolvedStep = AutomationStepDefinition | AutomationPromptStep;

export interface AutomationStepContext {
  workflow: AutomationWorkflowRun;
  state: AutomationWorkflowStepState;
  step: AutomationResolvedStep;
  index: number;
  automation: ProjectAutomationRecord;
  /** Saves the workflow as it is now, e.g. right after a run was started. */
  save(): void;
  /** False once a person stopped the workflow; nothing may start for it after that. */
  isActive(): boolean;
}

export type AutomationStepProgress =
  /** The step could not start yet, e.g. its run is still busy; it is tried again later. */
  | { kind: "pending" }
  | { kind: "waiting" }
  | { kind: "done"; value: string; note?: string | null }
  /** Ends the workflow on purpose, e.g. a question nobody answered in time. */
  | { kind: "stop"; reason: string };

const PR_POLL_INTERVAL_MS = 60_000;
const MAX_CONTEXT_ANSWER_CHARS = 4_000;
const WAITING: AutomationStepProgress = { kind: "waiting" };
const PENDING: AutomationStepProgress = { kind: "pending" };
const done = (value: string, note?: string | null): AutomationStepProgress => ({ kind: "done", value, note: note ?? null });

/** An open request an interrupted attempt already made: same branch, same target, and the same fork when both are known. */
export const findRecoverablePullRequest = (
  items: readonly ProjectForgeRequestSummary[],
  wanted: { sourceBranch: string; targetBranch: string; sourceRepository: string | null },
): ProjectForgeRequestSummary | undefined => items.find((item) =>
  item.sourceBranch === wanted.sourceBranch && item.targetBranch === wanted.targetBranch &&
  (!wanted.sourceRepository || !item.sourceRepository || item.sourceRepository === wanted.sourceRepository));

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}\n[…]` : value);

/** What earlier steps decided, so later agents know about answers and links. */
const describeEarlierAutomationSteps = (workflow: AutomationWorkflowRun, index: number): string | null => {
  const lines = workflow.steps.slice(0, index).flatMap((state) => {
    if (state.status !== "done" || state.stepId === AUTOMATION_PROMPT_STEP_ID && !state.value) return [];
    const step = state.stepId === AUTOMATION_PROMPT_STEP_ID ? null : workflow.definition.steps.find((entry) => entry.id === state.stepId);
    const label = step?.kind === "ask" ? `Asked "${step.title}"` : AUTOMATION_STEP_LABELS[state.kind];
    const value = state.value ? automationStepValueLabel(state.value) : "";
    const detail = [value, state.note, state.prUrl && state.prUrl !== state.note ? state.prUrl : null].filter(Boolean).join(" — ");
    return detail && value !== "Finished" ? [`- ${label}: ${detail}`] : [];
  });
  if (!lines.length) return null;
  return ["<automation_context>", `Earlier steps of the automation "${workflow.automationName}":`, ...lines, "</automation_context>"].join("\n");
};

/** Runs the individual steps of automation workflows. The workflow service decides which step is next. */
export class AutomationStepService extends AppService<
  | "council"
  | "forgeIssueActions"
  | "forgeRequests"
  | "runBranches"
  | "runForge"
  | "runLifecycle"
  | "runTurns"
  | "verification"
  | "workspaceGuard"
> {
  async begin(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { step, state } = context;
    switch (step.kind) {
      case "agent": return this.beginAgent(context);
      case "ask":
        state.question = {
          title: step.title,
          detail: step.detail,
          choices: [...step.choices],
          requireReason: step.requireReason,
          askedAt: new Date().toISOString(),
          expiresAt: step.timeoutHours === null ? null : new Date(Date.now() + step.timeoutHours * 3_600_000).toISOString(),
          answer: null,
        };
        return WAITING;
      case "council": return this.beginCouncil(context);
      case "verify": return this.verify(context);
      case "open-pr": return this.openPullRequest(context);
      case "wait-pr":
        state.waitUntil = new Date(Date.now() + step.timeoutHours * 3_600_000).toISOString();
        return this.checkPullRequest(context);
      case "merge-pr": return this.mergePullRequest(context);
      case "wait":
        state.waitUntil = new Date(Date.now() + step.minutes * 60_000).toISOString();
        return WAITING;
    }
  }

  /** Looks at a step that already started. Steps that finish in one go are started again after a restart. */
  async check(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { step, state } = context;
    switch (step.kind) {
      case "agent": return this.checkAgent(context);
      case "ask": return this.checkQuestion(context);
      case "council": return state.councilRoundId ? this.checkCouncil(context) : this.beginCouncil(context);
      case "verify": return this.verify(context);
      case "open-pr": return state.prUrl ? done("opened", state.prUrl) : this.openPullRequest(context);
      case "wait-pr": return this.checkPullRequest(context);
      case "merge-pr": return this.mergePullRequest(context);
      case "wait": return state.waitUntil && Date.now() >= Date.parse(state.waitUntil) ? done("done") : WAITING;
    }
  }

  /** The latest run an earlier step started or worked on. */
  private latestRunId(context: AutomationStepContext): string | null {
    for (let index = context.index - 1; index >= 0; index -= 1) {
      const runId = context.workflow.steps[index]?.runId;
      if (runId) return runId;
    }
    return null;
  }

  private latestPullRequest(context: AutomationStepContext): { runId: string; prUrl: string } {
    for (let index = context.index - 1; index >= 0; index -= 1) {
      const state = context.workflow.steps[index];
      if (state?.prUrl && state.runId) return { runId: state.runId, prUrl: state.prUrl };
    }
    throw new Error("No pull request was opened by an earlier step.");
  }

  private requireWorkRun(context: AutomationStepContext): RunRecord {
    const runId = this.latestRunId(context);
    if (!runId) throw new Error("This step needs an agent step before it.");
    return this.db.getRun(runId);
  }

  /** A run that is busy, or whose council review is still working, must not be touched yet. */
  private isRunBusy(run: RunRecord): boolean {
    if (ACTIVE_RUN_STATUSES.has(run.status)) return true;
    const latest = this.db.listCouncilRounds(run.id).at(-1);
    return Boolean(latest && isCouncilRoundActive(latest));
  }

  private effortOptions(automation: ProjectAutomationRecord): Pick<RunFollowUpOptions, "reasoningEffort" | "anthropicEffort" | "executionOptions"> {
    const hasExecutionOptions = Object.keys(automation.executionOptions).length > 0;
    return {
      reasoningEffort: hasExecutionOptions ? automation.executionOptions.reasoningEffort : automation.effort,
      anthropicEffort: hasExecutionOptions ? automation.executionOptions.anthropicEffort : automation.effort,
      executionOptions: hasExecutionOptions ? automation.executionOptions : undefined,
    };
  }

  private agentPrompt(context: AutomationStepContext, base: string): string {
    const { workflow, step, index } = context;
    const parts = [base.trim()];
    if (index === 0 && workflow.trigger.context) parts.push(`<automation_trigger>\n${workflow.trigger.context}\n</automation_trigger>`);
    const earlier = index > 0 ? describeEarlierAutomationSteps(workflow, index) : null;
    if (earlier) parts.push(earlier);
    if (step.kind === "agent" && step.check) parts.push(automationCheckInstruction(step.check));
    return parts.filter(Boolean).join("\n\n");
  }

  private async beginAgent(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { automation, workflow, state, step, index } = context;
    if (step.kind !== "agent") throw new Error("Not an agent step.");
    const isPrompt = step.id === AUTOMATION_PROMPT_STEP_ID;
    const yoloMode = !workflow.trigger.untrusted;
    const previousRunId = !isPrompt && "workspace" in step && step.workspace === "continue" ? this.latestRunId(context) : null;
    const prompt = this.agentPrompt(context, isPrompt ? automation.prompt : "prompt" in step ? step.prompt : "");
    if (previousRunId) {
      const previous = this.db.getRun(previousRunId);
      if (this.isRunBusy(previous) || !context.isActive()) return PENDING;
      const turnMarker = randomUUID();
      await this.services.runTurns.followUpRunInternal(
        previousRunId,
        prompt,
        { mode: "code", modelId: automation.modelId, yoloMode, ...this.effortOptions(automation) },
        { source: "automation", automationWorkflowRunId: workflow.id, automationStepIndex: index, automationTurnMarker: turnMarker },
        { background: true },
      );
      state.turnMarker = turnMarker;
      if (await this.stopIfWorkflowStopped(context, previousRunId)) return PENDING;
      state.runId = previousRunId;
      context.save();
      return WAITING;
    }
    const model = this.db.getModel(automation.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const project = this.db.getProject(automation.projectId);
    let attachments = isPrompt ? automation.attachments : [];
    let runPrompt = prompt;
    let forgeIssue;
    if (isPrompt && workflow.trigger.issueNumber !== null) {
      const issue = await this.services.forgeIssueActions.prepareForgeIssueAutomationContext(project.id, workflow.trigger.issueNumber);
      attachments = [...attachments, issue.attachment];
      runPrompt = `${prompt}\n\n${issue.prompt}`;
      forgeIssue = issue.reference;
    }
    // Reading the issue takes a moment; a workflow stopped meanwhile starts nothing.
    if (!context.isActive()) return PENDING;
    const run = await this.services.runLifecycle.createRun({
      projectId: automation.projectId,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: getHarnessTypeForProvider(provider.providerType),
      mode: "code",
      yoloMode,
      untrustedInput: workflow.trigger.untrusted,
      workspaceType: project.kind === "git" ? "worktree" : "copy",
      baseBranch: project.kind === "git" ? automation.baseBranch ?? project.baseBranch : undefined,
      prompt: runPrompt,
      attachments,
      ...this.effortOptions(automation),
      kind: "automation",
      automationId: automation.id,
      ...(forgeIssue ? { forgeIssue } : {}),
    }, { background: true });
    if (await this.stopIfWorkflowStopped(context, run.id)) return PENDING;
    state.runId = run.id;
    context.save();
    if (isPrompt) {
      this.events.publish("automationStarted", {
        automationId: automation.id,
        automationName: automation.name,
        projectId: project.id,
        projectName: project.name,
        runId: run.id,
        startedAt: run.startedAt ?? run.createdAt,
      });
    }
    return WAITING;
  }

  private async checkAgent(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { state, step, automation, workflow } = context;
    if (step.kind !== "agent") throw new Error("Not an agent step.");
    if (!state.runId) throw new Error("BuildWarden stopped while this step was starting. Retry the step.");
    const run = this.db.getRun(state.runId);
    if (ACTIVE_RUN_STATUSES.has(run.status)) return WAITING;
    const orchestration = this.db.getOrchestrationByCoordinatorRunId(run.id);
    if (orchestration && ["active", "waiting", "paused", "attention"].includes(orchestration.status)) return WAITING;
    if (run.status !== "completed") {
      throw new Error(run.errorMessage?.trim() || (run.status === "cancelled" ? "The agent run was stopped." : "The agent run failed."));
    }
    if (!step.check) return done("done");
    const answer = parseAutomationCheckAnswer(latestRunAnswerText(this.currentTurnSteps(run.id, state.turnMarker ?? null)));
    if (answer) return done(answer, step.check);
    if (state.checkReminded) throw new Error("The agent did not answer the step's question with ANSWER: yes or ANSWER: no.");
    if (!context.isActive()) return WAITING;
    const turnMarker = randomUUID();
    state.checkReminded = true;
    state.turnMarker = turnMarker;
    context.save();
    await this.services.runTurns.followUpRunInternal(
      run.id,
      `Answer this question about your work with exactly one line, \`ANSWER: yes\` or \`ANSWER: no\`:\n${step.check}`,
      { mode: "ask", modelId: automation.modelId, yoloMode: false },
      { source: "automation", automationWorkflowRunId: workflow.id, automationCheckReminder: true, automationTurnMarker: turnMarker },
      { background: true },
    );
    await this.stopIfWorkflowStopped(context, run.id);
    return WAITING;
  }

  /**
   * The steps of the turn this step sent. A step that started the run reads the whole run; one that continued a
   * run reads only what came after its prompt, so an earlier turn's answer never answers this step.
   */
  private currentTurnSteps(runId: string, turnMarker: string | null) {
    const steps = this.db.getRunSteps(runId);
    if (!turnMarker) return steps;
    const promptIndex = steps.findLastIndex((entry) => entry.eventType === "log" && parseMetadataRecord(entry.metadataJson).automationTurnMarker === turnMarker);
    return promptIndex < 0 ? [] : steps.slice(promptIndex + 1);
  }

  /** A turn that started after a person stopped the workflow is stopped too, instead of running unwatched. */
  private async stopIfWorkflowStopped(context: AutomationStepContext, runId: string): Promise<boolean> {
    if (context.isActive()) return false;
    try {
      await this.services.runTurns.cancelRun(runId);
    } catch (error) {
      this.logControllerWarn("Could not stop a run that started after its automation workflow was stopped.", { runId, error });
    }
    return true;
  }

  private checkQuestion({ state, step }: AutomationStepContext): AutomationStepProgress {
    const question = state.question;
    if (!question || step.kind !== "ask") throw new Error("This question was not asked. Retry the step.");
    if (question.answer) return done(question.answer.choice, question.answer.reason);
    if (!question.expiresAt || Date.now() < Date.parse(question.expiresAt)) return WAITING;
    if (!step.timeoutChoice) return { kind: "stop", reason: `Nobody answered "${question.title}" in time.` };
    question.answer = { choice: step.timeoutChoice, reason: null, answeredAt: new Date().toISOString(), timedOut: true };
    return done(step.timeoutChoice, "No answer in time");
  }

  private async beginCouncil(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const run = this.requireWorkRun(context);
    if (ACTIVE_RUN_STATUSES.has(run.status)) return PENDING;
    const latest = this.db.listCouncilRounds(run.id).at(-1);
    // A round the council started on its own after the run is reused instead of starting a second one.
    const round = latest && isCouncilRoundActive(latest) ? latest : await this.services.council.startCouncil(run.id);
    context.state.runId = run.id;
    context.state.councilRoundId = round.id;
    context.save();
    return this.checkCouncil(context);
  }

  private async checkCouncil(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { state, step } = context;
    if (step.kind !== "council" || !state.councilRoundId) throw new Error("The council review was not started. Retry the step.");
    const round = this.db.getCouncilRound(state.councilRoundId);
    if (isCouncilRoundActive(round)) return WAITING;
    if (round.status === "applied") return done(step.fixFindings ? "fixed" : "issues", `${String(round.appliedGroupIds.length)} findings fixed`);
    if (round.status !== "ready") throw new Error(round.error?.trim() || "The council review could not finish.");
    const recommended = round.groups.filter((group) => group.decision === "recommended" && !round.appliedGroupIds.includes(group.id));
    if (!recommended.length) return done("clean", round.groups.length ? `${String(round.groups.length)} findings, none recommended` : null);
    if (!step.fixFindings) return done("issues", `${String(recommended.length)} recommended findings`);
    await this.services.council.applyCouncilFindings(round.id, recommended.map((group) => group.id));
    return WAITING;
  }

  private async verify(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const run = this.requireWorkRun(context);
    if (this.isRunBusy(run)) return PENDING;
    context.state.runId = run.id;
    const result = await this.services.verification.verifyRunRevision(run.id);
    if (result.status === "passed") return done("passed");
    if (result.status === "failed") return done("failed", result.reason);
    throw new Error(result.reason?.trim() || `Verification ended as "${result.status}".`);
  }

  private async openPullRequest(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { automation, step } = context;
    if (step.kind !== "open-pr") throw new Error("Not a pull request step.");
    const run = this.requireWorkRun(context);
    if (this.isRunBusy(run)) return PENDING;
    this.services.workspaceGuard.requireGitRun(run, "Opening a pull request");
    const project = this.db.getProject(run.projectId);
    const targetBranch = automation.baseBranch ?? project.baseBranch;
    const title = step.title.trim() || automation.name;
    const summary = await this.services.workspaceGuard.serializeProjectBranchMutation(project.id, async (): Promise<ProjectForgeRequestSummary | null> => {
      const current = this.db.getRun(run.id);
      if (current.workspaceType === "worktree") await this.gitService.checkoutWorktreeBranch(current.worktreePath, current.branchName);
      if (await this.gitService.hasChanges(current.worktreePath)) await this.services.runBranches.commitRunUnlocked(current.id, title);
      const pullRequestContext = await this.gitService.getPullRequestContext(current.worktreePath, targetBranch);
      if (!pullRequestContext.diff.trim()) return null;
      await this.services.verification.requireVerifiedRevision(current.id);
      await this.gitService.publishBranch(current.worktreePath, current.branchName);
      const forge = await this.services.forgeRequests.createProjectPrReviewProvider(project.id);
      const answer = latestRunAnswerText(this.db.getRunSteps(current.id)).trim();
      const description = this.services.forgeIssueActions.withForgeIssueClosingReference(current, [
        answer ? clip(answer, MAX_CONTEXT_ANSWER_CHARS) : current.prompt,
        "",
        "---",
        `Opened by the BuildWarden automation "${automation.name}".`,
      ].join("\n"));
      try {
        return await forge.createRequest({ sourceBranch: current.branchName, targetBranch, title, description });
      } catch (error) {
        // An interrupted earlier attempt may have opened it already. Only the same branch, target and fork counts.
        const sourceRepository = await resolveRunForgeSourceRepository(this.gitService, current.worktreePath, current.branchName, forge)
          .catch(() => null);
        const { items } = await forge.listRequests({ state: "open", sourceBranch: current.branchName });
        const existing = findRecoverablePullRequest(items, { sourceBranch: current.branchName, targetBranch, sourceRepository });
        if (!existing) throw error;
        return existing;
      }
    });
    context.state.runId = run.id;
    if (!summary) return done("no-changes");
    context.state.prUrl = summary.url;
    context.save();
    await this.services.runForge.syncRunForgeRequest(run.id, true, true, summary.url).catch((error: unknown) => {
      this.logControllerWarn("Could not link an automation pull request to its run.", { runId: run.id, error });
    });
    return done("opened", summary.url);
  }

  private async checkPullRequest(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { state, step } = context;
    if (step.kind !== "wait-pr") throw new Error("Not a pull request wait.");
    const { runId, prUrl } = this.latestPullRequest(context);
    state.runId = runId;
    state.prUrl = prUrl;
    const timedOut = state.waitUntil !== null && Date.now() >= Date.parse(state.waitUntil);
    if (!timedOut && state.polledAt && Date.now() - Date.parse(state.polledAt) < PR_POLL_INTERVAL_MS) return WAITING;
    state.polledAt = new Date().toISOString();
    const summary = await this.services.runForge.syncRunForgeRequest(runId, true, true, prUrl);
    if (summary?.state === "merged") return done("merged");
    if (summary?.state === "closed") return done("closed");
    if (summary && step.until === "checks" && summary.statusLastSyncedAt) {
      const { checks } = summary;
      const settled = checks.running === 0 && checks.completed >= checks.total;
      if (settled) return done(checks.failed > 0 ? "failing" : "passing", `${String(checks.successful)}/${String(checks.total)} checks passed`);
    }
    return timedOut ? done("timeout") : WAITING;
  }

  private async mergePullRequest(context: AutomationStepContext): Promise<AutomationStepProgress> {
    const { step, state } = context;
    if (step.kind !== "merge-pr") throw new Error("Not a merge step.");
    const { runId, prUrl } = this.latestPullRequest(context);
    state.runId = runId;
    state.prUrl = prUrl;
    const summary = await this.services.runForge.syncRunForgeRequest(runId, true, true, prUrl);
    if (!summary) throw new Error("The pull request could not be read.");
    if (summary.state === "merged") return done("merged", summary.url);
    const method = summary.supportedMergeMethods.includes(step.method) ? step.method : summary.supportedMergeMethods[0];
    if (!method) throw new Error("This repository allows no merge method BuildWarden can use.");
    if (!summary.headSha) throw new Error("The pull request's head commit is unknown. Try again later.");
    await this.services.runForge.mergeRunForgeRequest(runId, { method, expectedHeadSha: summary.headSha });
    return done("merged", summary.url);
  }
}
