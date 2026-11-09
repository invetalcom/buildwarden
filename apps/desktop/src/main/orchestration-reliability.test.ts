import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type {
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
  OrchestrationTeamSettings,
  RunRecord,
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

interface Internals {
  runWorkers: Map<string, unknown>;
  followUpRunInternal: (...args: unknown[]) => Promise<unknown>;
  handleOrchestrationChildTerminal: (childRunId: string) => Promise<void>;
  captureOrchestrationResultSnapshot: (...args: unknown[]) => Promise<string | undefined>;
  executeOrchestrationTool: (runId: string, callId: string, toolName: string, args: Record<string, unknown>) => Promise<RunToolResult>;
  maybeWakeOrchestrationCoordinator: (orchestrationId: string) => Promise<void>;
  discardPreparedRunWorkspace: (...args: unknown[]) => Promise<boolean>;
  getProviderLimitState: () => Promise<null>;
}

/** A controller over a real database, as the app has after a restart. */
const openController = (db: BuildWardenDatabase, dir: string) => {
  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  const internals = controller as unknown as Internals;
  const followUp = vi.fn(async () => undefined);
  internals.followUpRunInternal = followUp;
  internals.getProviderLimitState = async () => null;
  return { controller, internals, followUp };
};

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-orchestration-recovery-"));
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
  const addChildTask = (clientTaskId: string, status: OrchestrationTaskStatus): { child: RunRecord; task: OrchestrationTaskRecord } => {
    const child = db.createRun({ ...runInput, prompt: "Inspect", kind: "orchestration-task", parentRunId: coordinator.id, rootRunId: coordinator.id });
    const created = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId, title: clientTaskId, prompt: "Inspect",
      roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    return { child, task: db.updateOrchestrationTask(created.id, { status, childRunId: child.id }) };
  };
  return { dir, db, project, model, coordinator, orchestration, wave, addChildTask, ...openController(db, dir) };
};

describe("result publication across a crash", () => {
  it("does not report a task complete until its result is published", async () => {
    const { db, orchestration, internals, addChildTask } = await fixture();
    const { child, task } = addChildTask("review", "running");
    db.updateRunStatus(child.id, "completed", { summary: "Found two bugs." });
    let observed: OrchestrationTaskStatus | null = null;
    internals.captureOrchestrationResultSnapshot = vi.fn(async () => {
      // The snapshot phase runs while the outcome is only an intent.
      observed = db.getOrchestrationTask(task.id).status;
      return undefined;
    });

    await internals.handleOrchestrationChildTerminal(child.id);

    expect(observed).toBe("running");
    expect(db.getOrchestrationTask(task.id).status).toBe("completed");
    expect(db.listOrchestrationTaskResults(task.id)).toMatchObject([{ version: 1, summary: "Found two bugs.", status: "completed" }]);
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("finishes a publication the app stopped in the middle of", async () => {
    const { dir, db, orchestration, addChildTask } = await fixture();
    const { child, task } = addChildTask("review", "running");
    db.updateRunStatus(child.id, "completed", { summary: "Recovered summary." });
    // The app stopped after recording the outcome and before publishing it.
    db.createOrchestrationEffect({
      orchestrationId: orchestration.id, taskId: task.id, kind: "publish-result",
      payload: { childRunId: child.id, status: "completed", summary: "Recovered summary.", errorMessage: null, inputTokens: 5, outputTokens: 7 },
    });
    db.updateRunStatus(orchestration.coordinatorRunId, "completed");
    const { controller } = openController(db, dir);

    await controller.reconcileOrchestrationsAfterRestart();

    expect(db.getOrchestrationTask(task.id)).toMatchObject({ status: "completed", summary: "Recovered summary.", inputTokens: 5, outputTokens: 7 });
    expect(db.listOrchestrationTaskResults(task.id)).toHaveLength(1);
    const types = db.listOrchestrationEvents(orchestration.id).map((event) => event.type);
    expect(types).toContain("task-completed");
    expect(types).toContain("recovered");
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("settles a child that finished before the app could record anything", async () => {
    const { dir, db, addChildTask } = await fixture();
    const { child, task } = addChildTask("review", "running");
    db.updateRunStatus(child.id, "failed", { errorMessage: "Tests failed." });
    const { controller } = openController(db, dir);

    await controller.reconcileOrchestrationsAfterRestart();

    expect(db.getOrchestrationTask(task.id)).toMatchObject({ status: "failed", attentionReason: "Tests failed." });
    expect(db.listOrchestrationTaskResults(task.id)).toMatchObject([{ status: "failed", errorMessage: "Tests failed." }]);
  });

  it("publishes a recorded failure instead of deferring it when a limit becomes known after the crash", async () => {
    const { dir, db, orchestration, addChildTask } = await fixture();
    const { child, task } = addChildTask("limited", "running");
    db.updateRunStatus(child.id, "failed", { errorMessage: "You have hit your usage limit." });
    db.createOrchestrationEffect({
      orchestrationId: orchestration.id, taskId: task.id, kind: "publish-result",
      payload: { childRunId: child.id, status: "failed", summary: null, errorMessage: "You have hit your usage limit." },
    });
    const { controller, internals } = openController(db, dir);
    const resetsAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    internals.getProviderLimitState = vi.fn(async () => ({ reason: "Usage limit", resetsAt })) as unknown as Internals["getProviderLimitState"];

    await controller.reconcileOrchestrationsAfterRestart();

    expect(db.getOrchestrationTask(task.id)).toMatchObject({ status: "failed", deferredUntil: null });
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("reuses a snapshot taken before the crash instead of taking another", async () => {
    const { dir, db, orchestration, addChildTask } = await fixture();
    const { child, task } = addChildTask("implement", "running");
    db.updateRunStatus(child.id, "completed", { summary: "Done." });
    const snapshot = join(dir, "snapshot");
    await mkdir(snapshot);
    db.createOrchestrationEffect({
      orchestrationId: orchestration.id, taskId: task.id, kind: "publish-result",
      payload: { childRunId: child.id, status: "completed", summary: "Done.", workspaceSnapshotPath: snapshot },
    });
    const { controller, internals } = openController(db, dir);
    const capture = vi.fn(async () => "unexpected");
    internals.captureOrchestrationResultSnapshot = capture;

    await controller.reconcileOrchestrationsAfterRestart();

    expect(capture).not.toHaveBeenCalled();
    expect(db.listOrchestrationTaskResults(task.id)[0]?.workspaceSnapshotPath).toBe(snapshot);
  });
});

describe("other interrupted side effects", () => {
  it("removes a child workspace whose run was never created and requeues the task", async () => {
    const { dir, db, orchestration, model, wave } = await fixture();
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId: "lost", title: "Lost", prompt: "Inspect",
      roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    db.updateOrchestrationTask(task.id, { status: "provisioning" });
    const workspace = { workspaceType: "worktree", workspaceVcs: "git", branchName: "bw/lost", worktreePath: join(dir, "lost-worktree") };
    db.createOrchestrationEffect({ orchestrationId: orchestration.id, taskId: task.id, kind: "launch-child", payload: { workspace } });
    const { controller, internals } = openController(db, dir);
    const discard = vi.fn(async () => true);
    internals.discardPreparedRunWorkspace = discard;
    vi.spyOn(internals as unknown as { dispatchOrchestrationTasks: () => Promise<void> }, "dispatchOrchestrationTasks").mockResolvedValue();

    await controller.reconcileOrchestrationsAfterRestart();

    expect(discard).toHaveBeenCalledWith(dir, workspace);
    expect(db.getOrchestrationTask(task.id).status).toBe("pending");
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("advances the delivery cursor when the coordinator turn did start", async () => {
    const { dir, db, orchestration, coordinator } = await fixture();
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, type: "task-completed", title: "t", content: "c" });
    const target = db.getOrchestration(orchestration.id).lastEventSequence;
    const effect = db.createOrchestrationEffect({
      orchestrationId: orchestration.id, kind: "deliver-update",
      payload: { targetSequence: target, previousWakeMode: "all-terminal", previousWakeTaskIds: [] },
    });
    db.updateOrchestration(orchestration.id, { status: "active", wakeMode: null });
    db.appendRunStep(coordinator.id, "log", "Follow-up command", "update", JSON.stringify({ source: "orchestration", orchestrationDeliveryId: effect.id }));
    db.appendRunStep(coordinator.id, "output", "Agent output", "Reviewing the results.");
    db.updateRunStatus(coordinator.id, "completed");
    const { controller } = openController(db, dir);

    await controller.reconcileOrchestrationsAfterRestart();

    expect(db.getOrchestration(orchestration.id).lastDeliveredSequence).toBeGreaterThanOrEqual(target);
    expect(db.getOrchestrationEffect(effect.id)?.status).toBe("completed");
  });

  /** A delivery whose follow-up step was written, but whose worker never started. */
  const unstartedDelivery = async (userWake: boolean) => {
    const context = await fixture();
    const { db, orchestration, coordinator, addChildTask } = context;
    const { child, task } = addChildTask("finished", "completed");
    db.updateRunStatus(child.id, "completed");
    db.publishOrchestrationTaskResult(task.id);
    db.updateOrchestrationTask(task.id, { adoptionStatus: "proposed" });
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "task-completed", title: "t", content: "c" });
    const effect = db.createOrchestrationEffect({
      orchestrationId: orchestration.id, kind: "deliver-update",
      payload: { targetSequence: db.getOrchestration(orchestration.id).lastEventSequence, previousWakeMode: "adoption-decided", previousWakeTaskIds: [task.id], userWake },
    });
    db.updateOrchestration(orchestration.id, { status: "active", wakeMode: null, wakeTaskIds: [] });
    db.appendRunStep(coordinator.id, "log", "Follow-up command", "update", JSON.stringify({ source: userWake ? "user" : "orchestration", orchestrationDeliveryId: effect.id }));
    db.updateRunStatus(coordinator.id, "cancelled", { errorMessage: "Session interrupted" });
    const reopened = openController(db, context.dir);
    const recover = vi.spyOn(reopened.controller, "recoverInterruptedRun").mockResolvedValue();
    await reopened.controller.reconcileOrchestrationsAfterRestart();
    return { ...context, ...reopened, effect, task, recover };
  };

  it("repeats an automatic update whose turn showed no activity before the crash", async () => {
    const { db, orchestration, effect, task } = await unstartedDelivery(false);
    expect(db.getOrchestration(orchestration.id)).toMatchObject({
      status: "waiting", wakeMode: "adoption-decided", wakeTaskIds: [task.id], lastDeliveredSequence: 0,
    });
    expect(db.getOrchestrationEffect(effect.id)?.status).toBe("failed");
  });

  it("holds an undelivered user follow-up for the user instead of resuming without it", async () => {
    const { db, orchestration, effect, recover } = await unstartedDelivery(true);
    expect(db.getOrchestration(orchestration.id)).toMatchObject({
      status: "attention", lastDeliveredSequence: 0, errorMessage: expect.stringContaining("Send it again"),
    });
    expect(recover).not.toHaveBeenCalled();
    expect(db.getOrchestrationEffect(effect.id)?.status).toBe("failed");
  });

  it("restores the exact wake condition when the coordinator turn never started", async () => {
    const { dir, db, orchestration, coordinator, addChildTask } = await fixture();
    // The task has a published result, so task recovery leaves it alone and no child restarts.
    const { child, task } = addChildTask("finished", "completed");
    db.updateRunStatus(child.id, "completed");
    db.publishOrchestrationTaskResult(task.id);
    // The coordinator was waiting on a decision that is still open, so nothing wakes it.
    db.updateOrchestrationTask(task.id, { adoptionStatus: "proposed" });
    const effect = db.createOrchestrationEffect({
      orchestrationId: orchestration.id, kind: "deliver-update",
      payload: { targetSequence: 1, previousWakeMode: "adoption-decided", previousWakeTaskIds: [task.id] },
    });
    db.updateOrchestration(orchestration.id, { status: "active", wakeMode: null, wakeTaskIds: [] });
    db.updateRunStatus(coordinator.id, "completed");
    const { controller, internals } = openController(db, dir);
    vi.spyOn(internals as unknown as { recoverInterruptedRun: () => Promise<void> }, "recoverInterruptedRun").mockResolvedValue();

    await controller.reconcileOrchestrationsAfterRestart();

    expect(db.getOrchestration(orchestration.id)).toMatchObject({ status: "waiting", wakeMode: "adoption-decided", wakeTaskIds: [task.id] });
    expect(db.getOrchestration(orchestration.id).lastDeliveredSequence).toBe(0);
    expect(db.getOrchestrationEffect(effect.id)?.status).toBe("failed");
  });

  it("records a completed delivery receipt when a coordinator wake starts", async () => {
    const { db, orchestration, internals, addChildTask } = await fixture();
    const { task } = addChildTask("finished", "completed");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "task-completed", title: "t", content: "c" });
    db.updateOrchestration(orchestration.id, { status: "waiting", wakeMode: "all-terminal", wakeTaskIds: [task.id] });
    db.updateRunStatus(orchestration.coordinatorRunId, "completed");

    await internals.maybeWakeOrchestrationCoordinator(orchestration.id);

    const followUp = internals.followUpRunInternal as unknown as ReturnType<typeof vi.fn>;
    const metadata = followUp.mock.calls[0]?.[3] as { orchestrationDeliveryId: string };
    expect(metadata).toMatchObject({ orchestrationDeliveryId: expect.any(String) });
    expect(db.getOrchestrationEffect(metadata.orchestrationDeliveryId)?.status).toBe("completed");
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });
});

/** Runs a coordinator tool as the worker would, returning the parsed answer and its raw size. */
const callTool = async (internals: Internals, coordinatorRunId: string, toolName: string, args: Record<string, unknown>) => {
  internals.runWorkers.set(coordinatorRunId, { cancelled: false, providerType: "codex-cli" });
  const result = await internals.executeOrchestrationTool(coordinatorRunId, `call-${toolName}`, toolName, args);
  return { size: result.content.length, body: JSON.parse(result.content) as Record<string, unknown> };
};

const stubChildSummary = (internals: Internals) => Object.assign(internals, {
  getRunWorktreeDiffSummary: async () => ({ summary: { files: [] }, worktreeUnavailable: true }),
});

describe("buildwarden_tasks_read stays bounded", () => {
  it("never repeats a published result's text through event metadata", async () => {
    const { db, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("huge", "completed");
    db.updateOrchestrationTask(task.id, { summary: "s".repeat(120_000) });
    db.publishOrchestrationTaskResult(task.id);
    db.publishOrchestrationTaskResult(task.id);
    stubChildSummary(internals);

    const { size, body } = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id });

    expect(size).toBeLessThan(45_000);
    const activity = body.activity as Array<Record<string, unknown>>;
    expect(activity.filter((entry) => entry.type === "result-published").every((entry) => typeof entry.resultId === "string")).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("s".repeat(1_100));
    expect((body.task as Record<string, unknown>).nextSummaryOffset).toBe(32_000);
  });

  it("pages messages instead of returning every one", async () => {
    const { db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("chatty", "running");
    for (let index = 0; index < 25; index += 1) {
      db.createOrchestrationTaskMessage({ orchestrationId: orchestration.id, taskId: task.id, source: "coordinator", content: `${String(index)} ${"m".repeat(5_000)}` });
    }
    stubChildSummary(internals);

    const first = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id });
    const second = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id, messagesOffset: first.body.nextMessagesOffset });

    expect(first.body).toMatchObject({ totalMessages: 25, nextMessagesOffset: 10 });
    expect((first.body.messages as Array<{ content: string }>)[0]!.content.length).toBeLessThan(2_100);
    expect((second.body.messages as unknown[]).length).toBe(10);
    expect(second.body.nextMessagesOffset).toBe(20);
  });

  it("keeps the whole answer under budget even with a large diff and many steps", async () => {
    const { db, coordinator, internals, addChildTask } = await fixture();
    const { child, task } = addChildTask("busy", "completed");
    db.updateOrchestrationTask(task.id, { summary: "r".repeat(40_000) });
    for (let index = 0; index < 50; index += 1) db.appendRunStep(child.id, "output", `Output ${String(index)}`, "o".repeat(5_000));
    Object.assign(internals, {
      getRunWorktreeDiffSummary: async () => ({ summary: { files: [] }, worktreeUnavailable: false }),
      getRunWorktreeDiff: async () => ({ diff: "+line\n".repeat(30_000) }),
    });

    const { size, body } = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id, recentSteps: 50, includeDiff: true });

    expect(size).toBeLessThanOrEqual(120_000);
    expect(body.responseTruncated).toEqual(expect.any(String));
  });
});

describe("coded tool failures", () => {
  it("names an unknown task with a stable code", async () => {
    const { coordinator, internals } = await fixture();
    internals.runWorkers.set(coordinator.id, {});
    await expect(internals.executeOrchestrationTool(coordinator.id, "c", "buildwarden_tasks_read", { taskId: "missing" }))
      .rejects.toMatchObject({ code: "task_not_found" });
  });

  it("keeps a code when a failed request is retried with the same requestId", async () => {
    const { coordinator, internals } = await fixture();
    internals.runWorkers.set(coordinator.id, {});
    const args = { requestId: "request-1", tasks: [{ clientTaskId: "a", title: "A", prompt: "Inspect", roleId: "nobody", intent: "inspect" }] };
    await expect(internals.executeOrchestrationTool(coordinator.id, "c1", "buildwarden_tasks_delegate", args)).rejects.toMatchObject({ code: "role_unknown" });
    await expect(internals.executeOrchestrationTool(coordinator.id, "c2", "buildwarden_tasks_delegate", args)).rejects.toMatchObject({ code: "operation_failed_previously" });
    await expect(internals.executeOrchestrationTool(coordinator.id, "c3", "buildwarden_tasks_delegate", { ...args, tasks: [] }))
      .rejects.toMatchObject({ code: "request_id_conflict" });
  });
});

describe("per-task execution options", () => {
  const withEffortProfile = async () => {
    const context = await fixture();
    const { db, model } = context;
    const profiled = db.addModel({
      providerAccountId: model.providerAccountId, modelId: "profiled", displayName: "Profiled", capabilities: {}, enabled: true,
      config: { buildwardenExecutionProfile: { source: "provider", controls: [{ id: "reasoningEffort", label: "Effort", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] }] } },
    });
    const team = context.orchestration.teamSnapshot;
    db.updateOrchestration(context.orchestration.id, { teamSnapshot: {
      ...team,
      models: [{ modelId: profiled.id, enabled: true, maxConcurrent: 4 }],
      roles: team.roles.map((role) => ({ ...role, eligibleModelIds: [profiled.id], preferredModelId: profiled.id })),
    } });
    return context;
  };

  it("lists what a task may set for each model, and rejects anything else", async () => {
    const { coordinator, internals } = await withEffortProfile();
    const view = await callTool(internals, coordinator.id, "buildwarden_orchestration_get", {});
    expect((view.body.models as Array<Record<string, unknown>>)[0]).toMatchObject({ executionOptions: { reasoningEffort: ["low", "high"] } });

    const delegate = (executionOptions: Record<string, unknown>, requestId: string) => internals.executeOrchestrationTool(coordinator.id, requestId, "buildwarden_tasks_delegate", {
      requestId, tasks: [{ clientTaskId: requestId, title: "T", prompt: "Inspect", roleId: "researcher", intent: "inspect", executionOptions }],
    });
    await expect(delegate({ reasoningEffort: "ultra" }, "request-bad-value")).rejects.toMatchObject({ code: "execution_option_unsupported" });
    await expect(delegate({ serviceTier: "fast" }, "request-bad-key")).rejects.toMatchObject({ code: "execution_option_unsupported" });
    // Arguments arrive as parsed JSON, which can carry own keys named like Object.prototype members.
    for (const key of ["constructor", "toString", "__proto__"]) {
      await expect(delegate(JSON.parse(`{"${key}":"high"}`) as Record<string, unknown>, `request-proto-${key}`))
        .rejects.toMatchObject({ code: "execution_option_unsupported" });
    }
  });

  it("stores accepted options on the task", async () => {
    const { dir, db, orchestration, coordinator, internals } = await withEffortProfile();
    // Delegation snapshots the coordinator workspace, which must be a repository.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
    git("commit", "--allow-empty", "-m", "Initial");
    vi.spyOn(internals as unknown as { dispatchOrchestrationTasks: () => Promise<void> }, "dispatchOrchestrationTasks").mockResolvedValue();
    await callTool(internals, coordinator.id, "buildwarden_tasks_delegate", {
      requestId: "request-good", tasks: [{ clientTaskId: "good", title: "T", prompt: "Inspect", roleId: "researcher", intent: "inspect", executionOptions: { reasoningEffort: "high" } }],
    });
    const task = db.getOrchestrationTaskByClientTaskId(orchestration.id, "good");
    expect(task && db.getOrchestrationTaskExecutionOptions(task.id)).toEqual({ reasoningEffort: "high" });
  });
});

describe("blocking wait", () => {
  it("returns the result once the child finishes, and the next wake does not repeat it", async () => {
    const { db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { child, task } = addChildTask("quick", "running");
    db.updateRunStatus(child.id, "completed", { summary: "Quick answer." });
    internals.captureOrchestrationResultSnapshot = vi.fn(async () => undefined);
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });

    const waiting = internals.executeOrchestrationTool(coordinator.id, "wait", "buildwarden_orchestration_wait", { mode: "all-terminal", taskIds: [task.id], timeoutMs: 5_000 });
    await internals.handleOrchestrationChildTerminal(child.id);
    const body = JSON.parse((await waiting).content) as Record<string, unknown>;

    expect(body).toMatchObject({ satisfied: true, timedOut: false });
    expect(body.update).toContain("Quick answer.");
    // The result is only a tool result until the coordinator shows it received it.
    expect(db.getOrchestration(orchestration.id).lastDeliveredSequence).toBe(0);
    // Transports log the wait's own result before the model has it, so that is no evidence.
    db.appendRunStep(coordinator.id, "tool-result", "buildwarden_orchestration_wait", "wait result",
      JSON.stringify({ toolName: "buildwarden_orchestration_wait", callId: "wait" }));
    await internals.executeOrchestrationTool(coordinator.id, "list", "buildwarden_tasks_list", {});
    expect(db.getOrchestration(orchestration.id).lastDeliveredSequence).toBe(0);
    // The model's next call is.
    db.appendRunStep(coordinator.id, "tool-call", "buildwarden_tasks_list", "{}", JSON.stringify({ toolName: "buildwarden_tasks_list", callId: "list" }));
    await internals.executeOrchestrationTool(coordinator.id, "list-2", "buildwarden_tasks_list", {});
    const current = db.getOrchestration(orchestration.id);
    expect(current.lastDeliveredSequence).toBe(current.lastEventSequence);
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("does not count a tool called in parallel with the wait as proof the result arrived", async () => {
    const { db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("quick", "completed");
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "task-completed", title: "t", content: "Quick answer." });
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });
    // The model calls the wait and another tool in one response, with text before them.
    db.appendRunStep(coordinator.id, "output", "Agent output", "Checking.", JSON.stringify({ streamId: "message-0" }));
    db.appendRunStep(coordinator.id, "tool-call", "buildwarden_orchestration_wait", "{}", JSON.stringify({ toolName: "buildwarden_orchestration_wait", callId: "wait" }));
    db.appendRunStep(coordinator.id, "tool-call", "read_file", "{}", JSON.stringify({ toolName: "read_file", callId: "parallel" }));
    await internals.executeOrchestrationTool(coordinator.id, "wait", "buildwarden_orchestration_wait", { mode: "all-terminal", timeoutMs: 1_000 });

    // The parallel call finishes after the wait, and its record is updated; the model has read neither result.
    db.appendRunStep(coordinator.id, "tool-progress", "read_file", "reading", JSON.stringify({ toolName: "read_file", callId: "parallel" }));
    db.appendRunStep(coordinator.id, "tool-call", "read_file", "{}", JSON.stringify({ toolName: "read_file", callId: "parallel" }));
    db.appendRunStep(coordinator.id, "tool-result", "read_file", "contents", JSON.stringify({ toolName: "read_file", callId: "parallel" }));
    db.appendRunStep(coordinator.id, "output", "Agent output", "Checking. Still.", JSON.stringify({ streamId: "message-0" }));
    await internals.executeOrchestrationTool(coordinator.id, "list", "buildwarden_tasks_list", {});
    expect(db.getOrchestration(orchestration.id).lastDeliveredSequence).toBe(0);

    // A new message from the model is.
    db.appendRunStep(coordinator.id, "output", "Agent output", "The task is done.", JSON.stringify({ streamId: "message-1" }));
    await internals.executeOrchestrationTool(coordinator.id, "list-2", "buildwarden_tasks_list", {});
    const current = db.getOrchestration(orchestration.id);
    expect(current.lastDeliveredSequence).toBe(current.lastEventSequence);
  });

  it("reports the user's adoption decisions, as a wake does", async () => {
    const { db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("impl", "completed");
    db.appendOrchestrationEvent({
      orchestrationId: orchestration.id, taskId: task.id, type: "adoption-rejected", title: "Adoption rejected",
      content: "The user rejected the changes from impl.",
    });
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });

    const result = await internals.executeOrchestrationTool(coordinator.id, "wait", "buildwarden_orchestration_wait", { mode: "all-terminal", timeoutMs: 1_000 });

    expect(JSON.parse(result.content).update).toContain("The user rejected the changes from impl.");
  });

  it("keeps the news for the next wake when the turn ends before the result was received", async () => {
    const { dir, db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("quick", "completed");
    db.updateOrchestrationTask(task.id, { summary: "Quick answer." });
    db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "task-completed", title: "t", content: "Quick answer." });
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });
    await internals.executeOrchestrationTool(coordinator.id, "wait", "buildwarden_orchestration_wait", { mode: "all-terminal", timeoutMs: 1_000 });
    // The wait's own result is logged, then the app stops before the model responded to it.
    db.appendRunStep(coordinator.id, "tool-result", "buildwarden_orchestration_wait", "wait result",
      JSON.stringify({ toolName: "buildwarden_orchestration_wait", callId: "wait" }));
    db.updateRunStatus(coordinator.id, "completed");
    const { controller, followUp } = openController(db, dir);
    const failedWait = vi.spyOn(db, "updateOrchestrationEffect");

    await controller.reconcileOrchestrationsAfterRestart();

    // The unconfirmed wait counts as not delivered, so startup's wake carries the news again.
    expect(failedWait).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "failed" }));
    expect(followUp).toHaveBeenCalledWith(coordinator.id, expect.stringContaining("Quick answer."), expect.anything(), expect.anything());
    expect(db.listPendingOrchestrationEffects({ orchestrationId: orchestration.id })).toEqual([]);
  });

  it("times out without cancelling the child", async () => {
    const { db, coordinator, internals, addChildTask } = await fixture();
    const { task } = addChildTask("slow", "running");
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });

    const result = await internals.executeOrchestrationTool(coordinator.id, "wait", "buildwarden_orchestration_wait", { mode: "all-terminal", timeoutMs: 1_000 });

    expect(JSON.parse(result.content)).toMatchObject({ satisfied: false, timedOut: true, next: expect.stringContaining("yield") });
    expect(db.getOrchestrationTask(task.id).status).toBe("running");
  });
});

describe("child launch ownership", () => {
  it("records the workspace it is about to create before creating any of it", async () => {
    const { dir, db, model, wave, orchestration, coordinator, internals } = await fixture();
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId: "new", title: "New", prompt: "Inspect",
      roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    let recorded: Array<{ payload: Record<string, unknown> }> = [];
    const prepare = vi.fn(async () => {
      recorded = db.listPendingOrchestrationEffects({ taskId: task.id, kind: "launch-child" });
      throw new Error("disk full");
    });
    const discard = vi.fn(async () => true);
    Object.assign(internals, { prepareContinuationWorkspace: prepare, discardPreparedRunWorkspace: discard });

    await expect((internals as unknown as { createOrchestrationChildRun: (run: RunRecord, t: OrchestrationTaskRecord) => Promise<RunRecord> })
      .createOrchestrationChildRun(coordinator, task)).rejects.toThrow("disk full");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ phase: "preparing", workspace: { workspaceType: "worktree", worktreePath: expect.any(String) } });
    const workspaceId = (prepare.mock.calls[0] as unknown[] | undefined)?.[5];
    expect(String((recorded[0]?.payload.workspace as { branchName: string }).branchName)).toContain(String(workspaceId));
    expect(discard).toHaveBeenCalledWith(dir, recorded[0]?.payload.workspace);
    expect(db.listPendingOrchestrationEffects({ taskId: task.id })).toEqual([]);
  });

  it("keeps a failed launch's workspace recorded until startup removes it, even after the orchestration ended", async () => {
    const { dir, db, model, wave, orchestration, coordinator, internals } = await fixture();
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId: "locked", title: "Locked", prompt: "Inspect",
      roleId: "researcher", modelId: model.id, intent: "inspect",
    });
    const prepare = vi.fn(async () => { throw new Error("disk full"); });
    const lockedDiscard = vi.fn(async () => false);
    Object.assign(internals, { prepareContinuationWorkspace: prepare, discardPreparedRunWorkspace: lockedDiscard });

    await expect((internals as unknown as { createOrchestrationChildRun: (run: RunRecord, t: OrchestrationTaskRecord) => Promise<RunRecord> })
      .createOrchestrationChildRun(coordinator, task)).rejects.toThrow("disk full");

    const [kept] = db.listPendingOrchestrationEffects({ taskId: task.id, kind: "launch-child" });
    expect(kept?.payload).toMatchObject({ phase: "cleanup", workspace: { worktreePath: expect.any(String) } });
    expect(kept?.errorMessage).toContain("tries again at the next start");

    // Startup only resumes active orchestrations, but the removal is retried regardless.
    db.updateOrchestration(orchestration.id, { status: "completed" });
    const restarted = openController(db, dir);
    const discard = vi.fn(async () => true);
    restarted.internals.discardPreparedRunWorkspace = discard;
    await restarted.controller.reconcileOrchestrationsAfterRestart();

    expect(discard).toHaveBeenCalledWith(dir, kept?.payload.workspace);
    expect(db.listPendingOrchestrationEffects({ taskId: task.id })).toEqual([]);
  });

  it("removes a stale launch workspace even though a later attempt launched the task elsewhere", async () => {
    const { dir, db, orchestration, addChildTask } = await fixture();
    const { task } = addChildTask("relaunched", "running");
    const stale = { workspaceType: "worktree", workspaceVcs: "git", branchName: "bw/stale", worktreePath: join(dir, "stale-worktree") };
    db.createOrchestrationEffect({ orchestrationId: orchestration.id, taskId: task.id, kind: "launch-child", payload: { workspace: stale, phase: "cleanup" } });
    // Ended, so startup checks only this effect and does not resume the running child.
    db.updateOrchestration(orchestration.id, { status: "completed" });
    const { controller, internals } = openController(db, dir);
    const discard = vi.fn(async () => true);
    internals.discardPreparedRunWorkspace = discard;

    await controller.reconcileOrchestrationsAfterRestart();

    expect(discard).toHaveBeenCalledWith(dir, stale);
    expect(db.listPendingOrchestrationEffects({ taskId: task.id, kind: "launch-child" })).toEqual([]);
  });
});

describe("unfinished native subagents", () => {
  it("closes subagents a stopped child left open and says so in its result", async () => {
    const { db, orchestration, coordinator, internals, addChildTask } = await fixture();
    const { child, task } = addChildTask("parent", "running");
    db.appendRunStep(child.id, "tool-progress", "Subagent: reviewer", "running", JSON.stringify({
      toolName: "subagent", subagent: { id: "sub-1", source: "claude", status: "running", name: "reviewer" },
    }));
    db.updateRunStatus(child.id, "completed", { summary: "Done, mostly." });
    internals.captureOrchestrationResultSnapshot = vi.fn(async () => undefined);
    stubChildSummary(internals);

    await internals.handleOrchestrationChildTerminal(child.id);

    expect(db.listRunSubagentStates(child.id)).toMatchObject([{ id: "sub-1", status: "cancelled" }]);
    const completed = db.listOrchestrationEvents(orchestration.id).find((event) => event.type === "task-completed");
    expect(completed?.metadata).toMatchObject({ abandonedSubagents: 1 });
    expect(completed?.content).toContain("still running when the child stopped");
    // Later activity on the task must not push the publication out of view.
    for (let index = 0; index < 25; index += 1) {
      db.appendOrchestrationEvent({ orchestrationId: orchestration.id, taskId: task.id, type: "message", title: "Message", content: `note ${String(index)}` });
    }
    const { body } = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id });
    expect(body.pendingWork).toMatchObject({ completionState: "result-available-subagents-abandoned", nativeSubagents: { open: 0 } });
  });
});

describe("token budgets and unmetered integrations", () => {
  it("refuses to delegate to a model that reports no usage while a token budget is set", async () => {
    const { db, orchestration, coordinator, internals } = await fixture();
    const acp = db.addProviderAccount({ providerType: "acp", label: "ACP", apiBaseUrl: null, apiKeyRef: "acp", configJson: "{}" });
    const acpModel = db.addModel({ providerAccountId: acp.id, modelId: "default", displayName: "ACP default", config: {}, capabilities: {}, enabled: true });
    const team = orchestration.teamSnapshot;
    db.updateOrchestration(orchestration.id, { teamSnapshot: {
      ...team, maxTotalTokens: 10_000,
      models: [...team.models, { modelId: acpModel.id, enabled: true, maxConcurrent: 1 }],
      roles: team.roles.map((role) => ({ ...role, eligibleModelIds: [...role.eligibleModelIds, acpModel.id] })),
    } });
    internals.runWorkers.set(coordinator.id, { cancelled: false, providerType: "codex-cli" });

    await expect(internals.executeOrchestrationTool(coordinator.id, "d", "buildwarden_tasks_delegate", {
      requestId: "unmetered", tasks: [{ clientTaskId: "a", title: "A", prompt: "Inspect", roleId: "researcher", intent: "inspect", modelId: acpModel.id }],
    })).rejects.toMatchObject({ code: "model_unavailable", message: expect.stringContaining("reports no token usage") });
  });
});

describe("pending native work", () => {
  it("reports open subagents of a child and a result they never finished", async () => {
    const { db, coordinator, internals, addChildTask } = await fixture();
    const { child, task } = addChildTask("parent", "completed");
    db.publishOrchestrationTaskResult(task.id);
    db.appendRunStep(child.id, "tool-progress", "Subagent: reviewer", "running", JSON.stringify({
      toolName: "subagent", subagent: { id: "sub-1", source: "claude", status: "running", name: "reviewer" },
    }));
    db.appendRunStep(child.id, "tool-result", "Subagent: tester", "done", JSON.stringify({
      toolName: "subagent", subagent: { id: "sub-2", source: "claude", status: "completed", name: "tester" },
    }));
    stubChildSummary(internals);

    const { body } = await callTool(internals, coordinator.id, "buildwarden_tasks_read", { taskId: task.id });

    expect(body.pendingWork).toMatchObject({
      completionState: "result-available-subagents-unfinished",
      nativeSubagents: { total: 2, open: 1, openItems: [{ id: "sub-1", name: "reviewer", status: "running" }] },
    });
  });
});

describe("delegation input limits", () => {
  it("rejects a task field longer than its schema allows, even when the transport did not check", async () => {
    const { coordinator, internals } = await fixture();
    internals.runWorkers.set(coordinator.id, {});
    await expect(internals.executeOrchestrationTool(coordinator.id, "c", "buildwarden_tasks_delegate", {
      requestId: "request-long-title",
      tasks: [{ clientTaskId: "a", title: "t".repeat(161), prompt: "Inspect", roleId: "researcher", intent: "inspect" }],
    })).rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringContaining("title is longer than 160") });
  });
});

describe("tool approvals", () => {
  it("stores always-allow for an MCP tool by its identity, never as a shell pattern", async () => {
    const { db, project, coordinator, controller, internals } = await fixture();
    const worker = { postMessage: vi.fn() };
    internals.runWorkers.set(coordinator.id, { worker, cancelled: false, providerType: "ai-sdk" });
    await (internals as unknown as { handleRunWorkerShellApprovalRequest: (run: RunRecord, payload: unknown) => Promise<void> })
      .handleRunWorkerShellApprovalRequest(coordinator, {
        type: "shell-approval-request", requestId: "r1", command: 'mcp docs create-issue {"title":"Bug"}', approvalKey: "mcp:docs/create-issue",
      });

    await controller.respondToShellApproval(coordinator.id, "r1", "allow-always", { command: 'mcp docs create-issue {"title":"Bug"}' });

    const settings = db.getSettings();
    expect(JSON.parse(settings.toolApprovalAllowlist ?? "{}")).toEqual({ [project.id]: ["mcp:docs/create-issue"] });
    expect(settings.shellAllowlistExtra ?? "[]").toBe("[]");
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "shell-approval-response", requestId: "r1", decision: "allow-always" });
  });

  it("answers a broader approval of a one-time action as allow once, and stores nothing", async () => {
    const { db, coordinator, controller, internals } = await fixture();
    const worker = { postMessage: vi.fn() };
    internals.runWorkers.set(coordinator.id, { worker, cancelled: false, providerType: "acp" });
    await (internals as unknown as { handleRunWorkerShellApprovalRequest: (run: RunRecord, payload: unknown) => Promise<void> })
      .handleRunWorkerShellApprovalRequest(coordinator, {
        type: "shell-approval-request", requestId: "r1", command: "Edit note", approvalKey: "acp:account:edit:Edit note", onceOnly: true,
      });
    expect(db.getRunSteps(coordinator.id).some((step) => JSON.parse(step.metadataJson).approvalOnceOnly === true)).toBe(true);

    await controller.respondToShellApproval(coordinator.id, "r1", "allow-always", { command: "Edit note" });

    const settings = db.getSettings();
    expect(settings.toolApprovalAllowlist ?? "{}").toBe("{}");
    expect(settings.shellAllowlistExtra ?? "[]").toBe("[]");
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "shell-approval-response", requestId: "r1", decision: "allow-once" });
  });
});
