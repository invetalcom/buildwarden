import { describe, expect, it } from "vitest";
import type { ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { buildRunReasoningInput, harnessTypeForProvider } from "./app-model";

describe("harnessTypeForProvider", () => {
  const cases: Array<[ProviderType, string]> = [
    ["codex-cli", "codex-app-server"],
    ["claude-code", "claude-code"],
    ["cursor-agent", "cursor-acp"],
    ["azure-legacy", "azure-legacy"],
    ["ai-sdk", "ai-sdk"],
  ];

  it.each(cases)("maps %s to harness type %s", (providerType, expected) => {
    expect(harnessTypeForProvider(providerType)).toBe(expected);
  });
});

describe("buildRunReasoningInput", () => {
  it("normalizes OpenAI-style reasoning effort for Codex CLI", () => {
    expect(buildRunReasoningInput("codex-cli", null, "high", "medium")).toEqual({ reasoningEffort: "high" });
  });

  it("normalizes OpenAI-style reasoning effort for Cursor Agent", () => {
    expect(buildRunReasoningInput("cursor-agent", null, "xhigh", "medium")).toEqual({ reasoningEffort: "xhigh" });
  });

  it("falls back to medium reasoning effort for Cursor Agent when given an unsupported value", () => {
    expect(buildRunReasoningInput("cursor-agent", null, "extreme", "medium")).toEqual({ reasoningEffort: "medium" });
  });

  it("normalizes Anthropic-style effort for Claude Code", () => {
    expect(buildRunReasoningInput("claude-code", null, "medium", "high")).toEqual({ anthropicEffort: "high" });
  });

  it("routes AI SDK openai family through OpenAI-style reasoning effort", () => {
    expect(buildRunReasoningInput("ai-sdk", "openai" as UnifiedProviderFamily, "low", "medium")).toEqual({
      reasoningEffort: "low",
    });
  });

  it("routes AI SDK anthropic family through Anthropic-style effort", () => {
    expect(buildRunReasoningInput("ai-sdk", "anthropic" as UnifiedProviderFamily, "medium", "max")).toEqual({
      anthropicEffort: "max",
    });
  });

  it("returns no reasoning input for providers/families that do not support it", () => {
    expect(buildRunReasoningInput("azure-legacy", null, "high", "high")).toEqual({});
    expect(buildRunReasoningInput("ai-sdk", "google" as UnifiedProviderFamily, "high", "high")).toEqual({});
    expect(buildRunReasoningInput("ai-sdk", "xai" as UnifiedProviderFamily, "high", "high")).toEqual({});
  });
});