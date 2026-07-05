import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mergeRunSubagentInfo, type HarnessRunChunk } from "@buildwarden/shared";
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
