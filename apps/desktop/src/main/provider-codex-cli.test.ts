import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mergeRunSubagentInfo, type HarnessRunChunk, type HarnessToolContext } from "@buildwarden/shared";
import {
  buildCodexPlanProgressChunk,
  CodexAppServerSession,
  extractCodexAgentNickname,
  parseCodexModelListPage,
  requestCodexAvailableModels,
} from "@buildwarden/provider-codex-cli";

describe("Codex CLI plan progress", () => {
  it("maps turn plan updates to replaceable plan-progress chunks", () => {
    const chunk = buildCodexPlanProgressChunk({
      explanation: "Implementing the approved plan.",
      plan: [
        { step: "Update shared contracts", status: "completed" },
        { step: "Render progress pill", status: "inProgress" },
        { step: "Run validation", status: "pending" },
      ],
    });

    expect(chunk).toEqual({
      type: "plan-progress",
      title: "Plan progress",
      value: "Implementing the approved plan.\n\n1. [x] Update shared contracts\n2. [-] Render progress pill\n3. [ ] Run validation",
      metadata: {
        provider: "codex-cli",
        planProgress: {
          explanation: "Implementing the approved plan.",
          source: "codex",
          steps: [
            { title: "Update shared contracts", status: "completed" },
            { title: "Render progress pill", status: "inProgress" },
            { title: "Run validation", status: "pending" },
          ],
        },
        streamId: "codex-plan-progress",
        replace: true,
        rawPlanUpdate: {
          explanation: "Implementing the approved plan.",
          plan: [
            { step: "Update shared contracts", status: "completed" },
            { step: "Render progress pill", status: "inProgress" },
            { step: "Run validation", status: "pending" },
          ],
        },
      },
    });
  });

  it("parses model/list pages from Codex app-server responses", () => {
    expect(
      parseCodexModelListPage({
        data: [
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
          { model: "gpt-5", name: "GPT-5" },
          { id: "legacy-id-model" },
          { displayName: "Missing ID" },
        ],
        nextCursor: "page-2",
      }),
    ).toEqual({
      models: [
        { modelId: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", source: "provider" },
        { modelId: "gpt-5", displayName: "GPT-5", source: "provider" },
        { modelId: "legacy-id-model", displayName: "legacy-id-model", source: "provider" },
      ],
      nextCursor: "page-2",
    });
  });

  it("preserves advertised Codex effort levels, including ultra, and fast-mode capability", () => {
    const page = parseCodexModelListPage({
      data: [{
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Faster" },
          { reasoningEffort: "ultra", description: "Deepest" },
        ],
      }],
    });
    expect(page.models[0]?.config).toEqual({
      buildwardenExecutionProfile: {
        source: "provider",
        controls: [
          {
            id: "reasoningEffort",
            label: "Effort",
            defaultValue: "low",
            options: [
              { value: "auto", label: "Provider default" },
              { value: "low", label: "Low", description: "Faster" },
              { value: "ultra", label: "Ultra", description: "Deepest" },
            ],
          },
          {
            id: "serviceTier",
            label: "Speed",
            defaultValue: "auto",
            options: [
              { value: "auto", label: "Standard" },
              { value: "fast", label: "Fast", description: "Use Codex fast mode (higher credit consumption)." },
            ],
          },
        ],
      },
    });
  });

  it("does not add max or ultra to Codex GPT-5.5", () => {
    const model = parseCodexModelListPage({
      data: [{
        model: "gpt-5.5",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      }],
    }).models[0]!;
    const controls = (model.config as {
      buildwardenExecutionProfile: { controls: Array<{ id: string; options: Array<{ value: string; label: string }> }> };
    }).buildwardenExecutionProfile.controls;

    expect(controls.find((control) => control.id === "reasoningEffort")?.options.map((entry) => entry.value))
      .toEqual(["auto", "low", "medium", "high", "xhigh"]);
    expect(controls.find((control) => control.id === "reasoningEffort")?.options.map((entry) => entry.label))
      .toEqual(["Provider default", "Low", "Medium", "High", "Extra high"]);
    expect(controls.find((control) => control.id === "serviceTier")?.options.map((entry) => entry.value))
      .toEqual(["auto", "fast"]);
  });

  it("does not infer controls for an unknown Codex model", () => {
    expect(parseCodexModelListPage({ data: [{ model: "future-codex-model" }] }).models[0]?.config).toBeUndefined();
  });

  it("forwards selected Codex effort and fast service tier on turn/start", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const requests: Array<Record<string, unknown>> = [];
    stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) requests.push(JSON.parse(line) as Record<string, unknown>);
    });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin,
      killed: true,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const session = new CodexAppServerSession(child, "thread-1", "C:\\repo", undefined, undefined, vi.fn());
    stdout.write(`${JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-1" } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const resultPromise = session.startTurn({
      prompt: "Inspect",
      modelId: "gpt-5.6-sol",
      mode: "code",
      providerOptions: { reasoningEffort: "ultra", serviceTier: "fast" },
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0]!;
    expect(request).toMatchObject({ method: "turn/start" });
    expect(request.params).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
      serviceTier: "fast",
      collaborationMode: { settings: { reasoning_effort: "ultra" } },
    });
    stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })}\n`);
    await expect(resultPromise).resolves.toMatchObject({ threadId: "thread-1" });
    session.stop();
  });

  it("pages through Codex model/list cursors and deduplicates model ids", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses = [
      {
        data: [
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
          { model: "gpt-5", displayName: "GPT-5" },
        ],
        nextCursor: "page-2",
      },
      {
        models: [
          { model: "GPT-5", displayName: "Duplicate casing" },
          { model: "gpt-5-mini", display_name: "GPT-5 mini" },
        ],
      },
    ];

    const models = await requestCodexAvailableModels({
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        requests.push({ method, params });
        return responses.shift() as T;
      },
    });

    expect(requests).toEqual([
      { method: "model/list", params: {} },
      { method: "model/list", params: { cursor: "page-2" } },
    ]);
    expect(models).toEqual([
      { modelId: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", source: "provider" },
      { modelId: "gpt-5", displayName: "GPT-5", source: "provider" },
      { modelId: "gpt-5-mini", displayName: "GPT-5 mini", source: "provider" },
    ]);
  });

  it("propagates Codex model/list failures so the controller can fall back", async () => {
    await expect(
      requestCodexAvailableModels({
        request: async () => {
          throw new Error("model/list failed");
        },
      }),
    ).rejects.toThrow("model/list failed");
  });
});

describe("Codex CLI subagents", () => {
  const flushLines = () => new Promise((resolve) => setTimeout(resolve, 10));

  const createSession = () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      killed: true,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const chunks: HarnessRunChunk[] = [];
    const session = new CodexAppServerSession(child, "parent-thread", "C:\repo", undefined, undefined, (chunk) => {
      chunks.push(chunk);
    });
    const notify = async (method: string, params: unknown) => {
      stdout.write(`${JSON.stringify({ method, params })}\n`);
      await flushLines();
    };
    return { session, chunks, notify };
  };

  it("maps collab tool-call items to subagent lifecycle chunks", async () => {
    const { chunks, notify } = createSession();
    await notify("thread/started", { thread: { id: "parent-thread" } });
    await notify("item/completed", {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call_1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        prompt: "Count the .txt files in the workspace.\nReport only the number.",
        model: "gpt-5.5",
        agentsStates: { "child-thread": { status: "pendingInit", message: null } },
      },
    });

    const subagentChunk = chunks.find((chunk) => chunk.metadata?.toolName === "subagent");
    expect(subagentChunk).toBeDefined();
    expect(subagentChunk?.type).toBe("tool-progress");
    expect(subagentChunk?.metadata?.streamId).toBe("subagent:child-thread");
    expect(subagentChunk?.metadata?.subagent).toMatchObject({
      id: "child-thread",
      source: "codex-cli",
      status: "pending",
      model: "gpt-5.5",
      description: "Count the .txt files in the workspace.",
    });
  });

  it("routes child-thread activity into stamped chunks without ending the parent turn", async () => {
    const { chunks, notify } = createSession();
    await notify("thread/started", { thread: { id: "parent-thread" } });
    await notify("item/completed", {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call_1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        prompt: "Count files.",
        agentsStates: { "child-thread": { status: "pendingInit", message: null } },
      },
    });
    chunks.length = 0;

    await notify("turn/started", {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "inProgress" },
    });
    await notify("item/agentMessage/delta", {
      threadId: "child-thread",
      turnId: "child-turn",
      itemId: "msg_child",
      delta: "2 files found.",
    });
    await notify("turn/completed", {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "completed" },
    });

    const runningChunk = chunks.find(
      (chunk) => chunk.metadata?.toolName === "subagent" && (chunk.metadata?.subagent as { status?: string }).status === "running",
    );
    expect(runningChunk).toBeDefined();

    const messageChunk = chunks.find((chunk) => chunk.type === "message");
    expect(messageChunk?.metadata?.subagentId).toBe("child-thread");
    expect(messageChunk?.value).toBe("2 files found.");

    const completedChunk = chunks.find(
      (chunk) => chunk.metadata?.toolName === "subagent" && (chunk.metadata?.subagent as { status?: string }).status === "completed",
    );
    expect(completedChunk?.type).toBe("tool-result");

    // Child turns must not leak run-level usage updates or completion signals.
    expect(chunks.some((chunk) => chunk.value === "Usage updated.")).toBe(false);
  });

  it("keeps the cached and reasoning breakdown when turn/completed carries no usage", async () => {
    const { chunks, notify } = createSession();
    await notify("thread/started", { thread: { id: "parent-thread" } });
    // Shape emitted by codex-cli 0.144.x.
    await notify("thread/tokenUsage/updated", {
      threadId: "parent-thread",
      turnId: "parent-turn",
      tokenUsage: {
        total: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        last: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        modelContextWindow: 258_400,
      },
    });
    await notify("turn/completed", {
      threadId: "parent-thread",
      turn: { id: "parent-turn", status: "completed" },
    });

    const usageChunks = chunks.filter((chunk) => chunk.value === "Usage updated.");
    expect(usageChunks).toHaveLength(2);
    expect(usageChunks.at(-1)?.metadata?.usageTotals).toMatchObject({
      inputTokens: 14_494,
      outputTokens: 20,
      cachedInputTokens: 5_504,
      reasoningTokens: 13,
      usedTokens: 14_514,
      maxTokens: 258_400,
    });
  });

  it("keeps the cached and reasoning breakdown when turn/completed carries an empty usage", async () => {
    const { chunks, notify } = createSession();
    await notify("thread/started", { thread: { id: "parent-thread" } });
    await notify("thread/tokenUsage/updated", {
      threadId: "parent-thread",
      turnId: "parent-turn",
      tokenUsage: {
        total: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        last: { totalTokens: 14_514, inputTokens: 14_494, cachedInputTokens: 5_504, outputTokens: 20, reasoningOutputTokens: 13 },
        modelContextWindow: 258_400,
      },
    });
    // A present-but-empty usage object normalizes to zeros; it must not count as data.
    await notify("turn/completed", {
      threadId: "parent-thread",
      turn: { id: "parent-turn", status: "completed", usage: {} },
    });

    expect(chunks.filter((chunk) => chunk.value === "Usage updated.").at(-1)?.metadata?.usageTotals).toMatchObject({
      inputTokens: 14_494,
      outputTokens: 20,
      cachedInputTokens: 5_504,
      reasoningTokens: 13,
      usedTokens: 14_514,
      maxTokens: 258_400,
    });
  });

  it("captures the child final answer from wait tool-call agent states", async () => {
    const { chunks, notify } = createSession();
    await notify("thread/started", { thread: { id: "parent-thread" } });
    await notify("item/completed", {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call_2",
        tool: "wait",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        prompt: null,
        model: null,
        agentsStates: { "child-thread": { status: "completed", message: "2. Count was non-recursive." } },
      },
    });

    const subagentChunk = chunks.findLast((chunk) => chunk.metadata?.toolName === "subagent");
    expect(subagentChunk?.metadata?.subagent).toMatchObject({
      id: "child-thread",
      status: "completed",
      summary: "2. Count was non-recursive.",
    });
  });
});

describe("Codex app-server dynamic BuildWarden tools", () => {
  it("executes item/tool/call requests through the in-app host context and returns the app-server response shape", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const responses: string[] = [];
    stdin.on("data", (chunk) => responses.push(String(chunk)));
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin,
      killed: true,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const executeTool = vi.fn(async () => ({
      toolCallId: "call-1",
      name: "buildwarden_tasks_list" as const,
      ok: true,
      content: JSON.stringify([{ id: "task-1", status: "running" }]),
    }));
    const toolContext: HarnessToolContext = {
      tools: [{
        name: "buildwarden_tasks_list",
        description: "List durable tasks.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      executeTool,
    };
    const chunks: HarnessRunChunk[] = [];
    new CodexAppServerSession(
      child,
      "parent-thread",
      "C:\\repo",
      undefined,
      undefined,
      (chunk) => chunks.push(chunk),
      toolContext,
    );

    const dynamicToolItem = {
      type: "dynamicToolCall",
      id: "call-1",
      tool: "buildwarden_tasks_list",
      arguments: {},
      status: "inProgress",
    };
    stdout.write(`${JSON.stringify({
      method: "item/started",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        item: dynamicToolItem,
      },
    })}\n`);
    stdout.write(`${JSON.stringify({
      id: 17,
      method: "item/tool/call",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        callId: "call-1",
        tool: "buildwarden_tasks_list",
        arguments: {},
      },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdout.write(`${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        item: { ...dynamicToolItem, status: "completed", success: true },
      },
    })}\n`);

    expect(executeTool).toHaveBeenCalledWith({
      id: "call-1",
      name: "buildwarden_tasks_list",
      arguments: {},
    });
    expect(responses.join("")).toContain('"success":true');
    expect(responses.join("")).toContain('"type":"inputText"');
    expect(chunks.map((chunk) => chunk.type)).toEqual(expect.arrayContaining(["tool-call", "tool-result"]));
    expect(chunks).not.toContainEqual(expect.objectContaining({ title: "Codex update", value: "Dynamic Tool Call" }));
  });

  it("drops a late host-tool response after the app-server session stops", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const responses: string[] = [];
    stdin.on("data", (chunk) => responses.push(String(chunk)));
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin,
      killed: true,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    let resolveTool!: (value: Awaited<ReturnType<HarnessToolContext["executeTool"]>>) => void;
    const executeTool = vi.fn(() => new Promise<Awaited<ReturnType<HarnessToolContext["executeTool"]>>>((resolve) => {
      resolveTool = resolve;
    }));
    const session = new CodexAppServerSession(
      child,
      "parent-thread",
      "C:\\repo",
      undefined,
      undefined,
      vi.fn(),
      {
        tools: [{
          name: "buildwarden_tasks_list",
          description: "List durable tasks.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
        executeTool,
      },
    );

    stdout.write(`${JSON.stringify({
      id: 18,
      method: "item/tool/call",
      params: {
        callId: "call-late",
        tool: "buildwarden_tasks_list",
        arguments: {},
      },
    })}\n`);
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledOnce());
    session.stop();
    stdin.destroy();
    resolveTool({
      toolCallId: "call-late",
      name: "buildwarden_tasks_list",
      ok: true,
      content: "[]",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(responses).toEqual([]);
  });
});

describe("Codex agent nickname extraction", () => {
  it("pulls quoted nicknames out of delegation prompts", () => {
    expect(
      extractCodexAgentNickname('You are subagent "board-structure". The user explicitly asked the parent not to research directly.'),
    ).toBe("board-structure");
    expect(extractCodexAgentNickname('Spawn agent "data-flow" to trace persistence.')).toBe("data-flow");
    expect(extractCodexAgentNickname("You are “test-coverage”. Inspect the specs.")).toBe("test-coverage");
  });

  it("returns undefined when the prompt has no quoted nickname", () => {
    expect(extractCodexAgentNickname("Count the .txt files in this directory.")).toBeUndefined();
    expect(extractCodexAgentNickname(undefined)).toBeUndefined();
    expect(extractCodexAgentNickname("")).toBeUndefined();
  });
});

describe("subagent usage merging", () => {
  it("keeps known usage sub-fields when an update carries partial usage", () => {
    const running = mergeRunSubagentInfo(undefined, {
      id: "agent-1",
      source: "codex-cli",
      status: "running",
      usage: { toolUses: 3, durationMs: 4_200 },
    });

    const afterTokenRefresh = mergeRunSubagentInfo(running, {
      id: "agent-1",
      source: "codex-cli",
      status: "running",
      usage: { totalTokens: 14_202 },
    });

    expect(afterTokenRefresh.usage).toEqual({ totalTokens: 14_202, toolUses: 3, durationMs: 4_200 });
  });

  it("still adopts usage when only one side has it", () => {
    const withoutUsage = mergeRunSubagentInfo(undefined, { id: "agent-1", source: "codex-cli", status: "running" });
    expect(withoutUsage.usage).toBeUndefined();

    const gained = mergeRunSubagentInfo(withoutUsage, {
      id: "agent-1",
      source: "codex-cli",
      status: "running",
      usage: { totalTokens: 10 },
    });
    expect(gained.usage).toEqual({ totalTokens: 10 });

    const kept = mergeRunSubagentInfo(gained, { id: "agent-1", source: "codex-cli", status: "completed" });
    expect(kept.usage).toEqual({ totalTokens: 10 });
  });
});
