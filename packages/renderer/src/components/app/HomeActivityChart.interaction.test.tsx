/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { HomeChartMetric, HomeChartRange } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HomeActivityChart } from "./HomeActivityChart";
import type { HomeChartDay } from "./landing-page-model";
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

const day = (offset: number, runs: number, tokens: number, cost: number | null, failedRuns = 0): HomeChartDay => {
  const date = new Date(2026, 10, 20 + offset);
  return { key: `2026-11-${String(20 + offset)}`, date, runs, failedRuns, tokens, cost };
};

const DAYS = [day(0, 2, 1_000, 0.5), day(1, 0, 0, 0), day(2, 4, 50_000, 2, 1)];

const render = async (props: Partial<Parameters<typeof HomeActivityChart>[0]> = {}) => {
  const onMetricsChange = vi.fn<(metrics: HomeChartMetric[]) => void>();
  const onRangeChange = vi.fn<(range: HomeChartRange) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <HomeActivityChart days={DAYS} metrics={["runs", "tokens", "cost"]} available={["runs", "tokens", "cost"]} range={7}
      onMetricsChange={onMetricsChange} onRangeChange={onRangeChange} {...props} />,
  ));
  return { onMetricsChange, onRangeChange };
};

const chip = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('[aria-label="Chart metrics"] button')].find((button) => button.textContent?.startsWith(label))!;
const lanes = () => [...container!.querySelectorAll<HTMLElement>('[data-ui="home-chart-lane"]')].map((lane) => lane.dataset.metric);

describe("HomeActivityChart", () => {
  it("draws one lane per metric, each scaled to its own busiest day", async () => {
    await render();
    expect(lanes()).toEqual(["runs", "tokens", "cost"]);

    // Read from server markup: the test DOM drops the max() the bar heights are written with.
    const markup = renderToStaticMarkup(
      <HomeActivityChart days={DAYS} metrics={["runs", "tokens", "cost"]} available={["runs", "tokens", "cost"]} range={7} onMetricsChange={vi.fn()} onRangeChange={vi.fn()} />,
    );
    const heights = (metric: string) =>
      [...markup.split(`data-metric="${metric}"`)[1]!.split("data-metric=")[0]!.matchAll(/height:(max\(2px, [\d.]+%\))/g)].map((match) => match[1]);
    // The busiest day fills its lane, whatever the unit; the empty day draws no bar.
    expect(heights("runs")).toEqual(["max(2px, 50%)", "max(2px, 100%)"]);
    expect(heights("tokens")).toEqual(["max(2px, 2%)", "max(2px, 100%)"]);
    expect(heights("cost")).toEqual(["max(2px, 25%)", "max(2px, 100%)"]);
  });

  it("shows the totals of the window on the chips", async () => {
    await render();

    expect(chip("Runs").textContent).toBe("Runs6");
    expect(chip("Cost").textContent).toBe(`Cost${formatUsd(2.5)}`);
  });

  it("switches a metric off and on through its chip, keeping the lane order", async () => {
    const { onMetricsChange } = await render();

    await act(async () => chip("Tokens").click());
    expect(onMetricsChange).toHaveBeenLastCalledWith(["runs", "cost"]);
    expect(chip("Tokens").getAttribute("aria-pressed")).toBe("true");
  });

  it("adds a hidden metric back in its place", async () => {
    const { onMetricsChange } = await render({ metrics: ["cost"] });

    expect(lanes()).toEqual(["cost"]);
    expect(chip("Runs").getAttribute("aria-pressed")).toBe("false");
    await act(async () => chip("Runs").click());
    expect(onMetricsChange).toHaveBeenLastCalledWith(["runs", "cost"]);
  });

  it("never switches the last metric off", async () => {
    const { onMetricsChange } = await render({ metrics: ["runs"] });

    await act(async () => chip("Runs").click());
    expect(onMetricsChange).not.toHaveBeenCalled();
  });

  it("leaves a lane without data out and remembers that the layout asked for it", async () => {
    const { onMetricsChange } = await render({ available: ["runs", "tokens"] });

    expect(lanes()).toEqual(["runs", "tokens"]);
    expect(container!.textContent).not.toContain("Cost");
    await act(async () => chip("Tokens").click());
    expect(onMetricsChange).toHaveBeenLastCalledWith(["runs", "cost"]);
  });

  it("reports a new range", async () => {
    const { onRangeChange } = await render();

    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[aria-label="Chart range"] button')].find((button) => button.textContent === "30d")!.click());
    expect(onRangeChange).toHaveBeenCalledWith(30);
  });

  it("reads single days with the arrow keys, including failed runs", async () => {
    await render();
    const plot = container!.querySelector<HTMLElement>('[role="group"][tabindex="0"]')!;
    const press = (key: string) => act(async () => { plot.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

    await press("ArrowLeft");
    const tooltip = () => container!.querySelector('[data-ui="popover"]')?.textContent ?? "";
    expect(tooltip()).toContain("Today");
    expect(tooltip()).toContain("1 failed");
    await press("Home");
    expect(tooltip()).not.toContain("Today");
    expect(tooltip()).toContain(formatUsd(0.5));
    await press("Escape");
    expect(container!.querySelector('[data-ui="popover"]')).toBeNull();
  });

  it("says so when the window holds no activity", async () => {
    await render({ days: [day(0, 0, 0, null), day(1, 0, 0, null)], available: ["runs", "tokens"] });

    expect(container!.textContent).toContain("No activity in the last 2 days");
  });
});
