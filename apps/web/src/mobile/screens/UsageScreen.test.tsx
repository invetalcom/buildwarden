/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { formatUsd } from "@buildwarden/renderer/logic";
import { APP_SETTING_KEYS, type AppSnapshot, type UsageCostReport, type UsageReportRow } from "@buildwarden/shared";
import { MobileAppProvider, type MobileAppValue } from "../data/mobile-app-context";
import { UsageScreen } from "./UsageScreen";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = undefined; });

const row = (bucket: string, modelIndex: number, cost: number | null): UsageReportRow => ({
  bucket,
  modelIndex,
  projectIndex: 0,
  tokens: { inputTokens: 1_000, uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 },
  cost: cost === null ? null : { input: cost, cacheRead: 0, cacheWrite: 0, output: 0 },
  cacheSavingsUsd: 0,
});

const report: UsageCostReport = {
  generatedAt: "2026-10-20T12:00:00.000Z",
  rangeDays: 30,
  bucketSize: "day",
  buckets: ["2026-10-19", "2026-10-20"],
  previousBuckets: ["2026-10-17", "2026-10-18"],
  pricing: { status: "fresh", source: "test", fetchedAt: "2026-10-20T11:00:00.000Z", knownModels: 10 },
  models: [
    { providerType: "claude-code", modelId: "claude-sonnet-5-5", rates: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }, matchedKey: "claude-sonnet-5-5" },
    { providerType: "claude-code", modelId: "opus", rates: null, matchedKey: null },
  ],
  projects: [{ projectId: "p1", name: "Alpha" }],
  rows: [row("2026-10-19", 0, 1.25), row("2026-10-20", 0, 2.5), row("2026-10-20", 1, null)],
};

const render = async ({ admin, enabled = true }: { admin: boolean; enabled?: boolean }) => {
  const getUsageCostReport = vi.fn(async () => report);
  const setAppSetting = vi.fn<BuildWardenClient["setAppSetting"]>(async () => undefined);
  const push = vi.fn();
  const snapshot = {
    projects: [{ project: { id: "p1", name: "Alpha" } }],
    // Read-only sessions never receive host settings; the snapshot flag is what tells them.
    settings: admin ? { [APP_SETTING_KEYS.usageCostTrackingEnabled]: String(enabled) } : {},
    tokenUsage: { standaloneChats: { inputTokens: 0, outputTokens: 0 }, today: { inputTokens: 0, outputTokens: 0 }, costTrackingEnabled: enabled },
  } as unknown as AppSnapshot;
  const client = {
    capabilities: { platform: "web", settings: admin },
    getUsageCostReport,
    setAppSetting,
  } as unknown as BuildWardenClient;
  const value = {
    client,
    snapshot,
    snapshotStore: { refresh: vi.fn(async () => undefined) },
    router: { push, back: vi.fn() },
  } as unknown as MobileAppValue;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<MobileAppProvider value={value}><UsageScreen /></MobileAppProvider>));
  return { getUsageCostReport, setAppSetting, push };
};

const button = (text: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
const tile = (label: string) =>
  [...document.querySelectorAll("p")].find((element) => element.textContent === label)?.parentElement?.textContent ?? "";

describe("mobile usage screen", () => {
  it("shows KPIs, both charts, and model rows to read-only sessions without price editing", async () => {
    const { getUsageCostReport, setAppSetting } = await render({ admin: false });
    expect(getUsageCostReport).toHaveBeenCalledWith({ rangeDays: 30, refreshPricing: false });
    expect(tile("Estimated API cost")).toContain(formatUsd(3.75));
    expect(document.querySelector('[aria-label^="Estimated cost over time"]')).not.toBeNull();
    expect(document.querySelector('[aria-label^="Tokens over time"]')).not.toBeNull();
    expect(container.textContent).toContain("claude-sonnet-5-5");
    expect(container.textContent).toContain("No price");
    expect(document.querySelector("input")).toBeNull();
    expect(setAppSetting).not.toHaveBeenCalled();
  });

  it("excludes a model from every number when its row is tapped", async () => {
    await render({ admin: false });
    const sonnetRow = [...document.querySelectorAll('[role="checkbox"]')].find((entry) => entry.textContent?.includes("claude-sonnet-5-5"));
    await act(async () => (sonnetRow as HTMLButtonElement).click());
    expect(sonnetRow?.getAttribute("aria-checked")).toBe("false");
    expect(tile("Estimated API cost")).toContain(formatUsd(0));
  });

  it("switches the period and the chart breakdown", async () => {
    const { getUsageCostReport } = await render({ admin: false });
    await act(async () => [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "7d")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(getUsageCostReport).toHaveBeenLastCalledWith({ rangeDays: 7, refreshPricing: false });
    await act(async () => button("By")?.click());
    await act(async () => button("Token type")?.click());
    expect(button("By")?.textContent).toContain("Token type");
  });

  it("explains how to turn tracking on instead of loading a report while it is off", async () => {
    const { getUsageCostReport, push } = await render({ admin: true, enabled: false });
    expect(getUsageCostReport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Cost tracking is off");
    await act(async () => button("Open network settings")?.click());
    expect(push).toHaveBeenCalledWith({ name: "settings", section: "network" });
  });

  it("does not offer settings to read-only sessions while tracking is off", async () => {
    await render({ admin: false, enabled: false });
    expect(container.textContent).toContain("An admin session or the desktop app can turn it on");
    expect(button("Open network settings")).toBeUndefined();
  });
});
