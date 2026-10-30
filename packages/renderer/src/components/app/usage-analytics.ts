import type {
  ProviderType,
  UsageBucketSize,
  UsageCategoryCost,
  UsageCostReport,
  UsageModelRates,
  UsageReportRow,
  UsageTokenBreakdown,
} from "@buildwarden/shared";
import { PROVIDER_TYPE_LABELS } from "./provider-model-labels";

/**
 * Presentation-free analytics over a {@link UsageCostReport}, shared by the desktop dashboard and
 * the mobile usage screen. The host returns time-bucketed rows once per range; every filter,
 * breakdown, and comparison here is computed on the client so changing them is instant.
 */

export const USAGE_RANGE_OPTIONS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: "Today", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: null },
];

export type UsageBreakdown = "model" | "tokenType" | "project";
export type UsageMetric = "cost" | "tokens";

export const USAGE_BREAKDOWN_OPTIONS: ReadonlyArray<{ value: UsageBreakdown; label: string }> = [
  { value: "model", label: "Model" },
  { value: "tokenType", label: "Token type" },
  { value: "project", label: "Project" },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const formatUsd = (value: number): string => {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return value < 0 ? "−<$0.01" : "<$0.01";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Axis-friendly money: no cents once values reach whole dollars. */
export const formatUsdAxis = (value: number): string => {
  if (value === 0) return "$0";
  if (value < 1) return `$${Number(value.toFixed(2))}`;
  if (value < 1_000) return `$${Number(value.toFixed(value < 10 ? 1 : 0))}`;
  return `$${formatTokenCount(value)}`;
};

export const formatTokenCount = (value: number): string => {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(value < 10_000 ? 1 : 0))}K`;
  if (value < 1_000_000_000) return `${Number((value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1))}M`;
  return `${Number((value / 1_000_000_000).toFixed(2))}B`;
};

/** Per-million rates shown compactly, e.g. `$3`, `$0.3`, or `$0.075`. */
export const formatRate = (value: number): string => `$${Number(value.toFixed(value < 0.1 ? 3 : 2))}`;

export const formatPercent = (value: number): string =>
  `${Number((value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0))}%`;

/** Signed change versus the previous period, or `null` when there is nothing to compare against. */
export const usageDelta = (current: number, previous: number | null): number | null =>
  previous === null || previous === 0 ? null : (current - previous) / previous;

export const formatDelta = (delta: number): string =>
  `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${formatPercent(Math.abs(delta))}`;

export const providerTypeLabel = (providerType: string): string =>
  PROVIDER_TYPE_LABELS[providerType as ProviderType] ?? providerType;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Compact bucket label: `14:00` for hours, `Oct 20` for days and weeks (keyed by their Monday),
 * `Oct 2026` for months. `withYear` appends a short year to days and weeks, for axes that span years.
 */
export const formatUsageBucket = (bucket: string, bucketSize: UsageBucketSize, withYear = false): string => {
  if (bucketSize === "hour") return `${bucket.slice(11, 13)}:00`;
  const month = MONTHS[Number(bucket.slice(5, 7)) - 1] ?? bucket.slice(5, 7);
  if (bucketSize === "month") return `${month} ${bucket.slice(0, 4)}`;
  const label = `${month} ${Number(bucket.slice(8, 10))}`;
  return withYear ? `${label} '${bucket.slice(2, 4)}` : label;
};

/** Long-form bucket label for tooltips and tables. */
export const describeUsageBucket = (bucket: string, bucketSize: UsageBucketSize): string => {
  if (bucketSize === "hour") return `${formatUsageBucket(bucket, "day")}, ${bucket.slice(11, 13)}:00`;
  if (bucketSize === "month") return formatUsageBucket(bucket, "month");
  const day = `${formatUsageBucket(bucket, "day")}, ${bucket.slice(0, 4)}`;
  return bucketSize === "week" ? `Week of ${day}` : day;
};

/** Whether an axis spans more than one calendar year, so its labels need the year. */
export const usageBucketsSpanYears = (buckets: readonly string[]): boolean =>
  buckets.length > 1 && buckets[0]!.slice(0, 4) !== buckets.at(-1)!.slice(0, 4);

// ---------------------------------------------------------------------------
// Series identity and color
// ---------------------------------------------------------------------------

/** Categorical slots defined as `--usage-series-N` (validated palette); the tail folds into "Other". */
const USAGE_SERIES_SLOT_COUNT = 7;
const USAGE_OTHER_COLOR = "var(--usage-series-other)";
export const USAGE_UNATTRIBUTED_COLOR = "var(--usage-series-unattributed)";
export const usageSeriesColor = (slot: number): string => `var(--usage-series-${slot + 1})`;

const UNATTRIBUTED_MODEL_LABEL = "Before cost tracking";
export const OTHER_SERIES_KEY = "__other__";

export interface UsageModelEntry {
  key: string;
  index: number;
  providerType: string;
  modelId: string | null;
  label: string;
  rates: UsageModelRates | null;
  matchedKey: string | null;
  /** Categorical slot, or `null` when folded into "Other" (or unattributed usage). */
  slot: number | null;
  color: string;
}

export interface UsageProjectEntry {
  key: string;
  index: number;
  projectId: string | null;
  label: string;
  slot: number | null;
  color: string;
}

const usageModelKey = (model: { providerType: string; modelId: string | null }): string =>
  `${model.providerType}:${model.modelId ?? ""}`;

const usageProjectKey = (project: { projectId: string | null }): string => project.projectId ?? "standalone";

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface UsageTotals {
  tokens: UsageTokenBreakdown;
  /** Processed input plus output. */
  totalTokens: number;
  cost: UsageCategoryCost;
  costUsd: number;
  cacheSavingsUsd: number;
  /** Tokens of models without a known price (including pre-attribution usage). */
  unpricedTokens: number;
  /** Processed input recorded before attribution, which has no cache split. */
  unattributedInputTokens: number;
}

const emptyUsageTotals = (): UsageTotals => ({
  tokens: { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  costUsd: 0,
  cacheSavingsUsd: 0,
  unpricedTokens: 0,
  unattributedInputTokens: 0,
});

const rowCost = (row: UsageReportRow): number =>
  row.cost ? row.cost.input + row.cost.cacheRead + row.cost.cacheWrite + row.cost.output : 0;

const rowTokens = (row: UsageReportRow): number => row.tokens.inputTokens + row.tokens.outputTokens;

const addRow = (totals: UsageTotals, row: UsageReportRow, unattributed = false): void => {
  const { tokens } = totals;
  if (unattributed) totals.unattributedInputTokens += row.tokens.inputTokens;
  tokens.inputTokens += row.tokens.inputTokens;
  tokens.uncachedInputTokens += row.tokens.uncachedInputTokens;
  tokens.cacheReadTokens += row.tokens.cacheReadTokens;
  tokens.cacheWriteTokens += row.tokens.cacheWriteTokens;
  tokens.outputTokens += row.tokens.outputTokens;
  tokens.reasoningTokens += row.tokens.reasoningTokens;
  totals.totalTokens += rowTokens(row);
  totals.cacheSavingsUsd += row.cacheSavingsUsd;
  if (!row.cost) {
    totals.unpricedTokens += rowTokens(row);
    return;
  }
  totals.cost.input += row.cost.input;
  totals.cost.cacheRead += row.cost.cacheRead;
  totals.cost.cacheWrite += row.cost.cacheWrite;
  totals.cost.output += row.cost.output;
  totals.costUsd += rowCost(row);
};

const summarizeUsage = (
  rows: Iterable<UsageReportRow>,
  isUnattributed: (row: UsageReportRow) => boolean = () => false,
): UsageTotals => {
  const totals = emptyUsageTotals();
  for (const row of rows) addRow(totals, row, isUnattributed(row));
  return totals;
};

/** Share of processed input served from cache, over usage whose cache split is known. */
export const cacheHitRate = (totals: UsageTotals): number => {
  const input = totals.tokens.inputTokens - totals.unattributedInputTokens;
  return input > 0 ? totals.tokens.cacheReadTokens / input : 0;
};

/** Blended estimated cost per one million priced tokens. */
export const costPerMillionTokens = (totals: UsageTotals): number | null => {
  const pricedTokens = totals.totalTokens - totals.unpricedTokens;
  return pricedTokens > 0 ? (totals.costUsd / pricedTokens) * 1_000_000 : null;
};

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface UsageFilters {
  /** Model keys left out. Exclusion (rather than inclusion) keeps newly seen models visible. */
  excludedModels: ReadonlySet<string>;
  excludedProjects: ReadonlySet<string>;
}

const EMPTY_USAGE_FILTERS: UsageFilters = { excludedModels: new Set(), excludedProjects: new Set() };

export interface UsageBreakdownRow<Entry> {
  entry: Entry;
  totals: UsageTotals;
  /** Share of the filtered total cost (or tokens when nothing is priced). */
  share: number;
  excluded: boolean;
}

export interface UsageAnalytics {
  bucketSize: UsageBucketSize;
  buckets: string[];
  models: UsageModelEntry[];
  projects: UsageProjectEntry[];
  /** Filtered rows in the selected window. */
  rows: UsageReportRow[];
  current: UsageTotals;
  /** Same filters over the preceding window; `null` for all history. */
  previous: UsageTotals | null;
  modelRows: Array<UsageBreakdownRow<UsageModelEntry>>;
  projectRows: Array<UsageBreakdownRow<UsageProjectEntry>>;
}

/**
 * Gives the leading entities the categorical slots. Hosts send each entity's all-time rank, so a
 * model keeps its color in every period; older hosts fall back to ranking by this report's
 * unfiltered current-window cost. Filters never affect slots: color follows the entity.
 */
const assignSlots = <Item>(
  items: readonly Item[],
  weight: (item: Item) => [cost: number, tokens: number],
  eligible: (item: Item) => boolean,
  colorRank: (item: Item) => number | null | undefined,
): Map<Item, number | null> => {
  if (items.some((item) => eligible(item) && colorRank(item) !== undefined)) {
    return new Map(items.map((item) => {
      const rank = eligible(item) ? colorRank(item) : null;
      return [item, rank !== null && rank !== undefined && rank < USAGE_SERIES_SLOT_COUNT ? rank : null];
    }));
  }
  const ranked = items
    .filter(eligible)
    .map((item) => ({ item, weight: weight(item) }))
    .sort((a, b) => b.weight[0] - a.weight[0] || b.weight[1] - a.weight[1]);
  const slots = new Map<Item, number | null>(items.map((item) => [item, null]));
  ranked.slice(0, USAGE_SERIES_SLOT_COUNT).forEach(({ item }, index) => slots.set(item, index));
  return slots;
};

export const buildUsageAnalytics = (report: UsageCostReport, filters: UsageFilters = EMPTY_USAGE_FILTERS): UsageAnalytics => {
  const current = new Set(report.buckets);
  const previous = new Set(report.previousBuckets);
  const currentRows = report.rows.filter((row) => current.has(row.bucket));

  const modelWeight = report.models.map(() => [0, 0] as [number, number]);
  const projectWeight = report.projects.map(() => [0, 0] as [number, number]);
  for (const row of currentRows) {
    modelWeight[row.modelIndex]![0] += rowCost(row);
    modelWeight[row.modelIndex]![1] += rowTokens(row);
    projectWeight[row.projectIndex]![0] += rowCost(row);
    projectWeight[row.projectIndex]![1] += rowTokens(row);
  }

  const modelSlots = assignSlots(
    report.models.map((_, index) => index),
    (index) => modelWeight[index]!,
    (index) => report.models[index]!.modelId !== null,
    (index) => report.models[index]!.colorRank,
  );
  const models: UsageModelEntry[] = report.models.map((model, index) => {
    const slot = modelSlots.get(index) ?? null;
    let color = slot === null ? USAGE_OTHER_COLOR : usageSeriesColor(slot);
    if (model.modelId === null) color = USAGE_UNATTRIBUTED_COLOR;
    return {
      key: usageModelKey(model),
      index,
      providerType: model.providerType,
      modelId: model.modelId,
      label: model.modelId ?? UNATTRIBUTED_MODEL_LABEL,
      rates: model.rates,
      matchedKey: model.matchedKey,
      slot,
      color,
    };
  });
  const projectSlots = assignSlots(
    report.projects.map((_, index) => index),
    (index) => projectWeight[index]!,
    () => true,
    (index) => report.projects[index]!.colorRank,
  );
  const projects: UsageProjectEntry[] = report.projects.map((project, index) => {
    const slot = projectSlots.get(index) ?? null;
    return {
      key: usageProjectKey(project),
      index,
      projectId: project.projectId,
      label: project.name,
      slot,
      color: slot === null ? USAGE_OTHER_COLOR : usageSeriesColor(slot),
    };
  });

  const included = (row: UsageReportRow) =>
    !filters.excludedModels.has(models[row.modelIndex]!.key) && !filters.excludedProjects.has(projects[row.projectIndex]!.key);
  const unattributed = (row: UsageReportRow) => report.models[row.modelIndex]!.modelId === null;
  const rows = currentRows.filter(included);
  const currentTotals = summarizeUsage(rows, unattributed);
  const previousTotals = report.previousBuckets.length > 0
    ? summarizeUsage(report.rows.filter((row) => previous.has(row.bucket) && included(row)), unattributed)
    : null;

  // Breakdown rows respect the other dimension's filter, but list every entity of their own
  // dimension so an excluded one can be switched back on from the table.
  const modelTotals = models.map(() => emptyUsageTotals());
  const projectTotals = projects.map(() => emptyUsageTotals());
  for (const row of currentRows) {
    if (!filters.excludedProjects.has(projects[row.projectIndex]!.key)) addRow(modelTotals[row.modelIndex]!, row, unattributed(row));
    if (!filters.excludedModels.has(models[row.modelIndex]!.key)) addRow(projectTotals[row.projectIndex]!, row, unattributed(row));
  }
  const shareOf = (totals: UsageTotals) => {
    if (currentTotals.costUsd > 0) return totals.costUsd / currentTotals.costUsd;
    if (currentTotals.totalTokens > 0) return totals.totalTokens / currentTotals.totalTokens;
    return 0;
  };
  const byWeight = <Entry>(a: UsageBreakdownRow<Entry>, b: UsageBreakdownRow<Entry>) =>
    b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens;

  return {
    bucketSize: report.bucketSize,
    buckets: report.buckets,
    models,
    projects,
    rows,
    current: currentTotals,
    previous: previousTotals,
    modelRows: models
      .map((entry) => {
        const excluded = filters.excludedModels.has(entry.key);
        return { entry, totals: modelTotals[entry.index]!, share: excluded ? 0 : shareOf(modelTotals[entry.index]!), excluded };
      })
      .filter((row) => row.totals.totalTokens > 0)
      .sort(byWeight),
    projectRows: projects
      .map((entry) => {
        const excluded = filters.excludedProjects.has(entry.key);
        return { entry, totals: projectTotals[entry.index]!, share: excluded ? 0 : shareOf(projectTotals[entry.index]!), excluded };
      })
      .filter((row) => row.totals.totalTokens > 0)
      .sort(byWeight),
  };
};

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export interface UsageSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export interface UsageTimeSeries {
  buckets: string[];
  bucketSize: UsageBucketSize;
  /** Ordered bottom-to-top of the stack (largest first). */
  series: UsageSeries[];
}

const TOKEN_TYPE_SERIES: ReadonlyArray<{
  key: string;
  label: string;
  cost: (cost: UsageCategoryCost) => number;
  tokens: (tokens: UsageTokenBreakdown) => number;
}> = [
  { key: "input", label: "Input", cost: (cost) => cost.input, tokens: (tokens) => tokens.uncachedInputTokens },
  { key: "cacheRead", label: "Cache read", cost: (cost) => cost.cacheRead, tokens: (tokens) => tokens.cacheReadTokens },
  { key: "cacheWrite", label: "Cache write", cost: (cost) => cost.cacheWrite, tokens: (tokens) => tokens.cacheWriteTokens },
  { key: "output", label: "Output", cost: (cost) => cost.output, tokens: (tokens) => tokens.outputTokens },
];

export const buildUsageTimeSeries = (
  analytics: UsageAnalytics,
  breakdown: UsageBreakdown,
  metric: UsageMetric,
): UsageTimeSeries => {
  const bucketIndex = new Map(analytics.buckets.map((bucket, index) => [bucket, index]));
  const series = new Map<string, UsageSeries>();
  const seriesFor = (key: string, label: string, color: string): UsageSeries => {
    let entry = series.get(key);
    if (!entry) {
      entry = { key, label, color, values: analytics.buckets.map(() => 0) };
      series.set(key, entry);
    }
    return entry;
  };

  if (breakdown === "tokenType") {
    TOKEN_TYPE_SERIES.forEach((type, slot) => seriesFor(type.key, type.label, usageSeriesColor(slot)));
  }

  for (const row of analytics.rows) {
    const at = bucketIndex.get(row.bucket);
    if (at === undefined) continue;
    if (breakdown === "tokenType") {
      for (const type of TOKEN_TYPE_SERIES) {
        let value = type.tokens(row.tokens);
        if (metric === "cost") value = row.cost ? type.cost(row.cost) : 0;
        series.get(type.key)!.values[at] += value;
      }
      continue;
    }
    const value = metric === "cost" ? rowCost(row) : rowTokens(row);
    if (breakdown === "model") {
      const model = analytics.models[row.modelIndex]!;
      const target = model.modelId !== null && model.slot === null
        ? seriesFor(OTHER_SERIES_KEY, "Other models", USAGE_OTHER_COLOR)
        : seriesFor(model.key, model.label, model.color);
      target.values[at] += value;
    } else {
      const project = analytics.projects[row.projectIndex]!;
      const target = project.slot === null
        ? seriesFor(OTHER_SERIES_KEY, "Other projects", USAGE_OTHER_COLOR)
        : seriesFor(project.key, project.label, project.color);
      target.values[at] += value;
    }
  }

  const total = (entry: UsageSeries) => entry.values.reduce((sum, value) => sum + value, 0);
  const ordered = [...series.values()].filter((entry) => total(entry) > 0);
  if (breakdown !== "tokenType") {
    // Largest at the base; "Other" and pre-attribution usage always sit on top.
    const rank = (entry: UsageSeries) => {
      if (entry.key === OTHER_SERIES_KEY) return 1;
      return entry.color === USAGE_UNATTRIBUTED_COLOR ? 2 : 0;
    };
    ordered.sort((a, b) => rank(a) - rank(b) || total(b) - total(a));
  }
  return { buckets: analytics.buckets, bucketSize: analytics.bucketSize, series: ordered };
};
