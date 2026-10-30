import type {
  UsageBucketSize,
  UsageCostReport,
  UsagePricingInfo,
  UsageReportModel,
  UsageReportProject,
  UsageReportRow,
} from "@buildwarden/shared";
import type { TokenUsageCostRow } from "@buildwarden/db";
import {
  cacheSavingsUsd,
  costByCategory,
  ratesPerMillion,
  resolveModelRate,
  uncachedInputTokens,
  type RateTable,
  type ResolvedModelRate,
} from "./model-pricing";

export const STANDALONE_CHATS_PROJECT_NAME = "Standalone chats";

/** All history switches from daily to weekly bars past this many days, and to monthly past two years. */
const MAX_DAILY_SPAN_DAYS = 120;
const MAX_WEEKLY_SPAN_DAYS = 730;

const pad = (value: number): string => String(value).padStart(2, "0");

export const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const localHourKey = (date: Date): string => `${localDayKey(date)}T${pad(date.getHours())}`;

const localMonthKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

const startOfLocalDay = (date: Date): Date => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
};

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

/** Monday of the local week, matching SQLite's `date(x, '-6 days', 'weekday 1')`. */
const startOfLocalWeek = (date: Date): Date => addDays(startOfLocalDay(date), -((date.getDay() + 6) % 7));

const listDayKeys = (from: Date, through: Date): string[] => {
  const keys: string[] = [];
  for (let cursor = startOfLocalDay(from); cursor <= through && keys.length < 3_660; cursor = addDays(cursor, 1)) {
    keys.push(localDayKey(cursor));
  }
  return keys;
};

const listWeekKeys = (from: Date, through: Date): string[] => {
  const keys: string[] = [];
  for (let cursor = startOfLocalWeek(from); cursor <= through && keys.length < 1_000; cursor = addDays(cursor, 7)) {
    keys.push(localDayKey(cursor));
  }
  return keys;
};

const listMonthKeys = (from: Date, through: Date): string[] => {
  const keys: string[] = [];
  for (let cursor = new Date(from.getFullYear(), from.getMonth(), 1); cursor <= through && keys.length < 1_000; cursor.setMonth(cursor.getMonth() + 1)) {
    keys.push(localMonthKey(cursor));
  }
  return keys;
};

const listHourKeys = (from: Date, through: Date): string[] => {
  const keys: string[] = [];
  for (let cursor = new Date(from); cursor <= through && keys.length < 48; cursor.setHours(cursor.getHours() + 1)) {
    keys.push(localHourKey(cursor));
  }
  return keys;
};

export interface UsageReportWindow {
  bucketSize: UsageBucketSize;
  buckets: string[];
  previousBuckets: string[];
  /** Earliest instant to read: the start of the previous window, or `null` for all history. */
  since: Date | null;
  /**
   * Events between the end of the comparison window and the start of the current one. Skipping
   * them makes the comparison end at the same time of day as now, so a partly elapsed today is not
   * compared with a full day.
   */
  exclude: { from: Date; to: Date } | null;
}

/**
 * The selected window and the comparison window before it. A one-day range is today in hours
 * (through the current hour) compared with yesterday up to the same time; longer ranges are whole
 * local days ending now, compared with the same duration ending at the same time `rangeDays` ago.
 * All history has no comparison and picks day, week, or month buckets from its overall span.
 */
export const usageReportWindow = (rangeDays: number | null, now: Date, earliest: Date | null = null): UsageReportWindow => {
  const today = startOfLocalDay(now);
  if (rangeDays === null) {
    if (!earliest) return { bucketSize: "day", buckets: [], previousBuckets: [], since: null, exclude: null };
    const spanDays = Math.round((today.getTime() - startOfLocalDay(earliest).getTime()) / 86_400_000) + 1;
    const bucketSize: UsageBucketSize = spanDays <= MAX_DAILY_SPAN_DAYS ? "day" : spanDays <= MAX_WEEKLY_SPAN_DAYS ? "week" : "month";
    const buckets = bucketSize === "day"
      ? listDayKeys(earliest, now)
      : bucketSize === "week" ? listWeekKeys(earliest, now) : listMonthKeys(earliest, now);
    return { bucketSize, buckets, previousBuckets: [], since: null, exclude: null };
  }
  const days = Math.max(1, Math.floor(rangeDays));
  const comparisonEnd = addDays(now, -days);
  if (days === 1) {
    const yesterday = addDays(today, -1);
    return {
      bucketSize: "hour",
      buckets: listHourKeys(today, now),
      previousBuckets: listHourKeys(yesterday, comparisonEnd),
      since: yesterday,
      exclude: { from: comparisonEnd, to: today },
    };
  }
  const start = addDays(today, -(days - 1));
  const previousStart = addDays(start, -days);
  return {
    bucketSize: "day",
    buckets: listDayKeys(start, now),
    previousBuckets: listDayKeys(previousStart, comparisonEnd),
    since: previousStart,
    exclude: { from: comparisonEnd, to: start },
  };
};

interface UsageColorRanks {
  /** Attributed models ordered by all-time usage. */
  models: ReadonlyArray<{ providerType: string; modelId: string }>;
  /** Project ids (`null` for standalone chats) ordered by all-time usage. */
  projectIds: ReadonlyArray<string | null>;
}

export interface BuildUsageCostReportInput {
  rows: readonly TokenUsageCostRow[];
  table: RateTable;
  pricing: UsagePricingInfo;
  rangeDays: number | null;
  now: Date;
  window: UsageReportWindow;
  ranks?: UsageColorRanks;
}

const modelRankKey = (providerType: string, modelId: string | null): string => `${providerType}\u0000${modelId ?? ""}`;

export const buildUsageCostReport = (input: BuildUsageCostReportInput): UsageCostReport => {
  const { rows, table, pricing, rangeDays, now, window, ranks } = input;
  const inWindow = new Set([...window.buckets, ...window.previousBuckets]);
  const modelRanks = new Map((ranks?.models ?? []).map((model, index) => [modelRankKey(model.providerType, model.modelId), index]));
  const projectRanks = new Map((ranks?.projectIds ?? []).map((projectId, index) => [projectId ?? "", index]));

  const models: UsageReportModel[] = [];
  const modelIndexes = new Map<string, number>();
  const rates: Array<ResolvedModelRate | null> = [];
  const projects: UsageReportProject[] = [];
  const projectIndexes = new Map<string, number>();
  const reportRows: UsageReportRow[] = [];

  for (const row of rows) {
    if (!inWindow.has(row.bucket)) continue;
    const providerType = row.providerType ?? "unknown";
    const modelKey = modelRankKey(providerType, row.modelId);
    let modelIndex = modelIndexes.get(modelKey);
    if (modelIndex === undefined) {
      const resolved = row.modelId ? resolveModelRate(table, providerType, row.modelId) : null;
      modelIndex = models.length;
      modelIndexes.set(modelKey, modelIndex);
      rates.push(resolved);
      models.push({
        providerType,
        modelId: row.modelId,
        rates: resolved ? ratesPerMillion(resolved.rates) : null,
        matchedKey: resolved?.matchedKey ?? null,
        colorRank: row.modelId ? modelRanks.get(modelKey) ?? null : null,
      });
    }

    const projectKey = row.projectId ?? "";
    let projectIndex = projectIndexes.get(projectKey);
    if (projectIndex === undefined) {
      projectIndex = projects.length;
      projectIndexes.set(projectKey, projectIndex);
      projects.push({
        projectId: row.projectId,
        name: row.projectId ? row.projectName ?? "Deleted project" : STANDALONE_CHATS_PROJECT_NAME,
        colorRank: projectRanks.get(projectKey) ?? null,
      });
    }

    const resolved = rates[modelIndex] ?? null;
    reportRows.push({
      bucket: row.bucket,
      modelIndex,
      projectIndex,
      tokens: {
        inputTokens: row.inputTokens,
        uncachedInputTokens: uncachedInputTokens(row),
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
      },
      cost: resolved ? costByCategory(row, resolved.rates) : null,
      cacheSavingsUsd: resolved ? cacheSavingsUsd(row, resolved.rates) : 0,
    });
  }

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    bucketSize: window.bucketSize,
    buckets: window.buckets,
    previousBuckets: window.previousBuckets,
    pricing,
    models,
    projects,
    rows: reportRows,
  };
};
