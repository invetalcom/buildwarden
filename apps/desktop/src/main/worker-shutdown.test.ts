import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopWorkerAfterCleanup } from "./worker-shutdown";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const worker = () => Object.assign(new EventEmitter(), { threadId: 1, terminate: vi.fn(async () => 0) }) as unknown as Worker;

it.each(["done", "error"])("waits for provider cleanup before terminating the worker (%s)", async (type) => {
  const child = worker();
  const requestStop = vi.fn();
  const stopped = stopWorkerAfterCleanup(child, requestStop);
  expect(requestStop).toHaveBeenCalledOnce();
  child.emit("message", { type: "chunk" });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(child.terminate).not.toHaveBeenCalled();
  child.emit("message", { type });
  await stopped;
  expect(child.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount("message")).toBe(0);
});

it("bounds shutdown if the worker cannot acknowledge cancellation", async () => {
  const child = worker();
  const stopped = stopWorkerAfterCleanup(child, vi.fn());
  await vi.advanceTimersByTimeAsync(12_000);
  await stopped;
  expect(child.terminate).toHaveBeenCalledOnce();
  expect(child.listenerCount("exit")).toBe(0);
});

it("registers listeners before cancellation can finish synchronously", async () => {
  const child = worker();
  await stopWorkerAfterCleanup(child, () => child.emit("exit", 0));
  expect(child.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("terminates the worker even when sending cancellation throws", async () => {
  const child = worker();
  await expect(stopWorkerAfterCleanup(child, () => { throw new Error("Port closed"); })).rejects.toThrow("Port closed");
  expect(child.terminate).toHaveBeenCalledOnce();
  expect(child.listenerCount("message")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
