import { describe, expect, it } from "vitest";
import type { TokenUsageCostRow } from "@buildwarden/db";
import type { UsagePricingInfo } from "@buildwarden/shared";
import { parseLiteLlmRateTable } from "./model-pricing";
import { buildUsageCostReport, localDayKey, STANDALONE_CHATS_PROJECT_NAME, usageRangeStart } from "./usage-cost-report";

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
  day: "2026-10-19",
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

describe("buildUsageCostReport", () => {
  const report = buildUsageCostReport({
    rows: [
      row({ day: "2026-10-18", inputTokens: 1_100_000, outputTokens: 100_000, cacheReadTokens: 900_000, cacheWriteTokens: 100_000 }),
      row({ projectId: null, projectName: null, providerType: "codex-cli", modelId: "gpt-5", inputTokens: 2_000_000, outputTokens: 50_000, cacheReadTokens: 1_600_000 }),
      row({ modelId: "opus", inputTokens: 10_000, outputTokens: 1_000 }),
      row({ day: "2026-10-17", providerType: null, modelId: null, inputTokens: 5_000, outputTokens: 500 }),
    ],
    table,
    overrides: {},
    pricing,
    rangeDays: 7,
    now,
  });

  it("prices each model by token category and totals the estimate", () => {
    const sonnet = report.models.find((model) => model.modelId === "claude-sonnet-4-5");
    expect(sonnet?.costUsd).toBeCloseTo(2.445);
    expect(sonnet?.rates).toEqual({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 });
    const gpt = report.models.find((model) => model.modelId === "gpt-5");
    // 400K uncached * $1.25 + 1.6M cached * $0.125 + 50K output * $10
    expect(gpt?.costUsd).toBeCloseTo(0.5 + 0.2 + 0.5);
    expect(report.totals.costUsd).toBeCloseTo(2.445 + 1.2);
    expect(report.totals.cacheSavingsUsd).toBeCloseTo(2.43 + 1.8);
  });

  it("keeps unpriced and pre-attribution usage visible without pricing it", () => {
    const opus = report.models.find((model) => model.modelId === "opus");
    expect(opus).toMatchObject({ costUsd: null, cost: null, priceSource: null });
    expect(report.totals.unpricedTokens).toBe(11_000);
    expect(report.unattributed).toEqual({ inputTokens: 5_000, outputTokens: 500 });
    expect(report.models.some((model) => model.modelId === null)).toBe(false);
  });

  it("groups cost by project with standalone chats on their own", () => {
    expect(report.projects.map((project) => [project.name, Number(project.costUsd.toFixed(3)), project.unpricedTokens])).toEqual([
      ["Alpha", 2.445, 11_000],
      [STANDALONE_CHATS_PROJECT_NAME, 1.2, 0],
    ]);
  });

  it("fills every day of the range, including days without usage", () => {
    expect(report.daily).toHaveLength(7);
    expect(report.daily[0]?.day).toBe("2026-10-13");
    expect(report.daily.at(-1)).toMatchObject({ day: "2026-10-19" });
    expect(report.daily.find((day) => day.day === "2026-10-18")?.costUsd).toBeCloseTo(2.445);
    expect(report.daily.find((day) => day.day === "2026-10-17")).toMatchObject({ costUsd: 0, inputTokens: 5_000 });
  });

  it("uses overrides for models without a public price", () => {
    const withOverride = buildUsageCostReport({
      rows: [row({ modelId: "opus", inputTokens: 1_000_000, outputTokens: 0 })],
      table,
      overrides: { opus: { inputPerMillion: 5, outputPerMillion: 25 } },
      pricing,
      rangeDays: 1,
      now,
    });
    expect(withOverride.models[0]).toMatchObject({ costUsd: 5, priceSource: "override" });
    expect(withOverride.totals.unpricedTokens).toBe(0);
  });
});

describe("usage ranges", () => {
  it("starts a one-day range at local midnight today and returns null for all history", () => {
    expect(localDayKey(usageRangeStart(1, now) as Date)).toBe("2026-10-19");
    expect(localDayKey(usageRangeStart(30, now) as Date)).toBe("2026-09-20");
    expect(usageRangeStart(null, now)).toBeNull();
  });

  it("starts an all-history chart at the first recorded day", () => {
    const report = buildUsageCostReport({
      rows: [row({ day: "2026-10-16", inputTokens: 10, outputTokens: 1 })],
      table,
      overrides: {},
      pricing,
      rangeDays: null,
      now,
    });
    expect(report.daily.map((day) => day.day)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
  });
});
