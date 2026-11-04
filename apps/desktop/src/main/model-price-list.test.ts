import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_PRICES_URL, LITELLM_PRICES_URL, ModelPriceList } from "./model-price-list";

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
const CURSOR_DOCUMENT = "| Model | Provider | Input | Cache write | Cache read | Output |\n| --- | --- | --- | --- | --- | --- |\n| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 |";
const successResponse = (url: string | URL | Request) => String(url) === CURSOR_PRICES_URL ? new Response(CURSOR_DOCUMENT) : jsonResponse(PRICE_DOCUMENT);

describe("ModelPriceList", () => {
  it("refreshes old LiteLLM-only caches and retains them if both sources are offline", async () => {
    const filePath = cachePath();
    writeFileSync(filePath, JSON.stringify({ version: 1, fetchedAtMs: Date.now(), rates: { "gpt-5": [1, 2, 1, 1] } }));
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const result = await new ModelPriceList({ cacheFilePath: filePath, resolveFetch: async () => fetchMock }).load();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.table.get("gpt-5")?.input).toBe(1);
    expect(result.pricing.status).toBe("cached");
  });

  it("downloads, caches for a day, and reuses the cached table on the next launch", async () => {
    let now = 1_000_000;
    const fetchMock = vi.fn(async (url: string | URL | Request) => successResponse(url));
    const filePath = cachePath();
    const prices = new ModelPriceList({ cacheFilePath: filePath, resolveFetch: async () => fetchMock as unknown as typeof fetch, now: () => now });

    const first = await prices.load();
    expect(first.pricing).toMatchObject({ status: "fresh", knownModels: 2 });
    expect(first.pricing.source).toContain(CURSOR_PRICES_URL);
    expect(first.table.get("cursor/composer-2.5")?.cacheRead).toBeCloseTo(0.0000002, 12);
    expect(first.table.get("gpt-5")?.output).toBe(0.00001);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 60 * 60 * 1000;
    await prices.load();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const relaunchFetch = vi.fn(async () => jsonResponse(PRICE_DOCUMENT));
    const relaunched = new ModelPriceList({ cacheFilePath: filePath, resolveFetch: async () => relaunchFetch as unknown as typeof fetch, now: () => now });
    const cached = await relaunched.load();
    expect(cached.pricing.status).toBe("cached");
    expect(cached.table.size).toBe(2);
    expect(relaunchFetch).not.toHaveBeenCalled();
  });

  it("falls back to the GitHub contents API when the raw URL fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url) === LITELLM_PRICES_URL ? jsonResponse({}, 503) : successResponse(url));
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as unknown as typeof fetch });

    const result = await prices.load();
    expect(result.pricing.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.github.com"))).toBe(true);
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
    expect(fetchMock).toHaveBeenCalledTimes(3);

    now += 61_000;
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("allows a forced refresh after a minute even when the cache is fresh", async () => {
    let now = 9_000_000;
    const fetchMock = vi.fn(async (url: string | URL | Request) => successResponse(url));
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as unknown as typeof fetch, now: () => now });
    await prices.load();
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 61_000;
    await prices.load(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps cached Cursor rates when only the Cursor source fails and retries after a minute", async () => {
    let now = 9_000_000;
    let failCursor = false;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (failCursor && String(url) === CURSOR_PRICES_URL) throw new Error("offline");
      return successResponse(url);
    });
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as typeof fetch, now: () => now });
    await prices.load();
    now += 61_000;
    failCursor = true;
    const partial = await prices.load(true);
    expect(partial.table.has("cursor/composer-2.5")).toBe(true);
    expect(partial.pricing).toMatchObject({ status: "cached", error: expect.stringContaining("Cursor") });
    failCursor = false;
    now += 61_000;
    expect((await prices.load()).pricing.status).toBe("fresh");
  });

  it("still loads Cursor prices when LiteLLM is unavailable", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url) === CURSOR_PRICES_URL ? successResponse(url) : jsonResponse({}, 503));
    const prices = new ModelPriceList({ cacheFilePath: cachePath(), resolveFetch: async () => fetchMock as typeof fetch });
    const result = await prices.load();
    expect(result.table.has("cursor/composer-2.5")).toBe(true);
    expect(result.pricing.error).toContain("LiteLLM");
  });
});
