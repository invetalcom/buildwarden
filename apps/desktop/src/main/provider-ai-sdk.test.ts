import { describe, expect, it } from "vitest";
import { AI_SDK_RECOMMENDED_MODEL_IDS, getModelPresetsForProvider } from "@buildwarden/shared";
import { generateText } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/index";
import { MockLanguageModelV4 } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/test/index";
import {
  AiSdkProviderAdapter,
  applyAnthropicCacheBreakpoints,
  buildAiSdkPlanProgressChunk,
  buildAiSdkProviderOptions,
  buildInstructionsForFamily,
  parseAiSdkModelsApiAvailableModels,
  PRUNED_TOOL_OUTPUT_TEXT,
  pruneOldToolOutputs,
  requestAiSdkModelsApiAvailableModels,
  splitSystemMessagesIntoInstructions,
} from "../../../../packages/provider-ai-sdk/src";

describe("AiSdkProviderAdapter", () => {
  it("rejects missing api keys for direct providers", () => {
    const adapter = new AiSdkProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "ai-sdk",
        label: "OpenAI",
        apiKey: "",
        config: { providerFamily: "openai" },
      }),
    ).toThrow("An API key is required for AI SDK providers.");
  });

  it("accepts missing api keys for openai-compatible family", () => {
    const adapter = new AiSdkProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "ai-sdk",
        label: "Local model",
        apiKey: "",
        apiBaseUrl: "http://localhost:1234/v1",
        config: { providerFamily: "openai-compatible" },
      }),
    ).not.toThrow();
  });

  it("lists recommended models from shared catalog", () => {
    const adapter = new AiSdkProviderAdapter();
    expect(adapter.listRecommendedModels()).toEqual([...AI_SDK_RECOMMENDED_MODEL_IDS]);
  });

  it("returns curated presets for non-Google AI SDK families", async () => {
    const adapter = new AiSdkProviderAdapter();
    const expected = getModelPresetsForProvider("ai-sdk", "anthropic").map((preset) => ({
      modelId: preset.modelId,
      displayName: preset.displayName,
      source: "curated" as const,
    }));

    await expect(
      adapter.listAvailableModels({
        providerAccountId: "provider-1",
        providerType: "ai-sdk",
        config: { providerFamily: "anthropic" },
        apiBaseUrl: null,
      }),
    ).resolves.toEqual(expected);
  });

  it("normalizes Google models from the AI SDK model catalog", () => {
    expect(
      parseAiSdkModelsApiAvailableModels(
        {
          data: [
            { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", type: "language" },
            { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro Preview", type: "language" },
            { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", type: "language" },
            { id: "google/gemini-embedding-001", name: "Gemini Embedding", type: "embedding" },
            { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
            { id: "google/", name: "Missing model", type: "language" },
          ],
        },
        "google",
      ),
    ).toEqual([
      { modelId: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", source: "provider" },
      { modelId: "gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview", source: "provider" },
      { modelId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", source: "provider" },
    ]);
  });

  it("supports models response shape from the AI SDK catalog", () => {
    expect(
      parseAiSdkModelsApiAvailableModels(
        {
          models: [{ id: "google/gemini-3-flash", displayName: "Gemini 3 Flash", modelType: "language" }],
        },
        "google",
      ),
    ).toEqual([{ modelId: "gemini-3-flash", displayName: "Gemini 3 Flash", source: "provider" }]);
  });

  it("does not surface catalog models for non-Google AI SDK families", () => {
    expect(
      parseAiSdkModelsApiAvailableModels(
        {
          data: [{ id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro Preview", type: "language" }],
        },
        "openai",
      ),
    ).toEqual([]);
  });

  it("propagates AI SDK catalog request failures so the controller can fall back", async () => {
    await expect(
      requestAiSdkModelsApiAvailableModels("google", async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response)),
    ).rejects.toThrow("AI SDK model catalog request failed (503 Service Unavailable).");
  });

  it("propagates empty Google catalog results so the controller can fall back", async () => {
    await expect(
      requestAiSdkModelsApiAvailableModels("google", async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" }],
        }),
      } as Response)),
    ).rejects.toThrow("AI SDK model catalog did not report any google language models.");
  });

  it("builds plan-progress chunks for the internal update_plan tool", () => {
    expect(
      buildAiSdkPlanProgressChunk({
        steps: [
          { title: "Inspect contracts", status: "completed" },
          { title: "Patch renderer", status: "in_progress" },
        ],
      }),
    ).toEqual({
      type: "plan-progress",
      title: "Plan progress",
      value: "1. [x] Inspect contracts\n2. [-] Patch renderer",
      metadata: {
        provider: "ai-sdk",
        planProgress: {
          source: "ai-sdk",
          steps: [
            { title: "Inspect contracts", status: "completed" },
            { title: "Patch renderer", status: "inProgress" },
          ],
        },
        streamId: "ai-sdk-plan-progress",
        replace: true,
      },
    });
  });

  it("returns null for invalid update_plan payloads", () => {
    expect(buildAiSdkPlanProgressChunk({ steps: [] })).toBeNull();
    expect(buildAiSdkPlanProgressChunk({})).toBeNull();
    expect(buildAiSdkPlanProgressChunk({ steps: "not an array" })).toBeNull();
  });
});

describe("splitSystemMessagesIntoInstructions", () => {
  const makeMockModel = () =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Hello, world!" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      }),
    });

  it("joins system messages into instructions and drops them from the message list", () => {
    expect(
      splitSystemMessagesIntoInstructions([
        { role: "system", content: "First." },
        { role: "user", content: "hi" },
        { role: "system", content: "Second." },
        { role: "system", content: "   " },
        { role: "assistant", content: "hello" },
      ]),
    ).toEqual({
      instructions: "First.\n\nSecond.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
  });

  it("omits instructions when no system messages are present", () => {
    expect(splitSystemMessagesIntoInstructions([{ role: "user", content: "hi" }])).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("regression: AI SDK 7 rejects system roles inside messages", async () => {
    await expect(
      generateText({
        model: makeMockModel(),
        messages: [
          { role: "system", content: "You are BuildWarden." },
          { role: "user", content: "hi" },
        ] as never,
      }),
    ).rejects.toThrow(/System messages are not allowed/);
  });

  it("cached anthropic instructions pass AI SDK 7 validation and keep providerOptions", async () => {
    const model = makeMockModel();
    const instructions = buildInstructionsForFamily("anthropic", "You are BuildWarden.");

    expect(instructions).toEqual({
      role: "system",
      content: "You are BuildWarden.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });

    const result = await generateText({
      model,
      instructions: instructions as never,
      messages: [{ role: "user", content: "hi" }] as never,
    });

    expect(result.text).toBe("Hello, world!");
    const prompt = model.doGenerateCalls[0]?.prompt as Array<{ role: string; content: unknown; providerOptions?: unknown }>;
    expect(prompt[0]).toMatchObject({
      role: "system",
      content: "You are BuildWarden.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("keeps plain string instructions for non-anthropic families", () => {
    expect(buildInstructionsForFamily("openai", "You are BuildWarden.")).toBe("You are BuildWarden.");
    expect(buildInstructionsForFamily("openai-compatible", "You are BuildWarden.")).toBe("You are BuildWarden.");
  });

  it("split output passes AI SDK 7 validation and reaches the model as a system prompt", async () => {
    const model = makeMockModel();
    const { instructions, messages } = splitSystemMessagesIntoInstructions([
      { role: "system", content: "You are BuildWarden." },
      { role: "user", content: "hi" },
    ]);

    const result = await generateText({
      model,
      ...(instructions ? { instructions } : {}),
      messages: messages as never,
    });

    expect(result.text).toBe("Hello, world!");
    const prompt = model.doGenerateCalls[0]?.prompt as Array<{ role: string; content: unknown }>;
    expect(prompt[0]).toMatchObject({ role: "system", content: "You are BuildWarden." });
    expect(prompt[1]).toMatchObject({ role: "user" });
  });
});

const toolResultMessage = (id: string, outputChars: number): Record<string, unknown> => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read_file",
      output: { type: "json", value: { ok: true, content: "x".repeat(outputChars) } },
    },
  ],
});

describe("pruneOldToolOutputs", () => {
  it("prunes old tool outputs while protecting the most recent ones", () => {
    const messages = [
      { role: "user", content: "task" },
      ...Array.from({ length: 12 }, (_, index) => toolResultMessage(`call-${String(index)}`, 30_000)),
    ];

    const result = pruneOldToolOutputs(messages);

    expect(result.prunedToolOutputs).toBe(6);
    expect(result.prunedChars).toBeGreaterThan(0);
    // Oldest six tool messages are pruned, most recent six are protected.
    for (let index = 1; index <= 6; index++) {
      const content = result.messages[index]?.content as Array<{ output: unknown }>;
      expect(content[0]?.output).toEqual({ type: "text", value: PRUNED_TOOL_OUTPUT_TEXT });
    }
    for (let index = 7; index <= 12; index++) {
      const content = result.messages[index]?.content as Array<{ output: { type: string } }>;
      expect(content[0]?.output.type).toBe("json");
    }
    // The user message is untouched (same reference).
    expect(result.messages[0]).toBe(messages[0]);
  });

  it("does not prune when the reclaimable amount is below the minimum savings", () => {
    const messages = [
      ...Array.from({ length: 6 }, (_, index) => toolResultMessage(`old-${String(index)}`, 10_000)),
      ...Array.from({ length: 6 }, (_, index) => toolResultMessage(`recent-${String(index)}`, 30_000)),
    ];

    const result = pruneOldToolOutputs(messages);

    expect(result.prunedToolOutputs).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("is idempotent: a second pass over pruned messages is a no-op", () => {
    const messages = [
      { role: "user", content: "task" },
      ...Array.from({ length: 12 }, (_, index) => toolResultMessage(`call-${String(index)}`, 30_000)),
    ];

    const firstPass = pruneOldToolOutputs(messages);
    expect(firstPass.prunedToolOutputs).toBe(6);

    const secondPass = pruneOldToolOutputs(firstPass.messages);
    expect(secondPass.prunedToolOutputs).toBe(0);
    expect(secondPass.messages).toBe(firstPass.messages);
  });

  it("ignores messages without tool results", () => {
    const messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "working on it" },
    ];

    const result = pruneOldToolOutputs(messages);
    expect(result.prunedToolOutputs).toBe(0);
    expect(result.messages).toBe(messages);
  });
});

describe("applyAnthropicCacheBreakpoints", () => {
  it("marks the last two user/tool messages and skips assistant messages", () => {
    const messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "thinking" },
      toolResultMessage("call-1", 10),
      { role: "assistant", content: "done" },
    ];

    const result = applyAnthropicCacheBreakpoints(messages);

    expect(result[0]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(result[1]?.providerOptions).toBeUndefined();
    expect(result[2]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(result[3]?.providerOptions).toBeUndefined();
  });

  it("slides breakpoints forward and strips stale ones as the conversation grows", () => {
    const initial = applyAnthropicCacheBreakpoints([
      { role: "user", content: "task" },
      toolResultMessage("call-1", 10),
    ]);
    expect(initial[0]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(initial[1]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });

    const grown = applyAnthropicCacheBreakpoints([
      ...initial,
      { role: "assistant", content: "next" },
      toolResultMessage("call-2", 10),
    ]);
    expect(grown[0]?.providerOptions).toBeUndefined();
    expect(grown[1]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(grown[3]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("preserves unrelated providerOptions when stripping stale breakpoints", () => {
    const messages = [
      {
        role: "user",
        content: "task",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" }, custom: "keep" }, other: { flag: true } },
      },
      { role: "user", content: "follow-up 1" },
      { role: "user", content: "follow-up 2" },
    ];

    const result = applyAnthropicCacheBreakpoints(messages);

    expect(result[0]?.providerOptions).toEqual({ anthropic: { custom: "keep" }, other: { flag: true } });
    expect(result[1]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(result[2]?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("returns the original array when no cacheable messages exist", () => {
    const messages = [{ role: "assistant", content: "hello" }];
    expect(applyAnthropicCacheBreakpoints(messages)).toBe(messages);
  });
});

describe("buildAiSdkProviderOptions prompt cache key", () => {
  it("adds promptCacheKey for the openai family", () => {
    expect(buildAiSdkProviderOptions("openai", "gpt-4o", undefined, undefined, "run-123")).toEqual({
      openai: { promptCacheKey: "run-123" },
    });
  });

  it("combines promptCacheKey with reasoning options", () => {
    expect(
      buildAiSdkProviderOptions("openai", "gpt-5.5", { reasoningEffort: "high" }, undefined, "run-123"),
    ).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "auto", promptCacheKey: "run-123" },
    });
  });

  it("does not leak the cache key to non-openai families", () => {
    expect(buildAiSdkProviderOptions("anthropic", "claude-sonnet-5", undefined, undefined, "run-123")).toBeUndefined();
    expect(buildAiSdkProviderOptions("google", "gemini-3-pro", undefined, undefined, "run-123")).toBeUndefined();
  });

  it("still returns undefined when nothing is configured", () => {
    expect(buildAiSdkProviderOptions("openai", "gpt-4o", undefined, undefined)).toBeUndefined();
  });
});
