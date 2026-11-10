import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpHarnessAdapter,
  AcpProviderAdapter,
  generateUtilityTextWithAcp,
  parseAcpCommandLine,
  parseAcpEnvironment,
  resolveWorkspacePath,
} from "@buildwarden/provider-acp";
import type { HarnessRunChunk, RunExecutionRequest } from "@buildwarden/shared";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A minimal ACP agent: it reads a file through the client, asks permission for an edit, lists
 * BuildWarden's tools through the MCP server it was given, and logs what it received.
 */
const FAKE_AGENT = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map();
let nextId = 1;
const request = (method, params) => new Promise((resolve) => {
  const id = "agent-" + nextId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? { error: message.error });
    return;
  }
  const { id, method, params } = message;
  log({ method, params });
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake Agent", version: "0.3.0" },
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: false } } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "session-1", models: { availableModels: [{ modelId: "fast", name: "Fast" }] },
      modes: { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }], currentModeId: "default" } } });
  } else if (method === "session/load") {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
    send({ id, result: { modes: { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
      currentModeId: process.env.FAKE_ACP_MODE ?? "default" } } });
  } else if (method === "session/set_model" || method === "session/set_mode") {
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading. " } });
    const file = await request("fs/read_text_file", { sessionId, path: "note.txt" });
    const outside = await request("fs/read_text_file", { sessionId, path: "../secret.txt" });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit note", kind: "edit", status: "pending", locations: [{ path: "note.txt" }] });
    const permission = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "t1" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    const allowed = permission.outcome?.optionId === "yes";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "edited" : "rejected" } }] });
    let tools = [];
    if (globalThis.bridge) {
      const response = await fetch(globalThis.bridge.url, { method: "POST", headers: { "Content-Type": "application/json", ...globalThis.bridge.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      tools = (await response.json()).result.tools.map((tool) => tool.name);
    }
    log({ results: { file, outside, permission, tools } });
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Read note", status: "completed", priority: "high" }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The note says: " + (file.content ?? "?") } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, result: null });
  }
  if (method === "session/new" || method === "session/load") {
    const server = (params.mcpServers ?? []).find((entry) => entry.name === "buildwarden");
    if (server) globalThis.bridge = { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
  }
});
`;

const setup = (mode: "code" | "ask" | "plan" = "code") => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const script = join(root, "fake-agent.mjs");
  const log = join(root, "agent.log");
  writeFileSync(script, FAKE_AGENT);
  writeFileSync(log, "");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "note.txt"), "ship it");
  writeFileSync(join(root, "secret.txt"), "outside");
  const config = { acpCommand: `"${process.execPath}" "${script}"`, acpEnv: `FAKE_ACP_LOG=${log}` };
  const input: RunExecutionRequest = {
    runId: "run-1", providerAccountId: "acp-account-1", worktreePath: workspace, mode, prompt: "Read the note", providerType: "acp", modelId: "fast", apiKey: "", config,
  };
  const entries = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, workspace, input, config, entries };
};

describe("ACP command configuration", () => {
  it("splits quoted command lines and environment pairs", () => {
    expect(parseAcpCommandLine(`"C:\\Program Files\\agent.exe" --acp 'two words'`)).toEqual(["C:\\Program Files\\agent.exe", "--acp", "two words"]);
    expect(() => parseAcpCommandLine(`agent "unclosed`)).toThrow("unclosed quote");
    expect(parseAcpEnvironment("A=1; B=two=parts\nC=")).toEqual({ A: "1", B: "two=parts", C: "" });
    expect(parseAcpEnvironment("PATH=C:\\a;C:\\b;MODE=fast")).toEqual({ PATH: "C:\\a;C:\\b", MODE: "fast" });
    expect(parseAcpEnvironment('TOKEN="abc;part=def"; MODE=fast; DIR=C:\\dir\\')).toEqual({ TOKEN: "abc;part=def", MODE: "fast", DIR: "C:\\dir\\" });
    expect(() => parseAcpEnvironment('TOKEN="abc;part=def')).toThrow("unclosed quote");
    expect(() => parseAcpEnvironment("NOVALUE")).toThrow("KEY=VALUE");
  });

  it("keeps agent file access inside the canonical workspace", async () => {
    const { root, workspace } = setup();
    const outside = join(workspace, "outside");
    symlinkSync(root, outside, "junction");
    symlinkSync(workspace, join(root, "alias"), "junction");
    await expect(resolveWorkspacePath(workspace, "../secret.txt")).rejects.toThrow("inside the run workspace");
    await expect(resolveWorkspacePath(workspace, "outside/secret.txt")).rejects.toThrow("inside the run workspace");
    await expect(resolveWorkspacePath(workspace, "outside/secret.txt", true)).rejects.toThrow("inside the run workspace");
    await expect(resolveWorkspacePath(workspace, "outside/new/nested/file.txt", true)).rejects.toThrow("inside the run workspace");
    await expect(resolveWorkspacePath(workspace, "new/nested/file.txt", true)).resolves.toBe(join(realpathSync(workspace), "new/nested/file.txt"));
    await expect(resolveWorkspacePath(join(root, "alias"), "note.txt")).resolves.toBe(join(realpathSync(workspace), "note.txt"));
    symlinkSync(workspace, join(workspace, "inside"), "junction");
    await expect(resolveWorkspacePath(workspace, "inside/note.txt")).resolves.toBe(join(realpathSync(workspace), "note.txt"));
  });
});

describe("ACP agent runs", () => {
  it.each(["ask", "plan"] as const)("enforces %s permissions before Full Access or approval", async (mode) => {
    for (const yoloMode of [false, true]) {
      for (const kind of ["execute", "edit", "other", "", "read", "search"]) {
        const { root, input, entries } = setup(mode);
        writeFileSync(join(root, "fake-agent.mjs"), FAKE_AGENT.replace('kind: "edit"', `kind: ${JSON.stringify(kind)}`));
        const approve = vi.fn(async () => "allow-once" as const);
        await new AcpHarnessAdapter(approve).run({ ...input, yoloMode }, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
        const allowed = kind === "read" || kind === "search";
        const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
        expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: allowed ? "yes" : "no" } });
        expect(approve).toHaveBeenCalledTimes(allowed && !yoloMode ? 1 : 0);
      }
    }
  }, 30_000);

  it("runs a turn: model, MCP bridge, file reads, approvals, plan, and output", async () => {
    const { input, entries } = setup("code");
    const approve = vi.fn(async () => "allow-once" as const);
    const chunks: HarnessRunChunk[] = [];
    const executeTool = vi.fn();
    const result = await new AcpHarnessAdapter(approve).run(
      input,
      { tools: [{ name: "buildwarden_orchestration_get", description: "Get", inputSchema: { type: "object" } }], executeTool },
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );

    expect(result.summary).toBe("The note says: ship it");
    expect(result.providerSessionRuntime?.resumeCursor).toEqual({ sessionId: "session-1" });
    const log = entries();
    expect(log.find((entry) => entry.method === "session/set_model")?.params).toMatchObject({ modelId: "fast" });
    expect(log.some((entry) => entry.method === "session/set_mode")).toBe(false);
    const results = log.find((entry) => entry.results)?.results as Record<string, Record<string, unknown> & { tools: string[] }>;
    expect(results.file).toEqual({ content: "ship it" });
    expect(results.outside).toMatchObject({ error: { message: expect.stringContaining("inside the run workspace") } });
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(results.tools).toEqual(["buildwarden_orchestration_get"]);
    expect(approve).toHaveBeenCalledWith("Edit note (note.txt)", { approvalKey: "acp:acp-account-1:edit:Edit note (note.txt)" });
    expect(chunks.find((chunk) => chunk.metadata?.sessionCapabilities)?.metadata?.sessionCapabilities)
      .toMatchObject({ agentName: "Fake Agent", agentVersion: "0.3.0", mcpHttp: true, sessionResume: true });
    expect(chunks.some((chunk) => chunk.type === "plan-progress")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "tool-result" && chunk.value === "edited")).toBe(true);
  });

  it("refuses edits and writes in ask mode and selects a read-only mode", async () => {
    const { input, entries } = setup("ask");
    const approve = vi.fn(async () => "allow-once" as const);
    await new AcpHarnessAdapter(approve).run(input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    const log = entries();
    const results = log.find((entry) => entry.results)?.results as Record<string, unknown>;
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(approve).not.toHaveBeenCalled();
    expect(log.find((entry) => entry.method === "session/set_mode")?.params).toMatchObject({ modeId: "plan" });
    expect(log.find((entry) => entry.method === "initialize")?.params).toMatchObject({ clientCapabilities: { fs: { writeTextFile: false } } });
  });

  it("reloads the previous session without repeating its history", async () => {
    const { input, entries } = setup("code");
    const chunks: HarnessRunChunk[] = [];
    await new AcpHarnessAdapter(async () => "allow-once").run(
      { ...input, providerSessionRuntime: { resumeCursor: { sessionId: "session-1" } } as unknown as RunExecutionRequest["providerSessionRuntime"] },
      { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal,
    );
    expect(entries().some((entry) => entry.method === "session/load")).toBe(true);
    expect(entries().some((entry) => entry.method === "session/new")).toBe(false);
    expect(entries().find((entry) => entry.method === "session/set_model")?.params).toMatchObject({ modelId: "fast" });
    expect(chunks.some((chunk) => chunk.value.includes("replayed history"))).toBe(false);
  });

  it.each(["code", "ask", "plan"] as const)("reconciles the model and %s mode after resuming", async (mode) => {
    const { input, entries } = setup(mode);
    await new AcpHarnessAdapter(async () => "allow-once").run({
      ...input, modelId: "different-model",
      config: { ...input.config, acpEnv: `${String(input.config?.acpEnv)};FAKE_ACP_MODE=${mode === "code" ? "plan" : "default"}` },
      providerSessionRuntime: {
        ownerId: input.runId, ownerKind: "run", providerAccountId: null, providerType: "acp", harnessType: "acp",
        status: "ready", cwd: input.worktreePath, modelId: "fast", runtimeMode: mode === "code" ? "plan" : "code",
        resumeCursor: { sessionId: "session-1" }, runtimePayload: null, lastSeenAt: "", createdAt: "", updatedAt: "",
      },
    }, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    const log = entries();
    expect(log.some((entry) => entry.method === "session/new")).toBe(false);
    expect(log.find((entry) => entry.method === "session/set_model")?.params).toMatchObject({ modelId: "different-model" });
    expect(log.find((entry) => entry.method === "session/set_mode")?.params).toMatchObject({ modeId: mode === "code" ? "default" : "plan" });
    const methods = log.map((entry) => entry.method);
    expect(methods.indexOf("session/set_model")).toBeLessThan(methods.indexOf("session/prompt"));
    expect(methods.indexOf("session/set_mode")).toBeLessThan(methods.indexOf("session/prompt"));
  });

  it.each(["session/set_model", "session/set_mode"])("stops before prompting when %s rejects the requested setting", async (method) => {
    const { root, input, entries } = setup("plan");
    writeFileSync(join(root, "fake-agent.mjs"), FAKE_AGENT.replace('if (method === "initialize") {',
      `if (method === ${JSON.stringify(method)}) { send({ id, error: { code: -32000, message: "unsupported setting" } }); } else if (method === "initialize") {`));
    await expect(new AcpHarnessAdapter().run(input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal))
      .rejects.toThrow("unsupported setting");
    expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
  });

  it("tells a text-generation session that it cannot read or write files", async () => {
    const { workspace, config, entries } = setup("ask");
    const result = await generateUtilityTextWithAcp({ cwd: workspace, prompt: "Write a commit message", modelId: "default", config });
    expect(result.text).toContain("The note says:");
    expect(entries().find((entry) => entry.method === "initialize")?.params)
      .toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  });

  it("lists the models an agent offers", async () => {
    const { config } = setup();
    const models = await new AcpProviderAdapter().listAvailableModels({ providerAccountId: "p", providerType: "acp", config });
    expect(models.map((model) => model.modelId)).toEqual(["default", "fast"]);
  });

  it("reports what the agent supports without starting a session", async () => {
    const { config, entries } = setup();
    await expect(new AcpProviderAdapter().probeSessionCapabilities({ providerAccountId: "p", providerType: "acp", config })).resolves.toMatchObject({
      agentName: "Fake Agent", agentVersion: "0.3.0", mcpHttp: true, sessionResume: true,
    });
    expect(entries().map((entry) => entry.method)).toEqual(["initialize"]);
  });
});

describe("ACP agent that exits early", () => {
  it("rejects requests instead of writing to the closed pipe", async () => {
    const { AcpConnection } = await import("@buildwarden/provider-acp");
    const connection = new AcpConnection({ command: process.execPath, args: ["-e", "process.exit(3)"], env: {} }, tmpdir(), 5_000);
    const exited = new Promise((resolve) => setTimeout(resolve, 500));
    connection.start();
    await exited;
    await expect(connection.request("initialize", {})).rejects.toThrow("not running");
    expect(() => connection.notify("session/cancel", {})).not.toThrow();
    await connection.close();
  });
});

describe("cancelling an ACP run before its session exists", () => {
  it.each([false, true])("finishes an established session after cancellation (cooperative: %s)", async (cooperative) => {
    const { root, input, entries } = setup();
    // Keep the prompt pending. A cooperative agent answers it only after session/cancel.
    const script = FAKE_AGENT
      .replace('const sessionId = params.sessionId;', 'globalThis.pendingPromptId = id; return; const sessionId = params.sessionId;')
      .replace('if (method === "initialize") {', `if (method === "session/cancel" && ${String(cooperative)}) {
        send({ id: globalThis.pendingPromptId, result: { stopReason: "cancelled" } });
      } else if (method === "initialize") {`);
    writeFileSync(join(root, "fake-agent.mjs"), script);
    const controller = new AbortController();
    const running = new AcpHarnessAdapter().run(input, { tools: [], executeTool: vi.fn() }, () => undefined, controller.signal);
    try {
      await vi.waitFor(() => expect(entries().some((entry) => entry.method === "session/prompt")).toBe(true));
      controller.abort();
      await expect(running).resolves.toMatchObject({ summary: "ACP agent run cancelled." });
      expect(entries().some((entry) => entry.method === "session/cancel")).toBe(true);
    } finally {
      controller.abort();
      await running;
    }
  }, 15_000);

  it("stops the agent instead of waiting for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-stall-"));
    roots.push(root);
    const script = join(root, "stall.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const started = Date.now();
    const running = new AcpHarnessAdapter().run(
      { runId: "r", worktreePath: root, mode: "code", prompt: "Hi", providerType: "acp", modelId: "default", apiKey: "",
        config: { acpCommand: `"${process.execPath}" "${script}"` } },
      { tools: [], executeTool: vi.fn() }, () => undefined, controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    await expect(running).resolves.toMatchObject({ summary: "ACP agent run cancelled." });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("does not start an agent for a run that was cancelled already", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new AcpHarnessAdapter().run(
      { runId: "r", worktreePath: tmpdir(), mode: "code", prompt: "Hi", providerType: "acp", modelId: "default", apiKey: "",
        config: { acpCommand: "this-agent-does-not-exist --acp" } },
      { tools: [], executeTool: vi.fn() }, () => undefined, controller.signal,
    )).resolves.toMatchObject({ summary: "ACP agent run cancelled." });
  });
});

describe("ACP text generation", () => {
  it("does not start an agent when the request was cancelled already", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateUtilityTextWithAcp({
      cwd: tmpdir(), prompt: "Write a commit message", modelId: "default", signal: controller.signal,
      config: { acpCommand: "this-agent-does-not-exist --acp" },
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ACP review fixes", () => {
  const run = (input: RunExecutionRequest, approve?: ConstructorParameters<typeof AcpHarnessAdapter>[0], chunks: HarnessRunChunk[] = []) =>
    new AcpHarnessAdapter(approve).run(input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
  const withAgent = (root: string, script: string) => writeFileSync(join(root, "fake-agent.mjs"), script);
  const resumeRuntime = (input: RunExecutionRequest) => ({
    ...input, providerSessionRuntime: { resumeCursor: { sessionId: "session-1" } } as unknown as RunExecutionRequest["providerSessionRuntime"],
  });

  it.each(["allow-for-run", "allow-always"] as const)("answers %s with the agent's one-time option, so the agent stores nothing", async (decision) => {
    const { root, input, entries } = setup("code");
    withAgent(root, FAKE_AGENT.replace(
      'options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }',
      'options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "yes", name: "Allow", kind: "allow_once" }',
    ));
    await run(input, async () => decision);
    const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });

  it.each([false, true])("declines an action the agent offers only a permanent approval for (Full Access: %s)", async (yoloMode) => {
    const { root, input, entries } = setup("code");
    withAgent(root, FAKE_AGENT.replace(
      'options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }',
      'options: [{ optionId: "always", name: "Always", kind: "allow_always" }',
    ));
    const approve = vi.fn(async () => "allow-once" as const);
    const chunks: HarnessRunChunk[] = [];
    await run({ ...input, yoloMode }, approve, chunks);
    const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
    // The user is not asked for something BuildWarden could only grant permanently inside the agent.
    expect(approve).not.toHaveBeenCalled();
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.value.includes("only a permanent approval"))).toBe(true);
  });

  it("skips the prompt for a tool the user always allows for this agent, and only this agent", async () => {
    const { input, entries } = setup("code");
    const approve = vi.fn(async () => "deny" as const);
    await run({ ...input, toolApprovalAllowlist: ["acp:acp-account-1:edit:Edit note (note.txt)"] }, approve);
    const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
    expect(approve).not.toHaveBeenCalled();
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });

    const other = setup("code");
    const otherApprove = vi.fn(async () => "deny" as const);
    await run({ ...other.input, providerAccountId: "acp-account-2", toolApprovalAllowlist: ["acp:acp-account-1:edit:Edit note (note.txt)"] }, otherApprove);
    expect(otherApprove).toHaveBeenCalledWith("Edit note (note.txt)", { approvalKey: "acp:acp-account-2:edit:Edit note (note.txt)" });
  });

  it("does not let an approval for one file's edit cover another edit with the same title", async () => {
    const { root, input } = setup("code");
    withAgent(root, FAKE_AGENT.replace('locations: [{ path: "note.txt" }]', 'locations: [{ path: "other.txt" }]'));
    const approve = vi.fn(async () => "deny" as const);
    await run({ ...input, toolApprovalAllowlist: ["acp:acp-account-1:edit:Edit note (note.txt)"] }, approve);
    expect(approve).toHaveBeenCalledWith("Edit note (other.txt)", { approvalKey: "acp:acp-account-1:edit:Edit note (other.txt)" });
  });

  it("keys an action without a command or files by its exact input", async () => {
    const { root, input } = setup("code");
    const withInput = (value: string) => FAKE_AGENT.replace('locations: [{ path: "note.txt" }]', `rawInput: { note: "${value}" }`);
    const keys: Array<string | undefined> = [];
    const approve = vi.fn(async (_command: string, options?: { approvalKey?: string; onceOnly?: boolean }) => {
      keys.push(options?.approvalKey);
      expect(options?.onceOnly).toBeUndefined();
      return "allow-once" as const;
    });
    for (const value of ["first", "second", "first"]) {
      withAgent(root, withInput(value));
      await run(input, approve);
    }
    expect(keys[0]).toMatch(/^acp:acp-account-1:edit:Edit note #[0-9a-f]{16}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("allows an action with nothing specific to remember only once", async () => {
    const { root, input, entries } = setup("code");
    withAgent(root, FAKE_AGENT.replace(', locations: [{ path: "note.txt" }]', ""));
    const approve = vi.fn(async () => "allow-once" as const);
    // A remembered approval for the bare title does not apply either.
    await run({ ...input, toolApprovalAllowlist: ["acp:acp-account-1:edit:Edit note"] }, approve);
    expect(approve).toHaveBeenCalledWith("Edit note", { approvalKey: "acp:acp-account-1:edit:Edit note", onceOnly: true });
    const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });

  it("shows the agent's reasoning as a reasoning stream", async () => {
    const { root, input } = setup("code");
    withAgent(root, FAKE_AGENT.replace(
      'update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading. " } });',
      'update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it " } }); update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "over." } }); update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading. " } });',
    ));
    const chunks: HarnessRunChunk[] = [];
    await run(input, async () => "allow-once", chunks);
    const reasoning = chunks.filter((chunk) => chunk.metadata?.assistantKind === "reasoning");
    expect(reasoning.at(-1)).toMatchObject({ type: "message", value: "Thinking it over.", metadata: { streamId: "acp-thought-0", replace: true } });
  });

  it("sends the earlier conversation when the saved session cannot be reloaded", async () => {
    const { root, input, entries } = setup("code");
    withAgent(root, FAKE_AGENT.replace('} else if (method === "session/load") {',
      '} else if (method === "session/load") { send({ id, error: { code: -32000, message: "session expired" } }); } else if (method === "never") {'));
    const chunks: HarnessRunChunk[] = [];
    await run({ ...resumeRuntime(input), resumeFallbackContext: "User: keep the public API stable." }, async () => "allow-once", chunks);
    const prompt = entries().find((entry) => entry.method === "session/prompt")?.params as { prompt: Array<{ text: string }> };
    expect(entries().some((entry) => entry.method === "session/new")).toBe(true);
    expect(prompt.prompt[0]?.text).toContain("<earlier_conversation>");
    expect(prompt.prompt[0]?.text).toContain("keep the public API stable");
    expect(chunks.some((chunk) => chunk.value.includes("earlier conversation is sent"))).toBe(true);
  });

  it("does not repeat the earlier conversation when the session reloads", async () => {
    const { input, entries } = setup("code");
    await run({ ...resumeRuntime(input), resumeFallbackContext: "User: keep the public API stable." }, async () => "allow-once");
    const prompt = entries().find((entry) => entry.method === "session/prompt")?.params as { prompt: Array<{ text: string }> };
    expect(prompt.prompt[0]?.text).not.toContain("<earlier_conversation>");
  });

  it("stops an inspect turn when the agent runs a command without asking", async () => {
    // t0 is never put to BuildWarden, so it was never approved.
    const { root, input } = setup("ask");
    withAgent(root, FAKE_AGENT.replace(
      'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"',
      'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: "Delete build", kind: "execute", status: "in_progress" }); update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"',
    ));
    await expect(run(input, async () => "allow-once")).rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
  });

  it("stops an inspect turn when the agent runs an edit BuildWarden rejected", async () => {
    const { root, input, entries } = setup("ask");
    withAgent(root, FAKE_AGENT.replace('const allowed = permission.outcome?.optionId === "yes";', "const allowed = true;"));
    await expect(run(input, async () => "allow-once")).rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
    const results = entries().find((entry) => entry.results)?.results as Record<string, unknown>;
    expect(results.permission).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  it.each(["other", "fetch", undefined])("stops an inspect turn when the agent runs a %s tool without asking", async (kind) => {
    const { root, input } = setup("ask");
    const kindField = kind ? `, kind: ${JSON.stringify(kind)}` : "";
    withAgent(root, FAKE_AGENT.replace(
      'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"',
      `update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: "create_issue (tracker MCP Server)"${kindField}, status: "completed" }); update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"`,
    ));
    await expect(run(input, async () => "allow-once")).rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
  });

  /** Agent code that calls a BuildWarden tool through the bridge the run handed it. */
  const callBridge = (name: string) =>
    `await fetch(globalThis.bridge.url, { method: "POST", headers: { "Content-Type": "application/json", ...globalThis.bridge.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: ${JSON.stringify(name)}, arguments: {} } }) });`;
  const toolUpdate = (title: string, status: string, kind = "other") =>
    `update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: ${JSON.stringify(title)}, kind: ${JSON.stringify(kind)}, status: ${JSON.stringify(status)} });`;
  const beforeEdit = 'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"';
  const bridgeTools = (...extra: string[]) => ({
    tools: ["buildwarden_tasks_list", ...extra].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    executeTool: vi.fn(async () => ({ ok: true, content: "[]" })),
  });

  it("lets an inspect turn call BuildWarden's own tools through the bridge", async () => {
    const { root, input } = setup("ask");
    const runWith = (agentCode: string) => {
      withAgent(root, FAKE_AGENT.replace(beforeEdit, `${agentCode} ${beforeEdit}`));
      return new AcpHarnessAdapter(async () => "allow-once").run(input, bridgeTools() as never, () => undefined, new AbortController().signal);
    };
    const title = "mcp__buildwarden__buildwarden_tasks_list";
    await expect(runWith(`${callBridge("buildwarden_tasks_list")} ${toolUpdate(title, "completed")}`)).resolves.toBeDefined();
    // Reported running before the bridge received it: checked once it completes, or when the turn ends.
    await expect(runWith(`${toolUpdate(title, "in_progress")} ${callBridge("buildwarden_tasks_list")} ${toolUpdate(title, "completed")}`)).resolves.toBeDefined();
    await expect(runWith(`${toolUpdate(title, "in_progress")} ${callBridge("buildwarden_tasks_list")}`)).resolves.toBeDefined();
  });

  it("does not take the agent's word that a tool is BuildWarden's", async () => {
    const { root, input } = setup("ask");
    const runWith = (agentCode: string, tools = bridgeTools()) => {
      withAgent(root, FAKE_AGENT.replace(beforeEdit, `${agentCode} ${beforeEdit}`));
      return new AcpHarnessAdapter(async () => "allow-once").run(input, tools as never, () => undefined, new AbortController().signal);
    };
    const violation = "without BuildWarden's permission in an inspect-only turn";
    // The run's own built-in tools are never served by the bridge, so another server's
    // `write_file` cannot pass for one of them.
    await expect(runWith(toolUpdate("mcp__filesystem__write_file", "completed"), bridgeTools("write_file", "run_shell"))).rejects.toThrow(violation);
    // A title naming a BuildWarden tool the bridge never received a call for.
    await expect(runWith(toolUpdate("mcp__buildwarden__buildwarden_tasks_list", "completed"))).rejects.toThrow(violation);
    await expect(runWith(toolUpdate("mcp__other__buildwarden_tasks_list", "in_progress"))).rejects.toThrow(violation);
    // One real bridge call vouches for one agent call, not for a look-alike next to it.
    await expect(runWith(
      `${callBridge("buildwarden_tasks_list")} ${toolUpdate("mcp__buildwarden__buildwarden_tasks_list", "completed")} ${toolUpdate("mcp__other__buildwarden_tasks_list", "completed").replace('"t0"', '"t2"')}`,
    )).rejects.toThrow(violation);
  });

  it("approves an inspect turn's permission request for a BuildWarden tool, then checks the call reached the bridge", async () => {
    const { root, input, entries } = setup("ask");
    const title = "buildwarden_tasks_list (buildwarden MCP Server)";
    const askThenCall = (call: string) =>
      `update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: ${JSON.stringify(title)}, status: "pending" });` +
      ` const asked = await request("session/request_permission", { sessionId, toolCall: { toolCallId: "t0" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "nope", name: "Reject", kind: "reject_once" }] });` +
      ` log({ bridgePermission: asked });` +
      ` if (asked.outcome?.optionId === "ok") { ${call} ${toolUpdate(title, "completed")} }`;
    const runWith = (agentCode: string) => {
      withAgent(root, FAKE_AGENT.replace(beforeEdit, `${agentCode} ${beforeEdit}`));
      return new AcpHarnessAdapter(approve).run(input, tools as never, () => undefined, new AbortController().signal);
    };
    const approve = vi.fn(async () => "allow-once" as const);
    const tools = bridgeTools();

    await expect(runWith(askThenCall(callBridge("buildwarden_tasks_list")))).resolves.toBeDefined();
    expect(entries().find((entry) => entry.bridgePermission)?.bridgePermission).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(tools.executeTool).toHaveBeenCalledTimes(1);
    // BuildWarden's own tools need no prompt; the edit later in the turn is still refused unasked.
    expect(approve).not.toHaveBeenCalled();
    // Permission for a BuildWarden tool does not cover a call that never reaches the bridge.
    await expect(runWith(askThenCall(""))).rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
  });

  it("rejects look-alike BuildWarden tool titles in an inspect turn", async () => {
    const { root, input } = setup("ask");
    const tools = bridgeTools();
    // Similar names, and state-changing calls whose title mentions a bridge tool, are still violations.
    for (const [title, kind] of [
      ["buildwarden_tasks_list_all", "other"],
      ["create_buildwarden_tasks_list", "other"],
      ["Run: echo buildwarden_tasks_list", "execute"],
      ["Edit buildwarden_tasks_list", "edit"],
    ] as const) {
      withAgent(root, FAKE_AGENT.replace(
        'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"',
        `update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: ${JSON.stringify(title)}, kind: ${JSON.stringify(kind)}, status: "completed" }); update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1"`,
      ));
      await expect(new AcpHarnessAdapter(async () => "allow-once").run(input, tools as never, () => undefined, new AbortController().signal), title)
        .rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
    }
  });

  it("closes the connection when the agent ignores the cancel after a violation", async () => {
    const { root, input } = setup("ask");
    // The agent runs a command unasked, then never answers the prompt or the cancel.
    withAgent(root, FAKE_AGENT.replace(
      'update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading. " } });',
      'update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: "Delete build", kind: "execute", status: "in_progress" }); return;',
    ));
    const started = Date.now();
    await expect(run(input, async () => "allow-once")).rejects.toThrow("without BuildWarden's permission in an inspect-only turn");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses an orchestration inspect task when the agent has no read-only mode, and warns otherwise", async () => {
    const { root, input, entries } = setup("ask");
    withAgent(root, FAKE_AGENT.replace(
      'modes: { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }], currentModeId: "default" } } });',
      '} });',
    ));
    await expect(run({ ...input, requireReadOnly: true })).rejects.toThrow("offers no read-only mode");
    expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
    const chunks: HarnessRunChunk[] = [];
    await run(input, undefined, chunks);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.value.includes("no read-only mode"))).toBe(true);
  });
});

describe("required project MCP servers on an ACP agent without HTTP MCP", () => {
  it("fails the run for a required server and only warns for optional ones", async () => {
    const { root, input, entries } = setup("code");
    writeFileSync(join(root, "fake-agent.mjs"), FAKE_AGENT.replace("mcpCapabilities: { http: true }", "mcpCapabilities: { http: false }"));
    const server = { name: "tracker", url: "https://example.test/mcp" };
    const run = (required: boolean, chunks: HarnessRunChunk[] = []) => new AcpHarnessAdapter(async () => "allow-once").run(
      { ...input, mcpServers: [{ ...server, required }] }, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);

    await expect(run(true)).rejects.toThrow("required project MCP server tracker cannot be used");
    expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
    const chunks: HarnessRunChunk[] = [];
    await run(false, chunks);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.value.includes("does not accept HTTP MCP servers"))).toBe(true);
  });
});

describe("required project MCP servers on an ACP agent with HTTP MCP", () => {
  it("checks that each required server connects before the session starts", async () => {
    const { input, entries } = setup("code");
    // Nothing listens on the discard port, so the connection is refused.
    const unreachable = { name: "tracker", url: "http://127.0.0.1:9/mcp" };
    const run = (required: boolean) => new AcpHarnessAdapter(async () => "allow-once").run(
      { ...input, mcpServers: [{ ...unreachable, required }] }, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);

    await expect(run(true)).rejects.toThrow("Required project MCP server could not connect: tracker");
    expect(entries().some((entry) => entry.method === "session/new")).toBe(false);
    // The agent reports nothing about optional servers, so they are handed over unchecked.
    await run(false);
    const created = entries().find((entry) => entry.method === "session/new")?.params as { mcpServers: Array<{ name: string }> };
    expect(created.mcpServers.map((server) => server.name)).toContain("tracker");
  });
});

describe("ACP served model", () => {
  it("reports the agent's model when the run uses the agent's default", async () => {
    const { root, input } = setup("code");
    writeFileSync(join(root, "fake-agent.mjs"), FAKE_AGENT.replace(
      'models: { availableModels: [{ modelId: "fast", name: "Fast" }] }',
      'models: { availableModels: [{ modelId: "fast", name: "Fast" }], currentModelId: "fast" }',
    ));
    const run = async (modelId: string) => {
      const chunks: HarnessRunChunk[] = [];
      await new AcpHarnessAdapter(async () => "allow-once").run({ ...input, modelId }, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
      return chunks.filter((chunk) => chunk.metadata?.executedModel !== undefined).map((chunk) => chunk.metadata?.executedModel);
    };
    expect(await run("default")).toEqual(["fast"]);
    // A model BuildWarden selected itself is already known.
    expect(await run("fast")).toEqual([]);
  });
});
