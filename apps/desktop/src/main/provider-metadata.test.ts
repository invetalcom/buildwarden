import { describe, expect, it } from "vitest";
import {
  connectionKindForProviderType,
  getDefaultProviderCapabilities,
  getModelPresetsForProvider,
  PROVIDER_TYPES_BY_CONNECTION_KIND,
} from "@buildwarden/shared";

describe("Cursor Agent provider metadata", () => {
  it("treats Cursor Agent as a local SDK/CLI connection", () => {
    expect(connectionKindForProviderType("cursor-agent")).toBe("local-sdk-cli");
    expect(PROVIDER_TYPES_BY_CONNECTION_KIND["local-sdk-cli"]).toContain("cursor-agent");
    expect(PROVIDER_TYPES_BY_CONNECTION_KIND["bring-your-own-key"]).not.toContain("cursor-agent");
  });

  it("only surfaces Cursor-tagged presets for Cursor Agent accounts", () => {
    const presets = getModelPresetsForProvider("cursor-agent", undefined);

    expect(presets).toEqual([{ group: "coding", modelId: "default", displayName: "Cursor Auto", tags: ["cursor-agent"] }]);
  });

  it("does not surface Cursor presets for other provider types", () => {
    expect(getModelPresetsForProvider("codex-cli", undefined).some((preset) => preset.modelId === "default")).toBe(false);
    expect(getModelPresetsForProvider("claude-code", undefined).some((preset) => preset.tags.includes("cursor-agent"))).toBe(
      false,
    );
  });

  it("reports streaming and tool support without a custom base URL for Cursor Agent", () => {
    expect(getDefaultProviderCapabilities("cursor-agent")).toEqual({
      supportsStreaming: true,
      supportsTools: true,
      supportsCustomBaseUrl: false,
    });
  });
});