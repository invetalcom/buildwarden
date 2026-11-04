import { describe, expect, it } from "vitest";
import type { TokenUsageCostRow } from "@buildwarden/db";
import type { UsagePricingInfo } from "@buildwarden/shared";
import { parseLiteLlmRateTable } from "./model-pricing";
import { buildUsageCostReport, cursorAccountUsageRows, CURSOR_ACCOUNT_PROJECT_ID, localDayKey, localSessionUsageRows, STANDALONE_CHATS_PROJECT_NAME, usageReportWindow } from "./usage-cost-report";

const perMillion = (value: number) => value / 1_000_000;

const table = parseLiteLlmRateTable({
  "claude-sonnet-4-5": {
    input_cost_per_token: perMillion(3),
    output_cost_per_token: perMillion(15),
    cache_read_input_token_cost: perMillion(0.3),
    cache_creation_input_token_cost: perMillion(3.75),
  },
  "gpt-5": { input_cost_per_token: perMillion(1.25), output_cost_per_token: perMillion(10), cache_read_input_token_cost: perMillion(0.125) },
});

const pricing: UsagePricingInfo = { status: "fresh", source: "test", fetchedAt: null, knownModels: table.size };

const row = (overrides: Partial<TokenUsageCostRow>): TokenUsageCostRow => ({
  bucket: "2026-10-19",
  projectId: "project-1",
  projectName: "Alpha",
  providerType: "claude-code",
  modelId: "claude-sonnet-4-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...overrides,
});

const now = new Date(2026, 9, 19, 15, 30);

describe("usageReportWindow", () => {
  it("compares today's hours with yesterday up to the same time", () => {
    const window = usageReportWindow(1, now);
    expect(window.bucketSize).toBe("hour");
    expect(window.buckets[0]).toBe("2026-10-19T00");
    expect(window.buckets.at(-1)).toBe("2026-10-19T15");
    expect(window.previousBuckets).toEqual(window.buckets.map((bucket) => bucket.replace("2026-10-19", "2026-10-18")));
    expect(localDayKey(window.since!)).toBe("2026-10-18");
    expect(window.exclude).toEqual({ from: new Date(2026, 9, 18, 15, 30), to: new Date(2026, 9, 19) });
  });

  it("compares whole days with the same duration ending at the same time of day", () => {
    const window = usageReportWindow(7, now);
    expect(window.bucketSize).toBe("day");
    expect(window.buckets).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(window.previousBuckets[0]).toBe("2026-10-06");
    expect(window.previousBuckets.at(-1)).toBe("2026-10-12");
    expect(window.exclude).toEqual({ from: new Date(2026, 9, 12, 15, 30), to: new Date(2026, 9, 13) });
  });

  it("picks day, week, or month buckets for all history from its span", () => {
    expect(usageReportWindow(null, now, null)).toEqual({ bucketSize: "day", buckets: [], previousBuckets: [], since: null, exclude: null });
    const days = usageReportWindow(null, now, new Date(2026, 9, 16, 9));
    expect(days).toMatchObject({ bucketSize: "day", buckets: ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"], previousBuckets: [] });
    const weeks = usageReportWindow(null, now, new Date(2026, 0, 1, 9));
    expect(weeks.bucketSize).toBe("week");
    expect(weeks.buckets[0]).toBe("2025-12-29");
    expect(weeks.buckets.at(-1)).toBe("2026-10-19");
    const months = usageReportWindow(null, now, new Date(2023, 4, 20));
    expect(months.bucketSize).toBe("month");
    expect(months.buckets[0]).toBe("2023-05");
    expect(months.buckets.at(-1)).toBe("2026-10");
  });
});

describe("buildUsageCostReport", () => {
  it("includes both CLI histories, bills recorded service tiers, and does not count reasoning twice", () => {
    const window = usageReportWindow(7, now);
    const rates = parseLiteLlmRateTable({
      "gpt-5": { input_cost_per_token: 1, output_cost_per_token: 2, cache_read_input_token_cost: 0.1, input_cost_per_token_priority: 3, output_cost_per_token_priority: 6 },
    });
    const rows = localSessionUsageRows([
      { provider: "codex", model: "gpt-5", timestampMs: now.getTime(), sessionId: "session", speed: "fast", dedupeKey: null, reportedCostUsd: null,
        totals: { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 0, outputTokens: 5, reasoningTokens: 2 } },
      { provider: "claude", model: "unknown", timestampMs: now.getTime(), sessionId: "session-2", speed: "standard", dedupeKey: "msg", reportedCostUsd: 0.75,
        totals: { uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 5, reasoningTokens: 0 } },
    ], window);
    const report = buildUsageCostReport({ rows, table: rates, pricing, rangeDays: 7, now, window });
    expect(report.rows[0]).toMatchObject({ tokens: { inputTokens: 30, outputTokens: 5, reasoningTokens: 2 }, cost: { input: 30, output: 30 } });
    expect(report.rows[0]?.cost?.cacheRead).toBeCloseTo(6);
    expect(report.rows[1]).toMatchObject({ tokens: { inputTokens: 35 }, cost: { other: 0.75 } });
    expect(report.projects.map((project) => project.name)).toEqual(["Codex sessions (this machine)", "Claude Code sessions (this machine)"]);
  });

  it("buckets account history, excludes the comparison gap, and compacts individually priced events", () => {
    const window = usageReportWindow(1, now);
    const accountEvent = { timestampMs: now.getTime() - 1000, modelId: "unknown-cursor-model", inputTokens: 350, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 50, reportedCostUsd: 0.25 };
    const rows = cursorAccountUsageRows([accountEvent, { ...accountEvent, reportedCostUsd: 0.5 }, { ...accountEvent, reportedCostUsd: null }, { ...accountEvent, timestampMs: window.exclude!.from.getTime() }], window);
    const result = buildUsageCostReport({ rows, table, pricing, rangeDays: 1, now, window });
    expect(result.rows).toHaveLength(2); // Keep unpriced usage separate from reported cost.
    expect(result.rows[0]).toMatchObject({ tokens: { inputTokens: 700, uncachedInputTokens: 200, outputTokens: 40 }, cost: { other: 0.75 } });
    expect(result.rows[1]?.cost).toBeNull();
    expect(result.projects).toEqual([{ projectId: CURSOR_ACCOUNT_PROJECT_ID, name: "Cursor account (all activity)", colorRank: null }]);
  });

  const report = buildUsageCostReport({
    rows: [
      row({ bucket: "2026-10-18", inputTokens: 1_100_000, outputTokens: 100_000, cacheReadTokens: 900_000, cacheWriteTokens: 100_000 }),
      row({ projectId: null, projectName: null, providerType: "codex-cli", modelId: "gpt-5", inputTokens: 2_000_000, outputTokens: 50_000, cacheReadTokens: 1_600_000 }),
      row({ modelId: "opus", inputTokens: 10_000, outputTokens: 1_000 }),
      row({ bucket: "2026-10-17", providerType: null, modelId: null, inputTokens: 5_000, outputTokens: 500 }),
      row({ bucket: "2026-10-10", inputTokens: 1_000, outputTokens: 100 }),
      row({ bucket: "2026-09-01", inputTokens: 7, outputTokens: 7 }),
    ],
    table,
    pricing,
    rangeDays: 7,
    now,
    window: usageReportWindow(7, now),
    ranks: {
      models: [{ providerType: "codex-cli", modelId: "gpt-5" }, { providerType: "claude-code", modelId: "claude-sonnet-4-5" }],
      projectIds: [null, "project-1"],
    },
  });

  it("returns the window, the comparison window, and only rows inside them", () => {
    expect(report.bucketSize).toBe("day");
    expect(report.buckets).toHaveLength(7);
    expect(report.previousBuckets).toHaveLength(7);
    // 2026-09-01 is older than the comparison window and is dropped.
    expect(report.rows.map((entry) => entry.bucket).sort()).toEqual(["2026-10-10", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-19"]);
  });

  it("prices each row by token category and keeps unpriced and pre-attribution rows unpriced", () => {
    const priced = report.rows.find((entry) => entry.bucket === "2026-10-18")!;
    expect(priced.cost!.input).toBeCloseTo(0.3);
    expect(priced.cost!.cacheRead).toBeCloseTo(0.27);
    expect(priced.cost!.cacheWrite).toBeCloseTo(0.375);
    expect(priced.cost!.output).toBeCloseTo(1.5);
    // 900K reads save $2.43; 100K writes cost $0.075 over the input rate.
    expect(priced.cacheSavingsUsd).toBeCloseTo(2.355);
    expect(priced.tokens.uncachedInputTokens).toBe(100_000);

    const opusIndex = report.models.findIndex((model) => model.modelId === "opus");
    expect(report.models[opusIndex]).toMatchObject({ rates: null, matchedKey: null });
    expect(report.rows.find((entry) => entry.modelIndex === opusIndex)?.cost).toBeNull();
    const legacy = report.models.find((model) => model.modelId === null);
    expect(legacy).toEqual({ providerType: "unknown", modelId: null, rates: null, matchedKey: null, colorRank: null });
  });

  it("indexes models and projects, naming standalone chats", () => {
    expect(report.models.find((model) => model.modelId === "gpt-5")).toMatchObject({
      providerType: "codex-cli",
      matchedKey: "gpt-5",
      rates: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, cacheWritePerMillion: 1.25 },
    });
    expect(report.projects).toEqual([
      { projectId: "project-1", name: "Alpha", colorRank: 1 },
      { projectId: null, name: STANDALONE_CHATS_PROJECT_NAME, colorRank: 0 },
    ]);
    expect(report.models.find((model) => model.modelId === "claude-sonnet-4-5")?.colorRank).toBe(1);
    expect(report.models.find((model) => model.modelId === "opus")?.colorRank).toBeNull();
  });

  it("uses the window's buckets for all history", () => {
    const window = usageReportWindow(null, now, new Date(2026, 9, 16, 9));
    const all = buildUsageCostReport({ rows: [row({ bucket: "2026-10-16", inputTokens: 10, outputTokens: 1 })], table, pricing, rangeDays: null, now, window });
    expect(all.buckets).toEqual(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(all.previousBuckets).toEqual([]);
    expect(all.rows).toHaveLength(1);
  });
});
