import { describe, expect, it } from "vitest";
import { AzureLegacyProviderAdapter } from "../../../../packages/provider-azure-legacy/src";

describe("AzureLegacyProviderAdapter", () => {
  it("rejects missing base urls", () => {
    const adapter = new AzureLegacyProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "azure-legacy",
        label: "Azure Legacy",
        apiKey: "test-key",
      }),
    ).toThrow("A base URL is required for Azure Legacy providers.");
  });

  it("accepts valid settings", () => {
    const adapter = new AzureLegacyProviderAdapter();

    expect(() =>
      adapter.validateConfiguration({
        providerType: "azure-legacy",
        label: "Azure Legacy",
        apiKey: "",
        apiBaseUrl: "https://host/openai/deployments/model/",
      }),
    ).not.toThrow();
  });
});
