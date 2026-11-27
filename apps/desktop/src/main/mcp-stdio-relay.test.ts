import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpStdioRelayServer, resolveMcpStdioRelayLaunch, runMcpStdioRelay, startHarnessMcp } from "@buildwarden/agent-runtime";
import { AcpHarnessAdapter } from "@buildwarden/provider-acp";
import type { HarnessRunChunk, HarnessToolContext, HarnessToolName, RunExecutionRequest, RunToolResult } from "@buildwarden/shared";

vi.setConfig({ testTimeout: 30_000 });

const RELAY_SOURCE = fileURLToPath(new URL("../../../../packages/agent-runtime/src/mcp-stdio-relay-main.ts", import.meta.url));
/** Node runs the relay's TypeScript source directly, as Electron runs its bundled copy. */
const relayLaunch = { command: process.execPath, args: [RELAY_SOURCE] };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const bridgeTools = () => {
  const executeTool = vi.fn(async (call: { id: string; name: HarnessToolName; arguments: Record<string, unknown> }): Promise<RunToolResult> => ({
    toolCallId: call.id, name: call.name, ok: true, content: `ran ${call.name} with ${JSON.stringify(call.arguments)}`,
  }));
  const context: HarnessToolContext = {
    tools: [{ name: "buildwarden_tasks_list", description: "List tasks", inputSchema: { type: "object" } }],
    executeTool,
  };
  return { ...context, executeTool };
};

describe("MCP stdio relay", () => {
  it("relays requests to the HTTP bridge and answers notifications with nothing", async () => {
    const bridge = (await startHarnessMcp(bridgeTools()))!;
    const input = new PassThrough();
    const written: unknown[] = [];
    const done = runMcpStdioRelay({ url: bridge.url, headers: bridge.headers, input, write: (message) => written.push(message) });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "buildwarden_tasks_list", arguments: { a: 1 } } })}\n`);
    input.end();
    await done;
    await bridge.close();
    expect(written).toHaveLength(3);
    expect(written).toContainEqual(expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: { name: "buildwarden-orchestration", version: "1.0.0" } }) }));
    expect(written).toContainEqual(expect.objectContaining({ id: 2, result: { tools: [expect.objectContaining({ name: "buildwarden_tasks_list" })] } }));
    expect(written).toContainEqual(expect.objectContaining({
      id: 3, result: { content: [{ type: "text", text: 'ran buildwarden_tasks_list with {"a":1}' }], isError: false },
    }));
  });

  it("turns a refused request into a JSON-RPC error for the agent", async () => {
    const bridge = (await startHarnessMcp(bridgeTools()))!;
    const input = new PassThrough();
    const written: unknown[] = [];
    const done = runMcpStdioRelay({ url: bridge.url, headers: { Authorization: "Bearer wrong" }, input, write: (message) => written.push(message) });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`);
    await done;
    await bridge.close();
    expect(written).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "The MCP server answered HTTP 401." } }]);
  });

  it("reads its launch from the environment and keeps the target in the server's environment", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveMcpStdioRelayLaunch(env)).toBeNull();
    env.BUILDWARDEN_MCP_STDIO_RELAY = JSON.stringify({ command: "/app/buildwarden", args: ["/app/relay.js"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    const launch = resolveMcpStdioRelayLaunch(env)!;
    expect(acpStdioRelayServer(launch, "tracker", { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer secret" } })).toEqual({
      name: "tracker",
      command: "/app/buildwarden",
      args: ["/app/relay.js"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "BUILDWARDEN_MCP_RELAY_URL", value: "http://127.0.0.1:1/mcp" },
        { name: "BUILDWARDEN_MCP_RELAY_HEADERS", value: '{"Authorization":"Bearer secret"}' },
      ],
    });
  });
});

interface SeenRequest { method: string; headers: Record<string, string>; body: Record<string, unknown> | null; redirect?: RequestRedirect }

/** A fake MCP endpoint: `answer` replies to each POST; a DELETE gets an empty 200. */
const fakeEndpoint = (answer: (body: Record<string, unknown>) => Response | Promise<Response>) => {
  const seen: SeenRequest[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const entry: SeenRequest = {
      method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    seen.push(entry);
    if (entry.method === "DELETE") return new Response(null, { status: 200 });
    return answer(entry.body ?? {});
  }) as typeof fetch;
  return { seen, fetcher };
};

const sseResponse = (message: unknown, headers: Record<string, string> = {}) =>
  new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } });
const jsonResponse = (message: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(message), { headers: { "content-type": "application/json", ...headers } });
const initializeResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });

/** Runs the relay over `lines` (objects are sent as JSON) and returns what it wrote for the agent. */
const relayLines = async (fetcher: typeof fetch, lines: unknown[]) => {
  const input = new PassThrough();
  const written: unknown[] = [];
  const done = runMcpStdioRelay({ url: "http://127.0.0.1:1/mcp", headers: {}, input, write: (message) => written.push(message), fetcher });
  for (const line of lines) input.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
  input.end();
  await done;
  return written;
};

describe("MCP stdio relay against an HTTP endpoint", () => {
  it("names the negotiated protocol version on every later request, also after an event-stream initialize", async () => {
    const { seen, fetcher } = fakeEndpoint((body) => body.method === "initialize"
      ? sseResponse(initializeResult(body.id), { "mcp-session-id": "sess-1" })
      : jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    const written = await relayLines(fetcher, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(written).toHaveLength(2);
    expect(seen.map((entry) => [entry.method, entry.headers["MCP-Protocol-Version"]])).toEqual([
      ["POST", undefined], ["POST", "2025-06-18"], ["DELETE", "2025-06-18"],
    ]);
  });

  it("opens a new session when the server forgot the old one, without repeating the failed call", async () => {
    let sessions = 0;
    const { seen, fetcher } = fakeEndpoint((body) => {
      if (body.method === "initialize") {
        sessions += 1;
        return jsonResponse(initializeResult(body.id), { "mcp-session-id": `s${String(sessions)}` });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return seen.at(-1)?.headers["Mcp-Session-Id"] === "s1"
        ? new Response("gone", { status: 404 })
        : jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const input = new PassThrough();
    const written: Array<Record<string, unknown>> = [];
    const done = runMcpStdioRelay({ url: "http://127.0.0.1:1/mcp", headers: {}, input, write: (message) => written.push(message as Record<string, unknown>), fetcher });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await vi.waitFor(() => expect(written).toHaveLength(2));
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    await done;
    expect(written[1]).toMatchObject({ id: 2, error: { message: expect.stringContaining("opened a new one") } });
    expect(written[2]).toMatchObject({ id: 3, result: { tools: [] } });
    expect(written).toHaveLength(3);
    expect(seen.filter((entry) => entry.body?.method === "tools/list").map((entry) => entry.headers["Mcp-Session-Id"])).toEqual(["s1", "s2"]);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", headers: { "Mcp-Session-Id": "s2" } });
  });

  it("stops reading a JSON body at its limit instead of buffering all of it", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(1_048_576)));
      },
      cancel() { cancelled = true; },
    });
    const { fetcher } = fakeEndpoint(() => new Response(endless(), { headers: { "content-type": "application/json" } }));
    const written = await relayLines(fetcher, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(written).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "The MCP server sent a response larger than the relay accepts." } }]);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });
});

/** An ACP agent without HTTP MCP: it starts each stdio server it is given and lists and calls its tools. */
const STDIO_AGENT = String.raw`
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let servers = [];
const callServer = (server, messages) => new Promise((resolve, reject) => {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } });
  const answers = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => answers.push(JSON.parse(line)));
  child.on("exit", () => resolve({ answers, stderr }));
  child.on("error", reject);
  for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n");
  child.stdin.end();
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: false } } } });
  } else if (method === "session/new") {
    servers = params.mcpServers;
    log({ servers: servers.map((server) => ({ name: server.name, hasCommand: typeof server.command === "string", type: server.type ?? null })) });
    send({ id, result: { sessionId: "s1" } });
  } else if (method === "session/prompt") {
    const bridge = servers.find((server) => server.name.startsWith("buildwarden-"));
    const result = !bridge ? { answers: [], stderr: "" } : await callServer(bridge, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "buildwarden_tasks_list", arguments: {} } },
    ]);
    log({ answers: result.answers, stderr: result.stderr.includes("Error") ? result.stderr : "" });
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, result: null });
  }
});
`;

describe("ACP agent without HTTP MCP", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-relay-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const script = join(root, "agent.mjs");
    const log = join(root, "agent.log");
    writeFileSync(script, STDIO_AGENT);
    writeFileSync(log, "");
    const input: RunExecutionRequest = {
      runId: "run-1", providerAccountId: "acp-1", worktreePath: workspace, mode: "code", prompt: "List tasks",
      providerType: "acp", modelId: "default", apiKey: "",
      config: { acpCommand: `"${process.execPath}" "${script}"`, acpEnv: `FAKE_ACP_LOG=${log}` },
      mcpServers: [{ name: "tracker", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } }],
    };
    const entries = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { input, entries };
  };

  it("gets BuildWarden's tools and the project's servers through the stdio relay", async () => {
    const { input, entries } = setup();
    const tools = bridgeTools();
    const chunks: HarnessRunChunk[] = [];
    const result = await new AcpHarnessAdapter(async () => "allow-once", { resolveStdioRelay: () => relayLaunch })
      .run(input, tools, (chunk) => chunks.push(chunk), new AbortController().signal);
    expect(result.summary).toBe("done");
    const [servers, answers] = entries();
    expect(servers).toEqual({ servers: [
      { name: expect.stringMatching(/^buildwarden-/), hasCommand: true, type: null },
      { name: "tracker", hasCommand: true, type: null },
    ] });
    expect(answers).toMatchObject({ stderr: "", answers: [
      { id: 1, result: { serverInfo: { name: "buildwarden-orchestration" } } },
      { id: 2, result: { content: [{ type: "text", text: "ran buildwarden_tasks_list with {}" }], isError: false } },
    ] });
    expect(tools.executeTool).toHaveBeenCalledOnce();
    expect(chunks.find((chunk) => chunk.metadata?.sessionCapabilities)?.metadata?.sessionCapabilities).toMatchObject({ mcpHttp: true });
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.value.includes("does not accept HTTP MCP servers"))).toBe(false);
  });

  it("still reports the tools as unavailable when no relay is configured", async () => {
    const { input } = setup();
    const chunks: HarnessRunChunk[] = [];
    await new AcpHarnessAdapter(async () => "allow-once", { resolveStdioRelay: () => null })
      .run({ ...input, mcpServers: [] }, bridgeTools(), (chunk) => chunks.push(chunk), new AbortController().signal);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.value.includes("does not accept HTTP MCP servers"))).toBe(true);
  });
});
