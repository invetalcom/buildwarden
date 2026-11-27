import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { GitService } from "@buildwarden/git-service";
import { APP_SETTING_KEYS, type RunExecutionRequest, type RunStepRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { planRunFork } from "./services/run-fork-service";

const workers = vi.hoisted(() => ({ requests: [] as Array<RunExecutionRequest | undefined> }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  class Worker extends EventEmitter {
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn(async () => 1);
    constructor(_path: unknown, options?: { workerData?: { request?: RunExecutionRequest } }) {
      super();
      workers.requests.push(options?.workerData?.request);
    }
  }
  return { Worker };
});

const roots: Array<{ root: string; db: BuildWardenDatabase }> = [];
afterEach(async () => {
  workers.requests.length = 0;
  for (const { root, db } of roots.splice(0)) {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const user = (commandType: string, extra: Record<string, unknown> = {}) => JSON.stringify({ source: "user", commandType, ...extra });

/** A Git project with a worktree run of two turns. The restore point before turn 2 holds turn 1's files. */
const setup = async (options: { sharedDependencies?: boolean; acp?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-fork-"));
  const repoPath = join(root, "project");
  mkdirSync(repoPath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "core.autocrlf", "false");
  writeFileSync(join(repoPath, "notes.txt"), "base\n");
  if (options.sharedDependencies) {
    // Like a JavaScript project: dependencies installed at the root and ignored as a folder.
    writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
    mkdirSync(join(repoPath, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repoPath, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  }
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-q", "-m", "base");

  const db = new BuildWardenDatabase(join(root, "buildwarden.sqlite"));
  await db.init();
  roots.push({ root, db });
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  db.setSetting(APP_SETTING_KEYS.worktreeRootOverride, join(root, "worktrees"));
  const project = db.addProject({ repoPath, baseBranch: "main", resolvedName: "Forks", kind: "git" });
  const provider = options.acp
    ? db.addProviderAccount({ providerType: "acp", label: "Agent", apiBaseUrl: null, apiKeyRef: "", configJson: JSON.stringify({ acpCommand: "agent --acp" }) })
    : db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt-test", displayName: "GPT test", config: {}, capabilities: {}, enabled: true });
  const gitService = new GitService();
  const workspace = await gitService.createWorktreeForRun(repoPath, project.name, "source", "main", join(root, "worktrees"), options.sharedDependencies === true);
  const run = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: options.acp ? "acp" : "codex-app-server",
    mode: "code", workspaceType: "worktree", workspaceVcs: "git", prompt: "Write the notes", ...workspace,
  });
  db.appendRunStep(run.id, "log", "Initial command", "Write the notes", user("initial", { modelId: model.id, providerAccountId: provider.id, mode: "code" }));
  const firstAnswer = db.appendRunStep(run.id, "output", "Agent output", "Wrote turn one.", "{}");
  writeFileSync(join(workspace.worktreePath, "notes.txt"), "turn one\n");
  const followUp = db.appendRunStep(run.id, "log", "Follow-up command", "Rewrite them", user("follow-up", { modelId: model.id, providerAccountId: provider.id, mode: "plan" }));
  db.saveRunTurnRestorePoint(run.id, {
    id: "point-2", stepId: followUp.id, prompt: "Rewrite them", createdAt: new Date().toISOString(), commandType: "follow-up", filesAvailable: true,
    patch: await gitService.createPromptRestorePatch(workspace.worktreePath), headSha: await gitService.getHeadCommitSha(workspace.worktreePath),
  });
  const secondAnswer = db.appendRunStep(run.id, "output", "Agent output", "Wrote turn two.", "{}");
  writeFileSync(join(workspace.worktreePath, "notes.txt"), "turn two\n");
  db.updateRunStatus(run.id, "completed");
  db.upsertProviderSessionRuntime(options.acp ? {
    ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType: "acp", harnessType: "acp",
    status: "ready", cwd: workspace.worktreePath, modelId: "gpt-test", runtimeMode: "code", resumeCursor: { sessionId: "source-session" },
    runtimePayload: { sessionType: "run", coordinatorPolicyHash: "policy-1" },
  } : {
    ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType: "codex-cli", harnessType: "codex-app-server",
    status: "ready", cwd: workspace.worktreePath, modelId: "gpt-test", runtimeMode: "code", resumeCursor: { threadId: "source-thread" },
  });
  const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(root, "logs"),
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  return { db, controller, run: db.getRun(run.id), firstAnswer, secondAnswer, followUp };
};

const step = (id: string, eventType: string, metadata: Record<string, unknown> = {}): RunStepRecord =>
  ({ id, runId: "run", eventType: eventType as RunStepRecord["eventType"], title: id, content: id, metadataJson: JSON.stringify(metadata), createdAt: "2026-11-25T10:00:00.000Z" });

describe("planRunFork", () => {
  const steps = [
    step("status", "status"),
    step("prompt", "log", { source: "user", commandType: "initial" }),
    step("answer", "output"),
    step("steer", "log", { source: "user", commandType: "steer" }),
    step("late", "output"),
    step("next", "log", { source: "user", commandType: "follow-up" }),
    step("final", "output"),
  ];

  it("keeps the whole turn, including messages steered into it", () => {
    const plan = planRunFork(steps, "answer");
    expect(plan.kept.map((entry) => entry.id)).toEqual(["status", "prompt", "answer", "steer", "late"]);
    expect(plan.nextPrompt?.id).toBe("next");
  });

  it("leaves the next turn's model and effort dividers out", () => {
    const withDividers = [
      ...steps.slice(0, 5),
      step("model", "status", { modelHandoff: { from: "a", to: "b" } }),
      step("effort", "status", { effortChange: { from: "low", to: "high" } }),
      ...steps.slice(5),
    ];
    const plan = planRunFork(withDividers, "answer");
    expect(plan.kept.map((entry) => entry.id)).toEqual(["status", "prompt", "answer", "steer", "late"]);
    expect(plan.nextPrompt?.id).toBe("next");
  });

  it("keeps everything when the turn is the latest", () => {
    expect(planRunFork(steps, "final")).toMatchObject({ kept: steps, nextPrompt: null });
  });

  it("refuses a step before the first prompt or one that is gone", () => {
    expect(() => planRunFork(steps, "status")).toThrow("after the run's first prompt");
    expect(() => planRunFork(steps, "missing")).toThrow("no longer in this run's history");
  });
});

describe("forkRun", () => {
  it("forks an earlier turn with its conversation and the files it left", async () => {
    const { db, controller, run, firstAnswer } = await setup();
    const fork = await controller.forkRun({ runId: run.id, stepId: firstAnswer.id });

    expect(fork).toMatchObject({ status: "completed", parentRunId: run.id, mode: "code", workspaceType: "worktree" });
    expect(fork.worktreePath).not.toBe(run.worktreePath);
    expect(readFileSync(join(fork.worktreePath, "notes.txt"), "utf8")).toBe("turn one\n");
    expect(readFileSync(join(run.worktreePath, "notes.txt"), "utf8")).toBe("turn two\n");
    const steps = db.getRunSteps(fork.id);
    expect(steps.map((entry) => entry.content)).toEqual(["Write the notes", "Wrote turn one.", expect.stringContaining("as they were when this turn ended")]);
    expect(JSON.parse(steps.at(-1)!.metadataJson)).toMatchObject({ forkedFromRunId: run.id, forkFiles: "turn-snapshot" });
    // The fork never borrows the source's provider session.
    expect(db.getProviderAccountSessionRuntime(fork.id, "run", fork.providerAccountId)).toBeNull();
    expect(db.getSettings().selectedRunId).toBe(fork.id);
  });

  it("forks a turn whose snapshot holds the shared dependency link", async () => {
    const { controller, run, firstAnswer } = await setup({ sharedDependencies: true });
    const fork = await controller.forkRun({ runId: run.id, stepId: firstAnswer.id });
    expect(readFileSync(join(fork.worktreePath, "notes.txt"), "utf8")).toBe("turn one\n");
    expect(lstatSync(join(fork.worktreePath, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(fork.worktreePath, "node_modules", "dep", "index.js"), "utf8")).toContain("module.exports");
  });

  it("gives a fork with isolated dependencies no link, even when the snapshot holds one", async () => {
    const { db, controller, run, firstAnswer } = await setup({ sharedDependencies: true });
    const profile = { id: "isolated", name: "Isolated", dependencies: "isolated", submodules: "none", commands: [], environmentFiles: [], previewCommand: "", previewUrl: "" };
    db.setSetting(APP_SETTING_KEYS.workspaceSetupProfiles, JSON.stringify({ [run.projectId]: { activeProfileId: profile.id, profiles: [profile] } }));
    const fork = await controller.forkRun({ runId: run.id, stepId: firstAnswer.id });
    expect(readFileSync(join(fork.worktreePath, "notes.txt"), "utf8")).toBe("turn one\n");
    expect(existsSync(join(fork.worktreePath, "node_modules"))).toBe(false);
  });

  it("forks the latest turn with the current files", async () => {
    const { db, controller, run, secondAnswer } = await setup();
    const fork = await controller.forkRun({ runId: run.id, stepId: secondAnswer.id });
    expect(fork.mode).toBe("plan");
    expect(readFileSync(join(fork.worktreePath, "notes.txt"), "utf8")).toBe("turn two\n");
    expect(db.getRunSteps(fork.id)).toHaveLength(5);
  });

  it("hands the copied conversation to the agent on the fork's first follow-up", async () => {
    const { controller, run, firstAnswer } = await setup();
    const fork = await controller.forkRun({ runId: run.id, stepId: firstAnswer.id });
    await controller.followUpRun(fork.id, "Now add a summary");
    const request = workers.requests.at(-1);
    expect(request?.providerSessionRuntime ?? null).toBeNull();
    expect(request?.prompt).toContain("Write the notes");
    expect(request?.prompt).toContain("Wrote turn one.");
    expect(request?.prompt).not.toContain("Wrote turn two.");
    expect(request?.prompt).toContain("Now add a summary");
  });

  it("forks the agent's own session when an ACP run is forked at its latest turn", async () => {
    const { db, controller, run, secondAnswer } = await setup({ acp: true });
    const fork = await controller.forkRun({ runId: run.id, stepId: secondAnswer.id });
    expect(db.getProviderAccountSessionRuntime(fork.id, "run", fork.providerAccountId)).toMatchObject({
      cwd: fork.worktreePath, resumeCursor: { forkFromSessionId: "source-session" }, runtimePayload: { coordinatorPolicyHash: "policy-1" },
    });
    const forkedStep = db.getRunSteps(fork.id).at(-1)!;
    expect(forkedStep.content).toContain("continues a fork of the agent's own session");
    expect(JSON.parse(forkedStep.metadataJson)).toMatchObject({ nativeSessionFork: true });
    // The source keeps its own session.
    expect(db.getProviderAccountSessionRuntime(run.id, "run", run.providerAccountId)?.resumeCursor).toEqual({ sessionId: "source-session" });

    await controller.followUpRun(fork.id, "Now add a summary");
    const request = workers.requests.at(-1);
    expect(request?.providerSessionRuntime?.resumeCursor).toEqual({ forkFromSessionId: "source-session" });
    // Should the agent fail to fork, a fresh session still receives the conversation.
    expect(request?.resumeFallbackContext).toContain("Wrote turn two.");
  });

  it("does not fork an ACP session for an earlier turn, or for an agent that cannot fork", async () => {
    const { db, controller, run, firstAnswer, secondAnswer } = await setup({ acp: true });
    const earlier = await controller.forkRun({ runId: run.id, stepId: firstAnswer.id });
    expect(db.getProviderAccountSessionRuntime(earlier.id, "run", earlier.providerAccountId)).toBeNull();

    db.setSetting(APP_SETTING_KEYS.reportedSessionCapabilities, JSON.stringify({ [run.providerAccountId]: { reportedAt: new Date().toISOString(), sessionFork: false } }));
    const latest = await controller.forkRun({ runId: run.id, stepId: secondAnswer.id });
    expect(db.getProviderAccountSessionRuntime(latest.id, "run", latest.providerAccountId)).toBeNull();
  });

  it("plans from the history a rewind that ran first left behind", async () => {
    const { db, controller, run, secondAnswer } = await setup();
    const rewind = controller.rewindRun({ runId: run.id, restorePointId: "point-2", mode: "conversation" });
    const fork = controller.forkRun({ runId: run.id, stepId: secondAnswer.id });
    await rewind;
    await expect(fork).rejects.toThrow("no longer in this run's history");
    expect(db.getRunSteps(run.id).map((entry) => entry.content)).not.toContain("Wrote turn two.");
  });

  it("removes a fork that fails after its run was created", async () => {
    const { db, controller, run, firstAnswer } = await setup();
    const copy = vi.spyOn(db, "copyRunSteps").mockImplementation(() => { throw new Error("disk full"); });
    await expect(controller.forkRun({ runId: run.id, stepId: firstAnswer.id })).rejects.toThrow("disk full");
    copy.mockRestore();
    const runs = db.listRunsWithStatuses(["queued", "preparing", "running", "completed", "failed", "cancelled"]);
    expect(runs.filter((entry) => entry.parentRunId === run.id)).toHaveLength(0);
    expect(readdirSync(join(run.worktreePath, ".."))).toEqual([basename(run.worktreePath)]);
  });

  it("takes the summary a rewind that ran first left behind", async () => {
    const { db, controller, run, firstAnswer } = await setup();
    db.updateRunStatus(run.id, "completed", { summary: "Wrote turn two." });
    const rewind = controller.rewindRun({ runId: run.id, restorePointId: "point-2", mode: "conversation" });
    // After the rewind, turn one is the latest, so the fork keeps the run's summary.
    const fork = controller.forkRun({ runId: run.id, stepId: firstAnswer.id });
    await rewind;
    expect((await fork).summary).toBeNull();
  });

  it("refuses a run that is still working", async () => {
    const { db, controller, run, firstAnswer } = await setup();
    db.updateRunStatus(run.id, "running");
    await expect(controller.forkRun({ runId: run.id, stepId: firstAnswer.id })).rejects.toThrow("Wait for this run to finish");
  });

  it("forks a run that may delegate until it has handed out tasks", async () => {
    const { db, controller, run, secondAnswer } = await setup();
    db.updateRunConfiguration(run.id, { delegationEnabled: true });
    const fork = await controller.forkRun({ runId: run.id, stepId: secondAnswer.id });
    expect(Boolean(fork.delegationEnabled)).toBe(true);

    db.createOrchestration({ projectId: run.projectId, coordinatorRunId: run.id, teamSnapshot: {} as never });
    await expect(controller.forkRun({ runId: run.id, stepId: secondAnswer.id })).rejects.toThrow("delegated tasks");
  });

  it("saves turn snapshots for a run that may delegate until it has handed out tasks", async () => {
    const { db, controller, run } = await setup();
    db.updateRunConfiguration(run.id, { delegationEnabled: true });
    const before = db.listRunTurnRestorePoints(run.id).length;
    await controller.followUpRun(run.id, "Third turn");
    const points = db.listRunTurnRestorePoints(run.id);
    expect(points).toHaveLength(before + 1);
    expect(points.at(-1)).toMatchObject({ prompt: "Third turn", filesAvailable: true });

    serviceOf(controller, "activeWorkers").runWorkers.delete(run.id);
    db.updateRunStatus(run.id, "completed");
    db.createOrchestration({ projectId: run.projectId, coordinatorRunId: run.id, teamSnapshot: {} as never });
    await controller.followUpRun(run.id, "Fourth turn");
    expect(db.listRunTurnRestorePoints(run.id)).toHaveLength(before + 1);
  });

  it("rewinds a run that may delegate until it has handed out tasks", async () => {
    const { db, controller, run } = await setup();
    db.updateRunConfiguration(run.id, { delegationEnabled: true });
    await controller.rewindRun({ runId: run.id, restorePointId: "point-2", mode: "conversation" });
    expect(db.getRunSteps(run.id).map((entry) => entry.content)).not.toContain("Wrote turn two.");
  });

  it("refuses to rewind a run that has handed out tasks", async () => {
    const { db, controller, run } = await setup();
    db.updateRunConfiguration(run.id, { delegationEnabled: true });
    db.createOrchestration({ projectId: run.projectId, coordinatorRunId: run.id, teamSnapshot: {} as never });
    await expect(controller.rewindRun({ runId: run.id, restorePointId: "point-2", mode: "conversation" })).rejects.toThrow("delegated tasks");
  });
});
