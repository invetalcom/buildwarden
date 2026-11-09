/**
 * A small MCP client for the Streamable HTTP transport. BuildWarden uses it to give harnesses
 * that only speak function calling (AI SDK, OpenRouter, Azure) the tools of a project's MCP
 * servers. Calls run in the run worker, so credentials never reach the renderer.
 */

export interface McpHttpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface BridgedMcpTool {
  /** Name the model sees: `mcp__<server>__<tool>`, limited to 64 safe characters. */
  name: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface BridgedMcpCallResult {
  ok: boolean;
  content: string;
  images: Array<{ mimeType: string; data: string }>;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 60_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_RESULT_CHARS = 100_000;
const MAX_ERROR_CHARS = 500;
/** One unfinished event-stream event; a tool result is capped at MAX_RESULT_CHARS anyway. */
const MAX_SSE_EVENT_CHARS = 4 * 1_048_576;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeNamePart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

export const bridgedMcpToolName = (serverName: string, toolName: string): string => {
  const server = sanitizeNamePart(serverName).slice(0, 20);
  return `mcp__${server}__${sanitizeNamePart(toolName)}`.slice(0, 64);
};

export const isBridgedMcpToolName = (name: string): boolean => name.startsWith("mcp__");

type JsonRpcResponse = { id?: number | string; result?: unknown; error?: { code?: number; message?: string } };

/** Reads a JSON-RPC response for `id` from an SSE body, stopping at the first match. */
const readSseResponse = async (response: Response, id: number): Promise<JsonRpcResponse> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The MCP server sent an empty event stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (message.id === id) return message;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      // A server that never ends an event must not grow the worker's memory without limit.
      if (buffer.length > MAX_SSE_EVENT_CHARS) throw new Error("The MCP server sent an event larger than the allowed limit.");
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new Error("The MCP server closed the event stream without a response.");
};

export class McpHttpClient {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;

  constructor(
    readonly server: McpHttpServerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "BuildWarden", version: "1.0.0" },
    }, MCP_REQUEST_TIMEOUT_MS, signal);
    this.protocolVersion = isRecord(result) && typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, MCP_REQUEST_TIMEOUT_MS, signal);
  }

  async listTools(signal?: AbortSignal): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }>> {
    const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }> = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, MCP_REQUEST_TIMEOUT_MS, signal);
      const page = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
      for (const entry of page) {
        if (!isRecord(entry) || typeof entry.name !== "string") continue;
        const annotations = isRecord(entry.annotations) ? entry.annotations : {};
        tools.push({
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object", properties: {} },
          readOnly: annotations.readOnlyHint === true,
        });
      }
      cursor = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
    return tools.slice(0, MAX_TOOLS_PER_SERVER);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgedMcpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, MCP_TOOL_CALL_TIMEOUT_MS, signal);
    return normalizeToolResult(result);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.server.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    } catch {
      // Servers may not support session termination; the session expires on its own.
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.server.headers ?? {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const message = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal, id);
    if (!message) throw new Error(`MCP server ${this.server.name} sent no response to ${method}.`);
    if (message.error) {
      // Server text reaches run steps and tool results, so it is bounded like any other server output.
      const detail = String(message.error.message ?? `${method} failed`).slice(0, MAX_ERROR_CHARS);
      throw new Error(`MCP server ${this.server.name}: ${detail}`);
    }
    return message.result;
  }

  private async post(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, id?: number): Promise<JsonRpcResponse | null> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(this.server.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (response.status === 202 || id === undefined) {
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && response.status !== 202) throw new Error(`MCP server ${this.server.name} returned HTTP ${String(response.status)}.`);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`MCP server ${this.server.name} returned HTTP ${String(response.status)}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return readSseResponse(response, id);
    return await response.json() as JsonRpcResponse;
  }
}

const normalizeToolResult = (result: unknown): BridgedMcpCallResult => {
  if (!isRecord(result)) return { ok: true, content: "", images: [] };
  const parts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ mimeType: block.mimeType, data: block.data });
      parts.push(`[image: ${block.mimeType}]`);
    } else if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      parts.push(typeof resource.text === "string" ? resource.text : `[resource: ${String(resource.uri ?? "unknown")}]`);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource link: ${block.uri}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const content = parts.join("\n");
  return {
    ok: result.isError !== true,
    content: content.length > MAX_RESULT_CHARS ? `${content.slice(0, MAX_RESULT_CHARS)}\n... truncated (${String(content.length)} chars total) ...` : content,
    images,
  };
};

export interface BridgedMcpSession {
  tools: BridgedMcpTool[];
  /** One entry per configured server, so callers can report which ones connected. */
  servers: Array<{ name: string; status: "connected" | "failed"; error?: string; toolCount: number }>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgedMcpCallResult>;
  close(): Promise<void>;
}

/**
 * Connects to every configured server and lists its tools. A server that fails to connect is
 * reported, not thrown, so one broken server does not stop the run.
 */
export const connectBridgedMcpServers = async (
  servers: readonly McpHttpServerConfig[],
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<BridgedMcpSession> => {
  const clients = new Map<string, { client: McpHttpClient; toolName: string }>();
  const connected: McpHttpClient[] = [];
  const tools: BridgedMcpTool[] = [];
  const statuses: BridgedMcpSession["servers"] = [];
  await Promise.all(servers.map(async (server) => {
    const client = new McpHttpClient(server, options.fetchImpl);
    try {
      await client.initialize(options.signal);
      // The server opened a session; close it even if listing its tools fails.
      connected.push(client);
      const listed = await client.listTools(options.signal);
      for (const tool of listed) {
        let name = bridgedMcpToolName(server.name, tool.name);
        for (let suffix = 2; clients.has(name); suffix += 1) name = `${name.slice(0, 60)}_${String(suffix)}`;
        clients.set(name, { client, toolName: tool.name });
        tools.push({
          name, serverName: server.name, toolName: tool.name,
          description: `[MCP ${server.name}] ${tool.description}`.slice(0, 1_024),
          inputSchema: tool.inputSchema, readOnly: tool.readOnly,
        });
      }
      statuses.push({ name: server.name, status: "connected", toolCount: listed.length });
    } catch (error) {
      statuses.push({ name: server.name, status: "failed", error: error instanceof Error ? error.message : String(error), toolCount: 0 });
    }
  }));
  return {
    tools,
    servers: statuses,
    call: async (name, args, signal) => {
      const target = clients.get(name);
      if (!target) return { ok: false, content: `Unknown MCP tool: ${name}`, images: [] };
      try {
        return await target.client.callTool(target.toolName, args, signal);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error), images: [] };
      }
    },
    close: async () => {
      await Promise.all(connected.map((client) => client.close()));
    },
  };
};

/**
 * Checks that every required server accepts a connection from this machine, for agents that
 * connect to project MCP servers themselves (ACP agents, Cursor). They report no connection
 * status, so this is the guarantee BuildWarden can give for them: when the run starts, each
 * required server is reachable with its configured headers. Optional servers are not checked.
 */
export const preflightRequiredMcpServers = async (
  servers: ReadonlyArray<McpHttpServerConfig & { required?: boolean }>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<void> => {
  const required = servers.filter((server) => server.required === true);
  if (required.length === 0) return;
  const session = await connectBridgedMcpServers(required, options);
  await session.close().catch(() => undefined);
  const failed = session.servers.filter((server) => server.status === "failed");
  if (failed.length > 0) {
    throw new Error(`Required project MCP server${failed.length === 1 ? "" : "s"} could not connect: ${
      failed.map((server) => `${server.name} (${server.error ?? "unknown error"})`).join("; ")}.`);
  }
};
