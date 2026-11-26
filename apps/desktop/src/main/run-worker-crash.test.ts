import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, type ModelRecord, type ProviderAccountRecord, type RunEvent, type RunRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { internalsOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";

interface CrashableWorker {
  emitThreadError(error: Error): Promise<void>;
}

const workers = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  class Worker extends EventEmitter {
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn(async () => 1);
    constructor() {
      super();
      workers.instances.push(this);
    }
    async emitThreadError(error: Error): Promise<void> {
      for (const listener of this.listeners("error")) await listener(error);
    }
  }
  return { Worker };
});

interface Internals {
  runWorkers: Map<string, unknown>;
  startWorker(run: RunRecord, provider: ProviderAccountRecord, model: ModelRecord, apiKey: string, proxy: undefined): Promise<unknown>;
  dispatchOrchestrationTasks: (orchestrationId: string) => Promise<void>;
}

const roots: Array<{ root: string; db: BuildWardenDatabase }> = [];
afterEach(async () => {
  workers.instances.length = 0;
  for (const { root, db } of roots.splice(0)) {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-worker-crash-"));
  const repoPath = join(root, "project");
  mkdirSync(repoPath);
  const db = new BuildWardenDatabase(join(root, "buildwarden.sqlite"));
  await db.init();
  roots.push({ root, db });
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  const project = db.addProject({ repoPath, baseBranch: "project-folder", resolvedName: "Crash", kind: "folder" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Agent", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "default", displayName: "Agent", config: {}, capabilities: {}, enabled: true });
  const runInput = {
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const,
    mode: "ask" as const, workspaceType: "local" as const, workspaceVcs: "folder" as const, prompt: "Work",
    branchName: "project-folder", worktreePath: repoPath,
  };
  const events = new HostEventBus();
  const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(root, "logs"),
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, events);
  const internals = internalsOf(controller) as unknown as Internals;
  const published: RunEvent[] = [];
  controller.onRunEvent((event) => published.push(event));
  const start = async (run: RunRecord): Promise<CrashableWorker> => {
    const worker = await internals.startWorker(run, provider, model, "", undefined);
    internals.runWorkers.set(run.id, { worker, cancelled: false, providerType: provider.providerType });
    return worker as CrashableWorker;
  };
  return { db, project, model, internals, runInput, published, start };
};

describe("run worker crashes", () => {
  it("settles a crashed orchestration child so its coordinator can continue", async () => {
    const { db, project, model, internals, runInput, start } = await setup();
    internals.dispatchOrchestrationTasks = vi.fn(async () => undefined);
    const coordinator = db.createRun({ ...runInput, prompt: "Coordinate", delegationEnabled: true });
    const orchestration = db.createOrchestration({
      projectId: project.id, coordinatorRunId: coordinator.id,
      teamSnapshot: {
        version: 1, maxConcurrentTasks: 1, maxTasksPerOrchestration: 1,
        models: [{ modelId: model.id, enabled: true, maxConcurrent: 1 }],
        roles: [{ id: "researcher", name: "Researcher", description: "Inspects.", eligibleModelIds: [model.id], preferredModelId: model.id, maxConcurrent: 1 }],
      },
    });
    const child = db.createRun({ ...runInput, kind: "orchestration-task", parentRunId: coordinator.id, rootRunId: coordinator.id });
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: db.createOrchestrationWave(orchestration.id).id, clientTaskId: "inspect",
      title: "Inspect", prompt: "Inspect", roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    db.updateOrchestrationTask(task.id, { status: "running", childRunId: child.id });

    const worker = await start(child);
    await worker.emitThreadError(new Error("Worker ran out of memory"));

    expect(db.getRun(child.id)).toMatchObject({ status: "failed", errorMessage: "Worker ran out of memory" });
    expect(db.getOrchestrationTask(task.id).status).toBe("failed");
    expect(internals.runWorkers.has(child.id)).toBe(false);
  });

  it("fails the Project Lab thread of a crashed implementation", async () => {
    const { db, project, model, runInput, start } = await setup();
    const thread = db.createProjectLabThread({
      projectId: project.id, kind: "implementation", mode: "new-feature", status: "running", origin: "manual",
      title: "Crash", summary: "Crash", implementationModelId: model.id, reviewModelId: model.id,
    });
    const run = db.createRun({ ...runInput, kind: "lab-implementation", labThreadId: thread.id });

    const worker = await start(run);
    await worker.emitThreadError(new Error("Worker ran out of memory"));

    expect(db.getProjectLabThread(thread.id)).toMatchObject({ status: "failed", outcome: "Worker ran out of memory" });
  });

  it("tells clients that the run failed", async () => {
    const { db, runInput, published, start } = await setup();
    const run = db.createRun({ ...runInput, kind: "standard" });

    const worker = await start(run);
    await worker.emitThreadError(new Error("Worker ran out of memory"));

    expect(published.filter((event) => event.runId === run.id).at(-1)).toMatchObject({ type: "error", title: "Run failed", content: "Worker ran out of memory" });
    expect(db.getRunSteps(run.id).filter((step) => step.eventType === "error")).toHaveLength(1);
  });
});

describe("starting a run worker", () => {
  it("reads the run history once", async () => {
    const { db, runInput, start } = await setup();
    const run = db.createRun({ ...runInput, kind: "standard" });
    db.appendRunStep(run.id, "log", "Prompt", "Work", JSON.stringify({ source: "user", commandType: "initial" }));
    const readHistory = vi.spyOn(db, "getRunSteps");

    await start(run);

    expect(readHistory).toHaveBeenCalledTimes(1);
  });
});
