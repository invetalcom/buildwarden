/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { UsageLineChart } from "./UsageCharts";
import type { UsageTimeSeries } from "./usage-analytics";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container.remove(); });

const data: UsageTimeSeries = {
  bucketSize: "day",
  buckets: ["2026-10-01", "2026-10-02", "2026-10-03"],
  series: [
    { key: "a", label: "Model A", color: "red", values: [2, 0, 2] },
    { key: "b", label: "Model B", color: "blue", values: [3, 0, 1] },
  ],
};

const render = async (series = data) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<UsageLineChart data={series} formatValue={String} formatAxis={String} ariaLabel="Usage over time" />));
};

describe("UsageLineChart", () => {
  it("plots independent series on their own scale and connects zero-usage buckets", async () => {
    await render();
    const paths = container.querySelectorAll("path[data-series-key]");
    expect(paths).toHaveLength(2);
    // Model B's maximum of 3 reaches the top. Stacking the total of 5 would not.
    expect(paths[1]?.getAttribute("d")).toBe("M144,18 L340,186 L536,130");
    expect(paths[0]?.getAttribute("d")).toBe("M144,74 L340,186 L536,74");
    expect(paths[0]?.getAttribute("fill")).toBe("none");
    expect(paths[0]?.getAttribute("stroke")).toBe("red");
  });

  it("shows totals and individual values through keyboard and touch interaction", async () => {
    await render();
    const chart = container.querySelector('[role="group"]')!;
    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("5");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("3Model B");
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Oct 2, 2026");
    expect(container.querySelector('[role="status"] p:nth-child(2)')?.textContent).toBe("0");
    await act(async () => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="status"]')).toBeNull();
    const targets = container.querySelectorAll('rect[fill="transparent"]');
    await act(async () => targets[2]?.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Oct 3, 2026");
  });

  it("renders visible points for a single bucket and an empty state for zero usage", async () => {
    await render({ ...data, buckets: [data.buckets[0]!], series: data.series.map((entry) => ({ ...entry, values: [entry.values[0]!] })) });
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    await act(async () => root?.render(<UsageLineChart data={{ ...data, series: [{ ...data.series[0]!, values: [9, 0, 1] }] }} integerTicks formatValue={String} formatAxis={String} ariaLabel="Runs" />));
    const tickLabels = [...container.querySelectorAll("svg text[text-anchor='end']")].map((tick) => Number(tick.textContent));
    expect(tickLabels.length).toBeGreaterThan(1);
    expect(tickLabels.every(Number.isInteger)).toBe(true);
    await act(async () => root?.render(<UsageLineChart data={{ ...data, series: [] }} formatValue={String} formatAxis={String} ariaLabel="Usage" />));
    expect(container.textContent).toContain("No usage in this period");
    expect(container.querySelector("svg")).toBeNull();
  });
});
