import type { ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  buildDailyRunActivity,
  buildProviderUsage,
  buildTodayActivity,
  countRunOutcomes,
  formatCompactNumber,
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
    expect(counts).toEqual({ completed: 2, failed: 1, active: 1, other: 1 });
    expect(successRate(counts)).toBeCloseTo(2 / 3);
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

  it("keeps small numbers exact and compacts large ones", () => {
    expect(formatCompactNumber(9_999)).toBe((9_999).toLocaleString());
    expect(formatCompactNumber(67_382_115)).not.toContain("67,382");
  });
});
