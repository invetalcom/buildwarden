import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHarnessAdapter } from "@buildwarden/provider-claude-code";
import type { RunExecutionRequest } from "@buildwarden/shared";

const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdk.query, createSdkMcpServer: vi.fn(), tool: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (isChat = false) => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-claude-logs-"));
  roots.push(root);
  const logDirPath = join(root, "logs");
  const input: RunExecutionRequest = {
    runId: "session-1", worktreePath: root, mode: "ask", prompt: "Hello",
    providerType: "claude-code", modelId: "sonnet", apiKey: "do-not-log-this",
    devLogging: { logDirPath }, isChat,
  };
  const run = (signal = new AbortController().signal) => new ClaudeCodeHarnessAdapter().run(
    input, { tools: [], executeTool: vi.fn() }, vi.fn(), signal,
  );
  const readLog = () => readFileSync(join(logDirPath, `${isChat ? "chat" : "run"}-session-1-claude-code-sonnet.jsonl`), "utf8");
  return { input, logDirPath, run, readLog };
};

const resultEvent = { type: "result", subtype: "success", result: "Hello back", session_id: "claude-session", usage: { input_tokens: 12, output_tokens: 3 } };
const respond = () => sdk.query.mockReturnValue({
  close: sdk.close,
  async *[Symbol.asyncIterator]() { yield resultEvent; },
});

describe("Claude dev logging", () => {
  it.each([false, true])("logs SDK events and appends follow-ups (chat=%s)", async (isChat) => {
    const { input, logDirPath, run, readLog } = setup(isChat);
    respond();
    await run();
    input.previousResponseId = "claude-session";
    await run();
    expect(readdirSync(logDirPath)).toHaveLength(1);
    const log = readLog();
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.event)).toEqual([
      "sdk.request", "sdk.event", "sdk.completed", "sdk.request", "sdk.event", "sdk.completed",
    ]);
    expect(entries[1].data).toEqual(resultEvent);
    expect(entries[3].data.resume).toBe("claude-session");
    expect(log).not.toContain(input.apiKey);
    expect(sdk.close).toHaveBeenCalledTimes(2);
  });

  it("does not create logs when logging is disabled", async () => {
    const { input, logDirPath, run } = setup();
    delete input.devLogging;
    respond();
    await run();
    expect(existsSync(logDirPath)).toBe(false);
  });

  it("records SDK startup errors and still rejects the run", async () => {
    const { run, readLog } = setup();
    sdk.query.mockImplementation(() => { throw new Error("Could not start Claude"); });
    await expect(run()).rejects.toThrow("Could not start Claude");
    expect(readLog()).toContain('"event":"sdk.error"');
    expect(readLog()).toContain("Could not start Claude");
  });

  it("records cancellation and closes the SDK query", async () => {
    const { run, readLog } = setup();
    const controller = new AbortController();
    sdk.query.mockReturnValue({
      close: sdk.close,
      async *[Symbol.asyncIterator]() {
        yield resultEvent;
        controller.abort();
        throw new Error("Aborted");
      },
    });
    await run(controller.signal);
    expect(readLog()).toContain('"event":"sdk.cancelled"');
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});
