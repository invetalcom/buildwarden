/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HomeLayoutSettingsSection } from "./settings-home-section";

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

const render = async (layout: HomeLayout = DEFAULT_HOME_LAYOUT, costTrackingEnabled = true) => {
  const onChange = vi.fn<(layout: HomeLayout) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<HomeLayoutSettingsSection layout={layout} busy={false} costTrackingEnabled={costTrackingEnabled} onChange={onChange} />));
  return onChange;
};

const control = (label: string) => container!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (label: string) => act(async () => control(label).click());

describe("HomeLayoutSettingsSection", () => {
  it("switches a section on at the end of the list and reorders the ones that show", async () => {
    const onChange = await render();

    await click("Show Projects on the Home page");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_HOME_LAYOUT, sections: ["greeting", "summary", "stats", "runs", "projects"] });
    await click("Move Recent runs earlier");
    expect(onChange.mock.lastCall![0].sections).toEqual(["greeting", "summary", "runs", "stats", "projects"]);
  });

  it("keeps at least one figure and one chart metric on", async () => {
    const onChange = await render({ ...DEFAULT_HOME_LAYOUT, stats: ["running"], chart: { ...DEFAULT_HOME_LAYOUT.chart, metrics: ["tokens"] } });

    expect(control("Show Running now in the numbers").disabled).toBe(true);
    expect(control("Show Tokens in the chart").disabled).toBe(true);
    await click("Show Cost in the chart");
    expect(onChange.mock.lastCall![0].chart.metrics).toEqual(["tokens", "cost"]);
  });

  it("switches off the controls of a section or chart that does not show", async () => {
    await render({ ...DEFAULT_HOME_LAYOUT, sections: ["greeting"], chart: { ...DEFAULT_HOME_LAYOUT.chart, show: false } });

    expect(control("Show Today in the numbers").disabled).toBe(true);
    expect(control("Show Runs in the chart").disabled).toBe(true);
    expect(container!.querySelector<HTMLInputElement>('[aria-label="Greeting text"]')!.disabled).toBe(false);
  });

  it("offers Reset only for a changed layout and resets to the default", async () => {
    await render();
    expect([...container!.querySelectorAll("button")].some((button) => button.textContent === "Reset")).toBe(false);
    await act(async () => root?.unmount());
    container?.remove();

    const onChange = await render({ ...DEFAULT_HOME_LAYOUT, position: "top" });
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent === "Reset")!.click());
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_HOME_LAYOUT);
  });

  it("says why Cost has nothing to show while cost tracking is off", async () => {
    await render(DEFAULT_HOME_LAYOUT, false);

    expect(container!.textContent).toContain("Cost needs cost tracking, which is off.");
  });
});
