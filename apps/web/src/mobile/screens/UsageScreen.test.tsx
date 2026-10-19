/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { formatUsd } from "@buildwarden/renderer/logic";
import { APP_SETTING_KEYS, type AppSnapshot, type UsageCostReport } from "@buildwarden/shared";
import { MobileAppProvider, type MobileAppValue } from "../data/mobile-app-context";
import { UsageScreen } from "./UsageScreen";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = undefined; });

const tokens = (input: number, output: number) => ({
  inputTokens: input, uncachedInputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output, reasoningTokens: 0,
});

const report: UsageCostReport = {
  generatedAt: "2026-10-19T12:00:00.000Z",
  rangeDays: 30,
  since: null,
  pricing: { status: "fresh", source: "test", fetchedAt: "2026-10-19T11:00:00.000Z", knownModels: 10 },
  totals: { tokens: tokens(1_000_000, 50_000), costUsd: 3.75, cost: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0.75 }, cacheSavingsUsd: 0, unpricedTokens: 11_000 },
  models: [
    {
      providerType: "claude-code", modelId: "claude-sonnet-4-5", tokens: tokens(1_000_000, 50_000), costUsd: 3.75,
      cost: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0.75 },
      rates: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
      priceSource: "litellm", matchedKey: "claude-sonnet-4-5", cacheSavingsUsd: 0,
    },
    { providerType: "claude-code", modelId: "opus", tokens: tokens(10_000, 1_000), costUsd: null, cost: null, rates: null, priceSource: null, matchedKey: null, cacheSavingsUsd: 0 },
  ],
  projects: [{ projectId: "p1", name: "Alpha", tokens: tokens(1_010_000, 51_000), costUsd: 3.75, unpricedTokens: 11_000 }],
  daily: [
    { day: "2026-10-18", costUsd: 1, inputTokens: 100, outputTokens: 10 },
    { day: "2026-10-19", costUsd: 2.75, inputTokens: 200, outputTokens: 20 },
  ],
  unattributed: { inputTokens: 0, outputTokens: 0 },
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

const setInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("mobile usage screen", () => {
  it("shows the estimate to read-only sessions without price editing", async () => {
    const { getUsageCostReport } = await render({ admin: false });
    expect(getUsageCostReport).toHaveBeenCalledWith({ rangeDays: 30, refreshPricing: false });
    expect(container.textContent).toContain(formatUsd(3.75));
    expect(container.textContent).toContain("claude-sonnet-4-5");
    expect(container.textContent).toContain("No price");

    await act(async () => button("opus")?.click());
    expect(document.body.textContent).toContain("admin scope can set a custom price");
    expect(document.querySelector('input[aria-label="Input USD per million tokens"]')).toBeNull();
  });

  it("lets admin sessions price a model from its detail sheet", async () => {
    const { setAppSetting } = await render({ admin: true });
    await act(async () => button("opus")?.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Input USD per million tokens"]')!;
    const output = document.querySelector<HTMLInputElement>('input[aria-label="Output USD per million tokens"]')!;
    await act(async () => {
      setInputValue(input, "5");
      setInputValue(output, "25");
    });
    await act(async () => button("Save price")?.click());
    expect(setAppSetting).toHaveBeenCalledWith(
      APP_SETTING_KEYS.modelPriceOverrides,
      JSON.stringify({ opus: { inputPerMillion: 5, outputPerMillion: 25 } }),
    );
  });

  it("switches the period and opens projects from the breakdown", async () => {
    const { getUsageCostReport, push } = await render({ admin: false });
    await act(async () => [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "7d")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(getUsageCostReport).toHaveBeenLastCalledWith({ rangeDays: 7, refreshPricing: false });
    await act(async () => button("Alpha")?.click());
    expect(push).toHaveBeenCalledWith({ name: "project", projectId: "p1", tab: "overview" });
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
