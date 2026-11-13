import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeHarnessAdapter,
  ClaudeTurnInput,
  claudeIdleTurnAction,
  claudeRequiredMcpState,
  readClaudeBackgroundAgentTasks,
  waitForClaudeRequiredMcpServers,
} from "@buildwarden/provider-claude-code";
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

describe("Claude turn input before steering", () => {
  it("moves foreground subagents to the background before sending the message", async () => {
    const input = new ClaudeTurnInput();
    input.start({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Start" } });
    const iterator = input[Symbol.asyncIterator]();
    await iterator.next();
    const order: string[] = [];
    input.setBackgroundMover(async () => { order.push("background"); });
    const steer = input.steer({ prompt: "Stop and summarize" });
    const next = iterator.next().then((result) => { order.push("steer"); return result; });
    await steer;
    await next;
    expect(order).toEqual(["background", "steer"]);
  });

  it("sends the message anyway when moving subagents fails", async () => {
    const input = new ClaudeTurnInput();
    input.start({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Start" } });
    const iterator = input[Symbol.asyncIterator]();
    await iterator.next();
    input.setBackgroundMover(async () => { throw new Error("unsupported"); });
    const steer = input.steer({ prompt: "Hello" });
    expect(text((await iterator.next()).value)).toBe("Hello");
    await steer;
  });
});

describe("required project MCP servers on Claude Code", () => {
  const servers = [{ name: "Docs", required: true }, { name: "Search" }, { name: "Tracker", required: true }];

  it("counts only connected as success; pending is undecided and a missing server has failed", () => {
    expect(claudeRequiredMcpState([
      { name: "external_1_docs", status: "failed" }, { name: "external_2_search", status: "failed" },
      { name: "external_3_tracker", status: "connected" }, { name: "buildwarden", status: "connected" },
    ], servers)).toEqual({ failed: ["Docs (failed)"], pending: [] });
    expect(claudeRequiredMcpState([{ name: "external_1_docs", status: "pending" }], servers))
      .toEqual({ failed: ["Tracker (not registered)"], pending: ["Docs"] });
    expect(claudeRequiredMcpState([{ name: "external_1_docs", status: "needs-auth" }, { name: "external_3_tracker", status: "connected" }], servers))
      .toEqual({ failed: ["Docs (needs-auth)"], pending: [] });
  });

  it("follows a pending required server until it connects or fails", async () => {
    const connecting = vi.fn()
      .mockResolvedValueOnce([{ name: "external_1_docs", status: "pending" }, { name: "external_3_tracker", status: "connected" }])
      .mockResolvedValue([{ name: "external_1_docs", status: "connected" }, { name: "external_3_tracker", status: "connected" }]);
    await expect(waitForClaudeRequiredMcpServers(connecting, servers, { pollMs: 1 })).resolves.toBeUndefined();
    expect(connecting).toHaveBeenCalledTimes(2);

    const failing = vi.fn()
      .mockResolvedValueOnce([{ name: "external_1_docs", status: "pending" }, { name: "external_3_tracker", status: "connected" }])
      .mockResolvedValue([{ name: "external_1_docs", status: "failed" }, { name: "external_3_tracker", status: "connected" }]);
    await expect(waitForClaudeRequiredMcpServers(failing, servers, { pollMs: 1 })).rejects.toThrow("could not connect: Docs (failed)");
  });

  it("fails a required server that is still pending at the deadline", async () => {
    const stuck = vi.fn(async () => [{ name: "external_1_docs", status: "pending" }, { name: "external_3_tracker", status: "connected" }]);
    await expect(waitForClaudeRequiredMcpServers(stuck, servers, { timeoutMs: 20, pollMs: 5 })).rejects.toThrow("Docs (still connecting after");
  });
});

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

describe("Claude background subagents at the end of a turn", () => {
  it("decides what a finished turn does with its session", () => {
    const idle = { runningBackgroundSubagents: 0, unansweredSteers: false, awaitingFollowOn: false };
    expect(claudeIdleTurnAction(idle)).toBe("close");
    expect(claudeIdleTurnAction({ ...idle, unansweredSteers: true })).toBe("drain-steers");
    expect(claudeIdleTurnAction({ ...idle, awaitingFollowOn: true, unansweredSteers: true })).toBe("await-follow-on");
    expect(claudeIdleTurnAction({ ...idle, runningBackgroundSubagents: 2, unansweredSteers: true })).toBe("wait-for-subagents");
  });

  it("counts only live, non-ambient background agents", () => {
    expect(readClaudeBackgroundAgentTasks({ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "a1", task_type: "local_agent", description: "Review" },
      { task_id: "b1", task_type: "local_bash", description: "npm run dev" },
      { task_id: "w1", task_type: "local_agent", description: "Watcher", ambient: true },
    ] })).toEqual(new Set(["a1"]));
    expect(readClaudeBackgroundAgentTasks({ type: "system", subtype: "init" })).toBeNull();
  });

  const runTurn = async (events: (iterator: AsyncIterator<SDKUserMessage>) => AsyncGenerator<Record<string, unknown>>) => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-claude-background-"));
    roots.push(root);
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => ({
      close: vi.fn(),
      backgroundTasks: vi.fn(async () => false),
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield* events(iterator);
      },
    }));
    const chunks: HarnessRunChunk[] = [];
    const input: RunExecutionRequest = {
      runId: "run-1", worktreePath: root, mode: "code", prompt: "Review the code", providerType: "claude-code", modelId: "sonnet", apiKey: "",
    };
    const result = await new ClaudeCodeHarnessAdapter().run(input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal);
    return { result, chunks };
  };
  /** Whether the turn's input closes within a short wait; the pending read is returned for later. */
  const closesSoon = async (iterator: AsyncIterator<SDKUserMessage>) => {
    const next = iterator.next();
    const closed = await Promise.race([next.then((value) => value.done === true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))]);
    return { closed, next };
  };
  const spawnBackgroundAgent = {
    type: "assistant", session_id: "s1", parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { subagent_type: "reviewer", description: "Review", prompt: "Review", run_in_background: true } }] },
  };
  const launchAck = { type: "user", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched successfully." }] } };

  it("keeps the session open until a background subagent finishes, so the agent can answer what it found", async () => {
    let closedAtFirstResult: boolean | undefined;
    let closedAtEnd: boolean | undefined;
    const { result, chunks } = await runTurn(async function* (iterator) {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield spawnBackgroundAgent;
      yield launchAck;
      yield { type: "system", subtype: "task_started", session_id: "s1", task_id: "task-1", tool_use_id: "agent-1", description: "Review" };
      yield { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [{ task_id: "task-1", task_type: "local_agent", description: "Review" }] };
      yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Started a reviewer." }] } };
      yield { type: "result", subtype: "success", result: "Started a reviewer.", session_id: "s1", usage: { input_tokens: 5, output_tokens: 2 } };
      const pending = await closesSoon(iterator);
      closedAtFirstResult = pending.closed;
      yield { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [] };
      yield { type: "system", subtype: "task_notification", session_id: "s1", task_id: "task-1", tool_use_id: "agent-1", status: "completed", summary: "Found one bug." };
      yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The reviewer found one bug." }] } };
      yield { type: "result", subtype: "success", result: "The reviewer found one bug.", session_id: "s1", usage: { input_tokens: 5, output_tokens: 2 } };
      closedAtEnd = (await pending.next).done === true;
    });

    expect(closedAtFirstResult).toBe(false);
    expect(closedAtEnd).toBe(true);
    expect(result.summary).toBe("The reviewer found one bug.");
    expect(chunks.some((chunk) => chunk.type === "status" && chunk.value === "Waiting for 1 required background task to finish.")).toBe(true);
    // The launch acknowledgement does not finish the subagent; its notification does.
    const states = chunks.flatMap((chunk) => {
      const subagent = chunk.metadata?.subagent as { id?: string; status?: string } | undefined;
      return subagent?.id === "agent-1" ? [subagent.status] : [];
    });
    expect(states.at(-1)).toBe("completed");
    expect(states.slice(0, -1)).not.toContain("completed");
  });

  it("ends the turn once the model answers, when the subagent streamed while the turn waited", async () => {
    let closedAtEnd: boolean | undefined;
    await runTurn(async function* (iterator) {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield spawnBackgroundAgent;
      yield launchAck;
      yield { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [{ task_id: "task-1", task_type: "local_agent", description: "Review" }] };
      yield { type: "result", subtype: "success", result: "Started a reviewer.", session_id: "s1", usage: { input_tokens: 5, output_tokens: 2 } };
      yield { type: "assistant", session_id: "s1", parent_tool_use_id: "agent-1", message: { content: [{ type: "text", text: "Reading the diff." }] } };
      yield { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [] };
      yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The reviewer found one bug." }] } };
      yield { type: "result", subtype: "success", result: "The reviewer found one bug.", session_id: "s1", usage: { input_tokens: 5, output_tokens: 2 } };
      closedAtEnd = (await closesSoon(iterator)).closed;
    });
    // Not held open for the follow-on grace, which is for a reply that has not come yet.
    expect(closedAtEnd).toBe(true);
  });

  it("does not hold the turn open for a background shell command with only a non-blocking poll", async () => {
    let closedAtResult: boolean | undefined;
    await runTurn(async function* (iterator) {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [{ task_id: "shell-1", task_type: "local_bash", description: "npm run dev" }] };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "poll", name: "TaskOutput", input: { task_id: "shell-1", block: false } }] } };
      yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Server started." }] } };
      yield { type: "result", subtype: "success", result: "Server started.", session_id: "s1", usage: { input_tokens: 5, output_tokens: 2 } };
      closedAtResult = (await closesSoon(iterator)).closed;
    });
    expect(closedAtResult).toBe(true);
  });

  it.each(["local_workflow", "mcp_task", "local_bash"])("waits for required %s work and the model's follow-up", async (taskType) => {
    let closedEarly: boolean | undefined;
    const { result } = await runTurn(async function* (iterator) {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "required", task_type: taskType }] };
      if (taskType === "local_bash") {
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "wait", name: "TaskOutput", input: { task_id: "required", block: true } }] } };
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "poll", name: "TaskOutput", input: { task_id: "required", block: false } }] } };
      }
      yield { type: "result", subtype: "success", result: "Work started", session_id: "s1" };
      const pending = await closesSoon(iterator);
      closedEarly = pending.closed;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Verified result" }] } };
      yield { type: "result", subtype: "success", result: "Verified result", session_id: "s1" };
      expect((await pending.next).done).toBe(true);
    });
    expect(closedEarly).toBe(false);
    expect(result.summary).toBe("Verified result");
  });

  it("excludes ambient workflows and MCP watchers", () => {
    expect(readClaudeBackgroundAgentTasks({ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "watch", task_type: "local_workflow", ambient: true },
      { task_id: "mcp-watch", task_type: "mcp_task", ambient: true },
    ] })).toEqual(new Set());
  });
});
