import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeHarnessAdapter,
  ClaudeCodeProviderAdapter,
  ClaudeCompactionWatch,
  applyClaudeCompactionPolicy,
  createClaudeCompactionPolicy,
  resolveClaudeAutoCompactWindow,
  withReportedClaudeContextUsage,
} from "@buildwarden/provider-claude-code";
import type { HarnessRunChunk, RunExecutionRequest, RunTokenUsage } from "@buildwarden/shared";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdk.query, createSdkMcpServer: vi.fn(), tool: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const assistantEvent = (contextTokens: number, parentToolUseId: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parentToolUseId,
  session_id: "claude-session",
  message: {
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Working" }],
    usage: { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: contextTokens - 1_002, output_tokens: 10 },
  },
});
const compactBoundary = (trigger: "auto" | "manual") => ({
  type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: 167_000 },
});

describe("Claude auto-compact window", () => {
  it("defaults to 200k and never goes below 150k", () => {
    expect(resolveClaudeAutoCompactWindow(undefined)).toBe(200_000);
    expect(resolveClaudeAutoCompactWindow(100_000)).toBe(150_000);
    expect(resolveClaudeAutoCompactWindow(400_000.4)).toBe(400_000);
  });

  it("rejects a configured window that would compact in a loop", () => {
    const adapter = new ClaudeCodeProviderAdapter();
    const validate = (value: unknown) => adapter.validateConfiguration({
      providerType: "claude-code", label: "Claude", apiKey: "", config: { claudeAutoCompactWindow: value },
    });
    expect(() => validate(100_000)).toThrow("at least 150,000 tokens");
    expect(() => validate(150_000)).not.toThrow();
  });
});

describe("Claude compaction policy", () => {
  const usage = (fields: Partial<RunTokenUsage>): RunTokenUsage => ({ inputTokens: 0, outputTokens: 0, ...fields });

  it("measures a 1M-window model against the compaction window and estimates the threshold", () => {
    const applied = applyClaudeCompactionPolicy(usage({ usedTokens: 63_000, maxTokens: 1_000_000 }), createClaudeCompactionPolicy(200_000));
    expect(applied).toMatchObject({ usedTokens: 63_000, maxTokens: 200_000, autoCompactThreshold: 167_000, compactsAutomatically: true });
  });

  it("keeps a model window smaller than the configured one", () => {
    const applied = applyClaudeCompactionPolicy(usage({ usedTokens: 250_000, maxTokens: 180_000 }), createClaudeCompactionPolicy(200_000));
    expect(applied).toMatchObject({ usedTokens: 180_000, maxTokens: 180_000, autoCompactThreshold: 147_000 });
  });

  it("prefers what Claude Code reports and stays stable when applied again", () => {
    const policy = withReportedClaudeContextUsage(createClaudeCompactionPolicy(200_000), {
      rawMaxTokens: 200_000, autoCompactThreshold: 160_000, isAutoCompactEnabled: true, unrelated: "ignored",
    });
    const once = applyClaudeCompactionPolicy(usage({ usedTokens: 70_000, maxTokens: 1_000_000 }), policy);
    expect(once).toMatchObject({ maxTokens: 200_000, autoCompactThreshold: 160_000 });
    expect(applyClaudeCompactionPolicy(once, policy)).toEqual(once);
  });

  it("reports no threshold when automatic compaction is turned off", () => {
    const policy = withReportedClaudeContextUsage(createClaudeCompactionPolicy(200_000), { isAutoCompactEnabled: false });
    const applied = applyClaudeCompactionPolicy(usage({ usedTokens: 300_000, maxTokens: 1_000_000, autoCompactThreshold: 167_000 }), policy);
    expect(applied).toMatchObject({ usedTokens: 300_000, maxTokens: 1_000_000, compactsAutomatically: false });
    expect(applied.autoCompactThreshold).toBeUndefined();
  });

  it("uses the model's full window that the session reports when automatic compaction is off", () => {
    const policy = withReportedClaudeContextUsage(createClaudeCompactionPolicy(200_000), { rawMaxTokens: 1_000_000, isAutoCompactEnabled: false });
    const applied = applyClaudeCompactionPolicy(usage({ usedTokens: 250_000 }), policy);
    expect(applied).toMatchObject({ usedTokens: 250_000, maxTokens: 1_000_000, compactsAutomatically: false });
  });

  it("ignores a context report it cannot read", () => {
    const policy = createClaudeCompactionPolicy(200_000);
    expect(withReportedClaudeContextUsage(policy, null)).toEqual(policy);
    expect(withReportedClaudeContextUsage(policy, { rawMaxTokens: "200000", autoCompactThreshold: -1 })).toEqual(policy);
  });
});

describe("Claude compaction watch", () => {
  it("warns once when the first request after an automatic compaction is already near the threshold", () => {
    const watch = new ClaudeCompactionWatch();
    expect(watch.observe(compactBoundary("auto"), 67_000)).toBeNull();
    // A subagent's request says nothing about the main conversation.
    expect(watch.observe(assistantEvent(66_000, "tool-1"), 67_000)).toBeNull();
    expect(watch.observe(assistantEvent(67_400), 67_000)).toContain("67k tokens right after compacting");
    expect(watch.observe(compactBoundary("auto"), 67_000)).toBeNull();
    expect(watch.observe(assistantEvent(67_400), 67_000)).toBeNull();
  });

  it("stays quiet when compaction freed room, when it was manual, or without a compaction", () => {
    const freed = new ClaudeCompactionWatch();
    freed.observe(compactBoundary("auto"), 167_000);
    expect(freed.observe(assistantEvent(67_400), 167_000)).toBeNull();
    const manual = new ClaudeCompactionWatch();
    manual.observe(compactBoundary("manual"), 67_000);
    expect(manual.observe(assistantEvent(67_400), 67_000)).toBeNull();
    expect(new ClaudeCompactionWatch().observe(assistantEvent(67_400), 67_000)).toBeNull();
  });
});

describe("Claude turn compaction reporting", () => {
  const run = (events: unknown[], getContextUsage?: () => Promise<unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-claude-compaction-"));
    roots.push(root);
    sdk.query.mockReturnValue({
      close: vi.fn(),
      ...(getContextUsage ? { getContextUsage: vi.fn(getContextUsage) } : {}),
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          // Lets the context report settle between events, as it does while a turn streams.
          await new Promise((resolve) => setTimeout(resolve, 0));
          yield event;
        }
      },
    });
    const input: RunExecutionRequest = {
      runId: "run-1", worktreePath: root, mode: "code", prompt: "Hello",
      providerType: "claude-code", modelId: "sonnet", apiKey: "",
    };
    const chunks: HarnessRunChunk[] = [];
    const done = new ClaudeCodeHarnessAdapter().run(
      input, { tools: [], executeTool: vi.fn() }, (chunk) => chunks.push(chunk), new AbortController().signal,
    );
    return { done, chunks };
  };
  const init = { type: "system", subtype: "init", session_id: "claude-session", model: "claude-sonnet-5-5" };
  const result = {
    type: "result", subtype: "success", result: "Done", session_id: "claude-session",
    usage: { input_tokens: 2, cache_read_input_tokens: 62_000, output_tokens: 10 },
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 2, cacheReadInputTokens: 62_000, outputTokens: 10, contextWindow: 1_000_000 } },
  };
  const lastUsage = (chunks: HarnessRunChunk[]) => chunks
    .map((chunk) => chunk.metadata?.usageTotals as RunTokenUsage | undefined)
    .filter((usage): usage is RunTokenUsage => usage !== undefined)
    .at(-1);

  it("sends the 200k window and reports usage against Claude Code's own threshold", async () => {
    const { done, chunks } = run([init, assistantEvent(62_000), result], () => Promise.resolve({
      rawMaxTokens: 200_000, autoCompactThreshold: 165_000, isAutoCompactEnabled: true,
    }));
    await done;
    expect(sdk.query.mock.calls[0][0].options.settings).toMatchObject({ autoCompactWindow: 200_000 });
    expect(lastUsage(chunks)).toMatchObject({ maxTokens: 200_000, autoCompactThreshold: 165_000, compactsAutomatically: true });
  });

  it("falls back to the estimated threshold when the session cannot report it", async () => {
    const { done, chunks } = run([init, assistantEvent(62_000), result], () => Promise.reject(new Error("closed")));
    await done;
    expect(lastUsage(chunks)).toMatchObject({ maxTokens: 200_000, autoCompactThreshold: 167_000 });
  });

  it("keeps the model's window during the turn when automatic compaction is off", async () => {
    // The session starts with the 200k default before Claude Code reports that compaction is off.
    const { done, chunks } = run([init, assistantEvent(62_000), assistantEvent(250_000), result], () => Promise.resolve({
      rawMaxTokens: 1_000_000, isAutoCompactEnabled: false,
    }));
    await done;
    const reported = chunks
      .map((chunk) => chunk.metadata?.usageTotals as RunTokenUsage | undefined)
      .filter((usage): usage is RunTokenUsage => usage?.compactsAutomatically === false);
    expect(reported.length).toBeGreaterThan(0);
    for (const usage of reported) expect(usage.maxTokens).toBe(1_000_000);
    expect(Math.max(...reported.map((usage) => usage.usedTokens ?? 0))).toBe(250_010);
  });

  it("adds a visible warning when compaction leaves the session at the threshold", async () => {
    const { done, chunks } = run([init, assistantEvent(60_000), compactBoundary("auto"), assistantEvent(160_000), result]);
    await done;
    const warnings = chunks.filter((chunk) => chunk.title === "Context nearly full");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].metadata?.silent).toBeUndefined();
  });
});
