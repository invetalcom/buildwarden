import { describe, expect, it } from "vitest";
import { advanceReportedTokenUsage, advanceUsageTracker, EMPTY_REPORTED_TOKEN_USAGE, startsFreshUsageBaseline, type UsageReportTracker } from "./token-usage-accounting";

const counters = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
});

const deltas = (input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({
  inputTokensDelta: input,
  outputTokensDelta: output,
  cacheReadTokensDelta: cacheRead,
  cacheWriteTokensDelta: cacheWrite,
  reasoningTokensDelta: reasoning,
});

describe("advanceReportedTokenUsage", () => {
  it("adds a fresh worker turn to the owner's previously persisted usage", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      EMPTY_REPORTED_TOKEN_USAGE,
      { inputTokens: 80, outputTokens: 10 },
    )).toEqual({ ...deltas(80, 10), nextReportedUsage: counters(80, 10) });
  });

  it("records only the increase between streamed reports from the same worker turn", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 140, outputTokens: 25 },
      counters(40, 5),
      { inputTokens: 80, outputTokens: 10 },
    )).toEqual({ ...deltas(40, 5), nextReportedUsage: counters(80, 10) });
  });

  it("subtracts a resumed provider session baseline before recording new usage", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      counters(100, 20),
      { inputTokens: 180, outputTokens: 30 },
    )).toEqual({ ...deltas(80, 10), nextReportedUsage: counters(180, 30) });
  });

  it("accepts legacy input/output-only baselines", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 180, outputTokens: 30, cachedInputTokens: 50 },
    )).toEqual({ ...deltas(80, 10, 50), nextReportedUsage: counters(180, 30, 50) });
  });

  it("never subtracts tokens when a provider reports a lower corrected total", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      counters(80, 10),
      { inputTokens: 70, outputTokens: 8 },
    )).toEqual({ ...deltas(0, 0), nextReportedUsage: counters(80, 10) });
  });

  it("tracks cache read, cache write, and reasoning deltas alongside processed tokens", () => {
    const first = advanceReportedTokenUsage(
      { inputTokens: 0, outputTokens: 0 },
      EMPTY_REPORTED_TOKEN_USAGE,
      { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 800, cacheCreationInputTokens: 150, reasoningTokens: 40 },
    );
    expect(first).toEqual({ ...deltas(1_000, 100, 800, 150, 40), nextReportedUsage: counters(1_000, 100, 800, 150, 40) });

    const second = advanceReportedTokenUsage(
      { inputTokens: 1_000, outputTokens: 100 },
      first.nextReportedUsage,
      { inputTokens: 2_500, outputTokens: 180, cachedInputTokens: 2_200, cacheCreationInputTokens: 150, reasoningTokens: 70 },
    );
    expect(second).toEqual({ ...deltas(1_500, 80, 1_400, 0, 30), nextReportedUsage: counters(2_500, 180, 2_200, 150, 70) });
  });
});

describe("startsFreshUsageBaseline", () => {
  it("only resets the baseline for chunks that announce a fresh provider session", () => {
    expect(startsFreshUsageBaseline({ usageBaseline: "fresh" })).toBe(true);
    expect(startsFreshUsageBaseline({ usageBaseline: "resumed" })).toBe(false);
    expect(startsFreshUsageBaseline({ usageTotals: { inputTokens: 1 } })).toBe(false);
    expect(startsFreshUsageBaseline(undefined)).toBe(false);
  });

  it("lets a fresh Codex thread record its full usage instead of hiding it under the old thread's total", () => {
    const carriedBaseline = counters(2_000_000, 50_000);
    const freshThreadReport = { inputTokens: 1_500_000, outputTokens: 30_000 };
    expect(advanceReportedTokenUsage({ inputTokens: 0, outputTokens: 0 }, carriedBaseline, freshThreadReport))
      .toMatchObject({ inputTokensDelta: 0, outputTokensDelta: 0 });
    expect(advanceReportedTokenUsage({ inputTokens: 0, outputTokens: 0 }, EMPTY_REPORTED_TOKEN_USAGE, freshThreadReport))
      .toMatchObject({ inputTokensDelta: 1_500_000, outputTokensDelta: 30_000 });
  });
});

describe("advanceUsageTracker", () => {
  const tracker = (): UsageReportTracker => ({
    reportedUsage: { ...EMPTY_REPORTED_TOKEN_USAGE },
    attribution: { providerType: "claude-code", modelId: "sonnet" },
  });

  it("attributes the whole delta to the configured model when no breakdown is reported", () => {
    expect(advanceUsageTracker(tracker(), { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 })).toEqual([{
      inputTokensDelta: 100,
      outputTokensDelta: 10,
      attribution: { providerType: "claude-code", modelId: "sonnet", cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 0 },
    }]);
  });

  it("records each concrete model separately and only its increase between reports", () => {
    const state = tracker();
    expect(advanceUsageTracker(state, {
      inputTokens: 25_000,
      outputTokens: 4,
      modelBreakdown: { "claude-sonnet-5-5": { inputTokens: 25_000, outputTokens: 4, cachedInputTokens: 14_300 } },
    })).toEqual([expect.objectContaining({ inputTokensDelta: 25_000, outputTokensDelta: 4, attribution: expect.objectContaining({ modelId: "claude-sonnet-5-5", cacheReadTokens: 14_300 }) })]);

    // The result event adds the helper model and confirms the main model's totals.
    const deltas = advanceUsageTracker(state, {
      inputTokens: 26_200,
      outputTokens: 24,
      modelBreakdown: {
        "claude-haiku-5-5": { inputTokens: 1_200, outputTokens: 20 },
        "claude-sonnet-5-5": { inputTokens: 25_000, outputTokens: 4, cachedInputTokens: 14_300 },
      },
    });
    expect(deltas).toEqual([
      expect.objectContaining({ inputTokensDelta: 1_200, outputTokensDelta: 20, attribution: expect.objectContaining({ modelId: "claude-haiku-5-5", providerType: "claude-code" }) }),
      expect.objectContaining({ inputTokensDelta: 0, outputTokensDelta: 0, attribution: expect.objectContaining({ modelId: "claude-sonnet-5-5" }) }),
    ]);
    expect(state.reportedUsage).toMatchObject({ inputTokens: 26_200, outputTokens: 24 });
  });
});
