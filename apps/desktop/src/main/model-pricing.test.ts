import { describe, expect, it } from "vitest";
import {
  cacheSavingsUsd,
  costByCategory,
  deserializeRateTable,
  parseLiteLlmRateTable,
  resolveModelRate,
  serializeRateTable,
  sumCategoryCost,
  uncachedInputTokens,
} from "./model-pricing";

const perMillion = (value: number) => value / 1_000_000;

const LITELLM_SAMPLE = {
  sample_spec: { max_tokens: "set to max tokens" },
  "claude-sonnet-4-5": {
    input_cost_per_token: perMillion(3),
    output_cost_per_token: perMillion(15),
    cache_read_input_token_cost: perMillion(0.3),
    cache_creation_input_token_cost: perMillion(3.75),
  },
  "gpt-5": { input_cost_per_token: perMillion(1.25), output_cost_per_token: perMillion(10), cache_read_input_token_cost: perMillion(0.125) },
  "openrouter/openai/gpt-5": { input_cost_per_token: perMillion(1.5), output_cost_per_token: perMillion(12) },
  "openrouter/vendor/only-prefixed": { input_cost_per_token: perMillion(2), output_cost_per_token: perMillion(4) },
  "bedrock/a/conflicting": { input_cost_per_token: perMillion(1), output_cost_per_token: perMillion(1) },
  "vertex/b/conflicting": { input_cost_per_token: perMillion(2), output_cost_per_token: perMillion(2) },
  "half-priced": { input_cost_per_token: perMillion(1) },
  "Mixed-Case-Model": { input_cost_per_token: perMillion(1), output_cost_per_token: perMillion(2) },
};

describe("parseLiteLlmRateTable", () => {
  const table = parseLiteLlmRateTable(LITELLM_SAMPLE);

  it("keeps fully priced models and falls back to the input rate for missing cache rates", () => {
    expect(table.get("claude-sonnet-4-5")).toEqual({
      input: perMillion(3), output: perMillion(15), cacheRead: perMillion(0.3), cacheWrite: perMillion(3.75),
    });
    expect(table.get("gpt-5")?.cacheWrite).toBe(perMillion(1.25));
    expect(table.get("mixed-case-model")).toBeDefined();
  });

  it("drops entries without both an input and an output rate", () => {
    expect(table.has("half-priced")).toBe(false);
    expect(table.has("sample_spec")).toBe(false);
  });

  it("aliases provider-prefixed models by bare name only when unambiguous", () => {
    expect(table.get("only-prefixed")).toEqual(table.get("openrouter/vendor/only-prefixed"));
    expect(table.has("conflicting")).toBe(false);
    // An existing bare key is never replaced by a prefixed variant.
    expect(table.get("gpt-5")?.input).toBe(perMillion(1.25));
  });

  it("returns an empty table for malformed documents", () => {
    expect(parseLiteLlmRateTable(null).size).toBe(0);
    expect(parseLiteLlmRateTable([1, 2]).size).toBe(0);
  });

  it("round-trips through the compact cache format", () => {
    expect(deserializeRateTable(JSON.parse(JSON.stringify(serializeRateTable(table))))).toEqual(table);
    expect(deserializeRateTable({ bad: [1, 2], worse: "x" }).size).toBe(0);
  });
});

describe("resolveModelRate", () => {
  const table = parseLiteLlmRateTable(LITELLM_SAMPLE);

  it("prefers provider-specific keys, then exact and bare names", () => {
    expect(resolveModelRate(table, "openrouter", "openai/gpt-5")).toMatchObject({ matchedKey: "openrouter/openai/gpt-5" });
    expect(resolveModelRate(table, "codex-cli", "GPT-5")).toMatchObject({ matchedKey: "gpt-5" });
    expect(resolveModelRate(table, "ai-sdk", "anthropic/claude-sonnet-4-5")).toMatchObject({ matchedKey: "claude-sonnet-4-5" });
  });

  it("normalizes dotted versions and bracketed context-tier suffixes", () => {
    expect(resolveModelRate(table, "cursor-agent", "claude-sonnet-4.5")).toMatchObject({ matchedKey: "claude-sonnet-4-5" });
    expect(resolveModelRate(table, "claude-code", "claude-sonnet-4-5[1m]")).toMatchObject({ matchedKey: "claude-sonnet-4-5" });
  });

  it("leaves ambiguous aliases and unknown models unpriced", () => {
    expect(resolveModelRate(table, "claude-code", "opus")).toBeNull();
    expect(resolveModelRate(table, "cursor-agent", "auto")).toBeNull();
    expect(resolveModelRate(table, "ai-sdk", "unknown-model")).toBeNull();
  });
});

describe("usage cost math", () => {
  const rates = { input: perMillion(3), output: perMillion(15), cacheRead: perMillion(0.3), cacheWrite: perMillion(3.75) };

  it("prices uncached input, cache reads, cache writes, and output separately", () => {
    const tokens = { inputTokens: 1_100_000, outputTokens: 100_000, cacheReadTokens: 900_000, cacheWriteTokens: 100_000 };
    expect(uncachedInputTokens(tokens)).toBe(100_000);
    const cost = costByCategory(tokens, rates);
    expect(cost.input).toBeCloseTo(0.3);
    expect(cost.cacheRead).toBeCloseTo(0.27);
    expect(cost.cacheWrite).toBeCloseTo(0.375);
    expect(cost.output).toBeCloseTo(1.5);
    expect(sumCategoryCost(cost)).toBeCloseTo(2.445);
    // Net of the cache-write premium: 2.43 saved on reads minus 0.075 extra for writes.
    expect(cacheSavingsUsd(tokens, rates)).toBeCloseTo(2.355);
  });

  it("treats input as uncached when a provider reported cache tokens outside input", () => {
    expect(uncachedInputTokens({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0 })).toBe(100);
  });
});
