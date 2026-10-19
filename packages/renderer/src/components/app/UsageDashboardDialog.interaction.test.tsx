/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi, UsageCostReport, UsageCostReportInput } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { UsageDashboardDialog } from "./UsageDashboardDialog";
import { formatRate, formatTokenCount, formatUsd, parsePriceOverrideDraft } from "./usage-dashboard-model";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const tokens = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: input,
  uncachedInputTokens: input - cacheRead,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  outputTokens: output,
  reasoningTokens: 0,
});

const REPORT: UsageCostReport = {
  generatedAt: "2026-10-19T12:00:00.000Z",
  rangeDays: 30,
  since: "2026-09-20T00:00:00.000Z",
  pricing: { status: "fresh", source: "https://example.test/prices.json", fetchedAt: "2026-10-19T11:00:00.000Z", knownModels: 2_000 },
  totals: {
    tokens: tokens(3_000_000, 150_000, 2_000_000),
    costUsd: 3.75,
    cost: { input: 1.25, cacheRead: 0.5, cacheWrite: 0, output: 2 },
    cacheSavingsUsd: 4.5,
    unpricedTokens: 11_000,
  },
  models: [
    {
      providerType: "claude-code",
      modelId: "claude-sonnet-4-5",
      tokens: tokens(2_000_000, 100_000, 1_500_000),
      costUsd: 3.75,
      cost: { input: 1.25, cacheRead: 0.5, cacheWrite: 0, output: 2 },
      rates: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
      priceSource: "litellm",
      matchedKey: "claude-sonnet-4-5",
      cacheSavingsUsd: 4.5,
    },
    {
      providerType: "claude-code",
      modelId: "opus",
      tokens: tokens(10_000, 1_000),
      costUsd: null,
      cost: null,
      rates: null,
      priceSource: null,
      matchedKey: null,
      cacheSavingsUsd: 0,
    },
  ],
  projects: [{ projectId: "p1", name: "Alpha", tokens: tokens(2_010_000, 101_000), costUsd: 3.75, unpricedTokens: 11_000 }],
  daily: [
    { day: "2026-10-18", costUsd: 1, inputTokens: 100, outputTokens: 10 },
    { day: "2026-10-19", costUsd: 2.75, inputTokens: 200, outputTokens: 20 },
  ],
  unattributed: { inputTokens: 500, outputTokens: 50 },
};

const renderDialog = async (overrides: { onPriceOverridesChange?: () => Promise<void>; canEditPrices?: boolean } = {}) => {
  const getUsageCostReport = vi.fn<(input: UsageCostReportInput) => Promise<UsageCostReport>>(async () => REPORT);
  const onPriceOverridesChange = vi.fn(overrides.onPriceOverridesChange ?? (async () => undefined));
  const onClose = vi.fn();
  const client = createElectronBuildWardenClient({ getUsageCostReport } as unknown as DesktopApi);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <BuildWardenClientProvider client={client}>
      <UsageDashboardDialog
        canEditPrices={overrides.canEditPrices ?? true}
        priceOverrides={{}}
        onPriceOverridesChange={onPriceOverridesChange}
        onClose={onClose}
      />
    </BuildWardenClientProvider>,
  ));
  return { getUsageCostReport, onPriceOverridesChange, onClose };
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === text);

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("UsageDashboardDialog", () => {
  it("loads the default 30-day report and shows totals, models, and projects", async () => {
    const { getUsageCostReport } = await renderDialog();
    expect(getUsageCostReport).toHaveBeenCalledWith({ rangeDays: 30, refreshPricing: false });
    const text = container?.textContent ?? "";
    expect(text).toContain(formatUsd(3.75));
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("No price");
    expect(text).toContain("Alpha");
    expect(text).toContain("recorded before cost tracking");
    expect(text).toContain(`${(2_000).toLocaleString()} models`);
  });

  it("reloads for a new period and forces a price refresh on demand", async () => {
    const { getUsageCostReport } = await renderDialog();
    await act(async () => buttonByText("7d")?.click());
    expect(getUsageCostReport).toHaveBeenLastCalledWith({ rangeDays: 7, refreshPricing: false });
    await act(async () => buttonByText("Refresh prices")?.click());
    expect(getUsageCostReport).toHaveBeenLastCalledWith({ rangeDays: 7, refreshPricing: true });
  });

  it("saves a custom price for an unpriced model", async () => {
    const { onPriceOverridesChange } = await renderDialog();
    await act(async () => buttonByText("Set price")?.click());
    const input = container?.querySelector<HTMLInputElement>('input[aria-label="Input USD per million tokens"]');
    const output = container?.querySelector<HTMLInputElement>('input[aria-label="Output USD per million tokens"]');
    expect(input).toBeTruthy();
    await act(async () => {
      setInputValue(input!, "5");
      setInputValue(output!, "25");
    });
    await act(async () => buttonByText("Save")?.click());
    expect(onPriceOverridesChange).toHaveBeenCalledWith({ opus: { inputPerMillion: 5, outputPerMillion: 25 } });
  });

  it("shows prices without edit controls in read-only sessions", async () => {
    await renderDialog({ canEditPrices: false });
    expect(container?.textContent).toContain("No price");
    expect(buttonByText("Set price")).toBeUndefined();
    expect(buttonByText("Edit")).toBeUndefined();
  });

  it("closes on Escape", async () => {
    const { onClose } = await renderDialog();
    const dialog = container?.querySelector('[role="dialog"]');
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("usage dashboard formatting", () => {
  it("formats money, token counts, and per-million rates compactly", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1234.5)).toBe((1234.5).toLocaleString(undefined, { style: "currency", currency: "USD" }));
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1_250)).toBe("1.3K");
    expect(formatTokenCount(2_500_000)).toBe("2.50M");
    expect(formatRate(3)).toBe("$3");
    expect(formatRate(0.3)).toBe("$0.3");
    expect(formatRate(0.075)).toBe("$0.075");
  });

  it("validates price drafts", () => {
    expect(parsePriceOverrideDraft({ inputPerMillion: "", outputPerMillion: "1", cacheReadPerMillion: "", cacheWritePerMillion: "" }))
      .toBe("Input rate is required.");
    expect(parsePriceOverrideDraft({ inputPerMillion: "1", outputPerMillion: "-2", cacheReadPerMillion: "", cacheWritePerMillion: "" }))
      .toBe("Output rate must be a number of at least 0.");
    expect(parsePriceOverrideDraft({ inputPerMillion: "1", outputPerMillion: "2", cacheReadPerMillion: "0", cacheWritePerMillion: "" }))
      .toEqual({ inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0 });
  });
});
