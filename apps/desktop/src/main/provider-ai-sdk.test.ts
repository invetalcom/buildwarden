import { describe, expect, it } from "vitest";
import { AI_SDK_RECOMMENDED_MODEL_IDS } from "@buildwarden/shared";
import { AiSdkProviderAdapter, buildAiSdkPlanProgressChunk } from "../../../../packages/provider-ai-sdk/src";

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
    ).toThrowError("An API key is required for AI SDK providers.");
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
