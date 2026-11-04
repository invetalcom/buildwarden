/** @vitest-environment happy-dom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, SubscriptionLimitsReport } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { AppTitleBar } from "./AppTitleBar";
import { TitleBarLimits } from "./TitleBarLimits";

let root: Root;
let container: HTMLDivElement;
const now = Date.parse("2026-11-04T12:00:00Z");
const report: SubscriptionLimitsReport = { accounts: [
  { id: "codex", label: "Codex", providerType: "codex-cli", status: "fresh", checkedAt: new Date(now).toISOString(), plan: "plus",
    windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 60, resetsAt: new Date(now + 86400_000).toISOString() }], resetCredits: { availableCount: 2 } },
  { id: "claude", label: "Claude", providerType: "claude-code", status: "unavailable", checkedAt: new Date(now).toISOString(), windows: [], message: "Check the provider CLI login." },
  { id: "cursor", label: "Cursor", providerType: "cursor-agent", status: "cached", checkedAt: new Date(now).toISOString(), windows: [{ id: "monthly", label: "Monthly", kind: "monthly", usedPercent: 10 }] },
] };
beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function render() {
  const getSubscriptionLimits = vi.fn(async () => report);
  const useSubscriptionReset = vi.fn();
  const onOpenLimits = vi.fn();
  const client = createElectronBuildWardenClient({ getSubscriptionLimits, useSubscriptionReset } as unknown as DesktopApi);
  await act(async () => root.render(<StrictMode><AppTitleBar uiTheme="dark" onOpenMenu={vi.fn()}
    trailing={<TitleBarLimits client={client} onOpenLimits={onOpenLimits} />} /></StrictMode>));
  return { getSubscriptionLimits, useSubscriptionReset, onOpenLimits };
}
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Subscription limits"]')!;
const click = async (label: string) => { await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); };

describe("title bar subscription limits", () => {
  it("uses a compact non-draggable icon and reads limits only after opening", async () => {
    const { getSubscriptionLimits, useSubscriptionReset } = await render();
    expect(getSubscriptionLimits).not.toHaveBeenCalled();
    expect(trigger().parentElement?.className).toContain("no-drag");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("");
    await click("Subscription limits");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const panel = document.querySelector("dialog")!;
    expect(panel.id).toBe(trigger().getAttribute("aria-controls"));
    expect(panel.textContent).toContain("40% left");
    expect(panel.textContent).toContain("60% used");
    expect(panel.textContent).toContain("Resets in 1d 0h");
    expect(panel.textContent).toContain("2 reset credits");
    expect(panel.textContent).toContain("Check the provider CLI login");
    expect(panel.textContent).toContain("Cached");
    expect(panel.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(useSubscriptionReset).not.toHaveBeenCalled();
  });
  it("refreshes on request and while open, then stops polling on close", async () => {
    const { getSubscriptionLimits } = await render();
    await click("Subscription limits"); await click("Refresh limits");
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: true });
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: false });
    await click("Close limits");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    const calls = getSubscriptionLimits.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(getSubscriptionLimits).toHaveBeenCalledTimes(calls);
  });
  it("opens the full Limits view and dismisses the popover", async () => {
    const { onOpenLimits } = await render();
    await click("Subscription limits");
    const open = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Open Limits")!;
    await act(async () => open.click());
    expect(onOpenLimits).toHaveBeenCalledOnce();
    expect(document.querySelector("dialog")).toBeNull();
  });
  it("preserves the previous reading and allows retry after a failed refresh", async () => {
    const { getSubscriptionLimits } = await render();
    await click("Subscription limits");
    getSubscriptionLimits.mockRejectedValueOnce(new Error("offline"));
    await click("Refresh limits");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Showing the previous reading");
    expect(document.querySelector("dialog")?.textContent).toContain("40% left");
    await click("Refresh limits");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("dismisses on Escape or a backdrop click, but not on a drag from inside", async () => {
    await render(); await click("Subscription limits");
    const panel = document.querySelector("dialog")!;
    await act(async () => {
      panel.querySelector("h2")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector("dialog")).not.toBeNull();
    await act(async () => {
      panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector("dialog")).toBeNull();
    await click("Subscription limits");
    await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel")));
    expect(document.querySelector("dialog")).toBeNull();
  });
});
