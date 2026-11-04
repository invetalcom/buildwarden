import type { UsageCategoryCost, UsageModelRates, UsageSpeed } from "@buildwarden/shared";

/** USD per token for each billed category. */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  fast?: TokenRates;
  ultrafast?: TokenRates;
}

export type RateTable = ReadonlyMap<string, TokenRates>;

export interface ResolvedModelRate {
  rates: TokenRates;
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

/** Same priority/ultrafast fields and Claude fast multiplier used by T3 Code. */
const speedRates = (entry: Record<string, unknown>, standard: TokenRates, suffix: string): TokenRates | undefined => {
  const input = finiteRate(entry[`input_cost_per_token${suffix}`]);
  const output = finiteRate(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return undefined;
  const cacheRate = (key: string, fallback: number) => finiteRate(entry[`${key}${suffix}`]) ?? (standard.input > 0 ? fallback / standard.input * input : input);
  return { input, output, cacheRead: cacheRate("cache_read_input_token_cost", standard.cacheRead), cacheWrite: cacheRate("cache_creation_input_token_cost", standard.cacheWrite) };
};

export const ratesAtSpeed = (rates: TokenRates, speed: UsageSpeed = "standard"): TokenRates =>
  (speed === "standard" ? undefined : rates[speed]) ?? rates;

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
    const rates: TokenRates = {
      input,
      output,
      cacheRead: finiteRate(entry.cache_read_input_token_cost) ?? input,
      cacheWrite: finiteRate(entry.cache_creation_input_token_cost) ?? input,
    };
    const specific = entry.provider_specific_entry;
    const multiple = finiteRate(specific && typeof specific === "object" ? (specific as Record<string, unknown>).fast : undefined);
    const fast = multiple !== null && multiple > 0 ? {
      input: rates.input * multiple, output: rates.output * multiple, cacheRead: rates.cacheRead * multiple, cacheWrite: rates.cacheWrite * multiple,
    } : speedRates(entry, rates, "_priority");
    const ultrafast = speedRates(entry, rates, "_ultrafast");
    table.set(key, { ...rates, ...(fast ? { fast } : {}), ...(ultrafast ? { ultrafast } : {}) });
  }

  const aliases = new Map<string, TokenRates | null>();
  for (const [key, rates] of table) {
    const alias = bareModelName(key);
    if (!alias || alias === key || table.has(alias)) continue;
    const held = aliases.get(alias);
    if (held === undefined) aliases.set(alias, rates);
    else if (held !== null) {
      if (!sameRates(held, rates) || (held.fast && rates.fast && !sameRates(held.fast, rates.fast)) || (held.ultrafast && rates.ultrafast && !sameRates(held.ultrafast, rates.ultrafast))) aliases.set(alias, null);
      else aliases.set(alias, { ...held, ...(held.fast || rates.fast ? { fast: held.fast ?? rates.fast } : {}), ...(held.ultrafast || rates.ultrafast ? { ultrafast: held.ultrafast ?? rates.ultrafast } : {}) });
    }
  }
  for (const [alias, rates] of aliases) {
    if (rates) table.set(alias, rates);
  }
  return table;
};

/**
 * Names that are ambiguous across model generations (`opus`) or not a real billed model
 * (`auto`, `default`, `<synthetic>`). They stay unpriced rather than guessing a generation.
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
  // Cursor appends effort/thinking/fast settings to billed model identifiers.
  const cursorBase = bare.replace(/^cursor-/, "").replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  const cursorNames = [bare.replace(/^cursor-/, ""), cursorBase];
  const candidates = [
    ...(providerType === "cursor-agent" ? cursorNames.flatMap((name) => [
      `cursor/${name}`, `cursor/${name.replace(/(\d)-(\d)/g, "$1.$2")}`,
    ]) : []),
    ...(PROVIDER_RATE_PREFIXES[providerType] ?? []).map((prefix) => `${prefix}${key}`),
    key,
    bare,
    // Some catalogs write versions with dots (`claude-sonnet-4.5`) where LiteLLM uses hyphens.
    bare.replace(/(\d)\.(\d)/g, "$1-$2"),
    ...(providerType === "cursor-agent" ? [cursorBase.startsWith("grok-") ? `xai/${cursorBase}` : cursorBase, cursorBase.replace(/(\d)\.(\d)/g, "$1-$2")] : []),
  ];
  return [...new Set(candidates.filter(Boolean))];
};

export const resolveModelRate = (table: RateTable, providerType: string, modelId: string): ResolvedModelRate | null => {
  const bare = bareModelName(stripVariantSuffix(normalizeRateKey(modelId)));
  if (!bare || UNPRICEABLE_MODELS.has(bare)) return null;
  for (const candidate of rateLookupCandidates(providerType, modelId)) {
    const rates = table.get(candidate);
    if (rates) return { rates, matchedKey: candidate };
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
  cost.input + cost.cacheRead + cost.cacheWrite + cost.output + (cost.other ?? 0);

/** T3 Code uses reported totals and list-price proportions, falling back to an unsplit cost. */
export const priceReportedUsage = (
  tokens: PricedTokenCounts, rates: TokenRates | undefined, reportedCostUsd: number | null | undefined,
): UsageCategoryCost | null => {
  const list = rates ? costByCategory(tokens, rates) : null;
  if (reportedCostUsd === null || reportedCostUsd === undefined || !Number.isFinite(reportedCostUsd) || reportedCostUsd < 0) return list;
  const total = list ? sumCategoryCost(list) : 0;
  if (!list || total <= 0) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: reportedCostUsd };
  const scale = reportedCostUsd / total;
  return { input: list.input * scale, cacheRead: list.cacheRead * scale, cacheWrite: list.cacheWrite * scale, output: list.output * scale };
};

/** Cursor publishes a machine-readable Markdown table with USD prices per million tokens. */
export const parseCursorRateTable = (markdown: string): Map<string, TokenRates> => {
  const table = new Map<string, TokenRates>();
  let columns: string[] = [];
  const clean = (text: string): string => text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) { columns = []; continue; }
    const cells = line.trim().split("|").slice(1, -1).map(clean);
    const lower = cells.map((cell) => cell.toLowerCase());
    if (lower.includes("input") && lower.includes("output") && (lower.includes("model") || lower.includes("name"))) {
      columns = lower;
      continue;
    }
    if (columns.length === 0) continue;
    const cell = (name: string) => cells[columns.indexOf(name)] ?? "";
    const price = (name: string): number | null => {
      const value = cell(name);
      return /^\$\d+(?:\.\d+)?$/.test(value) ? Number(value.slice(1)) / 1_000_000 : null;
    };
    const input = price("input");
    const output = price("output");
    const name = cell("model") || cell("name");
    if (input === null || output === null || !name) continue;
    const key = name.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, "-");
    table.set(`cursor/${key}`, { input, output, cacheRead: price("cache read") ?? input, cacheWrite: price("cache write") ?? input });
  }
  return table;
};

/**
 * Net effect of prompt caching: what cache reads saved against the uncached input rate, minus the
 * premium paid to write the cache (Anthropic bills writes above the input rate). Negative when a
 * cache was written but barely reused.
 */
export const cacheSavingsUsd = (tokens: PricedTokenCounts, rates: TokenRates): number =>
  tokens.cacheReadTokens * (rates.input - rates.cacheRead) - tokens.cacheWriteTokens * (rates.cacheWrite - rates.input);

export const ratesPerMillion = (rates: TokenRates): UsageModelRates => ({
  inputPerMillion: rates.input * 1_000_000,
  outputPerMillion: rates.output * 1_000_000,
  cacheReadPerMillion: rates.cacheRead * 1_000_000,
  cacheWritePerMillion: rates.cacheWrite * 1_000_000,
});

/** Compact on-disk form of a rate table: `[input, output, cacheRead, cacheWrite]` USD per token. */
type SerializedTokenRates = [number, number, number, number];
export type SerializedRateTable = Record<string, [...SerializedTokenRates, (SerializedTokenRates | null)?, (SerializedTokenRates | null)?]>;

const serializeRates = (rates: TokenRates): SerializedTokenRates => [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];

export const serializeRateTable = (table: RateTable): SerializedRateTable =>
  Object.fromEntries([...table].map(([key, rates]) => [key, rates.fast || rates.ultrafast
    ? [...serializeRates(rates), rates.fast ? serializeRates(rates.fast) : null, rates.ultrafast ? serializeRates(rates.ultrafast) : null]
    : serializeRates(rates)]));

const deserializeRates = (raw: unknown): TokenRates | undefined => {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const [input, output, cacheRead, cacheWrite] = raw.map(finiteRate);
  return input === null || output === null || cacheRead === null || cacheWrite === null ? undefined : { input, output, cacheRead, cacheWrite };
};

export const deserializeRateTable = (value: unknown): Map<string, TokenRates> => {
  const table = new Map<string, TokenRates>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return table;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw) || (raw.length !== 4 && raw.length !== 6)) continue;
    const rates = deserializeRates(raw.slice(0, 4));
    if (!rates) continue;
    const fast = deserializeRates(raw[4]);
    const ultrafast = deserializeRates(raw[5]);
    table.set(key, { ...rates, ...(fast ? { fast } : {}), ...(ultrafast ? { ultrafast } : {}) });
  }
  return table;
};
