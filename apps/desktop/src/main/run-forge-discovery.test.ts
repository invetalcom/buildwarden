import { afterEach, expect, it, vi } from "vitest";
import { RunForgeDiscovery } from "./run-forge-discovery";

afterEach(() => vi.useRealTimers());

it("honors disabling, re-enabling, and interval changes, including startup when hidden", async () => {
  vi.useFakeTimers();
  let intervalMs = 0;
  let visible = false;
  const refresh = vi.fn(async () => undefined);
  const discovery = new RunForgeDiscovery({
    projects: () => [{ projectId: "project", intervalMs }], shouldRun: () => visible,
    refresh, onError: vi.fn(),
  });
  discovery.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled();
  intervalMs = 120_000;
  discovery.refresh("project", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("project", true);
  await vi.advanceTimersByTimeAsync(240_000);
  expect(refresh).toHaveBeenCalledOnce();
  visible = true;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(refresh).toHaveBeenLastCalledWith("project", false);
  expect(refresh).toHaveBeenCalledTimes(2);
  intervalMs = 0;
  discovery.refresh("project", true);
  await vi.advanceTimersByTimeAsync(240_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  intervalMs = 60_000;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(refresh).toHaveBeenLastCalledWith("project", true);
  await discovery.stop();
});

it("starts enabled projects immediately even when no window is visible", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => undefined);
  const discovery = new RunForgeDiscovery({
    projects: () => [{ projectId: "enabled", intervalMs: 900_000 }, { projectId: "disabled", intervalMs: 0 }],
    shouldRun: () => false, refresh, onError: vi.fn(),
  });
  discovery.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("enabled", true);
  await discovery.stop();
});

it("discovers existing projects at startup and periodically without opening a run", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn<(projectId: string, includeOlder: boolean) => Promise<void>>(async () => undefined);
  const discovery = new RunForgeDiscovery({ projects: () => [{ projectId: "one", intervalMs: 60_000 }, { projectId: "two", intervalMs: 120_000 }], shouldRun: () => true, refresh, onError: vi.fn() });
  discovery.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh.mock.calls).toEqual([["one", true], ["two", true]]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  await discovery.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(3);
});

it("bounds concurrency and coalesces refreshes while retaining a refresh requested during a scan", async () => {
  vi.useFakeTimers();
  const releases: Array<() => void> = [];
  const refresh = vi.fn<(projectId: string, includeOlder: boolean) => Promise<void>>(() => new Promise<void>((resolve) => releases.push(resolve)));
  const discovery = new RunForgeDiscovery({ projects: () => ["one", "two", "three"].map((projectId) => ({ projectId, intervalMs: 60_000 })), shouldRun: () => true, refresh, onError: vi.fn() });
  discovery.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(2);
  discovery.refresh("one");
  discovery.refresh("one");
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh.mock.calls.map(([id]) => id)).toEqual(["one", "two", "three"]);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh.mock.calls.map(([id]) => id)).toEqual(["one", "two", "three", "one"]);
  const stopped = discovery.stop();
  for (const release of releases) release();
  await stopped;
});

it("isolates project errors and continues discovery", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const refresh = vi.fn(async (id: string) => { if (id === "bad") throw new Error("offline"); });
  const discovery = new RunForgeDiscovery({ projects: () => ["bad", "good", "next"].map((projectId) => ({ projectId, intervalMs: 60_000 })), shouldRun: () => true, refresh, onError });
  discovery.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
  expect(refresh).toHaveBeenCalledWith("next", true);
  await discovery.stop();
});
