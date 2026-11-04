import { describe, expect, it, vi } from "vitest";
import type { SubscriptionLimitsReport, SubscriptionProvider } from "@buildwarden/shared";
import { SubscriptionLimitsStore } from "./subscription-limits-store";

const report = (usedPercent = 40): SubscriptionLimitsReport => ({ accounts: [{ id: "codex", providerType: "codex-cli", label: "Codex", status: "fresh", checkedAt: "2026-11-04T12:00:00.000Z", windows: [{ id: "primary", label: "Session", kind: "session", usedPercent }] }] });
function setup() {
  const client = { getSubscriptionLimitsAvailability: vi.fn(async (): Promise<SubscriptionProvider[]> => ["codex-cli"]), getSubscriptionLimits: vi.fn(async () => report()) };
  return { client, store: new SubscriptionLimitsStore(client) };
}

describe("shared subscription limit readings", () => {
  it("prefetches once at startup, coalescing StrictMode initialization", async () => {
    const { client, store } = setup();
    await Promise.all([store.initialize("config"), store.initialize("config")]);
    expect(client.getSubscriptionLimitsAvailability).toHaveBeenCalledOnce();
    expect(client.getSubscriptionLimits).toHaveBeenCalledExactlyOnceWith({ refresh: true });
    expect(store.getSnapshot()).toMatchObject({ installed: ["codex-cli"], report: report(), refreshing: false });
    await store.initialize("config");
    expect(client.getSubscriptionLimits).toHaveBeenCalledOnce();
  });
  it("does not make limit requests when none of the supported providers are installed", async () => {
    const { client, store } = setup();
    client.getSubscriptionLimitsAvailability.mockResolvedValue([]);
    await store.initialize("config");
    await store.refresh(true);
    expect(store.getSnapshot().installed).toEqual([]);
    expect(client.getSubscriptionLimits).not.toHaveBeenCalled();
  });
  it("retains the warm reading while an open-triggered refresh is pending and coalesces concurrent opens", async () => {
    const { client, store } = setup();
    await store.initialize("config");
    let finish!: (result: SubscriptionLimitsReport) => void;
    client.getSubscriptionLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = store.refresh(true); const second = store.refresh(true);
    expect(first).toBe(second);
    expect(store.getSnapshot().report?.accounts[0]?.windows[0]?.usedPercent).toBe(40);
    expect(store.getSnapshot().refreshing).toBe(true);
    finish(report(60)); await first;
    expect(store.getSnapshot().report?.accounts[0]?.windows[0]?.usedPercent).toBe(60);
    expect(client.getSubscriptionLimits).toHaveBeenCalledTimes(2);
  });
  it("does not overwrite reset results with a refresh that started before the reset", async () => {
    const { client, store } = setup();
    await store.initialize("config");
    let finish!: (result: SubscriptionLimitsReport) => void;
    client.getSubscriptionLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.refresh(true);
    store.replaceReport(report(0));
    finish(report(90)); await pending;
    expect(store.getSnapshot().report?.accounts[0]?.windows[0]?.usedPercent).toBe(0);
  });
  it("recognizes newly installed and removed CLIs on a local availability recheck", async () => {
    const { client, store } = setup();
    client.getSubscriptionLimitsAvailability.mockResolvedValueOnce([]);
    await store.initialize("config");
    await store.initialize("config", true);
    expect(store.getSnapshot().installed).toEqual(["codex-cli"]);
    expect(client.getSubscriptionLimits).toHaveBeenCalledOnce();
    client.getSubscriptionLimitsAvailability.mockResolvedValue([]);
    await store.initialize("config", true);
    expect(store.getSnapshot()).toMatchObject({ installed: [], report: null });
  });
  it("keeps signed-out or temporarily unreachable installed providers visible", async () => {
    const { client, store } = setup();
    client.getSubscriptionLimits.mockRejectedValue(new Error("offline"));
    await store.initialize("config");
    expect(store.getSnapshot()).toMatchObject({ installed: ["codex-cli"], refreshing: false, error: expect.stringContaining("Could not refresh") });
  });
  it("discards late readings when provider configuration changes", async () => {
    const { client, store } = setup();
    await store.initialize("old-config");
    let finish!: (result: SubscriptionLimitsReport) => void;
    client.getSubscriptionLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = store.refresh(true);
    client.getSubscriptionLimitsAvailability.mockResolvedValue([]);
    await store.initialize("new-config");
    finish(report()); await old;
    expect(store.getSnapshot()).toMatchObject({ installed: [], report: null });
  });
});
