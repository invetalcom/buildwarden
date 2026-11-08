import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { OrchestrationTeamSettings, RunToolResult } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

/**
 * Replays recorded coordinator transcripts through the real tool bridge entry point, controller,
 * and database, with children started by the real launch path (only the worker thread is
 * faked). Each scenario also runs once per durability point with a simulated crash there: the
 * process stops writing, the app restarts on the same database, and the orchestration must end
 * up consistent.
 */

interface ReplayStep {
  hostToolRequest?: { type: "host-tool-request"; callId: string; toolName: string; arguments: Record<string, unknown> };
  expectResponseContains?: string[];
  childFinishes?: { clientTaskId: string; status: "completed" | "failed"; summary?: string; errorMessage?: string };
  coordinatorTurnEnds?: boolean;
  expectWakeContains?: string[];
  expectWakeOmits?: string[];
}

interface Internals {
  runWorkers: Map<string, unknown>;
  startWorker: (...args: unknown[]) => Promise<unknown>;
  followUpRunInternal: (...args: unknown[]) => Promise<unknown>;
  getProviderLimitState: () => Promise<null>;
  handleRunWorkerHostToolRequest: (runId: string, worker: unknown, payload: unknown) => Promise<void>;
  handleOrchestrationChildTerminal: (childRunId: string) => Promise<void>;
  handleOrchestrationCoordinatorTurnTerminal: (coordinatorRunId: string) => Promise<void>;
}

class SimulatedCrash extends Error {}

const FIXTURE_DIR = join(__dirname, "__fixtures__", "orchestration-replay");
const scenarios = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, steps: (JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as { steps: ReplayStep[] }).steps }));

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A controller whose worker threads and provider calls are faked; everything else is real. */
const openApp = async (dir: string, file: string, crashAtFlush?: number) => {
  const db = new BuildWardenDatabase(file);
  databases.push(db);
  await db.init();
  let flushes = 0;
  let crashed = false;
  if (crashAtFlush !== undefined) {
    const flush = db.flushDurable.bind(db);
    db.flushDurable = async () => {
      flushes += 1;
      if (flushes === crashAtFlush) {
        // Past this point the process is gone: nothing else reaches the database.
        crashed = true;
        const inner = (db as unknown as { db: DatabaseSync }).db;
        inner.prepare = () => { throw new SimulatedCrash("crashed"); };
        inner.exec = () => { throw new SimulatedCrash("crashed"); };
        throw new SimulatedCrash("crashed");
      }
      await flush();
    };
  }
  const secrets = { readSecret: async (): Promise<string | null> => null, saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  const internals = controller as unknown as Internals;
  const wakes: string[] = [];
  internals.startWorker = async () => ({ postMessage: () => undefined, terminate: async () => 0 });
  internals.getProviderLimitState = async () => null;
  internals.followUpRunInternal = async (...args: unknown[]) => { wakes.push(String(args[1])); };
  vi.spyOn(controller, "recoverInterruptedRun").mockResolvedValue();
  return { db, controller, internals, wakes, crashed: () => crashed, flushes: () => flushes };
};

const createWorkspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-replay-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
  execFileSync("git", ["init", "-b", "main", repo], { windowsHide: true });
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  await writeFile(join(repo, "README.md"), "# Replay\n");
  git("add", "."); git("commit", "-m", "Initial");
  const file = join(dir, "state.sqlite");
  const setup = new BuildWardenDatabase(file);
  await setup.init();
  const project = setup.addProject({ repoPath: repo, baseBranch: "main", resolvedName: "Replay" });
  const provider = setup.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = setup.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const team: OrchestrationTeamSettings = {
    version: 1, maxConcurrentTasks: 4, maxTasksPerOrchestration: 8,
    models: [{ modelId: model.id, enabled: true, maxConcurrent: 4 }],
    roles: [{ id: "researcher", name: "Researcher", description: "Inspects.", eligibleModelIds: [model.id], preferredModelId: model.id, maxConcurrent: 4 }],
  };
  setup.setSetting("orchestrationTeam", JSON.stringify(team));
  const coordinator = setup.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server",
    mode: "code", workspaceType: "local", branchName: "main", worktreePath: repo, prompt: "Coordinate", delegationEnabled: true,
  });
  setup.updateRunStatus(coordinator.id, "running");
  await setup.close();
  return { dir, file, coordinatorId: coordinator.id };
};

type App = Awaited<ReturnType<typeof openApp>>;

const finishChild = async (app: App, coordinatorId: string, outcome: NonNullable<ReplayStep["childFinishes"]>) => {
  const orchestration = app.db.getOrchestrationByCoordinatorRunId(coordinatorId);
  const task = orchestration ? app.db.getOrchestrationTaskByClientTaskId(orchestration.id, outcome.clientTaskId) : null;
  if (!task?.childRunId || !["provisioning", "queued", "running"].includes(task.status)) return;
  app.db.updateRunStatus(task.childRunId, outcome.status, { summary: outcome.summary ?? null, errorMessage: outcome.errorMessage ?? null });
  app.internals.runWorkers.delete(task.childRunId);
  await app.internals.handleOrchestrationChildTerminal(task.childRunId);
};

/** Plays the transcript until it ends or the simulated crash happens. */
const replay = async (app: App, coordinatorId: string, steps: ReplayStep[], strict: boolean) => {
  const coordinatorWorker = { postMessage: vi.fn() };
  app.internals.runWorkers.set(coordinatorId, { worker: coordinatorWorker, cancelled: false, providerType: "codex-cli" });
  for (const step of steps) {
    try {
      if (step.hostToolRequest) {
        await app.internals.handleRunWorkerHostToolRequest(coordinatorId, coordinatorWorker, step.hostToolRequest);
        const response = coordinatorWorker.postMessage.mock.calls.at(-1)?.[0] as { result: RunToolResult } | undefined;
        if (app.crashed()) return;
        if (strict) expect(response?.result.ok, response?.result.content).toBe(true);
        for (const text of step.expectResponseContains ?? []) if (strict) expect(response?.result.content).toContain(text);
      } else if (step.childFinishes) {
        await finishChild(app, coordinatorId, step.childFinishes);
      } else if (step.coordinatorTurnEnds) {
        app.internals.runWorkers.delete(coordinatorId);
        app.db.updateRunStatus(coordinatorId, "completed");
        await app.internals.handleOrchestrationCoordinatorTurnTerminal(coordinatorId);
      } else if (strict && (step.expectWakeContains || step.expectWakeOmits)) {
        const wake = app.wakes.at(-1) ?? "";
        for (const text of step.expectWakeContains ?? []) expect(wake).toContain(text);
        for (const text of step.expectWakeOmits ?? []) expect(wake).not.toContain(text);
      }
    } catch (error) {
      if (error instanceof SimulatedCrash || app.crashed()) return;
      throw error;
    }
    if (app.crashed()) return;
  }
};

/** What must hold after any crash and restart. */
const expectConsistent = (db: BuildWardenDatabase, coordinatorId: string) => {
  const orchestration = db.getOrchestrationByCoordinatorRunId(coordinatorId);
  if (!orchestration) return;
  expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  expect(orchestration.lastDeliveredSequence).toBeLessThanOrEqual(orchestration.lastEventSequence);
  for (const task of db.listOrchestrationTasks(orchestration.id)) {
    if (task.status === "provisioning") throw new Error(`Task ${task.clientTaskId} is stuck provisioning.`);
    if (!task.childRunId) continue;
    const child = db.getRun(task.childRunId);
    if (child.status === "completed" || child.status === "failed") {
      // A finished child is never left looking active, and its outcome is published.
      expect(["completed", "failed", "blocked", "pending"], task.clientTaskId).toContain(task.status);
      if (task.status === "completed" || task.status === "failed") {
        expect(db.listOrchestrationTaskResults(task.id).length, task.clientTaskId).toBeGreaterThan(0);
      }
    }
  }
};

describe.each(scenarios)("replayed orchestration $name", ({ steps }) => {
  it("plays through cleanly", async () => {
    const workspace = await createWorkspace();
    const app = await openApp(workspace.dir, workspace.file);
    await replay(app, workspace.coordinatorId, steps, true);
    expectConsistent(app.db, workspace.coordinatorId);
  });

  it("recovers consistently from a crash at every durability point", async () => {
    const probe = await createWorkspace();
    const counted = await openApp(probe.dir, probe.file, Number.POSITIVE_INFINITY);
    await replay(counted, probe.coordinatorId, steps, false);
    const durabilityPoints = counted.flushes();
    expect(durabilityPoints).toBeGreaterThan(5);

    for (let crashAt = 1; crashAt <= durabilityPoints; crashAt += 1) {
      const workspace = await createWorkspace();
      const crashing = await openApp(workspace.dir, workspace.file, crashAt);
      await replay(crashing, workspace.coordinatorId, steps, false);
      expect(crashing.crashed(), `crash point ${String(crashAt)}`).toBe(true);
      await crashing.db.close().catch(() => undefined);

      const restarted = await openApp(workspace.dir, workspace.file);
      await restarted.controller.reconcileOrphanedActiveSessions();
      await restarted.controller.reconcileOrchestrationsAfterRestart();
      // Children that were restarted after the crash still report their outcomes.
      for (const step of steps) {
        if (step.childFinishes) await finishChild(restarted, workspace.coordinatorId, step.childFinishes);
      }
      expectConsistent(restarted.db, workspace.coordinatorId);
      await restarted.db.close();
    }
  }, 180_000);
});
