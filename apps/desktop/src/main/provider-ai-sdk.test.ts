import { describe, expect, it } from "vitest";
import { AI_SDK_RECOMMENDED_MODEL_IDS } from "@easycode/shared";
import { AiSdkProviderAdapter } from "../../../../packages/provider-ai-sdk/src";

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
});
