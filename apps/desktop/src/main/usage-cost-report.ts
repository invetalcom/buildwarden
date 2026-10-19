import type {
  ModelPriceOverride,
  UsageCategoryCost,
  UsageCostReport,
  UsageDailyCostRow,
  UsageModelCostRow,
  UsagePricingInfo,
  UsageProjectCostRow,
  UsageTokenBreakdown,
} from "@buildwarden/shared";
import type { TokenUsageCostRow } from "@buildwarden/db";
import {
  cacheSavingsUsd,
  costByCategory,
  ratesPerMillion,
  resolveModelRate,
  sumCategoryCost,
  uncachedInputTokens,
  type RateTable,
  type ResolvedModelRate,
} from "./model-pricing";

export const STANDALONE_CHATS_PROJECT_NAME = "Standalone chats";

const emptyTokens = (): UsageTokenBreakdown => ({
  inputTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const emptyCost = (): UsageCategoryCost => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const addTokens = (target: UsageTokenBreakdown, source: UsageTokenBreakdown): void => {
  target.inputTokens += source.inputTokens;
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
};

const addCost = (target: UsageCategoryCost, source: UsageCategoryCost): void => {
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
};

const rowTokens = (row: TokenUsageCostRow): UsageTokenBreakdown => ({
  inputTokens: row.inputTokens,
  uncachedInputTokens: uncachedInputTokens(row),
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: row.reasoningTokens,
});

const totalTokenCount = (tokens: UsageTokenBreakdown): number => tokens.inputTokens + tokens.outputTokens;

/** Local calendar days from `startDay` through `endDay`, inclusive, as `YYYY-MM-DD`. */
const listDays = (startDay: string, endDay: string): string[] => {
  const days: string[] = [];
  const cursor = new Date(`${startDay}T00:00:00`);
  const end = new Date(`${endDay}T00:00:00`);
  while (cursor <= end && days.length < 3_660) {
    days.push(localDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

export const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Start of the local day `rangeDays - 1` days ago, so a range of 1 means "today". */
export const usageRangeStart = (rangeDays: number | null, now: Date): Date | null => {
  if (rangeDays === null) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (Math.max(1, Math.floor(rangeDays)) - 1));
  return start;
};

export interface BuildUsageCostReportInput {
  rows: readonly TokenUsageCostRow[];
  table: RateTable;
  overrides: Readonly<Record<string, ModelPriceOverride>>;
  pricing: UsagePricingInfo;
  rangeDays: number | null;
  now: Date;
}

export const buildUsageCostReport = (input: BuildUsageCostReportInput): UsageCostReport => {
  const { rows, table, overrides, pricing, rangeDays, now } = input;
  const since = usageRangeStart(rangeDays, now);
  const totals = {
    tokens: emptyTokens(),
    costUsd: 0,
    cost: emptyCost(),
    cacheSavingsUsd: 0,
    unpricedTokens: 0,
  };
  const unattributed = { inputTokens: 0, outputTokens: 0 };
  const models = new Map<string, UsageModelCostRow>();
  const resolvedRates = new Map<string, ResolvedModelRate | null>();
  const projects = new Map<string, UsageProjectCostRow>();
  const daily = new Map<string, UsageDailyCostRow>();

  for (const row of rows) {
    const day = daily.get(row.day) ?? { day: row.day, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    day.inputTokens += row.inputTokens;
    day.outputTokens += row.outputTokens;
    daily.set(row.day, day);

    if (!row.modelId) {
      // Recorded before provider/model attribution; the cache split is unknown, so it is not priced.
      unattributed.inputTokens += row.inputTokens;
      unattributed.outputTokens += row.outputTokens;
      continue;
    }

    const providerType = row.providerType ?? "unknown";
    const tokens = rowTokens(row);
    const modelKey = `${providerType}\u0000${row.modelId}`;
    let resolved = resolvedRates.get(modelKey);
    if (resolved === undefined) {
      resolved = resolveModelRate(table, overrides, providerType, row.modelId);
      resolvedRates.set(modelKey, resolved);
    }
    let model = models.get(modelKey);
    if (!model) {
      model = {
        providerType,
        modelId: row.modelId,
        tokens: emptyTokens(),
        costUsd: resolved ? 0 : null,
        cost: resolved ? emptyCost() : null,
        rates: resolved ? ratesPerMillion(resolved.rates) : null,
        priceSource: resolved?.source ?? null,
        matchedKey: resolved?.matchedKey ?? null,
        cacheSavingsUsd: 0,
      };
      models.set(modelKey, model);
    }
    addTokens(model.tokens, tokens);
    addTokens(totals.tokens, tokens);

    const projectKey = row.projectId ?? "";
    const project = projects.get(projectKey) ?? {
      projectId: row.projectId,
      name: row.projectId ? row.projectName ?? "Deleted project" : STANDALONE_CHATS_PROJECT_NAME,
      tokens: emptyTokens(),
      costUsd: 0,
      unpricedTokens: 0,
    };
    addTokens(project.tokens, tokens);
    projects.set(projectKey, project);

    if (!resolved || !model.cost || model.costUsd === null) {
      project.unpricedTokens += totalTokenCount(tokens);
      totals.unpricedTokens += totalTokenCount(tokens);
      continue;
    }
    const cost = costByCategory(row, resolved.rates);
    const costUsd = sumCategoryCost(cost);
    const savings = cacheSavingsUsd(row, resolved.rates);
    addCost(model.cost, cost);
    model.costUsd += costUsd;
    model.cacheSavingsUsd += savings;
    addCost(totals.cost, cost);
    totals.costUsd += costUsd;
    totals.cacheSavingsUsd += savings;
    project.costUsd += costUsd;
    day.costUsd += costUsd;
  }

  const firstDay = since ? localDayKey(since) : [...daily.keys()].sort()[0];
  const filledDaily = firstDay
    ? listDays(firstDay, localDayKey(now)).map((dayKey) => daily.get(dayKey) ?? { day: dayKey, costUsd: 0, inputTokens: 0, outputTokens: 0 })
    : [];

  const byCostThenTokens = <T extends { costUsd: number | null; tokens: UsageTokenBreakdown }>(a: T, b: T) =>
    (b.costUsd ?? -1) - (a.costUsd ?? -1) || totalTokenCount(b.tokens) - totalTokenCount(a.tokens);

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    since: since?.toISOString() ?? null,
    pricing,
    totals,
    models: [...models.values()].sort(byCostThenTokens),
    projects: [...projects.values()].sort(byCostThenTokens),
    daily: filledDaily,
    unattributed,
  };
};
