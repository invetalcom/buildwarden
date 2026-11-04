import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsagePricingInfo } from "@buildwarden/shared";
import {
  deserializeRateTable,
  parseLiteLlmRateTable,
  parseCursorRateTable,
  serializeRateTable,
  type RateTable,
} from "./model-pricing";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
// Request Markdown via content negotiation on the canonical page. Combining a .md
// suffix with Accept: text/markdown makes Cursor's docs server return HTTP 404.
export const CURSOR_PRICES_URL = "https://cursor.com/docs/models-and-pricing";
const LITELLM_PRICES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const PRICES_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum spacing between forced refreshes and between retries after a failed download. */
const PRICES_REFRESH_FLOOR_MS = 60 * 1000;
const PRICES_FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE_VERSION = 4;

export interface ModelPriceListOptions {
  /** Where the compact parsed table is cached between app launches. */
  cacheFilePath: string;
  /** Resolved per download so proxy settings changes apply without a restart. */
  resolveFetch: () => Promise<typeof fetch>;
  now?: () => number;
}

export interface ModelPriceListResult {
  table: RateTable;
  pricing: UsagePricingInfo;
}

interface SourceCache { fetchedAt: number | null; attemptedAt: number | null; error?: string }
interface CachedPriceList {
  sources?: Record<"LiteLLM" | "Cursor", SourceCache>;
  version: number;
  fetchedAtMs: number;
  rates: unknown;
  error?: string;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Downloads LiteLLM's and Cursor's public model prices on demand. Nothing is fetched until
 * {@link ModelPriceList.load} is called, which the controller only does while usage cost
 * tracking is enabled.
 */
export class ModelPriceList {
  private table: RateTable = new Map();
  private fetchedAtMs: number | null = null;
  private sources: Record<"LiteLLM" | "Cursor", SourceCache> = { LiteLLM: { fetchedAt: null, attemptedAt: null }, Cursor: { fetchedAt: null, attemptedAt: null } };
  private lastError: string | undefined;
  private status: UsagePricingInfo["status"] = "unavailable";
  private diskChecked = false;
  private cacheNeedsRefresh = false;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ModelPriceListOptions) {
    this.now = options.now ?? Date.now;
  }

  async load(force = false): Promise<ModelPriceListResult> {
    if (!this.inFlight) {
      this.inFlight = this.refresh(force).finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
    return { table: this.table, pricing: this.pricing() };
  }

  private pricing(): UsagePricingInfo {
    return {
      status: this.status,
      source: `${LITELLM_PRICES_URL}\n${CURSOR_PRICES_URL}`,
      fetchedAt: this.fetchedAtMs === null ? null : new Date(this.fetchedAtMs).toISOString(),
      knownModels: this.table.size,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async refresh(force: boolean): Promise<void> {
    if (!this.diskChecked) {
      this.diskChecked = true;
      await this.loadFromDisk();
    }
    const now = this.now();
    const due = (["LiteLLM", "Cursor"] as const).filter((name) => {
      const source = this.sources[name];
      if (source.attemptedAt !== null && now - source.attemptedAt < PRICES_REFRESH_FLOOR_MS) return false;
      return force || this.cacheNeedsRefresh || source.error || source.fetchedAt === null || now - source.fetchedAt >= PRICES_TTL_MS;
    });
    if (!due.length) return;
    const table = new Map(this.table);
    await Promise.all(due.map(async (name) => {
      const source = this.sources[name];
      source.attemptedAt = now;
      try {
        const fetchImpl = await this.options.resolveFetch();
        const rates = await (name === "Cursor" ? this.downloadCursor(fetchImpl) : this.download(fetchImpl));
        for (const key of table.keys()) if (key.startsWith("cursor/") === (name === "Cursor")) table.delete(key);
        for (const [key, rate] of rates) if (key.startsWith("cursor/") === (name === "Cursor")) table.set(key, rate);
        source.fetchedAt = now;
        source.error = undefined;
      } catch (error) { source.error = name + ": " + errorMessage(error); }
    }));
    this.table = table;
    this.cacheNeedsRefresh = false;
    const errors = Object.values(this.sources).flatMap((source) => source.error ? [source.error] : []);
    this.lastError = errors.length ? "Some model prices could not be updated. " + errors.join("; ") : undefined;
    // Report the oldest source still represented in the combined table.
    const times = Object.values(this.sources).flatMap((source) => source.fetchedAt === null ? [] : [source.fetchedAt]);
    this.fetchedAtMs = times.length ? Math.min(...times) : null;
    this.status = errors.length ? (this.table.size ? "cached" : "unavailable") : "fresh";
    await this.writeToDisk(this.fetchedAtMs ?? 0, this.table).catch(() => undefined);
  }

  private async downloadCursor(fetchImpl: typeof fetch): Promise<RateTable> {
    const response = await fetchImpl(CURSOR_PRICES_URL, { headers: { accept: "text/markdown" }, signal: AbortSignal.timeout(PRICES_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const table = parseCursorRateTable(await response.text());
    if (table.size === 0) throw new Error("the Cursor price list contained no usable model rates");
    return table;
  }

  private async download(fetchImpl: typeof fetch): Promise<RateTable> {
    let lastError: unknown;
    for (const [url, accept] of [
      [LITELLM_PRICES_URL, "application/json"],
      [LITELLM_PRICES_API_URL, "application/vnd.github.raw+json"],
    ] as const) {
      try {
        const response = await fetchImpl(url, {
          headers: { accept },
          signal: AbortSignal.timeout(PRICES_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const table = parseLiteLlmRateTable(await response.json());
        if (table.size === 0) throw new Error("the price list contained no usable model rates");
        return table;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const cached = JSON.parse(await readFile(this.options.cacheFilePath, "utf8")) as Partial<CachedPriceList>;
      if (![1, 2, 3, CACHE_FILE_VERSION].includes(cached.version ?? 0) || typeof cached.fetchedAtMs !== "number") return;
      const table = deserializeRateTable(cached.rates);
      if (table.size === 0) return;
      this.table = table;
      this.fetchedAtMs = cached.fetchedAtMs;
      this.cacheNeedsRefresh = cached.version !== CACHE_FILE_VERSION;
      for (const name of ["LiteLLM", "Cursor"] as const) {
        if ([...table.keys()].some((key) => key.startsWith("cursor/") === (name === "Cursor"))) this.sources[name].fetchedAt = cached.fetchedAtMs;
      }
      if (cached.version === CACHE_FILE_VERSION && cached.sources) {
        for (const name of ["LiteLLM", "Cursor"] as const) {
          const source = cached.sources[name];
          if (source && (source.fetchedAt === null || Number.isFinite(source.fetchedAt)) && (source.attemptedAt === null || Number.isFinite(source.attemptedAt))) this.sources[name] = source;
        }
      }
      this.lastError = typeof cached.error === "string" ? cached.error : undefined;
      this.status = "cached";
    } catch {
      // A missing or corrupt cache just means the next load downloads a fresh list.
    }
  }

  private async writeToDisk(fetchedAtMs: number, table: RateTable): Promise<void> {
    const payload: CachedPriceList = { version: CACHE_FILE_VERSION, fetchedAtMs, rates: serializeRateTable(table), error: this.lastError, sources: this.sources };
    await mkdir(dirname(this.options.cacheFilePath), { recursive: true });
    const tempPath = `${this.options.cacheFilePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(payload), "utf8");
    await rename(tempPath, this.options.cacheFilePath);
  }
}
