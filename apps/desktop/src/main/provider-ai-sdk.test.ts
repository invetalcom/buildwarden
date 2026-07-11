import { describe, expect, it } from "vitest";
import { AI_SDK_RECOMMENDED_MODEL_IDS, getModelPresetsForProvider } from "@buildwarden/shared";
import { generateText } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/index";
import { MockLanguageModelV4 } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/test/index";
import {
  AiSdkProviderAdapter,
  buildAiSdkPlanProgressChunk,
  parseAiSdkModelsApiAvailableModels,
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
