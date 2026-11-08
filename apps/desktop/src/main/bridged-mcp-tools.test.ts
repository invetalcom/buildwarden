import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBridgedMcpServers, McpHttpClient, startHarnessMcp } from "@buildwarden/agent-runtime";
import type { HarnessRunChunk, HarnessToolContext } from "@buildwarden/shared";
import { bridgeProjectMcpServers } from "./bridged-mcp-tools";

const servers: Server[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A Streamable HTTP MCP server: JSON for most answers, an event stream for one tool. */
const startMcpServer = async (options: { authorization?: string } = {}) => {
  const calls: Array<{ name: string; arguments: unknown; session: string | undefined }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (options.authorization && request.headers.authorization !== options.authorization) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-1" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "docs" } });
      if (message.method === "tools/list") {
        return reply({ tools: [
          { name: "search_docs", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
          { name: "create-issue", description: "Create", inputSchema: { type: "object" } },
        ] });
      }
      if (message.method === "tools/call") {
        const params = message.params ?? {};
        calls.push({ name: String(params.name), arguments: params.arguments, session: request.headers["mcp-session-id"] as string | undefined });
        if (params.name === "flood") {
          // An event that never ends.
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(`data: ${"x".repeat(5 * 1_048_576)}`);
          return;
        }
        if (params.name === "search_docs") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
          response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "found 3 pages" }] } })}\n\n`);
          return;
        }
        return reply({ content: [{ type: "text", text: "issue created" }], isError: false });
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`, calls };
};

const baseContext: HarnessToolContext = {
  tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
  executeTool: async (call) => ({ toolCallId: call.id, name: call.name, ok: true, content: "base" }),
};

describe("MCP client", () => {
  it("lists tools, keeps the session, and reads event-stream answers", async () => {
    const { url, calls } = await startMcpServer({ authorization: "Bearer secret" });
    const session = await connectBridgedMcpServers([
      { name: "Docs Server", url, headers: { Authorization: "Bearer secret" } },
      { name: "broken", url: "http://127.0.0.1:1/mcp" },
    ]);
    closers.push(session.close);

    expect(session.servers).toEqual(expect.arrayContaining([
      { name: "Docs Server", status: "connected", toolCount: 2 },
      expect.objectContaining({ name: "broken", status: "failed" }),
    ]));
    expect(session.tools.map((tool) => tool.name)).toEqual(["mcp__Docs_Server__search_docs", "mcp__Docs_Server__create-issue"]);
    await expect(session.call("mcp__Docs_Server__search_docs", { q: "wal" })).resolves.toMatchObject({ ok: true, content: "found 3 pages" });
    expect(calls).toEqual([{ name: "search_docs", arguments: { q: "wal" }, session: "session-1" }]);
  });

  it("refuses an event stream that never finishes an event", async () => {
    const { url } = await startMcpServer();
    const client = new McpHttpClient({ name: "docs", url });
    await client.initialize();
    await expect(client.callTool("flood", {})).rejects.toThrow("larger than the allowed limit");
  });
});

describe("bridged project MCP tools", () => {
  const bridge = async (mode: "code" | "ask", yoloMode: boolean, decision: "allow-once" | "allow-for-run" | "deny" = "allow-once") => {
    const { url, calls } = await startMcpServer();
    const chunks: HarnessRunChunk[] = [];
    const requestApproval = vi.fn(async () => decision);
    const bridged = await bridgeProjectMcpServers([{ name: "docs", url }], baseContext, {
      mode, yoloMode, requestApproval, onChunk: (chunk) => chunks.push(chunk), signal: new AbortController().signal,
    });
    closers.push(bridged.close);
    return { bridged, calls, chunks, requestApproval };
  };

  it("offers only read-only tools in ask mode", async () => {
    const { bridged, chunks } = await bridge("ask", true);
    expect(bridged.toolContext.tools.map((tool) => tool.name)).toEqual(["read_file", "mcp__docs__search_docs"]);
    expect(chunks[0]?.value).toContain("1 tools without a read-only hint are unavailable in ask mode");
    expect(chunks[0]?.metadata?.sessionCapabilities).toMatchObject({ mcpServers: [{ name: "docs", status: "connected" }] });
  });

  it("asks before each call without Full Access and honors the answer", async () => {
    const denied = await bridge("code", false, "deny");
    const refusal = await denied.bridged.toolContext.executeTool({ id: "1", name: "mcp__docs__create-issue", arguments: { title: "Bug" } });
    expect(refusal).toMatchObject({ ok: false, content: "The user denied this MCP tool call." });
    expect(denied.requestApproval).toHaveBeenCalledWith('mcp docs create-issue {"title":"Bug"}', { approvalKey: "mcp:docs/create-issue" });
    expect(denied.calls).toEqual([]);

    const allowed = await bridge("code", false, "allow-for-run");
    await allowed.bridged.toolContext.executeTool({ id: "1", name: "mcp__docs__create-issue", arguments: {} });
    await allowed.bridged.toolContext.executeTool({ id: "2", name: "mcp__docs__create-issue", arguments: {} });
    expect(allowed.requestApproval).toHaveBeenCalledTimes(1);
    expect(allowed.calls).toHaveLength(2);
  });

  it("skips the prompt for a tool the user always allows, whatever its arguments", async () => {
    const { url, calls } = await startMcpServer();
    const requestApproval = vi.fn(async () => "deny" as const);
    const bridged = await bridgeProjectMcpServers([{ name: "docs", url }], baseContext, {
      mode: "code", yoloMode: false, requestApproval, alwaysAllowed: ["mcp:docs/create-issue"],
      onChunk: () => undefined, signal: new AbortController().signal,
    });
    closers.push(bridged.close);
    await bridged.toolContext.executeTool({ id: "1", name: "mcp__docs__create-issue", arguments: { title: "Any" } });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("fails the run when a required server cannot connect, and skips an optional one", async () => {
    const { url } = await startMcpServer();
    const options = { mode: "code" as const, yoloMode: true, requestApproval: vi.fn(), onChunk: () => undefined, signal: new AbortController().signal };
    await expect(bridgeProjectMcpServers([{ name: "docs", url }, { name: "broken", url: "http://127.0.0.1:1/mcp", required: true }], baseContext, options))
      .rejects.toThrow("Required project MCP server could not connect: broken");
    const chunks: HarnessRunChunk[] = [];
    const optional = await bridgeProjectMcpServers([{ name: "docs", url }, { name: "broken", url: "http://127.0.0.1:1/mcp" }], baseContext,
      { ...options, onChunk: (chunk) => chunks.push(chunk) });
    closers.push(optional.close);
    expect(optional.toolContext.tools.map((tool) => tool.name)).toContain("mcp__docs__search_docs");
    expect(chunks[0]).toMatchObject({ type: "error", value: expect.stringContaining("broken: could not connect") });
  });

  it("passes other tools through to the harness's own context", async () => {
    const { bridged } = await bridge("code", true);
    await expect(bridged.toolContext.executeTool({ id: "1", name: "read_file", arguments: {} })).resolves.toMatchObject({ content: "base" });
  });
});

describe("run-scoped orchestration bridge credential", () => {
  it("stops working after an idle period, even before its absolute expiry", async () => {
    let now = 1_000;
    const executeTool = vi.fn(async () => ({ ok: true, content: "ok" }));
    const bridge = await startHarnessMcp(
      { tools: [{ name: "buildwarden_test", description: "test", inputSchema: { type: "object" } }], executeTool },
      undefined, now + 24 * 60 * 60 * 1_000, 60_000, () => now,
    );
    if (!bridge) throw new Error("Missing bridge");
    closers.push(bridge.close);
    const call = () => fetch(bridge.url, {
      method: "POST", headers: bridge.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "buildwarden_test", arguments: {} } }),
    });

    now += 59_000;
    expect((await call()).status).toBe(200);
    now += 59_000;
    expect((await call()).status).toBe(200);
    now += 61_000;
    expect((await call()).status).toBe(401);
    now += 1;
    expect((await call()).status).toBe(401);
  });
});
