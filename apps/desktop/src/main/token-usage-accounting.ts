import type { RunTokenUsage, TokenUsageTotals } from "@buildwarden/shared";

/** Cumulative counters last reported by one worker/provider session. */
export interface ReportedTokenUsage extends TokenUsageTotals {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface ReportedTokenUsageAdvance {
  inputTokensDelta: number;
  outputTokensDelta: number;
  cacheReadTokensDelta: number;
  cacheWriteTokensDelta: number;
  reasoningTokensDelta: number;
  nextReportedUsage: ReportedTokenUsage;
}

export const EMPTY_REPORTED_TOKEN_USAGE: ReportedTokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

const finiteNonNegative = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

/** Reads a cumulative provider report into tracker counters. */
export const readReportedTokenUsage = (usage: Partial<RunTokenUsage>): ReportedTokenUsage => ({
  inputTokens: finiteNonNegative(usage.inputTokens),
  outputTokens: finiteNonNegative(usage.outputTokens),
  cacheReadTokens: finiteNonNegative(usage.cachedInputTokens),
  cacheWriteTokens: finiteNonNegative(usage.cacheCreationInputTokens),
  reasoningTokens: finiteNonNegative(usage.reasoningTokens),
});

/**
 * Converts cumulative reports within one worker/provider session into durable deltas.
 * The owner totals are accepted to make the accounting boundary explicit; deltas are
 * intentionally based on the last provider report so a new worker turn starts at zero.
 */
export const advanceReportedTokenUsage = (
  _ownerUsage: TokenUsageTotals,
  lastReportedUsage: Partial<ReportedTokenUsage>,
  reportedUsage: Partial<RunTokenUsage>,
): ReportedTokenUsageAdvance => {
  const reported = readReportedTokenUsage(reportedUsage);
  const previous: ReportedTokenUsage = {
    inputTokens: finiteNonNegative(lastReportedUsage.inputTokens),
    outputTokens: finiteNonNegative(lastReportedUsage.outputTokens),
    cacheReadTokens: finiteNonNegative(lastReportedUsage.cacheReadTokens),
    cacheWriteTokens: finiteNonNegative(lastReportedUsage.cacheWriteTokens),
    reasoningTokens: finiteNonNegative(lastReportedUsage.reasoningTokens),
  };
  const delta = (key: keyof ReportedTokenUsage) => Math.max(0, reported[key] - previous[key]);
  const next = (key: keyof ReportedTokenUsage) => Math.max(previous[key], reported[key]);
  return {
    inputTokensDelta: delta("inputTokens"),
    outputTokensDelta: delta("outputTokens"),
    cacheReadTokensDelta: delta("cacheReadTokens"),
    cacheWriteTokensDelta: delta("cacheWriteTokens"),
    reasoningTokensDelta: delta("reasoningTokens"),
    nextReportedUsage: {
      inputTokens: next("inputTokens"),
      outputTokens: next("outputTokens"),
      cacheReadTokens: next("cacheReadTokens"),
      cacheWriteTokens: next("cacheWriteTokens"),
      reasoningTokens: next("reasoningTokens"),
    },
  };
};

/**
 * Codex marks its session chunk with `usageBaseline: "fresh"` when a resume fell back to a
 * new thread. That thread's cumulative totals restart at zero, so a baseline carried over
 * from the previous thread would swallow new usage until the new totals exceeded it.
 */
export const startsFreshUsageBaseline = (metadata: Record<string, unknown> | undefined): boolean =>
  metadata?.usageBaseline === "fresh";
