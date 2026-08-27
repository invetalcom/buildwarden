import { describe, expect, it } from "vitest";
import { AI_SDK_RECOMMENDED_MODEL_IDS, getModelPresetsForProvider } from "@buildwarden/shared";
import { generateText } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/index";
import { MockLanguageModelV4 } from "../../../../packages/provider-ai-sdk/node_modules/ai/dist/test/index";
import {
  AiSdkProviderAdapter,
  OpenRouterProviderAdapter,
  applyAnthropicCacheBreakpoints,
  assertOpenRouterAttachmentCompatibility,
  buildAttachmentUserContent,
  buildAiSdkExecutionProfile,
  buildAiSdkPlanProgressChunk,
  buildAiSdkProviderOptions,
  buildOpenRouterProviderOptions,
  extractProviderErrorText,
  buildInstructionsForFamily,
  parseAiSdkModelsApiAvailableModels,
  parseOpenRouterAvailableModels,
  PRUNED_TOOL_OUTPUT_TEXT,
  pruneOldToolOutputs,
  requestAiSdkModelsApiAvailableModels,
  requestOpenRouterAvailableModels,
  splitSystemMessagesIntoInstructions,
} from "../../../../packages/provider-ai-sdk/src";

describe("AiSdkProviderAdapter", () => {
  const controlValues = (family: "openai" | "anthropic" | "google" | "xai" | "openai-compatible", modelId: string, id: string) => {
    const config = buildAiSdkExecutionProfile(family, modelId) as {
      buildwardenExecutionProfile: { controls: Array<{ id: string; options: Array<{ value: string }> }> };
    };
    return config.buildwardenExecutionProfile.controls.find((control) => control.id === id)?.options.map((option) => option.value) ?? [];
  };

  it("publishes exact per-model effort and speed profiles", () => {
    expect(controlValues("openai", "gpt-5.5", "reasoningEffort")).toEqual(["auto", "none", "low", "medium", "high", "xhigh"]);
    expect(controlValues("openai", "gpt-5.5-pro", "reasoningEffort")).toEqual(["auto", "medium", "high", "xhigh"]);
    expect(controlValues("openai", "gpt-5.5", "serviceTier")).toEqual(["auto", "default", "flex", "priority"]);
    expect(controlValues("anthropic", "claude-opus-4-8", "speed")).toEqual(["auto", "standard", "fast"]);
    expect(controlValues("anthropic", "claude-opus-4-7", "speed")).toEqual([]);
    expect(controlValues("google", "gemini-3.1-pro-preview", "thinkingLevel")).toEqual(["auto", "low", "medium", "high"]);
    expect(controlValues("google", "gemini-3.5-flash", "thinkingLevel")).toEqual(["auto", "minimal", "low", "medium", "high"]);
    expect(controlValues("xai", "grok-4.5", "reasoningEffort")).toEqual(["auto", "low", "medium", "high"]);
    expect(controlValues("openai-compatible", "custom", "reasoningEffort")).toEqual([]);
  });

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

    const models = await adapter.listAvailableModels({
        providerAccountId: "provider-1",
        providerType: "ai-sdk",
        config: { providerFamily: "anthropic" },
        apiBaseUrl: null,
      });
    expect(models.map(({ modelId, displayName, source }) => ({ modelId, displayName, source }))).toEqual(expected);
    expect(models.find((model) => model.modelId === "opus")?.config).toEqual({
      buildwardenExecutionProfile: { source: "catalog", controls: [] },
    });
  });

  it("normalizes Google models from the AI SDK model catalog", () => {
    const models = parseAiSdkModelsApiAvailableModels(
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
      );
    expect(models.map(({ modelId, displayName, source }) => ({ modelId, displayName, source }))).toEqual([
      { modelId: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", source: "provider" },
      { modelId: "gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview", source: "provider" },
      { modelId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", source: "provider" },
    ]);
    expect(models.find((model) => model.modelId === "gemini-3-pro-preview")?.config).toMatchObject({
      buildwardenExecutionProfile: { controls: expect.arrayContaining([expect.objectContaining({ id: "thinkingLevel" })]) },
    });
  });

  it("supports models response shape from the AI SDK catalog", () => {
    const models = parseAiSdkModelsApiAvailableModels(
        {
          models: [{ id: "google/gemini-3-flash", displayName: "Gemini 3 Flash", modelType: "language" }],
        },
        "google",
      );
    expect(models.map(({ modelId, displayName, source }) => ({ modelId, displayName, source }))).toEqual([
      { modelId: "gemini-3-flash", displayName: "Gemini 3 Flash", source: "provider" },
    ]);
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

  it("normalizes OpenRouter text models and reports tool support", () => {
    const models = parseOpenRouterAvailableModels({
      data: [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          context_length: 200000,
          supported_parameters: ["tools", "reasoning"],
          architecture: { input_modalities: ["text", "image", "file", "audio", "video"], output_modalities: ["text"] },
        },
        {
          id: "openai/dall-e-3",
          name: "DALL-E 3",
          architecture: { output_modalities: ["image"] },
        },
        { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", supported_parameters: [] },
      ],
    });

    expect(models.map(({ modelId, displayName }) => ({ modelId, displayName }))).toEqual([
      { modelId: "anthropic/claude-sonnet-4", displayName: "Claude Sonnet 4" },
      { modelId: "google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    ]);
    expect(models[0]?.capabilities).toMatchObject({ supportsStreaming: true, supportsTools: true });
    expect(models[0]?.description).toBe("200K context · image, file, audio, video input · tools");
    expect(models[0]?.config).toMatchObject({
      buildwardenContextWindowTokens: 200000,
      buildwardenInputModalities: ["text", "image", "file", "audio", "video"],
      buildwardenOutputModalities: ["text"],
      buildwardenExecutionProfile: {
        source: "provider",
        controls: [expect.objectContaining({
          id: "reasoningEffort",
          options: expect.arrayContaining([expect.objectContaining({ value: "xhigh" })]),
        })],
      },
    });
    expect(models[1]?.capabilities).toMatchObject({ supportsTools: false });
  });

  it("converts OpenRouter image, audio, and video attachments into AI SDK file parts", () => {
    expect(buildAttachmentUserContent("Review these", [
      { fileName: "cats.png", mimeType: "image/png", dataBase64: "Ag==" },
      { fileName: "sample.mp3", mimeType: "audio/mpeg", dataBase64: "AA==" },
      { fileName: "clip.mp4", mimeType: "video/mp4", dataBase64: "AQ==" },
    ], "openrouter")).toEqual([
      { type: "text", text: "Review these" },
      { type: "file", data: "data:image/png;base64,Ag==", mediaType: "image/png", filename: "cats.png" },
      { type: "file", data: "data:audio/mpeg;base64,AA==", mediaType: "audio/mpeg", filename: "sample.mp3" },
      { type: "file", data: "data:video/mp4;base64,AQ==", mediaType: "video/mp4", filename: "clip.mp4" },
    ]);
  });

  it("rejects OpenRouter media that the selected catalog model cannot accept", () => {
    expect(() => assertOpenRouterAttachmentCompatibility({
      providerType: "openrouter",
      modelId: "z-ai/glm-5.3",
      modelConfig: { buildwardenInputModalities: ["text"] },
      attachments: [{ fileName: "cats.png", mimeType: "image/png", dataBase64: "AA==" }],
    })).toThrow(
      'OpenRouter model "z-ai/glm-5.3" does not support image input. Choose a model whose catalog entry lists image input, or enter a compatible model manually.',
    );
  });

  it("allows OpenRouter images for compatible and manually configured models", () => {
    const attachment = { fileName: "cats.png", mimeType: "image/png", dataBase64: "AA==" };
    expect(() => assertOpenRouterAttachmentCompatibility({
      providerType: "openrouter",
      modelId: "google/gemini-3.1-pro-preview",
      modelConfig: { buildwardenInputModalities: ["text", "image"] },
      attachments: [attachment],
    })).not.toThrow();
    expect(() => assertOpenRouterAttachmentCompatibility({
      providerType: "openrouter",
      modelId: "custom/vision-model",
      modelConfig: {},
      attachments: [attachment],
    })).not.toThrow();
  });

  it("extracts actionable messages from provider stream error payloads", () => {
    expect(extractProviderErrorText({
      responseBody: JSON.stringify({ error: { message: "No endpoints support image input for this model." } }),
    })).toBe("No endpoints support image input for this model.");
    expect(extractProviderErrorText(Object.assign(new Error("Request failed."), {
      responseBody: JSON.stringify({ error: { message: "The selected model only accepts text." } }),
    }))).toBe("The selected model only accepts text.");
  });

  it("maps supported OpenRouter reasoning effort into provider options", () => {
    expect(buildOpenRouterProviderOptions({ reasoningEffort: "high" })).toEqual({
      openrouter: { reasoning: { effort: "high" } },
    });
    expect(buildOpenRouterProviderOptions({ reasoningEffort: "auto" })).toBeUndefined();
    expect(buildOpenRouterProviderOptions({ reasoningEffort: "unsupported" })).toBeUndefined();
  });

  it("fetches OpenRouter models from a custom endpoint with authentication", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const models = await requestOpenRouterAvailableModels(
      {
        providerAccountId: "provider-1",
        providerType: "openrouter",
        config: { defaultHeaders: { "X-Custom": "value" } },
        apiKey: "secret",
        apiBaseUrl: "https://router.example.test/api/v1/",
      },
      async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return {
          ok: true,
          json: async () => ({ data: [{ id: "openai/gpt-5", name: "GPT-5" }] }),
        } as Response;
      },
    );

    expect(requestUrl).toBe("https://router.example.test/api/v1/models");
    expect(requestInit?.headers).toMatchObject({
      Accept: "application/json",
      Authorization: "Bearer secret",
      "X-Custom": "value",
    });
    expect(models[0]?.modelId).toBe("openai/gpt-5");
  });

  it("propagates OpenRouter catalog failures so manual model entry can be used", async () => {
    await expect(
      requestOpenRouterAvailableModels(
        {
          providerAccountId: "provider-1",
          providerType: "openrouter",
          config: {},
          apiKey: "secret",
        },
        async () => ({ ok: false, status: 503, statusText: "Service Unavailable" } as Response),
      ),
    ).rejects.toThrow("OpenRouter model catalog request failed (503 Service Unavailable).");
  });

  it("requires an API key for OpenRouter connections", () => {
    const adapter = new OpenRouterProviderAdapter();
    expect(() => adapter.validateConfiguration({
      providerType: "openrouter",
      label: "OpenRouter",
      apiKey: "",
    })).toThrow("An API key is required for OpenRouter.");
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

  it("maps service and reasoning controls to each AI SDK provider namespace", () => {
    expect(buildAiSdkProviderOptions("openai", "gpt-5.6", {
      reasoningEffort: "max",
      serviceTier: "priority",
    }, undefined)).toEqual({
      openai: { reasoningEffort: "max", reasoningSummary: "auto", serviceTier: "priority" },
    });
    expect(buildAiSdkProviderOptions("anthropic", "claude-opus-4-8", {
      anthropicEffort: "xhigh",
      speed: "fast",
    }, undefined)).toEqual({ anthropic: { effort: "xhigh", speed: "fast" } });
    expect(buildAiSdkProviderOptions("google", "gemini-3-pro", {
      thinkingLevel: "high",
      serviceTier: "flex",
    }, undefined)).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" }, serviceTier: "flex" } });
    expect(buildAiSdkProviderOptions("xai", "grok-4.3", { reasoningEffort: "medium" }, undefined)).toEqual({
      xai: { reasoningEffort: "medium" },
    });
    expect(buildAiSdkProviderOptions("openai-compatible", "custom", { reasoningEffort: "high" }, undefined)).toEqual({
      buildwardenCompatible: { reasoningEffort: "high" },
    });
  });

  it("treats auto as provider default and omits the override", () => {
    expect(buildAiSdkProviderOptions("openai", "gpt-5.6", { reasoningEffort: "auto", serviceTier: "auto" }, undefined)).toBeUndefined();
    expect(buildAiSdkProviderOptions("anthropic", "claude-opus-4-8", { anthropicEffort: "auto", speed: "auto" }, undefined)).toBeUndefined();
  });

  it("omits non-finite Google thinking budgets", () => {
    expect(buildAiSdkProviderOptions("google", "gemini-2.5-pro", { thinkingBudget: Number.NaN }, undefined)).toBeUndefined();
    expect(buildAiSdkProviderOptions("google", "gemini-2.5-pro", { thinkingBudget: Number.POSITIVE_INFINITY }, undefined)).toBeUndefined();
    expect(buildAiSdkProviderOptions("google", "gemini-2.5-pro", { thinkingBudget: 8_192 }, undefined)).toEqual({
      google: { thinkingConfig: { thinkingBudget: 8_192 } },
    });
  });
});
