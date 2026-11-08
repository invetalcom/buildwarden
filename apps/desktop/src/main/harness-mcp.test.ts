import { afterEach, describe, expect, it, vi } from "vitest";
import { startHarnessMcp } from "@buildwarden/agent-runtime";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

describe("run-scoped MCP bridge", () => {
  it("isolates credentials and tool contexts, and rejects expired access", async () => {
    const executeTool = vi.fn(async () => ({ ok: true, content: "first run" }));
    const context = { tools: [{ name: "buildwarden_test", description: "test", inputSchema: { type: "object" } }], executeTool };
    const first = await startHarnessMcp(context);
    const second = await startHarnessMcp(context, undefined, Date.now() - 1);
    if (!first || !second) throw new Error("Missing bridge");
    closers.push(first.close, second.close);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "buildwarden_test", arguments: {} } });
    expect((await fetch(first.url, { method: "POST", body })).status).toBe(401);
    expect((await fetch(first.url, { method: "POST", body, headers: second.headers })).status).toBe(401);
    expect((await fetch(second.url, { method: "POST", body, headers: second.headers })).status).toBe(401);
    const response = await fetch(first.url, { method: "POST", body, headers: first.headers });
    expect(await response.json()).toMatchObject({ result: { content: [{ type: "text", text: "first run" }], isError: false } });
    expect(executeTool).toHaveBeenCalledOnce();
  });
});
