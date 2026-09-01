import {
  enabledCodeIntelligenceTools,
  parseCodeIntelligenceSettings,
  serializeCodeIntelligenceSettings,
} from "@buildwarden/shared";
import { describe, expect, it } from "vitest";

describe("code-intelligence settings", () => {
  it.each([undefined, "", "not-json", "[]", "true", '{"azure-legacy":{"codebase_map":false}}'])("keeps every provider disabled for %j", (raw) => {
    const settings = parseCodeIntelligenceSettings(raw);
    expect(enabledCodeIntelligenceTools(settings, "azure-legacy")).toEqual([]);
    expect(enabledCodeIntelligenceTools(settings, "ai-sdk")).toEqual([]);
  });

  it("keeps provider opt-ins isolated and discards unknown or false operations", () => {
    const settings = parseCodeIntelligenceSettings(JSON.stringify({
      "ai-sdk": { codebase_map: true, find_references: true },
      "azure-legacy": { codebase_map: false, unknown_tool: true },
    }));

    expect(enabledCodeIntelligenceTools(settings, "ai-sdk")).toEqual(["codebase_map", "find_references"]);
    expect(enabledCodeIntelligenceTools(settings, "azure-legacy")).toEqual([]);
    expect(serializeCodeIntelligenceSettings(settings)).toBe('{"ai-sdk":{"codebase_map":true,"find_references":true}}');
  });
});
