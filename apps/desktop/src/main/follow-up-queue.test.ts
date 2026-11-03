import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { FollowUpQueueOwnerKind, ProviderType, RunEvent } from "@buildwarden/shared";
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

type FakeWorker = {
  postMessage: (message: { type: string; requestId?: string; prompt?: string }) => void;
  once: () => void;
  off: () => void;
};

type Internals = {
  startWorker: (...args: unknown[]) => object;
  runWorkers: Map<string, { worker: FakeWorker; cancelled: boolean; providerType?: ProviderType }>;
  capturePromptRestorePoint: () => Promise<void>;
  buildIntegratedSkillContext: () => Promise<undefined>;
  dispatchQueuedFollowUps: (kind: FollowUpQueueOwnerKind, ownerId: string) => Promise<string[]>;
  settleFollowUpSteer: (payload: { type: "steer-result"; requestId: string; error?: string; outcomeUnknown?: boolean }) => void;
};

const setup = async (providerType: ProviderType = "codex-cli") => {
  const dir = await mkdtemp(join(tmpdir(), "bw-follow-up-queue-")); dirs.push(dir);
  const cwd = join(dir, "repo"); await mkdir(cwd);
  const git = (...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  await git("init", "-b", "main"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.txt"), "original\n"); await git("add", "."); await git("commit", "-m", "Initial");

  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
  const project = db.addProject({ repoPath: cwd, baseBranch: "main", resolvedName: "Project" });
  const provider = db.addProviderAccount({ providerType, label: "Agent", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "agent-model", displayName: "Agent", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id,
    harnessType: providerType === "codex-cli" ? "codex-app-server" : "claude-code",
    mode: "code", workspaceType: "local", prompt: "Build the feature", branchName: "main", worktreePath: cwd,
  });
  db.appendRunStep(run.id, "log", "Initial command", "Build the feature", JSON.stringify({ source: "user", commandType: "initial", modelId: model.id }));
  db.updateRunStatus(run.id, "completed");
  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const events = new HostEventBus();
  const runEvents: RunEvent[] = [];
  events.subscribe("run", (event) => { runEvents.push(event); });
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, events);
  const internals = controller as unknown as Internals;
  const startWorker = vi.spyOn(internals, "startWorker").mockReturnValue({});
  vi.spyOn(internals, "capturePromptRestorePoint").mockResolvedValue(undefined);
  vi.spyOn(internals, "buildIntegratedSkillContext").mockResolvedValue(undefined);

  /** Puts the run mid-turn on a worker that answers steering with `steerError` (or accepts it). */
  const startTurn = (options: { steerError?: string; outcomeUnknown?: boolean } = {}) => {
    const posted: Array<{ type: string; prompt?: string }> = [];
    const worker: FakeWorker = {
      postMessage: (message) => {
        posted.push(message);
        if (message.type === "steer" && message.requestId) {
          const requestId = message.requestId;
          queueMicrotask(() => internals.settleFollowUpSteer({
            type: "steer-result", requestId,
            ...(options.steerError ? { error: options.steerError, outcomeUnknown: options.outcomeUnknown === true } : {}),
          }));
        }
      },
      once: () => undefined,
      off: () => undefined,
    };
    internals.runWorkers.set(run.id, { worker, cancelled: false, providerType });
    db.updateRunStatus(run.id, "running");
    return posted;
  };
  /** Ends the running turn the way the worker handler does. */
  const finishTurn = (status: "completed" | "cancelled" | "failed" = "completed") => {
    internals.runWorkers.delete(run.id);
    db.updateRunStatus(run.id, status);
  };
  const startedPrompts = () => startWorker.mock.calls.map((call) => (call[5] as { promptOverride?: string }).promptOverride ?? "");

  return { db, controller, internals, run, model, startWorker, startTurn, finishTurn, startedPrompts, runEvents };
};

describe("follow-up queue", () => {
  it("queues follow-ups while a turn runs and starts them in order as turns complete", async () => {
    const { db, controller, internals, run, startWorker, startTurn, finishTurn, startedPrompts } = await setup();
    startTurn();

    const first = await controller.queueRunFollowUp(run.id, "First follow-up", { mode: "code" });
    const second = await controller.queueRunFollowUp(run.id, "Second follow-up", { mode: "plan" });
    expect(first.outcome).toBe("queued");
    expect(second.queue.map((entry) => [entry.prompt, entry.mode, entry.runId])).toEqual([
      ["First follow-up", "code", run.id],
      ["Second follow-up", "plan", run.id],
    ]);
    expect(startWorker).not.toHaveBeenCalled();

    finishTurn();
    await internals.dispatchQueuedFollowUps("run", run.id);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startedPrompts()[0]).toContain("First follow-up");
    expect(db.listQueuedFollowUps("run", run.id).map((entry) => entry.prompt)).toEqual(["Second follow-up"]);

    finishTurn();
    await internals.dispatchQueuedFollowUps("run", run.id);
    expect(startedPrompts()[1]).toContain("Second follow-up");
    expect(db.getRun(run.id).mode).toBe("plan");
    expect(db.listQueuedFollowUps("run", run.id)).toEqual([]);
  });

  it("keeps attachments with the queued follow-up and passes them to the started turn", async () => {
    const { controller, internals, run, startWorker, startTurn, finishTurn } = await setup();
    startTurn();
    const attachment = { fileName: "notes.txt", mimeType: "text/plain", dataBase64: Buffer.from("hello").toString("base64") };
    const queued = await controller.queueRunFollowUp(run.id, "Use the notes", { attachments: [attachment] });
    expect(queued.queue[0]?.attachments).toEqual([{ fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 5 }]);
    expect(JSON.stringify(queued.queue)).not.toContain(attachment.dataBase64);

    finishTurn();
    await internals.dispatchQueuedFollowUps("run", run.id);
    const workerOptions = startWorker.mock.calls[0]?.[5] as { attachments?: unknown[] };
    expect(workerOptions.attachments).toEqual([attachment]);
  });

  it("holds the queue after a cancelled turn until the user resumes, and keeps order for new messages", async () => {
    const { db, controller, run, startTurn, finishTurn, startedPrompts } = await setup();
    startTurn();
    await controller.queueRunFollowUp(run.id, "Held follow-up");
    finishTurn("cancelled");

    // A new message while the queue is held goes behind the held one; the oldest starts first.
    const next = await controller.queueRunFollowUp(run.id, "Newer follow-up");
    expect(next.outcome).toBe("queued");
    expect(startedPrompts()).toHaveLength(1);
    expect(startedPrompts()[0]).toContain("Held follow-up");
    expect(db.listQueuedFollowUps("run", run.id).map((entry) => entry.prompt)).toEqual(["Newer follow-up"]);
  });

  it("resumes a held queue on request", async () => {
    const { db, controller, run, startTurn, finishTurn, startedPrompts } = await setup();
    startTurn();
    await controller.queueRunFollowUp(run.id, "Held follow-up");
    finishTurn("failed");
    expect(db.listQueuedFollowUps("run", run.id)).toHaveLength(1);

    const resumed = await controller.updateRunFollowUpQueue(run.id, { type: "resume" });
    expect(resumed.outcome).toBe("started");
    expect(startedPrompts()[0]).toContain("Held follow-up");
    expect(resumed.queue).toEqual([]);
  });

  it("returns an entry to its place when its turn cannot start", async () => {
    const { db, controller, internals, run, startWorker, startTurn, finishTurn } = await setup();
    startTurn();
    await controller.queueRunFollowUp(run.id, "First");
    await controller.queueRunFollowUp(run.id, "Second");
    finishTurn();
    startWorker.mockImplementationOnce(() => { throw new Error("Workers are unavailable."); });

    await internals.dispatchQueuedFollowUps("run", run.id);
    expect(db.listQueuedFollowUps("run", run.id).map((entry) => entry.prompt)).toEqual(["First", "Second"]);
    const held = db.getRunSteps(run.id).at(-1);
    expect(held?.title).toBe("Queued follow-up held");
    expect(held?.content).toContain("Workers are unavailable.");

    startWorker.mockImplementationOnce(() => { throw new Error("Still unavailable."); });
    await expect(controller.updateRunFollowUpQueue(run.id, { type: "resume" })).rejects.toThrow("Still unavailable.");
    expect(db.listQueuedFollowUps("run", run.id)).toHaveLength(2);
  });

  it("edits, reorders, and removes queued follow-ups", async () => {
    const { controller, run, startTurn } = await setup();
    startTurn();
    await controller.queueRunFollowUp(run.id, "One");
    await controller.queueRunFollowUp(run.id, "Two");
    const { queue } = await controller.queueRunFollowUp(run.id, "Three");
    const [one, two, three] = queue;

    await controller.updateRunFollowUpQueue(run.id, { type: "edit", queuedFollowUpId: two!.id, prompt: "  Two, revised  " });
    await controller.updateRunFollowUpQueue(run.id, { type: "move", queuedFollowUpId: three!.id, direction: "up" });
    let result = await controller.updateRunFollowUpQueue(run.id, { type: "move", queuedFollowUpId: one!.id, direction: "up" });
    expect(result.queue.map((entry) => entry.prompt)).toEqual(["One", "Three", "Two, revised"]);

    result = await controller.updateRunFollowUpQueue(run.id, { type: "delete", queuedFollowUpId: three!.id });
    expect(result.queue.map((entry) => entry.prompt)).toEqual(["One", "Two, revised"]);
    await expect(controller.updateRunFollowUpQueue(run.id, { type: "edit", queuedFollowUpId: one!.id, prompt: "  " }))
      .rejects.toThrow(/needs text/);
    await expect(controller.updateRunFollowUpQueue(run.id, { type: "delete", queuedFollowUpId: three!.id }))
      .rejects.toThrow(/already sent or removed/);
  });

  it("steers a follow-up into a running Codex turn and records it in the timeline", async () => {
    const { db, controller, run, startWorker, startTurn, runEvents } = await setup("codex-cli");
    const posted = startTurn();

    const result = await controller.queueRunFollowUp(run.id, "Also cover the edge case", undefined, "steer");
    expect(result).toMatchObject({ outcome: "steered", queue: [] });
    expect(posted).toEqual([expect.objectContaining({ type: "steer", prompt: "Also cover the edge case" })]);
    expect(startWorker).not.toHaveBeenCalled();
    const step = db.getRunSteps(run.id).at(-1);
    expect(step?.content).toBe("Also cover the edge case");
    expect(JSON.parse(step?.metadataJson ?? "{}")).toMatchObject({ source: "user", commandType: "steer", steered: true });
    expect(runEvents.some((event) => event.step?.id === step?.id)).toBe(true);
  });

  it("keeps a follow-up queued when the running turn refuses steering", async () => {
    const { db, controller, run, startTurn } = await setup("codex-cli");
    startTurn({ steerError: "The Codex turn is still starting." });

    const result = await controller.queueRunFollowUp(run.id, "Steer me", undefined, "steer");
    expect(result.outcome).toBe("queued");
    expect(result.steerError).toBe("The Codex turn is still starting.");
    expect(result.queue.map((entry) => entry.prompt)).toEqual(["Steer me"]);
    expect(db.getRunSteps(run.id).some((step) => step.content === "Steer me")).toBe(false);
  });

  it("does not steer providers without turn input and moves send-now entries to the front instead", async () => {
    const { controller, run, startTurn } = await setup("claude-code");
    const posted = startTurn();
    await controller.queueRunFollowUp(run.id, "First");
    const queued = await controller.queueRunFollowUp(run.id, "Second", undefined, "steer");
    expect(queued.outcome).toBe("queued");
    expect(queued.steerError).toMatch(/cannot take messages during a turn/);
    expect(posted).toEqual([]);

    const second = queued.queue[1]!;
    const sendNow = await controller.updateRunFollowUpQueue(run.id, { type: "send-now", queuedFollowUpId: second.id });
    expect(sendNow.outcome).toBe("moved-to-front");
    expect(sendNow.queue.map((entry) => entry.prompt)).toEqual(["Second", "First"]);
  });

  it("starts follow-ups immediately when the run is idle and nothing is queued", async () => {
    const { controller, run, startedPrompts } = await setup();
    const result = await controller.queueRunFollowUp(run.id, "Right away");
    expect(result).toMatchObject({ outcome: "started", queue: [] });
    expect(startedPrompts()[0]).toContain("Right away");
  });

  it("removes a run's queue when the run is deleted", async () => {
    const { db, controller, run, startTurn } = await setup();
    startTurn();
    await controller.queueRunFollowUp(run.id, "Soon gone");
    db.deleteRun(run.id);
    expect(db.listQueuedFollowUps("run", run.id)).toEqual([]);
  });

  it("keeps a starting entry persisted until its turn runs and tags the user step with its id", async () => {
    const { db, controller, internals, run, startWorker, startTurn, finishTurn } = await setup();
    startTurn();
    const { queue } = await controller.queueRunFollowUp(run.id, "Survive a crash");
    const id = queue[0]!.id;
    finishTurn();
    let stateDuringStart: string | null | undefined;
    startWorker.mockImplementationOnce(() => {
      stateDuringStart = db.getQueuedFollowUpEntry(id)?.deliveryState;
      return {};
    });
    await internals.dispatchQueuedFollowUps("run", run.id);
    expect(stateDuringStart).toBe("starting");
    expect(db.getQueuedFollowUpEntry(id)).toBeNull();
    expect(db.hasStepForQueuedFollowUp("run", run.id, id)).toBe(true);
  });

  it("settles deliveries cut off by a restart", async () => {
    const { db, controller, run, startTurn } = await setup();
    startTurn();
    const delivered = (await controller.queueRunFollowUp(run.id, "Reached the turn")).queue[0]!.id;
    const notStarted = (await controller.queueRunFollowUp(run.id, "Never started")).queue[1]!.id;
    const steered = (await controller.queueRunFollowUp(run.id, "Maybe steered")).queue[2]!.id;
    db.setQueuedFollowUpDeliveryState(delivered, "starting");
    db.appendRunStep(run.id, "log", "Follow-up command", "Reached the turn", JSON.stringify({ source: "user", commandType: "follow-up", queuedFollowUpId: delivered }));
    db.setQueuedFollowUpDeliveryState(notStarted, "starting");
    db.setQueuedFollowUpDeliveryState(steered, "steering");
    expect(db.listQueuedFollowUps("run", run.id)).toEqual([]);

    await controller.reconcileOrphanedActiveSessions();
    expect(db.getQueuedFollowUpEntry(delivered)).toBeNull();
    expect(db.listQueuedFollowUps("run", run.id).map((entry) => [entry.prompt, entry.deliveryUncertain])).toEqual([
      ["Never started", false],
      ["Maybe steered", true],
    ]);
  });

  it("flags an unconfirmed steer instead of resending it, until the user sends it again", async () => {
    const { db, controller, internals, run, startTurn, finishTurn, startedPrompts } = await setup("codex-cli");
    startTurn({ steerError: "Timed out waiting for turn/steer.", outcomeUnknown: true });

    const result = await controller.queueRunFollowUp(run.id, "Did this arrive?", undefined, "steer");
    expect(result.steerOutcomeUnknown).toBe(true);
    expect(result.steerError).toContain("will not send on its own");
    expect(result.queue).toEqual([expect.objectContaining({ prompt: "Did this arrive?", deliveryUncertain: true })]);
    expect(db.getRunSteps(run.id).at(-1)?.title).toBe("Steered message unconfirmed");

    finishTurn();
    await internals.dispatchQueuedFollowUps("run", run.id);
    expect(startedPrompts()).toEqual([]);
    await expect(controller.updateRunFollowUpQueue(run.id, { type: "resume" })).rejects.toThrow(/may already have reached the agent/);

    const sent = await controller.updateRunFollowUpQueue(run.id, { type: "send-now", queuedFollowUpId: result.queue[0]!.id });
    expect(sent).toMatchObject({ outcome: "started", queue: [] });
    expect(startedPrompts()[0]).toContain("Did this arrive?");
  });

  it("refuses to steer model or mode changes and notes kept execution settings", async () => {
    const { db, controller, run, model, startTurn } = await setup("codex-cli");
    const otherModel = db.addModel({ providerAccountId: model.providerAccountId, modelId: "other-model", displayName: "Other", config: {}, capabilities: {}, enabled: true });
    const posted = startTurn();

    const modelChange = await controller.queueRunFollowUp(run.id, "Use the other model", { modelId: otherModel.id }, "steer");
    expect(modelChange.steerError).toMatch(/model change waits/);
    const modeChange = await controller.queueRunFollowUp(run.id, "Plan instead", { modelId: model.id, mode: "plan" }, "steer");
    expect(modeChange.steerError).toMatch(/mode change waits/);
    expect(posted).toEqual([]);

    const effortChange = await controller.queueRunFollowUp(run.id, "Think harder", { modelId: model.id, mode: "code", reasoningEffort: "high" }, "steer");
    expect(effortChange.outcome).toBe("steered");
    expect(effortChange.notice).toMatch(/keeps its current reasoning/);
    expect(effortChange.queue.map((entry) => entry.prompt)).toEqual(["Use the other model", "Plan instead"]);
  });
});
