import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { OrchestrationTeamSettings, RunToolResult } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";
import * as diffWorker from "./run-worktree-diff-worker";

const exec = promisify(execFile);
const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-task-read-test-")); dirs.push(dir);
  const cwd = join(dir, "repo"); await mkdir(cwd);
  const git = (...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.txt"), "original\n");
  await git("add", "."); await git("commit", "-m", "Initial");

  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
  const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
  const runInput = { projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server" as const, mode: "code" as const, workspaceType: "local" as const, branchName: "main", worktreePath: cwd };
  const coordinator = db.createRun({ ...runInput, prompt: "Coordinate", delegationEnabled: true });
  const child = db.createRun({ ...runInput, prompt: "Implement", parentRunId: coordinator.id });
  const team: OrchestrationTeamSettings = {
    version: 1, maxConcurrentTasks: 1, maxTasksPerOrchestration: 4,
    models: [{ modelId: model.id, enabled: true, defaultEffort: "high", maxConcurrent: 1 }],
    roles: [{ id: "implementer", name: "Implementer", description: "Implements.", eligibleModelIds: [model.id], preferredModelId: model.id, maxConcurrent: 1 }],
  };
  const orchestration = db.createOrchestration({ projectId: project.id, coordinatorRunId: coordinator.id, teamSnapshot: team });
  const wave = db.createOrchestrationWave(orchestration.id);
  const task = db.createOrchestrationTask({
    orchestrationId: orchestration.id, waveId: wave.id, clientTaskId: "t1", title: "Implement", prompt: "Implement",
    roleId: "implementer", modelId: model.id, intent: "implement",
  });
  db.updateOrchestrationTask(task.id, { status: "completed", childRunId: child.id, summary: "Done." });

  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  const internals = controller as unknown as {
    runWorkers: Map<string, unknown>;
    executeOrchestrationTool: (coordinatorRunId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => Promise<RunToolResult>;
  };
  internals.runWorkers.set(coordinator.id, {});
  const readTask = async (args: Record<string, unknown> = {}) => {
    const result = await internals.executeOrchestrationTool(coordinator.id, "call-1", "buildwarden_tasks_read", { taskId: task.id, ...args });
    return { size: result.content.length, response: JSON.parse(result.content) as { childRun: Record<string, unknown> & { recentSteps: Array<{ content: string; contentChars: number; title: string }> } } };
  };
  return { db, cwd, child, readTask };
};

describe("buildwarden_tasks_read", () => {
  it("returns a bounded child run summary instead of full steps and diff", async () => {
    const { db, cwd, child, readTask } = await fixture();
    await writeFile(join(cwd, "source.txt"), `${"changed line\n".repeat(20_000)}`);
    db.appendRunStep(child.id, "tool-result", "Huge tool output", "x".repeat(500_000));
    db.appendRunStep(child.id, "tool-progress", "Progress", "y".repeat(500_000));
    for (let index = 0; index < 12; index += 1) db.appendRunStep(child.id, "output", `Output ${String(index)}`, "ok");

    const diffSpy = vi.spyOn(diffWorker, "runWorktreeDiffInWorker").mockResolvedValue({ ok: true, diff: "+changed line\n".repeat(20_000) });

    const { size, response } = await readTask();

    expect(size).toBeLessThan(30_000);
    expect(response.childRun).not.toHaveProperty("diff");
    expect(diffSpy).not.toHaveBeenCalled();
    expect(response.childRun).not.toHaveProperty("steps");
    expect(response.childRun.changedFiles).toMatchObject({ totalFiles: 1, files: [expect.objectContaining({ path: "source.txt" })] });
    expect(response.childRun.recentSteps.map((step) => step.title)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Output ${String(index + 4)}`),
    );

    const withHistory = await readTask({ recentSteps: 50, includeDiff: true });
    const huge = withHistory.response.childRun.recentSteps.find((step) => step.title === "Huge tool output");
    expect(huge?.contentChars).toBe(500_000);
    expect(huge?.content.length).toBeLessThan(2_100);
    expect(withHistory.response.childRun.recentSteps.some((step) => step.title === "Progress")).toBe(false);
    expect(typeof withHistory.response.childRun.diff).toBe("string");
    expect((withHistory.response.childRun.diff as string).length).toBeLessThan(61_000);
    expect(withHistory.response.childRun.diff).toContain("truncated");
  });

  it("includes progress steps that were replaced by their final tool result", async () => {
    const { db, child, readTask } = await fixture();
    const progress = db.appendRunStep(child.id, "tool-progress", "Subagent: reviewer", "running");
    db.appendRunStep(child.id, "tool-progress", "Shell progress", "still running");
    db.updateRunStep(progress.id, { eventType: "tool-result", title: "Subagent: reviewer", content: "completed" });

    const { response } = await readTask();

    expect(response.childRun.recentSteps.map((step) => step.title)).toEqual(["Subagent: reviewer"]);
    expect(response.childRun.recentSteps[0]?.content).toBe("completed");
  });
});
