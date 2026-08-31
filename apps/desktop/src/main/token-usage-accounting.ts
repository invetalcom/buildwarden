import type { RunTokenUsage, TokenUsageTotals } from "@buildwarden/shared";

export interface ReportedTokenUsageAdvance {
  inputTokensDelta: number;
  outputTokensDelta: number;
  nextReportedUsage: TokenUsageTotals;
}

const finiteNonNegative = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

/**
 * Converts cumulative reports within one worker/provider session into durable deltas.
 * The owner totals are accepted to make the accounting boundary explicit; deltas are
 * intentionally based on the last provider report so a new worker turn starts at zero.
 */
export const advanceReportedTokenUsage = (
  _ownerUsage: TokenUsageTotals,
  lastReportedUsage: TokenUsageTotals,
  reportedUsage: Partial<RunTokenUsage>,
): ReportedTokenUsageAdvance => {
  const reportedInputTokens = finiteNonNegative(reportedUsage.inputTokens);
  const reportedOutputTokens = finiteNonNegative(reportedUsage.outputTokens);
  const previousInputTokens = finiteNonNegative(lastReportedUsage.inputTokens);
  const previousOutputTokens = finiteNonNegative(lastReportedUsage.outputTokens);
  return {
    inputTokensDelta: Math.max(0, reportedInputTokens - previousInputTokens),
    outputTokensDelta: Math.max(0, reportedOutputTokens - previousOutputTokens),
    nextReportedUsage: {
      inputTokens: Math.max(previousInputTokens, reportedInputTokens),
      outputTokens: Math.max(previousOutputTokens, reportedOutputTokens),
    },
  };
};
