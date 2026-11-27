import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { AutomationTrigger, AutomationWorkflowRun, ProjectForgeRequestSummary } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEventBus } from "./host-events";
import { AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";
import { AutomationService } from "./services/automation-service";
import { AutomationTriggerService } from "./services/automation-trigger-service";

const tempDirs: string[] = [];
const databases: BuildWardenDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-automation-trigger-"));
  tempDirs.push(directory);
  const db = new BuildWardenDatabase(join(directory, "buildwarden.sqlite"));
  await db.init();
  databases.push(db);
  const project = db.addProject({ repoPath: join(directory, "repo"), baseBranch: "main", resolvedName: "Repo" });
  const provider = db.addProviderAccount({ providerType: "ai-sdk", label: "AI SDK", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "model", displayName: "Model", config: {}, capabilities: {} });
  const create = (name: string, trigger: AutomationTrigger) => db.createProjectAutomation(project.id, {
    name, prompt: name, cronExpression: "0 9 * * 1", modelId: model.id, workspaceType: "worktree", trigger,
  }, "2026-12-01T09:00:00.000Z", "UTC");
  const openRequests: ProjectForgeRequestSummary[] = [];
  const services = {
    activeWorkers: { agentWorkersStopping: false },
    automations: { startTriggeredAutomation: vi.fn(async () => null), startupReviewPending: false },
    automationWorkflows: { ownsRun: () => false },
    forgeRequests: { listProjectForgeRequests: vi.fn(async () => ({ provider: "github", webBaseUrl: "", repoLabel: "o/r", items: [...openRequests] })) },
  } as unknown as AppServices;
  const context = new AppServiceContext(db, {} as never, directory, {} as never, { killForRunId: vi.fn() }, new HostEventBus());
  const triggers = new AutomationTriggerService(context, services);
  return { db, project, create, triggers, services, openRequests };
};

const finishedWorkflow = (automationId: string, projectId: string, status: AutomationWorkflowRun["status"], id = "wf-1"): AutomationWorkflowRun => ({
  id, automationId, projectId, automationName: "Upstream", status, definition: { check: null, steps: [] }, steps: [], currentIndex: 0,
  trigger: { kind: "now", label: "", context: null, issueNumber: null, prUrl: null, prNumber: null, upstreamAutomationId: null, upstreamRunId: null, untrusted: false },
  error: null, createdAt: "", updatedAt: "", finishedAt: "",
});

const request = (number: number, targetBranch = "main"): ProjectForgeRequestSummary => ({
  provider: "github", number, title: `PR ${String(number)}`, url: `https://example.test/pr/${String(number)}`, state: "open", draft: false,
  author: "someone", sourceBranch: `feature-${String(number)}`, targetBranch, createdAt: null, updatedAt: null,
});

describe("automation triggers", () => {
  it("starts a follower once per finished upstream workflow and only for the chosen outcome", async () => {
    const { project, create, triggers, services } = await setup();
    const upstream = create("Upstream", { kind: "manual" });
    const onSuccess = create("On success", { kind: "automation-finished", automationId: upstream.id, outcome: "completed" });
    create("On failure", { kind: "automation-finished", automationId: upstream.id, outcome: "failed" });
    const start = vi.mocked(services.automations.startTriggeredAutomation);

    triggers.handleWorkflowFinished(finishedWorkflow(upstream.id, project.id, "completed"));
    triggers.handleWorkflowFinished(finishedWorkflow(upstream.id, project.id, "completed"));
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toBe(onSuccess.id);
    expect(start.mock.calls[0]?.[1]).toMatchObject({ kind: "automation-finished", upstreamAutomationId: upstream.id, untrusted: false });

    triggers.handleWorkflowFinished(finishedWorkflow(upstream.id, project.id, "completed", "wf-2"));
    expect(start).toHaveBeenCalledTimes(2);

    // An upstream started by an issue passes its answer on, and with it the need for shell approvals.
    const fromIssue = finishedWorkflow(upstream.id, project.id, "completed", "wf-3");
    fromIssue.trigger = { ...fromIssue.trigger, kind: "issue-labelled", issueNumber: 4, untrusted: true };
    triggers.handleWorkflowFinished(fromIssue);
    expect(start.mock.calls[2]?.[1]).toMatchObject({ kind: "automation-finished", untrusted: true });
  });

  it("ignores the pull requests open when the trigger was saved, then starts for new ones on the chosen branch", async () => {
    const { db, create, triggers, services, openRequests } = await setup();
    const automation = create("Review", { kind: "pr-opened", targetBranch: "main" });
    const start = vi.mocked(services.automations.startTriggeredAutomation);
    openRequests.push(request(4), request(7));
    await triggers.runTriggerTick();
    expect(start).not.toHaveBeenCalled();
    expect(JSON.parse(db.getProjectAutomationTriggerState(automation.id) ?? "{}")).toEqual({ kind: "pr-opened", highest: 7 });

    openRequests.push(request(8, "release"), request(9));
    (triggers as unknown as { checkedAt: Map<string, number> }).checkedAt.clear();
    await triggers.runTriggerTick();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[1]).toMatchObject({ kind: "pr-opened", prNumber: 9, untrusted: true });
    expect(JSON.parse(db.getProjectAutomationTriggerState(automation.id) ?? "{}")).toEqual({ kind: "pr-opened", highest: 9 });
  });

  it("refuses a loop made by two edits saved at the same time", async () => {
    const { db, create, services } = await setup();
    // Reading branches yields, so both edits pass their first check before either is saved.
    Object.assign(services, { projects: { getProjectBranches: () => new Promise((resolve) => setTimeout(() => resolve(["main"]), 20)) } });
    const context = new AppServiceContext(db, {} as never, "", {} as never, { killForRunId: vi.fn() }, new HostEventBus());
    const automations = new AutomationService(context, services);
    const first = create("First", { kind: "manual" });
    const second = create("Second", { kind: "manual" });
    const results = await Promise.allSettled([
      automations.updateProjectAutomation(first.id, { trigger: { kind: "automation-finished", automationId: second.id, outcome: "any" } }),
      automations.updateProjectAutomation(second.id, { trigger: { kind: "automation-finished", automationId: first.id, outcome: "any" } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { message: "These automations would start each other in a loop." } });
  });

  it("refuses automations that would start each other in a loop", async () => {
    const { db, project, create, services } = await setup();
    Object.assign(services, { projects: { getProjectBranches: async () => ["main"] } });
    const context = new AppServiceContext(db, {} as never, "", {} as never, { killForRunId: vi.fn() }, new HostEventBus());
    const automations = new AutomationService(context, services);
    const first = create("First", { kind: "manual" });
    const second = create("Second", { kind: "automation-finished", automationId: first.id, outcome: "any" });
    await expect(automations.updateProjectAutomation(first.id, { trigger: { kind: "automation-finished", automationId: second.id, outcome: "any" } }))
      .rejects.toThrow("These automations would start each other in a loop.");
    await expect(automations.updateProjectAutomation(first.id, { trigger: { kind: "automation-finished", automationId: first.id, outcome: "any" } }))
      .rejects.toThrow("An automation cannot start after itself.");
    await expect(automations.createProjectAutomation(project.id, {
      name: "Bad", prompt: "x", cronExpression: "", modelId: first.modelId, workspaceType: "worktree",
      trigger: { kind: "manual" }, workflow: { check: null, steps: [{ id: "m", when: null, kind: "merge-pr", method: "squash" }] },
    })).rejects.toThrow("needs an \"Open pull request\" step before it");
    const manual = await automations.createProjectAutomation(project.id, {
      name: "Manual", prompt: "x", cronExpression: "not a cron", modelId: first.modelId, workspaceType: "worktree", trigger: { kind: "manual" },
    });
    expect(manual).toMatchObject({ trigger: { kind: "manual" }, cronExpression: "0 9 * * 1-5" });
  });

  it("waits for the startup review before checking anything", async () => {
    const { create, triggers, services } = await setup();
    create("Review", { kind: "pr-opened", targetBranch: null });
    Object.assign(services.automations, { startupReviewPending: true });
    await triggers.runTriggerTick();
    expect(services.forgeRequests.listProjectForgeRequests).not.toHaveBeenCalled();
  });
});
