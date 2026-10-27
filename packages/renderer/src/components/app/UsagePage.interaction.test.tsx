/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi, UsageCostReport, UsageCostReportInput, UsageReportRow } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { UsagePage } from "./UsagePage";
import { formatUsd } from "./usage-analytics";

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

const row = (bucket: string, modelIndex: number, cost: number | null): UsageReportRow => ({
  bucket,
  modelIndex,
  projectIndex: 0,
  tokens: { inputTokens: 10_000, uncachedInputTokens: 2_000, cacheReadTokens: 8_000, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0 },
  cost: cost === null ? null : { input: cost, cacheRead: 0, cacheWrite: 0, output: 0 },
  cacheSavingsUsd: 0,
});

const REPORT: UsageCostReport = {
  generatedAt: "2026-10-20T12:00:00.000Z",
  rangeDays: 30,
  bucketSize: "day",
  buckets: ["2026-10-19", "2026-10-20"],
  previousBuckets: ["2026-10-17", "2026-10-18"],
  pricing: { status: "fresh", source: "https://example.test/prices.json", fetchedAt: "2026-10-20T11:00:00.000Z", knownModels: 2_000 },
  models: [
    { providerType: "codex-cli", modelId: "gpt-6.1-sol", rates: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2 }, matchedKey: "gpt-6.1-sol", colorRank: 0 },
    { providerType: "claude-code", modelId: "claude-sonnet-5-5", rates: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }, matchedKey: "claude-sonnet-5-5", colorRank: 1 },
    { providerType: "claude-code", modelId: "sonnet", rates: null, matchedKey: null, colorRank: 2 },
  ],
  projects: [{ projectId: "p1", name: "Kanban", colorRank: 0 }],
  rows: [row("2026-10-19", 0, 1), row("2026-10-20", 0, 2), row("2026-10-20", 1, 0.5), row("2026-10-20", 2, null), row("2026-10-18", 0, 1)],
};

type ReportLoader = (input: UsageCostReportInput) => Promise<UsageCostReport>;

const renderPage = async (loader: ReportLoader = async () => REPORT) => {
  const getUsageCostReport = vi.fn<ReportLoader>(loader);
  const client = createElectronBuildWardenClient({ getUsageCostReport } as unknown as DesktopApi);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <BuildWardenClientProvider client={client}>
      <UsagePage />
    </BuildWardenClientProvider>,
  ));
  return { getUsageCostReport };
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === text);

const kpi = (label: string) =>
  [...(container?.querySelectorAll("p") ?? [])].find((element) => element.textContent === label)?.parentElement?.textContent ?? "";

describe("UsagePage", () => {
  it("loads the default 30-day report with KPIs, charts, and breakdown tables", async () => {
    const { getUsageCostReport } = await renderPage();
    expect(getUsageCostReport).toHaveBeenCalledWith({ rangeDays: 30, refreshPricing: false });
    expect(kpi("Estimated API cost")).toContain(formatUsd(3.5));
    // 3.5 now vs 1 in the previous window.
    expect(kpi("Estimated API cost")).toContain("+250%");
    expect(container?.querySelector('[aria-label^="Estimated cost over time"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label^="Tokens over time"]')).not.toBeNull();
    expect(container?.textContent).toContain("claude-sonnet-5-5");
    expect(container?.textContent).toContain("No price");
    expect(container?.textContent).toContain("Kanban");
  });

  it("offers no price editing", async () => {
    await renderPage();
    expect(buttonByText("Set price")).toBeUndefined();
    expect(buttonByText("Edit")).toBeUndefined();
    expect(container?.querySelector("input")).toBeNull();
  });

  it("filters every number when a model is switched off in the table", async () => {
    await renderPage();
    const toggle = container?.querySelector<HTMLButtonElement>('[aria-label="Include gpt-6.1-sol"]');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(kpi("Estimated API cost")).toContain(formatUsd(0.5));
    expect(buttonByText("Clear filters")).toBeDefined();
    await act(async () => buttonByText("Clear filters")?.click());
    expect(kpi("Estimated API cost")).toContain(formatUsd(3.5));
  });

  it("switches the chart breakdown, shows the table view, and reloads for a new period", async () => {
    const { getUsageCostReport } = await renderPage();
    await act(async () => buttonByText("Token type")?.click());
    expect(container?.textContent).toContain("Cache read");
    await act(async () => buttonByText("Table")?.click());
    expect(container?.querySelector("table th[scope='row']")?.textContent).toBe("Oct 20, 2026");
    await act(async () => buttonByText("7d")?.click());
    expect(getUsageCostReport).toHaveBeenLastCalledWith({ rangeDays: 7, refreshPricing: false });
  });

  it("keeps the latest period when an earlier request answers last", async () => {
    // Hold every answer until the test releases it, so responses can arrive out of order.
    const pending = new Map<number | null, (report: UsageCostReport) => void>();
    await renderPage((input) => new Promise((resolve) => pending.set(input.rangeDays, resolve)));
    await act(async () => buttonByText("7d")?.click());
    const sevenDays: UsageCostReport = { ...REPORT, rangeDays: 7, rows: [row("2026-10-20", 0, 0.25)] };
    await act(async () => pending.get(7)?.(sevenDays));
    expect(kpi("Estimated API cost")).toContain(formatUsd(0.25));
    // The slower 30-day answer for the abandoned request must not replace it.
    await act(async () => pending.get(30)?.(REPORT));
    expect(kpi("Estimated API cost")).toContain(formatUsd(0.25));
    expect(kpi("Estimated API cost")).not.toContain(formatUsd(3.5));
  });

  it("labels the comparison by the loaded report while a new period is pending or fails", async () => {
    let fail: ((error: Error) => void) | undefined;
    await renderPage((input) => input.rangeDays === 30
      ? Promise.resolve(REPORT)
      : new Promise((_resolve, reject) => { fail = reject; }));
    expect(kpi("Estimated API cost")).toContain("vs prior 30 days");
    await act(async () => buttonByText("7d")?.click());
    expect(kpi("Estimated API cost")).toContain("vs prior 30 days");
    await act(async () => fail?.(new Error("offline")));
    expect(kpi("Estimated API cost")).toContain("vs prior 30 days");
    expect(kpi("Estimated API cost")).not.toContain("vs prior 7 days");
  });

  it("renders as a page section, not a modal dialog", async () => {
    await renderPage();
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    expect(container?.querySelector("h1")?.textContent).toBe("Usage & cost");
    expect(container?.querySelector('[aria-label="Close usage dashboard"]')).toBeNull();
  });
});
