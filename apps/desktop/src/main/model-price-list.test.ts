import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LITELLM_PRICES_URL, ModelPriceList } from "./model-price-list";

const tempDirs: string[] = [];
const cachePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-model-prices-"));
  tempDirs.push(dir);
  return join(dir, "model-prices.json");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PRICE_DOCUMENT = { "gpt-5": { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 } };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("ModelPriceList", () => {
  it("downloads, caches for a day, and reuses the cached table on the next launch", async () => {
    let now = 1_000_000;
    const fetchMock = vi.fn(async () => jsonResponse(PRICE_DOCUMENT));
    const filePath = cachePath();
    const prices = new ModelPriceList({ cacheFilePath: filePath, resolveFetch: async () => fetchMock as unknown as typeof fetch, now: () => now });

    const first = await prices.load();
    expect(first.pricing).toMatchObject({ status: "fresh", knownModels: 1, source: LITELLM_PRICES_URL });
    expect(first.table.get("gpt-5")?.output).toBe(0.00001);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000;
    await prices.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const relaunchFetch = vi.fn(async () => jsonResponse(PRICE_DOCUMENT));
    const relaunched = new ModelPriceList({ cacheFilePath: filePath, resolveFetch: async () => relaunchFetch as unknown as typeof fetch, now: () => now });
    const cached = await relaunched.load();
    expect(cached.pricing.status).toBe("cached");
    expect(cached.table.size).toBe(1);
    expect(relaunchFetch).not.toHaveBeenCalled();
  });

  it("falls back to the GitHub contents API when the raw URL fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url) === LITELLM_PRICES_URL ? jsonResponse({}, 503) : jsonResponse(PRICE_DOCUMENT));
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as unknown as typeof fetch });

    const result = await prices.load();
    expect(result.pricing.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("api.github.com");
  });

  it("reports unavailable pricing on failure and does not retry within the refresh floor", async () => {
    let now = 5_000_000;
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as unknown as typeof fetch, now: () => now });

    const failed = await prices.load();
    expect(failed.pricing).toMatchObject({ status: "unavailable", knownModels: 0 });
    expect(failed.pricing.error).toContain("offline");
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 61_000;
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("allows a forced refresh after a minute even when the cache is fresh", async () => {
    let now = 9_000_000;
    const fetchMock = vi.fn(async () => jsonResponse(PRICE_DOCUMENT));
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as unknown as typeof fetch, now: () => now });
    await prices.load();
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 61_000;
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
