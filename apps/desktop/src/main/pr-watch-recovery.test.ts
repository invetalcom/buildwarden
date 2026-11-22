import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { PrWatchRecord } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

const exec = promisify(execFile);
const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-pr-watch-recovery-")); dirs.push(dir);
  const cwd = join(dir, "repo"); await mkdir(cwd);
  const git = (...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  await git("init", "-b", "feature"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await git("config", "commit.gpgSign", "false");
  await writeFile(join(cwd, "source.txt"), "original\n");
  await git("add", "."); await git("commit", "-m", "Initial");
  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
  const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code", workspaceType: "local", prompt: "Implement", branchName: "feature", worktreePath: cwd });
  db.updateRunStatus(run.id, "completed");
  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  return { db, controller, project, run, cwd };
};

const recoveries = ["checkpoint resume", "checkpoint recovery", "provider session recovery"] as const;

it.each(recoveries)("does not finish a pending wake with a %s of the previous turn", async (kind) => {
  const { db, controller, project, run, cwd } = await fixture();
  const internals = controller as unknown as {
    startWorker: () => object;
    runWorkers: Map<string, unknown>;
    handlePrWatchRunTerminal: (runId: string) => Promise<void>;
  };
  vi.spyOn(internals, "startWorker").mockReturnValue({});
  const push = vi.spyOn(controller, "publishRunBranch");
  // The previous turn left a checkpoint (or a provider session), and the app exited after saving the
  // wake's prompt but before the run left its terminal state, so startup writes no interruption step.
  if (kind === "provider session recovery") {
    db.upsertProviderSessionRuntime({
      ownerId: run.id, ownerKind: "run", providerAccountId: run.providerAccountId, providerType: "codex-cli", harnessType: "codex-app-server",
      status: "stopped", cwd, runtimeMode: "code", resumeCursor: { sessionId: "session" },
    });
  } else {
    db.setSetting(`runCheckpoint:${run.id}`, JSON.stringify({ round: 3, memo: "Resume the earlier task" }));
  }
  const now = new Date().toISOString();
  db.appendRunStep(run.id, "log", "Follow-up command", "[PR watch] Fix the failing check.",
    JSON.stringify({ source: "user", commandType: "follow-up", prWatchWake: { wakeId: "wake-1" } }));
  const watch: PrWatchRecord = {
    runId: run.id, projectId: project.id, prUrl: "https://github.com/acme/repo/pull/21", prNumber: 21, provider: "github", status: "working",
    options: { checks: true, feedback: true, conflicts: true }, message: null, endReason: null, wakeCount: 1, attemptsOnHead: 1, attemptHeadSha: "abc",
    lastCheckedAt: null, lastWakeAt: now, lastResult: null, attention: null, createdAt: now, updatedAt: now,
    pending: { id: "wake-1", triggers: ["checks"], headSha: "abc", handledKeys: ["checks:21:abc"], feedback: [], repairRequested: false, startedAt: now },
  };
  db.savePrWatch(watch);
  await controller.reconcileOrphanedActiveSessions();

  if (kind === "checkpoint resume") await controller.resumeRunFromCheckpoint(run.id);
  else await controller.recoverInterruptedRun(run.id);
  expect(internals.runWorkers.has(run.id)).toBe(true);

  // The recovered turn finishes later with its own answer.
  await new Promise((resolve) => setTimeout(resolve, 5));
  db.appendRunStep(run.id, "output", "Answer", "Finished the earlier task.");
  db.updateRunStatus(run.id, "completed");
  internals.runWorkers.delete(run.id);
  await internals.handlePrWatchRunTerminal(run.id);

  expect(db.getPrWatch(run.id)).toMatchObject({ status: "paused", message: expect.stringContaining("app restarted") });
  expect(db.listPrWatchKeys(run.id).size).toBe(0);
  expect(push).not.toHaveBeenCalled();
});
