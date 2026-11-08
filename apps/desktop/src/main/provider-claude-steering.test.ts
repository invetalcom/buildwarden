import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHarnessAdapter, ClaudeTurnInput } from "@buildwarden/provider-claude-code";
import type { HarnessRunChunk, RunExecutionRequest } from "@buildwarden/shared";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query, createSdkMcpServer: vi.fn(), tool: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The parts of the SDK user message these tests read; the SDK types are not a desktop dependency. */
type SDKUserMessage = { uuid?: string; priority?: string; message: { content: string | Array<{ type: string; text?: string }> } };

const text = (message: SDKUserMessage | undefined): string => {
  const content = message?.message.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? "").join("");
};

describe("Claude turn input", () => {
  it("delivers steered messages in order and resolves once the SDK takes them", async () => {
    const input = new ClaudeTurnInput();
    input.start({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Start" } });
    const iterator = input[Symbol.asyncIterator]();
    expect(text((await iterator.next()).value)).toBe("Start");

    let delivered = false;
    const steer = input.steer({ prompt: "Also check the tests" }).then(() => { delivered = true; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    const next = (await iterator.next()).value as SDKUserMessage;
    await steer;
    expect(delivered).toBe(true);
    expect(next).toMatchObject({ priority: "next", uuid: expect.any(String) });
    expect(input.hasUnansweredSteers).toBe(true);
    input.markAnswered(next.uuid);
    expect(input.hasUnansweredSteers).toBe(false);
  });

  it("rejects a steer the turn ended before taking, and any steer after it closed", async () => {
    const input = new ClaudeTurnInput();
    input.start({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Start" } });
    const pending = input.steer({ prompt: "Too late" });
    input.close();
    await expect(pending).rejects.toThrow("ended before it accepted");
    await expect(input.steer({ prompt: "Closed" })).rejects.toThrow("not running");
  });
});

describe("Claude live steering", () => {
  it("folds a steered message into the running turn and ends once it is answered", async () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-claude-steer-"));
    roots.push(root);
    const prompts: string[] = [];
    let iteratorDone = false;
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        prompts.push(text((await iterator.next()).value));
        yield { type: "system", subtype: "init", session_id: "s1", claude_code_version: "2.9.0", tools: ["Bash", "Task"], mcp_servers: [{ name: "buildwarden", status: "connected" }] };
        yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Working." }] } };
        release();
        const steered = (await iterator.next()).value as SDKUserMessage;
        prompts.push(text(steered));
        yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, user_message_uuid: steered.uuid, message: { content: [{ type: "text", text: "Checked the tests too." }] } };
        yield { type: "result", subtype: "success", result: "Checked the tests too.", session_id: "s1", usage: { input_tokens: 10, output_tokens: 4 } };
        iteratorDone = (await iterator.next()).done === true;
      },
    }));
    const adapter = new ClaudeCodeHarnessAdapter();
    const chunks: HarnessRunChunk[] = [];
    const input: RunExecutionRequest = {
      runId: "run-1", worktreePath: root, mode: "code", prompt: "Fix the bug", providerType: "claude-code", modelId: "sonnet", apiKey: "",
    };

    await expect(adapter.steer({ prompt: "Not yet" })).rejects.toThrow("not running");
    const running = adapter.run(input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
    await working;
    await adapter.steer({ prompt: "Also check the tests" });
    const result = await running;

    expect(prompts[0]).toContain("Fix the bug");
    expect(prompts[1]).toBe("Also check the tests");
    expect(iteratorDone).toBe(true);
    expect(result.summary).toBe("Checked the tests too.");
    expect(chunks.find((chunk) => chunk.metadata?.sessionCapabilities)?.metadata?.sessionCapabilities).toMatchObject({
      agentVersion: "2.9.0", nativeSubagents: true, mcpServers: [{ name: "buildwarden", status: "connected" }],
    });
    await expect(adapter.steer({ prompt: "After the turn" })).rejects.toThrow("not running");
  });
});
