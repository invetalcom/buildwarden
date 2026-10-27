import type { RunTokenUsage, TokenUsageAttribution, TokenUsageTotals } from "@buildwarden/shared";

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

/** Usage reported by one run/chat worker session, turned into durable deltas as reports arrive. */
export interface UsageReportTracker {
  reportedUsage: TokenUsageTotals & Partial<ReportedTokenUsage>;
  /** Provider/model the worker runs with; stored on each usage event for cost estimates. */
  attribution?: { providerType: string; modelId: string };
  /** Last cumulative report per concrete model, for providers that split usage by model. */
  reportedByModel?: Map<string, ReportedTokenUsage>;
}

export interface AttributedUsageDelta {
  inputTokensDelta: number;
  outputTokensDelta: number;
  attribution?: TokenUsageAttribution;
}

const attributedDelta = (
  advance: ReportedTokenUsageAdvance,
  attribution: UsageReportTracker["attribution"],
): AttributedUsageDelta => ({
  inputTokensDelta: advance.inputTokensDelta,
  outputTokensDelta: advance.outputTokensDelta,
  ...(attribution
    ? {
        attribution: {
          ...attribution,
          cacheReadTokens: advance.cacheReadTokensDelta,
          cacheWriteTokens: advance.cacheWriteTokensDelta,
          reasoningTokens: advance.reasoningTokensDelta,
        },
      }
    : {}),
});

/**
 * Advances a worker's tracker with a cumulative provider report and returns the deltas to record.
 * When the report carries a per-model breakdown, each concrete model gets its own delta and
 * attribution (so an alias like `sonnet` and its helper models are priced correctly); otherwise
 * the whole delta is attributed to the worker's configured model.
 */
export const advanceUsageTracker = (
  tracker: UsageReportTracker,
  reported: Partial<RunTokenUsage>,
): AttributedUsageDelta[] => {
  const aggregate = advanceReportedTokenUsage(tracker.reportedUsage, tracker.reportedUsage, reported);
  tracker.reportedUsage = aggregate.nextReportedUsage;
  const breakdown = Object.entries(reported.modelBreakdown ?? {});
  if (breakdown.length === 0 || !tracker.attribution) {
    return [attributedDelta(aggregate, tracker.attribution)];
  }
  const reportedByModel = tracker.reportedByModel ?? new Map<string, ReportedTokenUsage>();
  tracker.reportedByModel = reportedByModel;
  const { providerType } = tracker.attribution;
  return breakdown.map(([modelId, usage]) => {
    const previous = reportedByModel.get(modelId) ?? EMPTY_REPORTED_TOKEN_USAGE;
    const advance = advanceReportedTokenUsage(previous, previous, usage);
    reportedByModel.set(modelId, advance.nextReportedUsage);
    return attributedDelta(advance, { providerType, modelId });
  });
};

/**
 * Codex marks its session chunk with `usageBaseline: "fresh"` when a resume fell back to a
 * new thread. That thread's cumulative totals restart at zero, so a baseline carried over
 * from the previous thread would swallow new usage until the new totals exceeded it.
 */
export const startsFreshUsageBaseline = (metadata: Record<string, unknown> | undefined): boolean =>
  metadata?.usageBaseline === "fresh";
