/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HoverCard } from "./hover-card";

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
  vi.useRealTimers();
});

const renderHoverCard = async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <HoverCard content={<p>Expanded prompt context</p>}>
        <button type="button">Agent run</button>
      </HoverCard>,
    );
  });
  return container.querySelector("button")!;
};

describe("HoverCard", () => {
  it("opens after hovering and renders its content in a portal", async () => {
    vi.useFakeTimers();
    const button = await renderHoverCard();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });

    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toContain("Expanded prompt context");
    expect(tooltip?.parentElement).toBe(document.body);
    expect(tooltip?.classList.contains("glass-popover")).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);
  });

  it("opens immediately for keyboard focus", async () => {
    const button = await renderHoverCard();

    await act(async () => button.focus());

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Expanded prompt context");
  });

  it.each([0, 320])("dismisses a mouse-focused run when leaving after %i ms of hovering", async (hoverTime) => {
    vi.useFakeTimers();
    const button = await renderHoverCard();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      // Synthetic pointer events do not perform the browser's default focus action.
      button.focus();
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      button.click();
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(hoverTime);
    });
    expect(Boolean(document.querySelector('[role="tooltip"]'))).toBe(hoverTime === 320);

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("stops retaining keyboard hover content after clicking the focused trigger", async () => {
    vi.useFakeTimers();
    const button = await renderHoverCard();
    await act(async () => button.focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      button.click();
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => button.blur());
    await act(async () => button.focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("stays open on pointer exit while the trigger retains keyboard focus", async () => {
    const button = await renderHoverCard();

    await act(async () => button.focus());
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Expanded prompt context");

    await act(async () => button.blur());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
