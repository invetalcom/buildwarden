import { describe, expect, it } from "vitest";
import type { UsageCostReport, UsageReportRow } from "@buildwarden/shared";
import {
  OTHER_SERIES_KEY,
  USAGE_UNATTRIBUTED_COLOR,
  buildUsageAnalytics,
  buildUsageTimeSeries,
  cacheHitRate,
  costPerMillionTokens,
  describeUsageBucket,
  formatDelta,
  formatTokenCount,
  formatUsageBucket,
  formatUsd,
  usageBucketsSpanYears,
  formatUsdAxis,
  usageDelta,
  usageSeriesColor,
} from "./usage-analytics";

const tokens = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: input,
  uncachedInputTokens: input - cacheRead,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  outputTokens: output,
  reasoningTokens: 0,
});

const row = (bucket: string, modelIndex: number, projectIndex: number, cost: number | null, input = 1_000, output = 100, cacheRead = 0): UsageReportRow => ({
  bucket,
  modelIndex,
  projectIndex,
  tokens: tokens(input, output, cacheRead),
  cost: cost === null ? null : { input: cost * 0.5, cacheRead: 0, cacheWrite: 0, output: cost * 0.5 },
  cacheSavingsUsd: 0,
});

const report: UsageCostReport = {
  generatedAt: "2026-10-20T12:00:00.000Z",
  rangeDays: 2,
  bucketSize: "day",
  buckets: ["2026-10-19", "2026-10-20"],
  previousBuckets: ["2026-10-17", "2026-10-18"],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  models: [
    { providerType: "claude-code", modelId: "claude-sonnet-5-5", rates: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }, matchedKey: "claude-sonnet-5-5", colorRank: 1 },
    { providerType: "codex-cli", modelId: "gpt-6.1-sol", rates: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2 }, matchedKey: "gpt-6.1-sol", colorRank: 0 },
    { providerType: "claude-code", modelId: "sonnet", rates: null, matchedKey: null, colorRank: 2 },
    { providerType: "unknown", modelId: null, rates: null, matchedKey: null, colorRank: null },
  ],
  projects: [{ projectId: "p1", name: "Alpha", colorRank: 0 }, { projectId: null, name: "Standalone chats", colorRank: 1 }],
  rows: [
    row("2026-10-19", 0, 0, 2, 10_000, 500, 8_000),
    row("2026-10-20", 0, 1, 1),
    row("2026-10-20", 1, 0, 4),
    row("2026-10-20", 2, 0, null),
    row("2026-10-19", 3, 0, null, 50_000, 0),
    row("2026-10-18", 0, 0, 3),
    row("2026-10-17", 1, 0, 1),
  ],
};

describe("buildUsageAnalytics", () => {
  it("totals the selected window and the comparison window", () => {
    const analytics = buildUsageAnalytics(report);
    expect(analytics.current.costUsd).toBeCloseTo(7);
    expect(analytics.previous?.costUsd).toBeCloseTo(4);
    expect(analytics.current.unpricedTokens).toBe(1_100 + 50_000);
    expect(usageDelta(analytics.current.costUsd, analytics.previous!.costUsd)).toBeCloseTo(0.75);
  });

  it("keeps each model's all-time color even when another model leads this period", () => {
    const reranked: UsageCostReport = {
      ...report,
      models: report.models.map((model) => model.modelId === "claude-sonnet-5-5" ? { ...model, colorRank: 0 } : model.modelId === "gpt-6.1-sol" ? { ...model, colorRank: 1 } : model),
    };
    const { models } = buildUsageAnalytics(reranked);
    expect(models.find((model) => model.modelId === "claude-sonnet-5-5")?.color).toBe(usageSeriesColor(0));
    expect(models.find((model) => model.modelId === "gpt-6.1-sol")?.color).toBe(usageSeriesColor(1));
  });

  it("falls back to this period's cost ranking for hosts that send no color rank", () => {
    const legacy = {
      ...report,
      models: report.models.map((model) => {
        const withoutRank: Partial<typeof model> = { ...model };
        delete withoutRank.colorRank;
        return withoutRank;
      }),
    } as unknown as UsageCostReport;
    const { models } = buildUsageAnalytics(legacy);
    expect(models.find((model) => model.modelId === "gpt-6.1-sol")?.color).toBe(usageSeriesColor(0));
  });

  it("gives categorical slots by cost rank and keeps unattributed usage neutral", () => {
    const { models } = buildUsageAnalytics(report);
    expect(models.find((model) => model.modelId === "gpt-6.1-sol")?.color).toBe(usageSeriesColor(0));
    expect(models.find((model) => model.modelId === "claude-sonnet-5-5")?.color).toBe(usageSeriesColor(1));
    expect(models.find((model) => model.modelId === null)?.color).toBe(USAGE_UNATTRIBUTED_COLOR);
  });

  it("applies filters everywhere without repainting the remaining models", () => {
    const unfiltered = buildUsageAnalytics(report);
    const filtered = buildUsageAnalytics(report, { excludedModels: new Set(["codex-cli:gpt-6.1-sol"]), excludedProjects: new Set() });
    expect(filtered.current.costUsd).toBeCloseTo(3);
    expect(filtered.previous?.costUsd).toBeCloseTo(3);
    expect(filtered.models.map((model) => model.color)).toEqual(unfiltered.models.map((model) => model.color));
    const excludedRow = filtered.modelRows.find((entry) => entry.entry.modelId === "gpt-6.1-sol");
    expect(excludedRow).toMatchObject({ excluded: true, share: 0 });
    expect(excludedRow?.totals.costUsd).toBeCloseTo(4);
  });

  it("filters by project and reports per-project breakdowns", () => {
    const analytics = buildUsageAnalytics(report, { excludedModels: new Set(), excludedProjects: new Set(["standalone"]) });
    expect(analytics.current.costUsd).toBeCloseTo(6);
    expect(analytics.projectRows.map((entry) => [entry.entry.label, entry.excluded])).toEqual([["Alpha", false], ["Standalone chats", true]]);
  });

  it("derives cache hit rate and blended cost per million priced tokens", () => {
    const analytics = buildUsageAnalytics(report);
    // Pre-attribution input (50K) has no cache split, so it is left out of the rate.
    expect(cacheHitRate(analytics.current)).toBeCloseTo(8_000 / (10_000 + 1_000 * 3));
    expect(costPerMillionTokens(analytics.current)).toBeCloseTo((7 / (10_500 + 1_100 * 2)) * 1_000_000);
  });
});

describe("buildUsageTimeSeries", () => {
  it("stacks cost by model per bucket and drops series without cost", () => {
    const series = buildUsageTimeSeries(buildUsageAnalytics(report), "model", "cost");
    expect(series.buckets).toEqual(["2026-10-19", "2026-10-20"]);
    expect(series.series.map((entry) => [entry.label, entry.values])).toEqual([
      ["gpt-6.1-sol", [0, 4]],
      ["claude-sonnet-5-5", [2, 1]],
    ]);
  });

  it("stacks tokens by model with pre-attribution usage on top", () => {
    const series = buildUsageTimeSeries(buildUsageAnalytics(report), "model", "tokens");
    expect(series.series.at(-1)).toMatchObject({ label: "Before cost tracking", values: [50_000, 0] });
  });

  it("splits by token type in a fixed order", () => {
    const series = buildUsageTimeSeries(buildUsageAnalytics(report), "tokenType", "tokens");
    expect(series.series.map((entry) => entry.key)).toEqual(["input", "cacheRead", "output"]);
    expect(series.series.find((entry) => entry.key === "cacheRead")?.values).toEqual([8_000, 0]);
  });

  it("folds models past the categorical slots into Other", () => {
    const many: UsageCostReport = {
      ...report,
      models: Array.from({ length: 9 }, (_, index) => ({ providerType: "ai-sdk", modelId: `m${index}`, rates: null, matchedKey: null, colorRank: index })),
      rows: Array.from({ length: 9 }, (_, index) => row("2026-10-20", index, 0, 10 - index)),
    };
    const series = buildUsageTimeSeries(buildUsageAnalytics(many), "model", "cost");
    expect(series.series).toHaveLength(8);
    // m7 and m8 (cost 3 and 2) fall outside the seven slots.
    expect(series.series.at(-1)).toMatchObject({ key: OTHER_SERIES_KEY, values: [0, 5] });
  });
});

describe("usage formatting", () => {
  it("formats buckets, axes, deltas, and token counts compactly", () => {
    expect(formatUsageBucket("2026-10-20", "day")).toBe("Oct 20");
    expect(formatUsageBucket("2026-10-20T07", "hour")).toBe("07:00");
    expect(formatUsageBucket("2026-10-19", "week")).toBe("Oct 19");
    expect(formatUsageBucket("2025-12-29", "week", true)).toBe("Dec 29 '25");
    expect(formatUsageBucket("2026-10", "month")).toBe("Oct 2026");
    expect(describeUsageBucket("2026-10-19", "week")).toBe("Week of Oct 19, 2026");
    expect(describeUsageBucket("2026-10-20T07", "hour")).toBe("Oct 20, 07:00");
    expect(describeUsageBucket("2026-10-20", "day")).toBe("Oct 20, 2026");
    expect(usageBucketsSpanYears(["2025-12-29", "2026-01-05"])).toBe(true);
    expect(usageBucketsSpanYears(["2026-01-05", "2026-10-19"])).toBe(false);
    expect(formatUsd(-0.004)).toBe("−<$0.01");
    expect(formatUsdAxis(0)).toBe("$0");
    expect(formatUsdAxis(0.25)).toBe("$0.25");
    expect(formatUsdAxis(2.5)).toBe("$2.5");
    expect(formatUsdAxis(1_500)).toBe("$1.5K");
    expect(formatDelta(0.125)).toBe("+13%");
    expect(formatDelta(-0.05)).toBe("−5%");
    expect(formatTokenCount(1_250)).toBe("1.3K");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});
