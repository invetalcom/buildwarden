import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { createAutomationStepState, type AutomationWorkflowRun, type RunRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEventBus } from "./host-events";
import { AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";
import { AutomationStepService, findRecoverablePullRequest, type AutomationStepContext } from "./services/automation-step-service";
import { automationTriggerInfo } from "./services/automation-trigger-service";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-automation-step-"));
  tempDirs.push(directory);
  const db = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await db.init();
  databases.push(db);
  const project = db.addProject({ repoPath: join(directory, "repo"), baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  const automation = db.createProjectAutomation(project.id, {
    name: "Triage", prompt: "Reproduce the issue", cronExpression: "0 9 * * 1", modelId: model.id, workspaceType: "worktree",
    trigger: { kind: "issue-labelled", label: "bug" },
  }, "2026-12-01T09:00:00.000Z", "UTC");
  let active = true;
  const services = {
    runLifecycle: { createRun: vi.fn(async () => ({ id: "run-1", createdAt: "", startedAt: null }) as unknown as RunRecord) },
    runTurns: { cancelRun: vi.fn(async () => undefined), followUpRunInternal: vi.fn() },
    forgeIssueActions: {
      prepareForgeIssueAutomationContext: vi.fn(async () => ({
        prompt: "Issue #4", attachment: { fileName: "issue.md", mimeType: "text/markdown", data: "", size: 0 }, reference: undefined,
      })),
    },
  } as unknown as AppServices;
  const context = new AppServiceContext(db, {} as never, directory, {} as never, { killForRunId: vi.fn() }, new HostEventBus());
  const steps = new AutomationStepService(context, services);
  const workflow: AutomationWorkflowRun = {
    id: "wf-1", automationId: automation.id, projectId: project.id, automationName: automation.name, status: "running",
    trigger: { ...automationTriggerInfo("issue-labelled", "Issue #4"), issueNumber: 4, untrusted: true },
    definition: automation.workflow, steps: [createAutomationStepState("prompt", "agent")], currentIndex: 0, error: null,
    createdAt: "", updatedAt: "", finishedAt: null,
  };
  const stepContext: AutomationStepContext = {
    workflow, state: workflow.steps[0]!, step: { id: "prompt", kind: "agent", when: null, check: null }, index: 0, automation,
    save: vi.fn(), isActive: () => active,
  };
  return { db, steps, services, stepContext, stop: () => { active = false; } };
};

describe("automation agent steps", () => {
  it("starts no run when the workflow was stopped while the issue was read", async () => {
    const { steps, services, stepContext, stop } = await setup();
    vi.mocked(services.forgeIssueActions.prepareForgeIssueAutomationContext).mockImplementation(async () => {
      stop();
      return { prompt: "Issue #4", attachment: { fileName: "issue.md", mimeType: "text/markdown", data: "", size: 0 } as never, reference: undefined as never };
    });
    await expect(steps.begin(stepContext)).resolves.toEqual({ kind: "pending" });
    expect(services.runLifecycle.createRun).not.toHaveBeenCalled();
  });

  it("stops a run that started after the workflow was stopped", async () => {
    const { steps, services, stepContext, stop } = await setup();
    vi.mocked(services.runLifecycle.createRun).mockImplementation(async () => {
      stop();
      return { id: "late-run", createdAt: "", startedAt: null } as unknown as RunRecord;
    });
    await expect(steps.begin(stepContext)).resolves.toEqual({ kind: "pending" });
    expect(services.runTurns.cancelRun).toHaveBeenCalledWith("late-run");
    expect(stepContext.state.runId).toBeNull();
  });

  it("reads a check's answer only from the turn the step sent", async () => {
    const { steps, services, stepContext, db } = await setup();
    const run = db.createRun({
      projectId: stepContext.automation.projectId, providerAccountId: db.getModel(stepContext.automation.modelId).providerAccountId,
      modelId: stepContext.automation.modelId, harnessType: "ai-sdk", mode: "code", workspaceType: "worktree", workspaceVcs: "git",
      prompt: "Check", branchName: "b", worktreePath: "w", kind: "automation", automationId: stepContext.automation.id,
    });
    db.appendRunStep(run.id, "output", "Answer", "Found three.\nANSWER: yes", "{}");
    db.updateRunStatus(run.id, "completed");
    const followUp = vi.mocked(services.runTurns.followUpRunInternal);
    // The follow-up writes its prompt step; this turn then ends without writing an answer.
    followUp.mockImplementation(async (runId, _prompt, _options, metadata) => {
      db.appendRunStep(runId, "log", "Follow-up", "Is it fixed?", JSON.stringify(metadata));
      return db.getRun(runId);
    });
    stepContext.workflow.steps = [{ ...createAutomationStepState("prompt", "agent"), status: "done", runId: run.id }, createAutomationStepState("fix", "agent")];
    const fixContext: AutomationStepContext = {
      ...stepContext, state: stepContext.workflow.steps[1]!, index: 1,
      step: { id: "fix", kind: "agent", when: null, prompt: "Fix it", workspace: "continue", check: "Is it fixed?" },
    };
    await expect(steps.begin(fixContext)).resolves.toEqual({ kind: "waiting" });
    await expect(steps.check(fixContext)).resolves.toEqual({ kind: "waiting" });
    expect(fixContext.state.checkReminded).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(2);
    db.appendRunStep(run.id, "output", "Answer", "ANSWER: no", "{}");
    await expect(steps.check(fixContext)).resolves.toEqual({ kind: "done", value: "no", note: "Is it fixed?" });
  });

  it("recovers only a pull request with the same branch, target and fork", () => {
    const request = (targetBranch: string, sourceRepository: string | null) => ({
      provider: "github", number: 1, title: "", url: `https://example.test/${targetBranch}`, state: "open", draft: false, author: null,
      sourceBranch: "automation/deps", sourceRepository, targetBranch, createdAt: null, updatedAt: null,
    } as const);
    const wanted = { sourceBranch: "automation/deps", targetBranch: "main", sourceRepository: "me/app" };
    expect(findRecoverablePullRequest([request("release", "me/app")], wanted)).toBeUndefined();
    expect(findRecoverablePullRequest([request("main", "fork/app")], wanted)).toBeUndefined();
    expect(findRecoverablePullRequest([request("release", "me/app"), request("main", "me/app")], wanted)?.url).toBe("https://example.test/main");
    expect(findRecoverablePullRequest([request("main", null)], { ...wanted, sourceRepository: null })?.url).toBe("https://example.test/main");
  });

  it("keeps shell approvals on for runs started by an issue", async () => {
    const { steps, services, stepContext } = await setup();
    await expect(steps.begin(stepContext)).resolves.toEqual({ kind: "waiting" });
    expect(services.runLifecycle.createRun).toHaveBeenCalledWith(expect.objectContaining({ yoloMode: false, untrustedInput: true }), { background: true });
    expect(stepContext.state.runId).toBe("run-1");
  });
});
