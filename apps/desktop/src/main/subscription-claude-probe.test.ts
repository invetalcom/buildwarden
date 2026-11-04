import { afterEach, describe, expect, it, vi } from "vitest";
import { readClaudeSubscription } from "@buildwarden/provider-claude-code";

const mocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), usage: vi.fn(), spawn: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query, createSdkMcpServer: vi.fn(), tool: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("Claude subscription SDK probe", () => {
  it("reads the control endpoint without sending a prompt, resuming a run, or persisting a session", async () => {
    mocks.usage.mockResolvedValue({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 25 } } });
    mocks.query.mockReturnValue({ initializationResult: async () => ({ account: { subscriptionType: "pro" } }), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: mocks.usage, close: mocks.close });
    // A missing version binary must not discard the successfully read limits.
    mocks.spawn.mockImplementation(() => { throw new Error("not found"); });
    const result = await readClaudeSubscription({ cwd: ".", config: { claudeBinaryPath: "test-claude", claudeLaunchArgs: "--resume old-run --settings hooks.json --mcp-config servers.json" } });
    expect(result).toMatchObject({ account: { subscriptionType: "pro" }, version: null, usage: { rate_limits_available: true } });
    expect(mocks.usage).toHaveBeenCalledExactlyOnceWith({ skipBehaviors: true });
    const input = mocks.query.mock.calls[0]![0];
    expect(input.options).toMatchObject({ persistSession: false, tools: [], allowedTools: [], settings: { disableAllHooks: true }, mcpServers: {}, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0" } });
    expect(input.options.extraArgs).toBeUndefined();
    expect(await input.prompt.next()).toEqual({ done: true, value: undefined });
    expect(input.options.abortController.signal.aborted).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("closes and aborts the process after failed initialization", async () => {
    mocks.query.mockReturnValue({ initializationResult: async () => { throw new Error("init failed"); }, close: mocks.close });
    await expect(readClaudeSubscription({ cwd: "." })).rejects.toThrow("init failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]![0].options.abortController.signal.aborted).toBe(true);
  });
  it("clears the deadline when the SDK throws before creating a query", async () => {
    vi.useFakeTimers();
    mocks.query.mockImplementation(() => { throw new Error("cannot spawn"); });
    await expect(readClaudeSubscription({ cwd: "." })).rejects.toThrow("cannot spawn");
    expect(vi.getTimerCount()).toBe(0);
  });
});
