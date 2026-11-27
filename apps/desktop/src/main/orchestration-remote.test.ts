import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { RemoteAccessServer, RemoteAuthService, RemoteOperationRegistry, validateNoRemoteArgs } from "@buildwarden/remote-server";
import { APP_SETTING_KEYS, MAX_LINKED_HOSTS, REMOTE_ACCESS_MCP_PATH, type AppSnapshot, type RunDetail, type RunInput, type RunRecord, type RunToolResult } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { internalsOf, serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { OutsideAgentMcp } from "./outside-agent-mcp";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const tempDatabase = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const db = new BuildWardenDatabase(join(dir, "state.sqlite"));
  await db.init();
  cleanup.push(async () => { await db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, db };
};

/** A second host: BuildWarden's MCP endpoint over a registry of fake runs. */
const startHost = async () => {
  const { db } = await tempDatabase("bw-linked-host-");
  const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(5) });
  const operations = new RemoteOperationRegistry(undefined, db);
  const runs = new Map<string, RunRecord>();
  const created: RunInput[] = [];
  const cancelled: string[] = [];
  const snapshot = {
    projects: [{ project: { id: "host-project", name: "Shop", repoPath: "/srv/shop", kind: "git" }, runs: [] }],
    providerAccounts: [{ id: "host-acc", providerType: "claude-code", label: "Claude" }],
    models: [{ id: "host-model", providerAccountId: "host-acc", modelId: "opus", displayName: "Opus", enabled: 1 }],
  } as unknown as AppSnapshot;
  operations.register("getSnapshot", async () => snapshot, validateNoRemoteArgs);
  operations.register("createRun", async (input) => {
    created.push(input);
    const run = { id: `host-run-${String(created.length)}`, projectId: input.projectId, status: "running", mode: input.mode, prompt: input.prompt,
      summary: null, errorMessage: null, branchName: "bw/x", worktreePath: "/srv/shop-wt" } as RunRecord;
    runs.set(run.id, run);
    return run;
  }, (args): args is [RunInput] => args.length === 1, "run:operate", true);
  operations.register("getRunDetail", async (runId) => ({ run: runs.get(runId)!, steps: [], notes: [], diff: "" }) as unknown as RunDetail,
    (args): args is [string] => args.length === 1 && runs.has(String(args[0])));
  operations.register("cancelRun", async (runId) => {
    cancelled.push(runId);
    runs.set(runId, { ...runs.get(runId)!, status: "cancelled" });
  }, (args): args is [string] => args.length === 1, "run:operate", true);
  const server = new RemoteAccessServer({ appVersion: "test", operations, auth, port: 0, mcp: new OutsideAgentMcp(operations) });
  const info = await server.start();
  cleanup.push(() => server.stop());
  const token = auth.exchangePairingCode(auth.createPairingGrant({ scopes: ["state:read", "run:operate"] }).code, "Coordinator host", null)!.token;
  return { mcpUrl: `${info.baseUrl}${REMOTE_ACCESS_MCP_PATH}`, token, runs, created, cancelled };
};

const setup = async () => {
  const host = await startHost();
  const { dir, db } = await tempDatabase("bw-remote-coordinator-");
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Shop", kind: "folder" });
  const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "gpt", displayName: "GPT", config: {}, capabilities: {}, enabled: true });
  const coordinator = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code",
    workspaceType: "local", workspaceVcs: "folder", branchName: "project-folder", worktreePath: dir, prompt: "Coordinate", delegationEnabled: true,
  });
  const secrets = new Map<string, string>();
  const controller = new AppController(db, {
    readSecret: async (key) => secrets.get(key) ?? null,
    saveSecret: async (key, value) => { secrets.set(key, value); },
    deleteSecret: async (key) => { secrets.delete(key); },
  }, dir,
  { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
  { killForRunId: vi.fn() }, new HostEventBus());
  const linked = await controller.saveLinkedHost({ label: "Build box", mcpUrl: host.mcpUrl, token: host.token });
  const internals = internalsOf<{ runWorkers: Map<string, unknown>; executeOrchestrationTool: (runId: string, callId: string, name: string, args: Record<string, unknown>) => Promise<RunToolResult> }>(controller);
  const tool = async (name: string, args: Record<string, unknown>) => {
    internals.runWorkers.set(coordinator.id, {});
    try {
      const result = await internals.executeOrchestrationTool(coordinator.id, `call-${name}`, name, args);
      return { ok: result.ok, body: JSON.parse(result.content) as Record<string, unknown> };
    } catch (error) {
      return { ok: false, body: { error: { code: (error as { code?: string }).code, message: String(error) } } };
    } finally {
      internals.runWorkers.delete(coordinator.id);
    }
  };
  const wake = vi.spyOn(serviceOf(controller, "orchestrationCoordinator"), "maybeWakeOrchestrationCoordinator").mockResolvedValue(undefined);
  const remote = serviceOf(controller, "orchestrationRemote");
  cleanup.push(async () => remote.stopPolling());
  const delegate = (clientTaskId: string, extra: Record<string, unknown> = {}) => tool("buildwarden_tasks_delegate", {
    requestId: `request-${clientTaskId}`,
    tasks: [{ clientTaskId, title: `Task ${clientTaskId}`, prompt: "Run the slow integration suite", roleId: "general", intent: "inspect", hostId: linked.id, ...extra }],
  });
  const taskByClientId = (clientTaskId: string) => {
    const orchestration = db.getOrchestrationByCoordinatorRunId(coordinator.id)!;
    return db.getOrchestrationTaskByClientTaskId(orchestration.id, clientTaskId)!;
  };
  return { db, controller, host, linked, tool, wake, remote, delegate, taskByClientId, coordinator };
};

describe("delegating to a linked host", () => {
  it("lists linked hosts to the coordinator", async () => {
    const { tool, linked } = await setup();
    expect((await tool("buildwarden_orchestration_get", {})).body).toMatchObject({ linkedHosts: [{ id: linked.id, label: "Build box" }] });
  });

  it("keeps every host when several are saved at once", async () => {
    const { controller, linked } = await setup();
    await Promise.all(["A", "B", "C"].map((label) => controller.saveLinkedHost({ label, mcpUrl: `https://${label.toLowerCase()}.example.ts.net/mcp`, token: label })));
    expect((await controller.listLinkedHosts()).map((host) => host.label).sort()).toEqual(["A", "B", "Build box", "C"]);
    await Promise.all([controller.removeLinkedHost(linked.id), controller.saveLinkedHost({ label: "D", mcpUrl: "https://d.example.ts.net/mcp", token: "D" })]);
    expect((await controller.listLinkedHosts()).map((host) => host.label).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("refuses a linked host past the limit before storing its token", async () => {
    const { controller } = await setup();
    for (let index = 1; index < MAX_LINKED_HOSTS; index += 1) {
      await controller.saveLinkedHost({ label: `H${String(index)}`, mcpUrl: `https://h${String(index)}.example.ts.net/mcp`, token: "t" });
    }
    await expect(controller.saveLinkedHost({ label: "One more", mcpUrl: "https://more.example.ts.net/mcp", token: "t" })).rejects.toThrow("up to 20 linked hosts");
    expect(await controller.listLinkedHosts()).toHaveLength(MAX_LINKED_HOSTS);
  });

  it("keeps a host's token for a new name, but asks for a new one when its address changes", async () => {
    const { controller, linked } = await setup();
    await expect(controller.saveLinkedHost({ id: linked.id, label: "Renamed", mcpUrl: linked.mcpUrl })).resolves.toMatchObject({ label: "Renamed" });
    await expect(controller.saveLinkedHost({ id: linked.id, label: "Renamed", mcpUrl: "https://elsewhere.example.ts.net/mcp" }))
      .rejects.toThrow("Paste an agent token from the new host");
    await expect(controller.saveLinkedHost({ id: linked.id, label: "Renamed", mcpUrl: "https://elsewhere.example.ts.net/mcp", token: "new" }))
      .resolves.toMatchObject({ mcpUrl: "https://elsewhere.example.ts.net/mcp" });
  });

  it("starts the task on the host and publishes the host run's summary when it ends", async () => {
    const { db, host, delegate, taskByClientId, remote, wake } = await setup();
    expect((await delegate("t1")).ok).toBe(true);
    await vi.waitFor(() => expect(taskByClientId("t1").status).toBe("running"));
    expect(host.created).toEqual([expect.objectContaining({ projectId: "host-project", mode: "ask", workspaceType: "worktree" })]);
    expect(host.created[0]?.prompt).toContain("Run the slow integration suite");
    expect(host.created[0]?.prompt).toContain("linked host Build box");
    expect(taskByClientId("t1").remote).toMatchObject({ hostLabel: "Build box", projectId: "host-project", runId: "host-run-1" });
    expect(taskByClientId("t1").childRunId).toBeNull();

    await remote.pollRemoteTasks();
    expect(taskByClientId("t1").status).toBe("running");
    host.runs.set("host-run-1", { ...host.runs.get("host-run-1")!, status: "completed", summary: "All 412 tests pass." });
    await remote.pollRemoteTasks();
    const task = taskByClientId("t1");
    expect(task).toMatchObject({ status: "completed", summary: "All 412 tests pass." });
    expect(db.listOrchestrationTaskResults(task.id)).toHaveLength(1);
    expect(db.listOrchestrationEvents(task.orchestrationId).filter((event) => event.taskId === task.id).map((event) => event.type))
      .toEqual(expect.arrayContaining(["task-started", "task-completed"]));
    expect(wake).toHaveBeenCalledWith(task.orchestrationId);
  });

  it("cancels the host's run with the task, and refuses messages and adoption", async () => {
    const { db, controller, host, delegate, taskByClientId, tool } = await setup();
    await delegate("t2", { intent: "implement" });
    await vi.waitFor(() => expect(taskByClientId("t2").status).toBe("running"));
    expect(host.created[0]?.mode).toBe("code");
    const send = await tool("buildwarden_tasks_send_message", { requestId: "send-request-1", taskId: taskByClientId("t2").id, content: "Also lint" });
    expect(send).toMatchObject({ ok: false, body: { error: { code: "delivery_unavailable" } } });

    const task = taskByClientId("t2");
    await serviceOf(controller, "orchestration").cancelOrchestrationTasks(db.getOrchestration(task.orchestrationId), [task.id]);
    expect(host.cancelled).toEqual(["host-run-1"]);
    expect(taskByClientId("t2").status).toBe("cancelled");
  });

  it("refuses a remote task when the orchestration has a token budget", async () => {
    const { db, coordinator, delegate, controller } = await setup();
    const orchestration = serviceOf(controller, "orchestration").getOrCreateOrchestration(db.getRun(coordinator.id));
    db.updateOrchestration(orchestration.id, { teamSnapshot: { ...orchestration.teamSnapshot, maxTotalTokens: 100_000 } });
    await expect(delegate("t11")).resolves.toMatchObject({ ok: false, body: { error: { code: "model_unavailable", message: expect.stringContaining("reports no token usage") } } });
  });

  it("fails the task when the host has no matching project, and rejects unknown hosts", async () => {
    const { delegate, taskByClientId } = await setup();
    await delegate("t3", { remoteProjectId: "missing-project" });
    await vi.waitFor(() => expect(taskByClientId("t3").status).toBe("failed"));
    expect(taskByClientId("t3").errorMessage).toContain("Build box could not start the task");
    await expect(delegate("t4", { hostId: "nope" })).resolves.toMatchObject({ ok: false, body: { error: { code: "invalid_arguments" } } });
  });

  it("fails a task the app stopped while starting, instead of starting a second run on the host", async () => {
    const { db, host, delegate, taskByClientId, remote } = await setup();
    await delegate("t6");
    await vi.waitFor(() => expect(taskByClientId("t6").status).toBe("running"));
    // As left by a crash between saving provisioning and the host's answer.
    db.updateOrchestrationTask(taskByClientId("t6").id, { status: "provisioning", remote: { ...taskByClientId("t6").remote!, runId: null } });
    await remote.pollRemoteTasks();
    expect(taskByClientId("t6")).toMatchObject({ status: "failed" });
    expect(taskByClientId("t6").errorMessage).toContain("Check that host for a run");
    expect(host.created).toHaveLength(1);
  });

  it("keeps cancelling a remote task until its host confirms", async () => {
    const { db, controller, host, delegate, taskByClientId, remote } = await setup();
    await delegate("t9");
    await vi.waitFor(() => expect(taskByClientId("t9").status).toBe("running"));
    const linkedHosts = serviceOf(controller, "linkedHosts");
    const call = linkedHosts.callHostTool.bind(linkedHosts);
    const offline = vi.spyOn(linkedHosts, "callHostTool").mockImplementation(async (hostId, name, args, signal) => {
      if (name === "cancel_run") throw new Error("connect ECONNREFUSED");
      return call(hostId, name, args, signal) as never;
    });
    const task = taskByClientId("t9");
    await expect(serviceOf(controller, "orchestration").cancelOrchestrationTasks(db.getOrchestration(task.orchestrationId), [task.id]))
      .rejects.toThrow("did not confirm");
    expect(taskByClientId("t9").status).toBe("running");
    await remote.pollRemoteTasks();
    expect(taskByClientId("t9").status).toBe("running");

    offline.mockRestore();
    await remote.pollRemoteTasks();
    expect(host.cancelled).toEqual(["host-run-1"]);
    expect(taskByClientId("t9").status).toBe("cancelled");
  });

  it("stops the host's run before the coordinator is deleted, and keeps the deletion retryable while the host is away", async () => {
    const { db, controller, host, delegate, taskByClientId, coordinator } = await setup();
    await delegate("t10");
    await vi.waitFor(() => expect(taskByClientId("t10").status).toBe("running"));
    const linkedHosts = serviceOf(controller, "linkedHosts");
    const call = linkedHosts.callHostTool.bind(linkedHosts);
    const offline = vi.spyOn(linkedHosts, "callHostTool").mockImplementation(async (hostId, name, args, signal) => {
      if (name === "cancel_run") throw new Error("connect ECONNREFUSED");
      return call(hostId, name, args, signal) as never;
    });
    await expect(controller.deleteRun(coordinator.id)).rejects.toThrow();
    expect(db.getRun(coordinator.id)).toBeDefined();
    offline.mockRestore();
    await controller.deleteRun(coordinator.id);
    expect(host.cancelled).toEqual(["host-run-1"]);
    expect(() => db.getRun(coordinator.id)).toThrow();
  });

  it("stops the host's run when the task was cancelled while the host was starting it", async () => {
    const { db, controller, host, delegate, taskByClientId } = await setup();
    const linkedHosts = serviceOf(controller, "linkedHosts");
    const call = linkedHosts.callHostTool.bind(linkedHosts);
    vi.spyOn(linkedHosts, "callHostTool").mockImplementation(async (hostId, name, args, signal) => {
      const answer = await call(hostId, name, args, signal);
      if (name === "start_run") {
        // The user cancels while the host's answer is on its way.
        const task = taskByClientId("t8");
        await serviceOf(controller, "orchestration").cancelOrchestrationTasks(db.getOrchestration(task.orchestrationId), [task.id]);
      }
      return answer as never;
    });
    await delegate("t8");
    await vi.waitFor(() => expect(host.cancelled).toEqual(["host-run-1"]));
    expect(taskByClientId("t8")).toMatchObject({ status: "cancelled", remote: { runId: null } });
  });

  it("fails the task and releases it when saving it before the start fails", async () => {
    const { db, host, delegate, taskByClientId, remote } = await setup();
    const save = db.flushDurable.bind(db);
    let failed = false;
    // Only the save that records provisioning, just before the host would be asked, fails.
    const flush = vi.spyOn(db, "flushDurable").mockImplementation(async () => {
      const provisioning = db.listActiveRemoteOrchestrationTasks().some((task) => task.status === "provisioning" && !task.remote?.runId);
      if (provisioning && !failed) {
        failed = true;
        throw new Error("disk full");
      }
      await save();
    });
    await delegate("t7");
    await vi.waitFor(() => expect(taskByClientId("t7").status).toBe("failed"));
    flush.mockRestore();
    expect(taskByClientId("t7").errorMessage).toContain("could not save the task");
    expect(host.created).toHaveLength(0);
    await remote.pollRemoteTasks();
    expect(host.created).toHaveLength(0);
  });

  it("keeps a running remote task across a restart instead of requeuing it here", async () => {
    const { controller, delegate, taskByClientId } = await setup();
    await delegate("t5");
    await vi.waitFor(() => expect(taskByClientId("t5").status).toBe("running"));
    await serviceOf(controller, "orchestrationRecovery").reconcileOrchestrationsAfterRestart();
    expect(taskByClientId("t5")).toMatchObject({ status: "running", childRunId: null, remote: { runId: "host-run-1" } });
  });
});
