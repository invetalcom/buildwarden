/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DESIGN_ASSET_MAX_BYTES, type DesignAsset, type DesignCustomization } from "@buildwarden/shared";
import { DesignMotionSection } from "./DesignMotionSection";

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
  vi.unstubAllGlobals();
});

const SVG = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
const svgAsset: DesignAsset = { type: "image/svg+xml", data: SVG };

const stubFileReader = (data: string) => vi.stubGlobal("FileReader", class {
  result = `data:application/octet-stream;base64,${data}`;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() { queueMicrotask(() => this.onload?.()); }
});

const setup = async (customization?: DesignCustomization) => {
  const handlers = { onMotion: vi.fn(), onIndicator: vi.fn(), onAsset: vi.fn(), onReset: vi.fn(), onError: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<DesignMotionSection customization={customization} busy={false} {...handlers} />));
  return { host: container, ...handlers };
};

const choose = async (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
};

describe("DesignMotionSection", () => {
  it("lists every indicator with the app's own look selected and a live sample of the real components", async () => {
    const { host } = await setup();
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"], button[aria-label$=" style"]')];
    expect(triggers.length).toBeGreaterThanOrEqual(9);
    expect(host.textContent).toContain("Circle (default)");
    expect(host.textContent).toContain("Still dot (default)");
    expect(host.querySelector('[data-ui="settings-row"] [data-ui="spinner"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="settings-row"] [data-ui="status-dot"][data-state="running"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="settings-row"] [data-ui="working"]')).not.toBeNull();
    // Nothing is changed yet, so there is nothing to reset.
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Default motion")).toBe(false);
  });

  it("reports a chosen look, and the app's own look as no choice", async () => {
    const { host, onIndicator } = await setup({ indicators: { spinner: "dots" } });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Spinner style"]')!;
    expect(trigger.textContent).toContain("Dots");
    await act(async () => trigger.click());
    const option = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((entry) => entry.textContent === label)!;
    await act(async () => option("Bars").click());
    expect(onIndicator).toHaveBeenLastCalledWith("spinner", "bars");
    await act(async () => trigger.click());
    await act(async () => option("Circle (default)").click());
    expect(onIndicator).toHaveBeenLastCalledWith("spinner", undefined);
  });

  it("asks for an image once an image look is chosen, one per run state for the run status", async () => {
    const { host, onAsset } = await setup({ indicators: { runStatus: "image", spinner: "shape" }, assets: { spinner: svgAsset } });
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="file"]')].map((input) => input.getAttribute("aria-label"));
    expect(inputs).toEqual(expect.arrayContaining(["Choose image: run-status", "Choose image: run-status-running", "Choose image: run-status-failed", "Choose image: spinner"]));
    // The run status has no image yet, the spinner has one.
    expect(host.textContent).toContain("Until then the default look stays.");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove image: spinner"]')!.click());
    expect(onAsset).toHaveBeenCalledWith("spinner", null);
  });

  it("stores a chosen file under the indicator's image name with the type its bytes have", async () => {
    stubFileReader(SVG);
    const { host, onAsset, onError } = await setup({ indicators: { spinner: "image" } });
    // The file claims to be a PNG; its bytes are an SVG.
    await choose(host.querySelector<HTMLInputElement>('input[aria-label="Choose image: spinner"]')!, new File(["x"], "anything.png", { type: "image/png" }));
    expect(onAsset).toHaveBeenCalledWith("spinner", svgAsset);
    expect(onError).toHaveBeenLastCalledWith("");
  });

  it("names a free image after its file, or after the name that was typed", async () => {
    stubFileReader(SVG);
    const { host, onAsset } = await setup();
    const add = host.querySelector<HTMLInputElement>('input[aria-label="Add theme image"]')!;
    await choose(add, new File(["x"], "Night Sky.svg"));
    expect(onAsset).toHaveBeenLastCalledWith("night-sky", svgAsset);
  });

  it("refuses a file that is too large or no image, and says why", async () => {
    stubFileReader(btoa("<html>not an image</html>"));
    const { host, onAsset, onError } = await setup();
    const add = host.querySelector<HTMLInputElement>('input[aria-label="Add theme image"]')!;
    await choose(add, new File(["x"], "page.html"));
    expect(onError).toHaveBeenLastCalledWith("Choose an SVG, GIF, PNG or WebP image.");
    await choose(add, new File([new Uint8Array(DESIGN_ASSET_MAX_BYTES + 1)], "huge.gif"));
    expect(onError).toHaveBeenLastCalledWith("A theme image is limited to 64 KB.");
    expect(onAsset).not.toHaveBeenCalled();
  });

  it("offers to return to the default motion once something is set", async () => {
    const { host, onReset, onMotion } = await setup({ motion: { reduce: "always" } });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Default motion")!.click());
    expect(onReset).toHaveBeenCalledOnce();
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "follow system")!.click());
    expect(onMotion).toHaveBeenLastCalledWith({ reduce: "system" });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "default")!.click());
    expect(onMotion).toHaveBeenLastCalledWith({ reduce: undefined });
  });
});
