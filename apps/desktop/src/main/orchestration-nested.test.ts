import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, parseOrchestrationTeamSettings, type OrchestrationRecord, type RunRecord } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { buildDelegatedTaskPrompt } from "./services/orchestration-policy";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async (maxDelegationDepth?: number, maxConcurrentTasks = 3) => {
  const dir = await mkdtemp(join(tmpdir(), "bw-nested-"));
  dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  databases.push(db);
  await db.init();
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  if (maxDelegationDepth) db.setSetting(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({ version: 1, maxConcurrentTasks, maxTasksPerOrchestration: 12, maxDelegationDepth, models: [], roles: [] }));
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project", kind: "folder" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt", displayName: "GPT", config: {}, capabilities: {}, enabled: true });
  const runInput = {
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const,
    mode: "code" as const, workspaceType: "local" as const, workspaceVcs: "folder" as const, branchName: "project-folder", worktreePath: dir,
  };
  const root = db.createRun({ ...runInput, prompt: "Coordinate", delegationEnabled: true });
  const controller = new AppController(db, { readSecret: async () => "key", saveSecret: async () => undefined, deleteSecret: async () => undefined }, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: vi.fn() }, new HostEventBus());
  const orchestration = serviceOf(controller, "orchestration");
  /** A child of `coordinator`'s orchestration, as dispatch would create it. */
  const addChild = (parent: OrchestrationRecord, coordinator: RunRecord, clientTaskId: string) => {
    const wave = db.createOrchestrationWave(parent.id);
    const task = db.createOrchestrationTask({
      orchestrationId: parent.id, waveId: wave.id, clientTaskId, title: clientTaskId, prompt: "Part", roleId: "general", modelId: model.id, intent: "inspect",
    });
    const child = db.createRun({
      ...runInput, prompt: "Part", kind: "orchestration-task", parentRunId: coordinator.id, rootRunId: coordinator.id, orchestrationTaskId: task.id,
      delegationEnabled: orchestration.childMayDelegate(coordinator, parent),
    });
    db.updateOrchestrationTask(task.id, { childRunId: child.id, status: "running" });
    return { task: db.getOrchestrationTask(task.id), child: db.getRun(child.id) };
  };
  return { db, controller, orchestration, root, addChild };
};

describe("nested delegation", () => {
  it("keeps delegation to the top-level run unless a deeper limit is set", async () => {
    expect(parseOrchestrationTeamSettings(JSON.stringify({ roles: [], models: [] })).maxDelegationDepth).toBeUndefined();
    expect(parseOrchestrationTeamSettings(JSON.stringify({ maxDelegationDepth: 9, roles: [], models: [] })).maxDelegationDepth).toBe(3);

    const { orchestration, root, addChild } = await fixture();
    const top = orchestration.getOrCreateOrchestration(root);
    const { child } = addChild(top, root, "c1");
    expect(child.delegationEnabled).toBeFalsy();
    expect(() => orchestration.getOrCreateOrchestration({ ...child, delegationEnabled: true })).toThrow("may not delegate further");
  });

  it("lets children delegate within the limit, which their orchestration inherits", async () => {
    const { db, orchestration, root, addChild } = await fixture(2);
    const top = orchestration.getOrCreateOrchestration(root);
    expect(top.teamSnapshot.maxDelegationDepth).toBe(2);
    const { child } = addChild(top, root, "c1");
    expect(Boolean(child.delegationEnabled)).toBe(true);
    expect(orchestration.delegationDepth(child)).toBe(1);

    // A later settings change cannot deepen the running tree.
    db.setSetting(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({ version: 1, maxDelegationDepth: 3, models: [], roles: [] }));
    const nested = orchestration.getOrCreateOrchestration(child);
    expect(nested.teamSnapshot.maxDelegationDepth).toBe(2);
    const { child: grandchild } = addChild(nested, child, "g1");
    expect(grandchild.delegationEnabled).toBeFalsy();
    expect(orchestration.delegationDepth(grandchild)).toBe(2);
    expect(() => orchestration.getOrCreateOrchestration({ ...grandchild, delegationEnabled: true })).toThrow("may not delegate further");
  });

  it("publishes a coordinating child's result only after its own tasks are done", async () => {
    const { db, controller, orchestration, root, addChild } = await fixture(2);
    const top = orchestration.getOrCreateOrchestration(root);
    const { task, child } = addChild(top, root, "c1");
    const nested = orchestration.getOrCreateOrchestration(child);
    const { task: subtask } = addChild(nested, child, "g1");
    const finished = db.updateRunStatus(child.id, "completed", { summary: "Waiting for my sub-task." });

    const results = serviceOf(controller, "orchestrationResults");
    expect(orchestration.isStillCoordinating(child.id)).toBe(true);
    await expect(results.settleOrchestrationChildTerminal(task, finished)).resolves.toBe("coordinating");
    expect(db.getOrchestrationTask(task.id).status).toBe("running");

    db.updateOrchestrationTask(subtask.id, { status: "completed", summary: "Sub-task done." });
    const final = db.updateRunStatus(child.id, "completed", { summary: "Done, including the sub-task." });
    expect(orchestration.isStillCoordinating(child.id)).toBe(false);
    await expect(results.settleOrchestrationChildTerminal(db.getOrchestrationTask(task.id), final, { deliverQueued: false })).resolves.toBe("settled");
    expect(db.getOrchestrationTask(task.id)).toMatchObject({ status: "completed", summary: "Done, including the sub-task." });
  });

  it("still reaches a child's own tasks when cancelling another task failed, also on retry", async () => {
    const { db, controller, orchestration, root, addChild } = await fixture(2);
    const top = orchestration.getOrCreateOrchestration(root);
    const { task: first, child } = addChild(top, root, "c1");
    const { task: second, child: other } = addChild(top, root, "c2");
    const nested = orchestration.getOrCreateOrchestration(child);
    const { task: subtask, child: grandchild } = addChild(nested, child, "g1");
    const cancelRun = vi.spyOn(serviceOf(controller, "runTurns"), "cancelRun");
    let failures = 2;
    cancelRun.mockImplementation(async (runId) => {
      // The other child and the grandchild cannot be stopped at first.
      if ((runId === other.id || runId === grandchild.id) && failures > 0) {
        failures -= 1;
        throw new Error(`could not stop ${runId}`);
      }
    });
    await expect(orchestration.cancelOrchestration(root.id)).rejects.toThrow();
    expect(db.getOrchestrationTask(first.id).status).toBe("cancelled");
    expect(db.getOrchestrationTask(second.id).status).toBe("running");
    expect(cancelRun).toHaveBeenCalledWith(grandchild.id);
    expect(db.getOrchestrationTask(subtask.id).status).toBe("running");

    await orchestration.cancelOrchestration(root.id);
    expect(db.getOrchestrationTask(second.id).status).toBe("cancelled");
    expect(db.getOrchestrationTask(subtask.id).status).toBe("cancelled");
  });

  it("lets a waiting coordinator's own task start when it holds the only slot", async () => {
    const { db, controller, orchestration, root, addChild } = await fixture(2, 1);
    const top = orchestration.getOrCreateOrchestration(root);
    const { child } = addChild(top, root, "c1");
    const nested = orchestration.getOrCreateOrchestration(child);
    // The child's turn ended after it delegated; its own task waits for capacity.
    const wave = db.createOrchestrationWave(nested.id);
    const subtask = db.createOrchestrationTask({
      orchestrationId: nested.id, waveId: wave.id, clientTaskId: "g1", title: "g1", prompt: "Part", roleId: "general", modelId: child.modelId, intent: "inspect",
    });
    expect(serviceOf(controller, "orchestrationDispatch").reserveOrchestrationTask(subtask)).toBe(true);
    // A coordinator whose turn is still running keeps its slot.
    db.updateOrchestrationTask(subtask.id, { status: "pending" });
    serviceOf(controller, "activeWorkers").runWorkers.set(child.id, {} as never);
    try {
      expect(serviceOf(controller, "orchestrationDispatch").reserveOrchestrationTask(db.getOrchestrationTask(subtask.id))).toBe(false);
    } finally {
      serviceOf(controller, "activeWorkers").runWorkers.delete(child.id);
    }
  });

  it("cancels the tasks a cancelled child delegated, and deletes the whole tree with the top-level run", async () => {
    const { db, controller, orchestration, root, addChild } = await fixture(2);
    const top = orchestration.getOrCreateOrchestration(root);
    const { task, child } = addChild(top, root, "c1");
    const nested = orchestration.getOrCreateOrchestration(child);
    const { child: grandchild, task: subtask } = addChild(nested, child, "g1");

    const impact = await serviceOf(controller, "runDeletion").getRunDeletionImpact(root.id);
    expect(impact.runIds).toEqual(expect.arrayContaining([root.id, child.id, grandchild.id]));
    expect(impact.nestedOrchestrationIds).toEqual([nested.id]);

    await orchestration.cancelOrchestrationTasks(top, [task.id]);
    expect(db.getOrchestrationTask(task.id).status).toBe("cancelled");
    expect(db.getOrchestration(nested.id).status).toBe("cancelled");
    expect(db.getOrchestrationTask(subtask.id).status).toBe("cancelled");

    await controller.deleteRun(root.id);
    expect(() => db.getRun(grandchild.id)).toThrow();
    expect(db.getOrchestrationByCoordinatorRunId(child.id)).toBeNull();
  });

  it("tells a child whether it may delegate", () => {
    const base = { roleName: "Researcher", intent: "inspect", task: "Look", goalText: null };
    expect(buildDelegatedTaskPrompt(base)).toContain("delegate further");
    expect(buildDelegatedTaskPrompt({ ...base, mayDelegate: true })).toContain("You may delegate parts of this task");
  });
});
