import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  data: { compileCacheDirectory: "worker-cache" },
  enable: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({ workerData: mocks.data }));
vi.mock("./compile-cache", () => ({
  enableCompileCacheSafely: mocks.enable,
  flushCompileCacheSafely: mocks.flush,
}));
afterEach(() => { vi.clearAllMocks(); });

describe("worker compile-cache bootstrap", () => {
  it("enables caching before loading the runtime and flushes before resolving", async () => {
    const { loadCachedWorker } = await import("./worker-bootstrap");
    const load = vi.fn(async () => {
      expect(mocks.enable).toHaveBeenCalledWith("worker-cache");
      expect(mocks.flush).not.toHaveBeenCalled();
    });
    await loadCachedWorker(load);
    expect(load).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it("flushes loaded modules even when runtime initialization fails", async () => {
    const { loadCachedWorker } = await import("./worker-bootstrap");
    await expect(loadCachedWorker(async () => { throw new Error("Runtime failure"); })).rejects.toThrow("Runtime failure");
    expect(mocks.flush).toHaveBeenCalledOnce();
  });
});
