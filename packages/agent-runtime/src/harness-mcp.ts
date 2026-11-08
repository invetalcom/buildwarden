import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface HarnessMcpContext<TName extends string> {
  tools: Array<{ name: TName; description: string; inputSchema: Record<string, unknown> }>;
  executeTool(call: { id: string; name: TName; arguments: Record<string, unknown> }): Promise<{
    ok: boolean; content: string; images?: Array<{ mimeType: string; data: string }>;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Per-run loopback bridge. Closing the server revokes its ephemeral credential. */
const readHttpJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 1_048_576) throw new Error("MCP request body is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const writeMcpJson = (response: ServerResponse, status: number, value?: unknown): void => {
  if (value === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

export const startHarnessMcp = async <TName extends string>(
  toolContext: HarnessMcpContext<TName>,
  onToolCall?: (toolName: string) => void,
  expiresAt = Date.now() + 24 * 60 * 60 * 1_000,
): Promise<{ url: string; headers: Record<string, string>; close: () => Promise<void> } | null> => {
  const tools = toolContext.tools.filter((tool) => tool.name.startsWith("buildwarden_"));
  if (tools.length === 0) return null;
  const bearerToken = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== "/mcp" || request.method !== "POST") {
        writeMcpJson(response, 404, { error: "Not found" });
        return;
      }
      if (Date.now() >= expiresAt || request.headers.authorization !== `Bearer ${bearerToken}`) {
        writeMcpJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const payload = await readHttpJsonBody(request);
      if (!isRecord(payload) || (typeof payload.id !== "string" && typeof payload.id !== "number" && payload.id !== undefined)) {
        writeMcpJson(response, 400, { error: "Invalid JSON-RPC request" });
        return;
      }
      const id = payload.id;
      const method = asString(payload.method);
      const params = isRecord(payload.params) ? payload.params : {};
      if (id === undefined) {
        writeMcpJson(response, 202);
        return;
      }
      if (method === "initialize") {
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: asString(params.protocolVersion) ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "buildwarden-orchestration", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "ping") {
        writeMcpJson(response, 200, { jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        });
        return;
      }
      if (method === "tools/call") {
        const name = asString(params.name);
        const definition = tools.find((tool) => tool.name === name);
        if (!definition || !name) {
          writeMcpJson(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Unknown BuildWarden tool: ${name ?? "(missing)"}` }], isError: true },
          });
          return;
        }
        onToolCall?.(definition.name);
        const callId = randomUUID();
        const result = await toolContext.executeTool({
          id: callId,
          name: definition.name,
          arguments: isRecord(params.arguments) ? params.arguments : {},
        }).catch((error: unknown): Awaited<ReturnType<HarnessMcpContext<TName>["executeTool"]>> => ({
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        }));
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result.content }, ...(result.images ?? []).map((image) => ({ type: "image", ...image }))],
            isError: !result.ok,
          },
        });
        return;
      }
      writeMcpJson(response, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported MCP method: ${method ?? "(missing)"}` },
      });
    })().catch((error) => {
      writeMcpJson(response, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    headers: { Authorization: `Bearer ${bearerToken}` },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections?.();
    }),
  };
};

