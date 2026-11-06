import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type {
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
  OrchestrationTeamSettings,
  RunToolResult,
} from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface ControllerInternals {
  runWorkers: Map<string, unknown>;
  executeOrchestrationTool: (runId: string, callId: string, toolName: string, args: Record<string, unknown>) => Promise<RunToolResult>;
  followUpRunInternal: (runId: string, prompt: string, options?: Record<string, unknown>, metadata?: Record<string, unknown>) => Promise<unknown>;
  maybeWakeOrchestrationCoordinator: (orchestrationId: string) => Promise<void>;
}

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-orchestration-test-"));
  dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  databases.push(db);
  await db.init();
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const runInput = {
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const,
    mode: "code" as const, workspaceType: "local" as const, branchName: "main", worktreePath: dir,
  };
  const coordinator = db.createRun({ ...runInput, prompt: "Coordinate", delegationEnabled: true });
  const team: OrchestrationTeamSettings = {
    version: 1, maxConcurrentTasks: 4, maxTasksPerOrchestration: 8,
    models: [{ modelId: model.id, enabled: true, maxConcurrent: 4 }],
    roles: [{ id: "researcher", name: "Researcher", description: "Inspects.", eligibleModelIds: [model.id], preferredModelId: model.id, maxConcurrent: 4 }],
  };
  const orchestration = db.createOrchestration({ projectId: project.id, coordinatorRunId: coordinator.id, teamSnapshot: team });
  const wave = db.createOrchestrationWave(orchestration.id);
  const addTask = (clientTaskId: string, status: OrchestrationTaskStatus): OrchestrationTaskRecord => {
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId, title: clientTaskId, prompt: "Inspect",
      roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    return db.updateOrchestrationTask(task.id, { status });
  };

  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  const internals = controller as unknown as ControllerInternals;
  const followUp = vi.fn(async () => undefined);
  internals.followUpRunInternal = followUp;

  /** Marks everything recorded so far as already reported to the coordinator. */
  const markDelivered = () => {
    const current = db.getOrchestration(orchestration.id);
    db.updateOrchestration(orchestration.id, { lastDeliveredSequence: current.lastEventSequence });
  };
  const yieldCoordinator = async (requestId: string, mode: string, taskIds?: string[]) => {
    internals.runWorkers.set(coordinator.id, {});
    const result = await internals.executeOrchestrationTool(coordinator.id, `call-${requestId}`, "buildwarden_orchestration_yield", {
      requestId, mode, ...(taskIds ? { taskIds } : {}),
    });
    internals.runWorkers.delete(coordinator.id);
    return JSON.parse(result.content) as { waiting: boolean };
  };
  return { db, orchestration, internals, followUp, addTask, markDelivered, yieldCoordinator };
};

describe("orchestration wake conditions", () => {
  it("does not treat a task finished in an earlier wave as a new any-terminal result", async () => {
    const { db, orchestration, internals, followUp, addTask, markDelivered, yieldCoordinator } = await fixture();
    addTask("earlier", "completed");
    const running = addTask("running", "running");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: running.id, type: "task-started", title: "t", content: "c" });
    markDelivered();

    await expect(yieldCoordinator("request-1", "any-terminal")).resolves.toMatchObject({ waiting: true });
    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);
    expect(followUp).not.toHaveBeenCalled();

    db.updateOrchestrationTask(running.id, { status: "completed" });
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: running.id, type: "task-completed", title: "t", content: "c" });
    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("wakes for a task result that has not been delivered yet", async () => {
    const { db, orchestration, internals, followUp, addTask, yieldCoordinator } = await fixture();
    const finished = addTask("finished", "completed");
    addTask("running", "running");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: finished.id, type: "task-completed", title: "t", content: "c" });

    await expect(yieldCoordinator("request-1", "any-terminal")).resolves.toMatchObject({ waiting: true });
    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);

    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("wakes once for a child waiting on a human, then not again until something changes", async () => {
    const { db, orchestration, internals, followUp, addTask, yieldCoordinator } = await fixture();
    const blocked = addTask("question", "waiting-input");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: blocked.id, type: "attention", title: "t", content: "c" });

    await yieldCoordinator("request-1", "attention");
    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);
    expect(followUp).toHaveBeenCalledTimes(1);

    await expect(yieldCoordinator("request-2", "attention")).resolves.toMatchObject({ waiting: true });
    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("refuses to park when every selected result has already been delivered", async () => {
    const { db, orchestration, addTask, markDelivered, yieldCoordinator } = await fixture();
    const finished = addTask("finished", "failed");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: finished.id, type: "attention", title: "t", content: "c" });
    markDelivered();

    await expect(yieldCoordinator("request-1", "attention")).resolves.toMatchObject({ waiting: false });

    expect(db.getOrchestration(orchestration.id)).toMatchObject({ status: "active", wakeMode: null });
  });

  it("rejects a wake condition that names a task outside the orchestration", async () => {
    const { addTask, yieldCoordinator } = await fixture();
    addTask("running", "running");

    await expect(yieldCoordinator("request-1", "all-terminal", ["missing-task"])).rejects.toThrow("does not belong");
  });
});
