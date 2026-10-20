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

const pad = (value: number): string => String(value).padStart(2, "0");

export const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const localHourKey = (date: Date): string => `${localDayKey(date)}T${pad(date.getHours())}`;

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

const listDayKeys = (from: Date, through: Date): string[] => {
  const keys: string[] = [];
  for (let cursor = startOfLocalDay(from); cursor <= through && keys.length < 3_660; cursor = addDays(cursor, 1)) {
    keys.push(localDayKey(cursor));
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
}

/**
 * The selected window and the equally long window before it. A one-day range is today in hours
 * (through the current hour) compared with all of yesterday; longer ranges are whole local days
 * ending today. All history has no previous window.
 */
export const usageReportWindow = (rangeDays: number | null, now: Date): UsageReportWindow => {
  const today = startOfLocalDay(now);
  if (rangeDays === null) return { bucketSize: "day", buckets: [], previousBuckets: [], since: null };
  const days = Math.max(1, Math.floor(rangeDays));
  if (days === 1) {
    const yesterday = addDays(today, -1);
    return {
      bucketSize: "hour",
      buckets: listHourKeys(today, now),
      previousBuckets: listHourKeys(yesterday, new Date(today.getTime() - 1)),
      since: yesterday,
    };
  }
  const start = addDays(today, -(days - 1));
  const previousStart = addDays(start, -days);
  return {
    bucketSize: "day",
    buckets: listDayKeys(start, today),
    previousBuckets: listDayKeys(previousStart, addDays(start, -1)),
    since: previousStart,
  };
};

export interface BuildUsageCostReportInput {
  rows: readonly TokenUsageCostRow[];
  table: RateTable;
  pricing: UsagePricingInfo;
  rangeDays: number | null;
  now: Date;
}

export const buildUsageCostReport = (input: BuildUsageCostReportInput): UsageCostReport => {
  const { rows, table, pricing, rangeDays, now } = input;
  const window = usageReportWindow(rangeDays, now);
  // All history has no fixed start, so its axis begins at the first recorded day.
  const buckets = rangeDays === null
    ? (rows.length > 0 ? listDayKeys(new Date(`${[...rows].map((row) => row.bucket).sort()[0]}T00:00:00`), now) : [])
    : window.buckets;
  const inWindow = new Set([...buckets, ...window.previousBuckets]);

  const models: UsageReportModel[] = [];
  const modelIndexes = new Map<string, number>();
  const rates: Array<ResolvedModelRate | null> = [];
  const projects: UsageReportProject[] = [];
  const projectIndexes = new Map<string, number>();
  const reportRows: UsageReportRow[] = [];

  for (const row of rows) {
    if (!inWindow.has(row.bucket)) continue;
    const providerType = row.providerType ?? "unknown";
    const modelKey = `${providerType}\u0000${row.modelId ?? ""}`;
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
    buckets,
    previousBuckets: window.previousBuckets,
    pricing,
    models,
    projects,
    rows: reportRows,
  };
};
