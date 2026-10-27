import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsagePricingInfo } from "@buildwarden/shared";
import {
  deserializeRateTable,
  parseLiteLlmRateTable,
  serializeRateTable,
  type RateTable,
} from "./model-pricing";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_PRICES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const PRICES_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum spacing between forced refreshes and between retries after a failed download. */
const PRICES_REFRESH_FLOOR_MS = 60 * 1000;
const PRICES_FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE_VERSION = 1;

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

interface CachedPriceList {
  version: number;
  fetchedAtMs: number;
  rates: unknown;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Downloads LiteLLM's public model price list on demand. Nothing is fetched until
 * {@link ModelPriceList.load} is called, which the controller only does while usage cost
 * tracking is enabled.
 */
export class ModelPriceList {
  private table: RateTable = new Map();
  private fetchedAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private lastError: string | undefined;
  private status: UsagePricingInfo["status"] = "unavailable";
  private diskChecked = false;
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
      source: LITELLM_PRICES_URL,
      fetchedAt: this.fetchedAtMs === null ? null : new Date(this.fetchedAtMs).toISOString(),
      knownModels: this.table.size,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async refresh(force: boolean): Promise<void> {
    const maxAgeMs = force ? PRICES_REFRESH_FLOOR_MS : PRICES_TTL_MS;
    if (!this.diskChecked) {
      this.diskChecked = true;
      await this.loadFromDisk();
    }
    const now = this.now();
    if (this.fetchedAtMs !== null && now - this.fetchedAtMs < maxAgeMs) return;
    if (this.lastFailureAtMs !== null && now - this.lastFailureAtMs < PRICES_REFRESH_FLOOR_MS) return;

    try {
      const fetchImpl = await this.options.resolveFetch();
      const table = await this.download(fetchImpl);
      this.table = table;
      this.fetchedAtMs = now;
      this.lastFailureAtMs = null;
      this.lastError = undefined;
      this.status = "fresh";
      await this.writeToDisk(now, table).catch(() => undefined);
    } catch (error) {
      this.lastFailureAtMs = now;
      this.lastError = `Price list download failed: ${errorMessage(error)}`;
      this.status = this.table.size > 0 ? "cached" : "unavailable";
    }
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
      if (cached.version !== CACHE_FILE_VERSION || typeof cached.fetchedAtMs !== "number") return;
      const table = deserializeRateTable(cached.rates);
      if (table.size === 0) return;
      this.table = table;
      this.fetchedAtMs = cached.fetchedAtMs;
      this.status = "cached";
    } catch {
      // A missing or corrupt cache just means the next load downloads a fresh list.
    }
  }

  private async writeToDisk(fetchedAtMs: number, table: RateTable): Promise<void> {
    const payload: CachedPriceList = { version: CACHE_FILE_VERSION, fetchedAtMs, rates: serializeRateTable(table) };
    await mkdir(dirname(this.options.cacheFilePath), { recursive: true });
    const tempPath = `${this.options.cacheFilePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(payload), "utf8");
    await rename(tempPath, this.options.cacheFilePath);
  }
}
