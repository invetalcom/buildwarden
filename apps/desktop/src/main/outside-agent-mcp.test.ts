import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { RemoteAccessServer, RemoteAuthService, RemoteOperationRegistry, validateNoRemoteArgs } from "@buildwarden/remote-server";
import { REMOTE_ACCESS_MCP_PATH, type AppSnapshot, type RemoteAccessScope, type RunDetail, type RunInput, type RunRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_AGENT_TOOLS, OutsideAgentMcp } from "./outside-agent-mcp";

const run = (overrides: Partial<RunRecord> = {}) => ({
  id: "run-1", projectId: "p1", status: "running", mode: "code", prompt: "Fix it", summary: null, errorMessage: null,
  branchName: "bw/fix", worktreePath: "/work/fix", ...overrides,
}) as RunRecord;

const snapshot = {
  projects: [
    { project: { id: "p1", name: "App", repoPath: "/repo/app", kind: "git" }, runs: [run({ status: "completed", summary: "Done" })] },
    { project: { id: "p2", name: "Notes", repoPath: "/repo/notes", kind: "folder" }, runs: [] },
  ],
  providerAccounts: [{ id: "acc-1", providerType: "claude-code", label: "Claude" }],
  models: [
    { id: "m-off", providerAccountId: "acc-1", modelId: "old", displayName: "Old", enabled: 0 },
    { id: "m-1", providerAccountId: "acc-1", modelId: "opus", displayName: "Opus", enabled: 1 },
  ],
} as unknown as AppSnapshot;

const setup = () => {
  const registry = new RemoteOperationRegistry(undefined, { createRemoteCommandIdempotency: () => true, getRemoteCommandIdempotency: () => null, completeRemoteCommandIdempotency: () => undefined } as never);
  const created: RunInput[] = [];
  const statuses = ["running", "running", "completed"];
  registry.register("getSnapshot", async () => snapshot, validateNoRemoteArgs);
  registry.register("createRun", async (input) => {
    created.push(input);
    return run({ projectId: input.projectId });
  }, (args): args is [RunInput] => args.length === 1, "run:operate", true);
  registry.register("followUpRun", async (runId, prompt) => run({ id: runId, prompt }), (args): args is [string, string] => args.length === 2, "run:operate", true);
  registry.register("getRunDetail", async (runId) => ({
    run: run({ id: runId, status: (statuses.shift() ?? "completed") as RunRecord["status"], summary: "Fixed" }),
    steps: [{ id: "s1", runId, eventType: "output", title: "Agent output", content: "Fixed", metadataJson: "{}", createdAt: "2026-11-27T10:00:00Z" }],
    notes: [], diff: "",
  }) as unknown as RunDetail, (args): args is [string] => args.length === 1);
  const mcp = new OutsideAgentMcp(registry, { serverVersion: "test", sleep: async () => undefined });
  const call = async (name: string, args: Record<string, unknown>, scopes: RemoteAccessScope[] = ["state:read", "run:operate"]) => {
    const answer = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { id: "session-1", scopes });
    const result = answer?.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError: boolean };
    return result;
  };
  return { mcp, call, created };
};

describe("BuildWarden MCP for outside agents", () => {
  it("lists its tools with read-only hints", async () => {
    const { mcp } = setup();
    const answer = await mcp.handle({ jsonrpc: "2.0", id: "a", method: "tools/list" }, { id: "s", scopes: [] });
    const tools = (answer?.result as { tools: typeof OUTSIDE_AGENT_TOOLS }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["list_projects", "list_models", "list_runs", "read_run", "start_run", "send_to_run", "wait_for_run", "cancel_run"]);
    expect(tools.find((tool) => tool.name === "start_run")?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "read_run")?.annotations.readOnlyHint).toBe(true);
    await expect(mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, { id: "s", scopes: [] })).resolves.toBeNull();
  });

  it("reads projects, models and runs", async () => {
    const { call } = setup();
    expect((await call("list_projects", {})).structuredContent).toEqual({ projects: [
      { id: "p1", name: "App", folder: "/repo/app", kind: "git", runs: 1 },
      { id: "p2", name: "Notes", folder: "/repo/notes", kind: "folder", runs: 0 },
    ] });
    expect((await call("list_models", {})).structuredContent).toEqual({ models: [
      { id: "m-1", model: "opus", name: "Opus", provider: "Claude", providerType: "claude-code" },
    ] });
    expect((await call("list_runs", { projectId: "p1" })).structuredContent).toMatchObject({ runs: [{ id: "run-1", status: "completed", summary: "Done" }] });
    expect(await call("list_runs", { projectId: "nope" })).toMatchObject({ isError: true });
  });

  it("starts a run with the app's defaults and an isolated workspace", async () => {
    const { call, created } = setup();
    await call("start_run", { projectId: "p1", prompt: "Add tests" });
    await call("start_run", { projectId: "p2", prompt: "Tidy notes", mode: "plan", modelId: "opus" });
    expect(created).toEqual([
      { projectId: "p1", providerAccountId: "acc-1", modelId: "m-1", harnessType: "claude-code", mode: "code", workspaceType: "worktree", workspaceVcs: "git", prompt: "Add tests" },
      { projectId: "p2", providerAccountId: "acc-1", modelId: "m-1", harnessType: "claude-code", mode: "plan", workspaceType: "copy", workspaceVcs: "folder", prompt: "Tidy notes" },
    ]);
    expect(await call("start_run", { projectId: "p1", prompt: "x", modelId: "old" })).toMatchObject({ isError: true });
  });

  it("lets a token do only what its scopes allow", async () => {
    const { call, created } = setup();
    const refused = await call("start_run", { projectId: "p1", prompt: "Add tests" }, ["state:read"]);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("run:operate");
    expect(created).toHaveLength(0);
  });

  it("waits until the run's turn ends", async () => {
    const { call } = setup();
    expect((await call("wait_for_run", { runId: "run-1" })).structuredContent).toMatchObject({
      run: { status: "completed", summary: "Fixed" }, finished: true, timedOut: false,
    });
  });
});

describe("the remote access server's MCP endpoint", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  it("answers authenticated MCP requests as JSON and notifications with 202", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-mcp-"));
    const db = new BuildWardenDatabase(join(directory, "test.sqlite"));
    await db.init();
    cleanup.push(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
    const auth = new RemoteAuthService({ store: db, credentialKey: new Uint8Array(32).fill(3) });
    const operations = new RemoteOperationRegistry();
    operations.register("getSnapshot", async () => snapshot, validateNoRemoteArgs);
    const handle = vi.fn(new OutsideAgentMcp(operations).handle.bind(new OutsideAgentMcp(operations)));
    const server = new RemoteAccessServer({ appVersion: "test", operations, auth, port: 0, mcp: { handle } });
    const info = await server.start();
    cleanup.push(() => server.stop());
    const grant = auth.createPairingGrant({ scopes: ["state:read"] });
    const token = auth.exchangePairingCode(grant.code, "Agent", null)!.token;
    const post = (body: unknown, bearer: string | null = token) => fetch(`${info.baseUrl}${REMOTE_ACCESS_MCP_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });

    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null)).status).toBe(401);
    const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toMatchObject({ id: 1, result: { serverInfo: { name: "buildwarden" } } });
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    await expect(listed.json()).resolves.toMatchObject({ id: 2, result: { isError: false, structuredContent: { projects: [{ id: "p1" }, { id: "p2" }] } } });
    expect(handle).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scopes: ["state:read"] }));
    expect((await fetch(`${info.baseUrl}${REMOTE_ACCESS_MCP_PATH}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});
