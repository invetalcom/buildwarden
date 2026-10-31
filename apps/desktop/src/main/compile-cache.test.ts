import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enable: vi.fn(), flush: vi.fn() }));
vi.mock("node:module", () => ({
  constants: { compileCacheStatus: { ENABLED: 1, ALREADY_ENABLED: 2, FAILED: 0, DISABLED: 3 } },
  enableCompileCache: mocks.enable,
  flushCompileCache: mocks.flush,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.enable.mockReset();
  mocks.flush.mockReset();
  vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("optional compile cache", () => {
  it.each([1, 2])("passes the active cache directory to workers for status %s", async (status) => {
    const activeDirectory = resolve("active-cache");
    mocks.enable.mockReturnValue({ status, directory: activeDirectory });
    const cache = await import("./compile-cache");
    const inheritedEnvironment = process.env.NODE_COMPILE_CACHE;
    expect(cache.enableCompileCacheSafely("requested-cache")).toBe(activeDirectory);
    expect(mocks.enable).toHaveBeenCalledWith(resolve("requested-cache"));
    expect(cache.getCompileCacheWorkerData()).toEqual({ compileCacheDirectory: activeDirectory });
    expect(process.env.NODE_COMPILE_CACHE).toBe(inheritedEnvironment);
    cache.flushCompileCacheSafely();
    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it.each([0, 3])("continues without caching for status %s", async (status) => {
    mocks.enable.mockReturnValue({ status, message: "Unavailable" });
    const cache = await import("./compile-cache");
    expect(cache.enableCompileCacheSafely("cache")).toBeUndefined();
    expect(cache.getCompileCacheWorkerData()).toEqual({});
    cache.flushCompileCacheSafely();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("tolerates cache creation and write errors", async () => {
    const cache = await import("./compile-cache");
    mocks.enable.mockImplementationOnce(() => { throw new Error("Read only"); });
    expect(() => cache.enableCompileCacheSafely("cache")).not.toThrow();
    mocks.enable.mockReturnValue({ status: 1, directory: resolve("cache") });
    cache.enableCompileCacheSafely("cache");
    mocks.flush.mockImplementation(() => { throw new Error("Disk full"); });
    expect(() => cache.flushCompileCacheSafely()).not.toThrow();
  });

  it("skips missing paths and honors Node's disable switch", async () => {
    const cache = await import("./compile-cache");
    for (const value of [undefined, null, 42, "", "  "]) cache.enableCompileCacheSafely(value);
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
    cache.enableCompileCacheSafely("cache");
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")("avoids the Node 24 long cache path hang on Windows", async () => {
    const cache = await import("./compile-cache");
    cache.enableCompileCacheSafely(resolve("a".repeat(181)));
    expect(mocks.enable).not.toHaveBeenCalled();
  });
});
