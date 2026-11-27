import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { AutomationStepDefinition, AutomationWorkflowDefinition, ProjectAutomationRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEventBus } from "./host-events";
import { AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";
import { AutomationStepService, type AutomationStepContext, type AutomationStepProgress } from "./services/automation-step-service";
import { automationTriggerInfo } from "./services/automation-trigger-service";
import { AutomationWorkflowService } from "./services/automation-workflow-service";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Agent steps finish at once with a scripted value; every other step runs for real. */
class ScriptedSteps extends AutomationStepService {
  agentResults: Array<AutomationStepProgress | Error> = [];
  agentStarts = 0;

  override async begin(context: AutomationStepContext): Promise<AutomationStepProgress> {
    if (context.step.kind !== "agent") return super.begin(context);
    this.agentStarts += 1;
    context.state.runId = `run-${String(this.agentStarts)}`;
    return this.nextAgentResult();
  }

  override async check(context: AutomationStepContext): Promise<AutomationStepProgress> {
    return context.step.kind === "agent" ? this.nextAgentResult() : super.check(context);
  }

  private nextAgentResult(): AutomationStepProgress {
    const next = this.agentResults.shift() ?? { kind: "done", value: "done" };
    if (next instanceof Error) throw next;
    return next;
  }
}

const setup = async (workflow: AutomationWorkflowDefinition) => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-automation-workflow-"));
  tempDirs.push(directory);
  const db = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await db.init();
  databases.push(db);
  const project = db.addProject({ repoPath: join(directory, "repo"), baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  const automation: ProjectAutomationRecord = db.createProjectAutomation(project.id, {
    name: "Dependencies", prompt: "Check dependencies", cronExpression: "0 9 * * 1", modelId: model.id, workspaceType: "worktree",
    trigger: { kind: "manual" }, workflow,
  }, "2026-12-01T09:00:00.000Z", "UTC");
  const context = new AppServiceContext(db, {} as never, directory, {} as never, { killForRunId: vi.fn() }, new HostEventBus());
  const services = {
    activeWorkers: { agentWorkersStopping: false },
    automationTriggers: { handleWorkflowFinished: vi.fn() },
    runTurns: { cancelRun: vi.fn() },
  } as unknown as AppServices;
  const steps = new ScriptedSteps(context, services);
  const workflows = new AutomationWorkflowService(context, services);
  Object.assign(services, { automationSteps: steps, automationWorkflows: workflows });
  return { db, automation, steps, workflows, services };
};

const askStep = (overrides: Partial<Extract<AutomationStepDefinition, { kind: "ask" }>> = {}): AutomationStepDefinition => ({
  id: "approve", when: { stepId: "prompt", equals: "yes" }, kind: "ask", title: "Upgrade them?", detail: "", choices: ["Upgrade", "Skip"],
  requireReason: false, timeoutHours: null, timeoutChoice: null, ...overrides,
});
const upgradeStep: AutomationStepDefinition = {
  id: "upgrade", when: { stepId: "approve", equals: "Upgrade" }, kind: "agent", prompt: "Upgrade them", workspace: "continue", check: null,
};

describe("automation workflows", () => {
  it("waits for an answer, then runs only the steps whose condition holds", async () => {
    const { automation, steps, workflows, services } = await setup({ check: "Outdated?", steps: [askStep(), upgradeStep] });
    steps.agentResults = [{ kind: "done", value: "yes" }, { kind: "done", value: "done" }];
    const started = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    expect(started).toMatchObject({ status: "waiting", currentIndex: 1 });
    expect(started.steps[0]).toMatchObject({ status: "done", value: "yes", runId: "run-1" });
    expect(started.steps[1]?.question).toMatchObject({ title: "Upgrade them?", choices: ["Upgrade", "Skip"], answer: null });

    const [question] = workflows.attentionItems();
    expect(question).toMatchObject({ kind: "approval", dismissible: false, automationQuestion: { workflowRunId: started.id, stepId: "approve" } });

    await expect(workflows.answerQuestion({ workflowRunId: started.id, stepId: "approve", choice: "Maybe" })).rejects.toThrow("Choose one of the offered answers.");
    const finished = await workflows.answerQuestion({ workflowRunId: started.id, stepId: "approve", choice: "Upgrade" });
    expect(finished.status).toBe("completed");
    expect(finished.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
    expect(steps.agentStarts).toBe(2);
    expect(workflows.attentionItems()).toEqual([]);
    expect(vi.mocked(services.automationTriggers.handleWorkflowFinished)).toHaveBeenCalledOnce();
  });

  it("skips a question whose condition does not hold", async () => {
    const { automation, steps, workflows } = await setup({ check: "Outdated?", steps: [askStep(), upgradeStep] });
    steps.agentResults = [{ kind: "done", value: "no" }];
    const finished = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    expect(finished.status).toBe("completed");
    expect(finished.steps.map((step) => step.status)).toEqual(["done", "skipped", "skipped"]);
    expect(steps.agentStarts).toBe(1);
  });

  it("needs a reason when the question asks for one", async () => {
    const { automation, steps, workflows } = await setup({ check: "Outdated?", steps: [askStep({ requireReason: true })] });
    steps.agentResults = [{ kind: "done", value: "yes" }];
    const started = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    await expect(workflows.answerQuestion({ workflowRunId: started.id, stepId: "approve", choice: "Skip" })).rejects.toThrow("needs a reason");
    const finished = await workflows.answerQuestion({ workflowRunId: started.id, stepId: "approve", choice: "Skip", reason: "Not now" });
    expect(finished.steps[1]).toMatchObject({ status: "done", value: "Skip", note: "Not now" });
  });

  it("uses the timeout answer, or stops when there is none", async () => {
    const { automation, steps, workflows, db } = await setup({ check: null, steps: [askStep({ when: null, timeoutHours: 1, timeoutChoice: "Skip" })] });
    steps.agentResults = [{ kind: "done", value: "done" }];
    const started = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    const expired = db.getAutomationWorkflowRun(started.id);
    const question = expired.steps[1]?.question;
    if (!question) throw new Error("The question was not asked.");
    question.expiresAt = new Date(Date.now() - 1_000).toISOString();
    db.saveAutomationWorkflowRun(expired);
    await workflows.advance(started.id);
    expect(db.getAutomationWorkflowRun(started.id)).toMatchObject({ status: "completed", steps: [{}, { value: "Skip", note: "No answer in time" }] });

    const other = await setup({ check: null, steps: [askStep({ when: null, timeoutHours: 1 })] });
    other.steps.agentResults = [{ kind: "done", value: "done" }];
    const unanswered = await other.workflows.startWorkflow(other.automation, automationTriggerInfo("now", "Started by hand"));
    const record = other.db.getAutomationWorkflowRun(unanswered.id);
    if (record.steps[1]?.question) record.steps[1].question.expiresAt = new Date(Date.now() - 1_000).toISOString();
    other.db.saveAutomationWorkflowRun(record);
    await other.workflows.advance(unanswered.id);
    expect(other.db.getAutomationWorkflowRun(unanswered.id)).toMatchObject({ status: "cancelled", error: 'Nobody answered "Upgrade them?" in time.' });
  });

  it("pauses on a failing step and runs it again on retry", async () => {
    const { automation, steps, workflows } = await setup({ check: null, steps: [{ ...upgradeStep, when: null }] });
    steps.agentResults = [{ kind: "done", value: "done" }, new Error("The agent run failed.")];
    const paused = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    expect(paused).toMatchObject({ status: "paused", error: "Agent (step 2): The agent run failed." });
    expect(paused.steps[1]).toMatchObject({ status: "failed", error: "The agent run failed." });
    expect(workflows.attentionItems()[0]).toMatchObject({ kind: "blocked", title: "Dependencies is paused" });

    const retried = await workflows.retryWorkflowRun(paused.id);
    expect(retried.status).toBe("completed");
    expect(steps.agentStarts).toBe(3);
  });

  it("stops a workflow that waits and tells the triggers", async () => {
    const { automation, steps, workflows, services } = await setup({ check: null, steps: [{ id: "pause", when: null, kind: "wait", minutes: 60 }] });
    steps.agentResults = [{ kind: "done", value: "done" }];
    const waiting = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    expect(waiting).toMatchObject({ status: "waiting", currentIndex: 1 });
    expect(workflows.hasActiveWorkflowRun(automation.id)).toBe(true);
    const stopped = await workflows.cancelWorkflowRun(waiting.id);
    expect(stopped).toMatchObject({ status: "cancelled", error: "Stopped by you." });
    expect(workflows.hasActiveWorkflowRun(automation.id)).toBe(false);
    expect(vi.mocked(services.automationTriggers.handleWorkflowFinished)).toHaveBeenCalledOnce();
    expect(workflows.ownsRun({ id: "run-1", automationId: automation.id })).toBe(true);
  });

  it("keeps running from the definition it started with", async () => {
    const { automation, steps, workflows, db } = await setup({ check: null, steps: [{ id: "pause", when: null, kind: "wait", minutes: 60 }] });
    steps.agentResults = [{ kind: "done", value: "done" }];
    const waiting = await workflows.startWorkflow(automation, automationTriggerInfo("now", "Started by hand"));
    db.updateProjectAutomation(automation.id, { workflow: { check: null, steps: [] } });
    expect(db.getAutomationWorkflowRun(waiting.id).definition.steps).toHaveLength(1);
    db.deleteProjectAutomation(automation.id);
    expect(db.listAutomationWorkflowRuns({ automationId: automation.id })).toEqual([]);
  });
});
