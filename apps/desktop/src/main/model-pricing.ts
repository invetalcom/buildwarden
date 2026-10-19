import {
  normalizeModelPriceOverrideKey,
  type ModelPriceOverride,
  type UsageCategoryCost,
  type UsageModelRates,
  type UsagePriceSource,
} from "@buildwarden/shared";

/** USD per token for each billed category. */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type RateTable = ReadonlyMap<string, TokenRates>;

export interface ResolvedModelRate {
  rates: TokenRates;
  source: UsagePriceSource;
  matchedKey: string;
}

/** Token counts for one model, with input stored as processed input (cache reads and writes included). */
export interface PricedTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const finiteRate = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const normalizeRateKey = (model: string): string => model.trim().toLowerCase();

const bareModelName = (key: string): string => {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
};

const sameRates = (a: TokenRates, b: TokenRates): boolean =>
  a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/**
 * Parses LiteLLM's `model_prices_and_context_window.json`. Entries without both an input
 * and an output rate are dropped: a half-priced model would silently under-report cost.
 * Missing cache rates fall back to the input rate instead of being treated as free.
 * Provider-prefixed keys (`openrouter/...`) also register their bare model name when every
 * prefixed variant agrees on price.
 */
export const parseLiteLlmRateTable = (document: unknown): Map<string, TokenRates> => {
  const table = new Map<string, TokenRates>();
  if (!document || typeof document !== "object" || Array.isArray(document)) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const input = finiteRate(entry.input_cost_per_token);
    const output = finiteRate(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const key = normalizeRateKey(name);
    if (!key) continue;
    table.set(key, {
      input,
      output,
      cacheRead: finiteRate(entry.cache_read_input_token_cost) ?? input,
      cacheWrite: finiteRate(entry.cache_creation_input_token_cost) ?? input,
    });
  }

  const aliases = new Map<string, TokenRates | null>();
  for (const [key, rates] of table) {
    const alias = bareModelName(key);
    if (!alias || alias === key || table.has(alias)) continue;
    const held = aliases.get(alias);
    if (held === undefined) aliases.set(alias, rates);
    else if (held !== null && !sameRates(held, rates)) aliases.set(alias, null);
  }
  for (const [alias, rates] of aliases) {
    if (rates) table.set(alias, rates);
  }
  return table;
};

/**
 * Names that are ambiguous across model generations (`opus`) or not a real billed model
 * (`auto`, `default`, `<synthetic>`). They stay unpriced unless the user sets an override.
 */
const UNPRICEABLE_MODELS = new Set(["<synthetic>", "synthetic", "default", "auto", "opus", "sonnet", "haiku", "fable"]);

const PROVIDER_RATE_PREFIXES: Partial<Record<string, readonly string[]>> = {
  openrouter: ["openrouter/"],
  "azure-legacy": ["azure/"],
};

/** Strips a bracketed variant suffix such as `claude-sonnet-4-5[1m]`; the base tier is priced. */
const stripVariantSuffix = (key: string): string => {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
};

const rateLookupCandidates = (providerType: string, modelId: string): string[] => {
  const key = stripVariantSuffix(normalizeRateKey(modelId));
  const bare = bareModelName(key);
  const candidates = [
    ...(PROVIDER_RATE_PREFIXES[providerType] ?? []).map((prefix) => `${prefix}${key}`),
    key,
    bare,
    // Some catalogs write versions with dots (`claude-sonnet-4.5`) where LiteLLM uses hyphens.
    bare.replace(/(\d)\.(\d)/g, "$1-$2"),
  ];
  return [...new Set(candidates.filter(Boolean))];
};

export const overrideToTokenRates = (override: ModelPriceOverride): TokenRates => ({
  input: override.inputPerMillion / 1_000_000,
  output: override.outputPerMillion / 1_000_000,
  cacheRead: (override.cacheReadPerMillion ?? override.inputPerMillion) / 1_000_000,
  cacheWrite: (override.cacheWritePerMillion ?? override.inputPerMillion) / 1_000_000,
});

export const resolveModelRate = (
  table: RateTable,
  overrides: Readonly<Record<string, ModelPriceOverride>>,
  providerType: string,
  modelId: string,
): ResolvedModelRate | null => {
  const overrideKey = normalizeModelPriceOverrideKey(modelId);
  const override = overrides[overrideKey];
  if (override) return { rates: overrideToTokenRates(override), source: "override", matchedKey: overrideKey };

  const bare = bareModelName(stripVariantSuffix(normalizeRateKey(modelId)));
  if (!bare || UNPRICEABLE_MODELS.has(bare)) return null;
  for (const candidate of rateLookupCandidates(providerType, modelId)) {
    const rates = table.get(candidate);
    if (rates) return { rates, source: "litellm", matchedKey: candidate };
  }
  return null;
};

/**
 * Most providers report input including cache reads/writes. When the cache counts exceed the
 * reported input, the provider evidently reported uncached input only, so use it as-is.
 */
export const uncachedInputTokens = (tokens: PricedTokenCounts): number => {
  const cached = tokens.cacheReadTokens + tokens.cacheWriteTokens;
  return cached > tokens.inputTokens ? tokens.inputTokens : tokens.inputTokens - cached;
};

export const costByCategory = (tokens: PricedTokenCounts, rates: TokenRates): UsageCategoryCost => ({
  input: uncachedInputTokens(tokens) * rates.input,
  cacheRead: tokens.cacheReadTokens * rates.cacheRead,
  cacheWrite: tokens.cacheWriteTokens * rates.cacheWrite,
  output: tokens.outputTokens * rates.output,
});

export const sumCategoryCost = (cost: UsageCategoryCost): number =>
  cost.input + cost.cacheRead + cost.cacheWrite + cost.output;

/** What cached input would have cost at the uncached input rate, minus what it did cost. */
export const cacheSavingsUsd = (tokens: PricedTokenCounts, rates: TokenRates): number =>
  Math.max(0, tokens.cacheReadTokens * (rates.input - rates.cacheRead));

export const ratesPerMillion = (rates: TokenRates): UsageModelRates => ({
  inputPerMillion: rates.input * 1_000_000,
  outputPerMillion: rates.output * 1_000_000,
  cacheReadPerMillion: rates.cacheRead * 1_000_000,
  cacheWritePerMillion: rates.cacheWrite * 1_000_000,
});

/** Compact on-disk form of a rate table: `[input, output, cacheRead, cacheWrite]` USD per token. */
export type SerializedRateTable = Record<string, [number, number, number, number]>;

export const serializeRateTable = (table: RateTable): SerializedRateTable =>
  Object.fromEntries([...table].map(([key, rates]) => [key, [rates.input, rates.output, rates.cacheRead, rates.cacheWrite]]));

export const deserializeRateTable = (value: unknown): Map<string, TokenRates> => {
  const table = new Map<string, TokenRates>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return table;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw) || raw.length !== 4) continue;
    const [input, output, cacheRead, cacheWrite] = raw.map(finiteRate);
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue;
    table.set(key, { input, output, cacheRead, cacheWrite });
  }
  return table;
};
