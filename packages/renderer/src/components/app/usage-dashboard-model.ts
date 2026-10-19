import type { ModelPriceOverride, ProviderType, UsageCategoryCost, UsageModelCostRow } from "@buildwarden/shared";
import { PROVIDER_TYPE_LABELS } from "./provider-model-labels";

export const USAGE_RANGE_OPTIONS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: "Today", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: null },
];

export const formatUsd = (value: number): string => {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return "<$0.01";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatTokenCount = (value: number): string => {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
};

/** Per-million rates shown compactly, e.g. `$3`, `$0.3`, or `$0.075`. */
export const formatRate = (value: number): string => `$${Number(value.toFixed(value < 0.1 ? 3 : 2))}`;

export const providerTypeLabel = (providerType: string): string =>
  PROVIDER_TYPE_LABELS[providerType as ProviderType] ?? providerType;

export const COST_CATEGORIES: ReadonlyArray<{ key: keyof UsageCategoryCost; label: string; colorVar: string }> = [
  { key: "input", label: "Input", colorVar: "var(--ec-accent)" },
  { key: "cacheRead", label: "Cache read", colorVar: "var(--ec-success)" },
  { key: "cacheWrite", label: "Cache write", colorVar: "var(--ec-warning)" },
  { key: "output", label: "Output", colorVar: "var(--ec-danger)" },
];

export interface PriceOverrideDraft {
  inputPerMillion: string;
  outputPerMillion: string;
  cacheReadPerMillion: string;
  cacheWritePerMillion: string;
}

const formatDraftRate = (value: number | undefined): string => value === undefined ? "" : String(Number(value.toPrecision(6)));

export const priceOverrideDraftFor = (row: UsageModelCostRow, override: ModelPriceOverride | undefined): PriceOverrideDraft => ({
  inputPerMillion: formatDraftRate(override?.inputPerMillion ?? row.rates?.inputPerMillion),
  outputPerMillion: formatDraftRate(override?.outputPerMillion ?? row.rates?.outputPerMillion),
  cacheReadPerMillion: formatDraftRate(override ? override.cacheReadPerMillion : row.rates?.cacheReadPerMillion),
  cacheWritePerMillion: formatDraftRate(override ? override.cacheWritePerMillion : row.rates?.cacheWritePerMillion),
});

/** Returns the override, or an error message when a rate is missing or not a non-negative number. */
export const parsePriceOverrideDraft = (draft: PriceOverrideDraft): ModelPriceOverride | string => {
  const parse = (value: string, label: string, required: boolean): number | undefined | string => {
    const trimmed = value.trim();
    if (!trimmed) return required ? `${label} is required.` : undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : `${label} must be a number of at least 0.`;
  };
  const input = parse(draft.inputPerMillion, "Input rate", true);
  const output = parse(draft.outputPerMillion, "Output rate", true);
  const cacheRead = parse(draft.cacheReadPerMillion, "Cache read rate", false);
  const cacheWrite = parse(draft.cacheWritePerMillion, "Cache write rate", false);
  for (const value of [input, output, cacheRead, cacheWrite]) {
    if (typeof value === "string") return value;
  }
  return {
    inputPerMillion: input as number,
    outputPerMillion: output as number,
    ...(cacheRead !== undefined ? { cacheReadPerMillion: cacheRead as number } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerMillion: cacheWrite as number } : {}),
  };
};
