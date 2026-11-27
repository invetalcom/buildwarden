import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { createAutomationStepState, type AutomationWorkflowRun, type RunRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEventBus } from "./host-events";
import { AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";
import { AutomationStepService, type AutomationStepContext } from "./services/automation-step-service";
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
  return { steps, services, stepContext, stop: () => { active = false; } };
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

  it("keeps shell approvals on for runs started by an issue", async () => {
    const { steps, services, stepContext } = await setup();
    await expect(steps.begin(stepContext)).resolves.toEqual({ kind: "waiting" });
    expect(services.runLifecycle.createRun).toHaveBeenCalledWith(expect.objectContaining({ yoloMode: false, untrustedInput: true }), { background: true });
    expect(stepContext.state.runId).toBe("run-1");
  });
});
