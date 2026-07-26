import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingHostToolRequests } from "./pending-host-tool-requests";

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingHostToolRequests", () => {
  it("rejects a host-tool call after its bounded response timeout", async () => {
    vi.useFakeTimers();
    const requests = new PendingHostToolRequests<string>(1_000);
    const result = requests.create("call-1");
    const rejection = expect(result).rejects.toThrow("Timed out waiting for BuildWarden host tool call-1.");

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(requests.resolve("call-1", "late")).toBe(false);
  });

  it("does not let an older reused call ID settle the newer request", async () => {
    vi.useFakeTimers();
    const requests = new PendingHostToolRequests<string>(1_000);
    const first = requests.create("call-shared");
    const firstResult = expect(first).rejects.toThrow("reused call ID call-shared");
    const second = requests.create("call-shared");

    await firstResult;
    expect(requests.resolve("call-shared", "new result")).toBe(true);
    await expect(second).resolves.toBe("new result");
    await vi.runAllTimersAsync();
  });

  it("clears pending timers when all calls are cancelled", async () => {
    vi.useFakeTimers();
    const requests = new PendingHostToolRequests<string>(1_000);
    const result = requests.create("call-1");
    const rejection = expect(result).rejects.toThrow("Run cancelled.");

    requests.rejectAll(new Error("Run cancelled."));

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
