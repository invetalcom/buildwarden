import { describe, expect, it } from "vitest";
import {
  shouldRequestAvailableProviderModels,
  type AvailableProviderModelsState,
} from "./available-provider-models";

const loadedState: AvailableProviderModelsState = {
  status: "loaded",
  models: [{ modelId: "gpt-5", displayName: "GPT-5", source: "provider" }],
  errorMessage: null,
};

describe("available provider model lookup gate", () => {
  it("does not request models before the add-model panel opens", () => {
    expect(shouldRequestAvailableProviderModels(null, "provider-1", undefined)).toBe(false);
    expect(shouldRequestAvailableProviderModels("connection", "provider-1", undefined)).toBe(false);
  });

  it("requests once when the add-model panel opens for an uncached provider", () => {
    expect(shouldRequestAvailableProviderModels("model", "provider-1", undefined)).toBe(true);
    expect(shouldRequestAvailableProviderModels("model", "provider-1", { status: "idle", models: [], errorMessage: null })).toBe(true);
    expect(shouldRequestAvailableProviderModels("model", "provider-1", { status: "loading", models: [], errorMessage: null })).toBe(false);
    expect(shouldRequestAvailableProviderModels("model", "provider-1", loadedState)).toBe(false);
  });

  it("requests for a newly selected provider without refetching the cached provider", () => {
    const cache: Record<string, AvailableProviderModelsState | undefined> = {
      "provider-1": loadedState,
    };

    expect(shouldRequestAvailableProviderModels("model", "provider-1", cache["provider-1"])).toBe(false);
    expect(shouldRequestAvailableProviderModels("model", "provider-2", cache["provider-2"])).toBe(true);
  });
});
