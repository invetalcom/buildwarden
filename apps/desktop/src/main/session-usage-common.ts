export type { LocalSessionUsageRecord as UsageRecord, UsageSpeed } from "@buildwarden/shared";
export type UsageTokenTotals = import("@buildwarden/shared").LocalSessionUsageRecord["totals"];

export const tokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

export const parseTimestampMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
