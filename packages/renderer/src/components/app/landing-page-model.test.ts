import type { ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  buildDailyRunActivity,
  buildHomeChartDays,
  buildHomeSummary,
  buildProviderUsage,
  buildTodayActivity,
  countRunOutcomes,
  formatCompactNumber,
  homeGreeting,
  successRate,
} from "./landing-page-model";

const now = new Date(2026, 9, 5, 15, 0);

const run = (overrides: Partial<RunRecord>): RunRecord => ({
  id: "run",
  projectId: "project-1",
  providerAccountId: "account-1",
  modelId: "model-1",
  harnessType: "codex-cli",
  status: "completed",
  inputTokens: 10,
  outputTokens: 5,
  createdAt: now.toISOString(),
  ...overrides,
} as RunRecord);

describe("landing page model", () => {
  it("groups display statuses into outcomes and derives a success rate from finished runs", () => {
    const counts = countRunOutcomes([
      run({ status: "completed" }),
      run({ status: "failed" }),
      run({ status: "running" }),
      run({ status: "cancelled" }),
      run({ status: "running", orchestrationStatus: "completed" }),
    ]);
    expect(counts).toEqual({ completed: 1, failed: 1, active: 2, other: 1 });
    expect(successRate(counts)).toBeCloseTo(1 / 2);
    expect(successRate({ completed: 0, failed: 0, active: 3, other: 0 })).toBeNull();
  });

  it("buckets runs into local days, oldest first, and ignores runs outside the window", () => {
    const yesterday = new Date(2026, 9, 4, 23, 30).toISOString();
    const days = buildDailyRunActivity([
      run({ id: "a", createdAt: now.toISOString() }),
      run({ id: "b", createdAt: yesterday, status: "failed", inputTokens: 100, outputTokens: 0 }),
      run({ id: "c", createdAt: new Date(2026, 8, 1).toISOString() }),
    ], 3, now);
    expect(days.map((day) => day.total)).toEqual([0, 1, 1]);
    expect(days[1]).toMatchObject({ failed: 1, tokens: 100 });
    expect(days[2]).toMatchObject({ completed: 1, tokens: 15 });
  });

  it("prefers the token ledger for today's usage", () => {
    const activity = buildTodayActivity([run({ status: "failed" })], { inputTokens: 40, outputTokens: 2 }, now);
    expect(activity).toMatchObject({ runsStarted: 1, failedRuns: 1, tokensUsed: 42 });
  });

  it("ranks provider accounts by run count and labels removed accounts", () => {
    const accounts: ProviderAccountRecord[] = [{
      id: "account-1", providerType: "codex-cli", label: "OpenAI", apiBaseUrl: null, apiKeyRef: "", configJson: "{}", createdAt: "", updatedAt: "",
    }];
    const usage = buildProviderUsage([
      run({ providerAccountId: "gone" }),
      run({ providerAccountId: "account-1" }),
      run({ providerAccountId: "account-1" }),
    ], accounts);
    expect(usage.map((entry) => [entry.label, entry.runs, entry.tokens])).toEqual([
      ["OpenAI", 2, 30],
      ["Removed provider", 1, 15],
    ]);
  });

  it("takes chart tokens from the runs while no usage report is given, and leaves cost unknown", () => {
    const days = buildHomeChartDays([
      run({ createdAt: new Date(2026, 9, 4, 9).toISOString(), status: "failed", inputTokens: 90, outputTokens: 10 }),
      run({}),
    ], 2, null, now);
    expect(days.map((day) => [day.runs, day.failedRuns, day.tokens, day.cost])).toEqual([[1, 1, 100, null], [1, 0, 15, null]]);
  });

  it("takes chart tokens and cost from the usage report, so both lanes describe the same usage", () => {
    const usage = new Map([["2026-10-05", { costUsd: 1.25, tokens: 4_000 }]]);
    const days = buildHomeChartDays([run({})], 2, usage, now);
    // A day the report has nothing for counts as zero, not as unknown.
    expect(days.map((day) => [day.runs, day.tokens, day.cost])).toEqual([[0, 0, 0], [1, 4_000, 1.25]]);
  });

  it("greets by the time of day", () => {
    expect(homeGreeting(new Date(2026, 9, 5, 8))).toBe("Good morning");
    expect(homeGreeting(new Date(2026, 9, 5, 14))).toBe("Good afternoon");
    expect(homeGreeting(new Date(2026, 9, 5, 22))).toBe("Good evening");
    expect(homeGreeting(new Date(2026, 9, 5, 3))).toBe("Good evening");
  });

  it("sums up the day in a sentence and adds what is waiting when that is known", () => {
    const today = { runsStarted: 5, completedRuns: 5, failedRuns: 0 };
    expect(buildHomeSummary({ activeRuns: 0, today, waiting: 0 })).toBe("5 runs finished today and none failed. Nothing is waiting for you.");
    expect(buildHomeSummary({ activeRuns: 0, today: { runsStarted: 3, completedRuns: 2, failedRuns: 1 }, waiting: 2 }))
      .toBe("3 runs finished today, 1 failed. 2 requests are waiting for you.");
    expect(buildHomeSummary({ activeRuns: 1, today, waiting: 1 })).toBe("1 run is working. 1 request is waiting for you.");
    expect(buildHomeSummary({ activeRuns: 0, today: { runsStarted: 0, completedRuns: 0, failedRuns: 0 }, waiting: null })).toBe("No runs yet today.");
    expect(buildHomeSummary({ activeRuns: 0, today: { runsStarted: 2, completedRuns: 0, failedRuns: 0 }, waiting: null })).toBe("2 runs started today.");
  });

  it("keeps small numbers exact and compacts large ones", () => {
    expect(formatCompactNumber(9_999)).toBe((9_999).toLocaleString());
    expect(formatCompactNumber(67_382_115)).not.toContain("67,382");
  });
});
