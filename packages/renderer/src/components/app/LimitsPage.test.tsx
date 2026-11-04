/** @vitest-environment happy-dom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, SubscriptionLimitsReport } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { LimitsPage } from "./LimitsPage";

let root: Root;
let container: HTMLDivElement;
const now = Date.parse("2026-11-04T12:00:00Z");
const report = (): SubscriptionLimitsReport => ({ accounts: [
  { id: "codex", label: "Codex", providerType: "codex-cli", status: "fresh", checkedAt: new Date(now).toISOString(), plan: "plus",
    windows: [{ id: "session", label: "Session", kind: "session", usedPercent: 85, resetsAt: new Date(now + 60 * 60_000).toISOString() }],
    resetCredits: { availableCount: 2, actionToken: "confirmation-token", nextExpiresAt: new Date(now + 86400_000).toISOString() } },
  { id: "claude", label: "Claude", providerType: "claude-code", status: "unavailable", checkedAt: new Date(now).toISOString(), windows: [], message: "Check the provider CLI login." },
  { id: "cursor", label: "Cursor", providerType: "cursor-agent", status: "fresh", checkedAt: new Date(now).toISOString(), windows: [{ id: "monthly", label: "Monthly", kind: "monthly", usedPercent: 20 }] },
] });
beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function render(options: { settings?: boolean; data?: SubscriptionLimitsReport } = {}) {
  const getSubscriptionLimits = vi.fn(async () => options.data ?? report());
  const useSubscriptionReset = vi.fn(async () => ({ outcome: "reset" as const, report: report() }));
  const base = createElectronBuildWardenClient({ getSubscriptionLimits, useSubscriptionReset } as unknown as DesktopApi);
  const client = { ...base, capabilities: { ...base.capabilities, settings: options.settings ?? true } };
  await act(async () => root.render(<StrictMode><BuildWardenClientProvider client={client}><LimitsPage /></BuildWardenClientProvider></StrictMode>));
  return { getSubscriptionLimits, useSubscriptionReset };
}
const button = (text: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };

describe("Limits dashboard", () => {
  it("shows provider percentages and reset schedules, with no manual reset for Cursor", async () => {
    await render();
    expect(container.textContent).toContain("85% used");
    expect(container.textContent).toContain("15% left");
    expect(container.textContent).toContain("Resets in 1h 0m");
    expect(container.textContent).toContain("Check the provider CLI login");
    expect(container.textContent).toContain("Cursor resets on its billing schedule");
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("85");
  });
  it("only consumes a reset after confirmation, and cancel spends nothing", async () => {
    const { useSubscriptionReset } = await render();
    await click("Use reset");
    expect(document.querySelector("dialog")?.textContent).toContain("cannot be undone");
    expect(useSubscriptionReset).not.toHaveBeenCalled();
    await click("Cancel");
    expect(document.querySelector("dialog")).toBeNull();
    await click("Use reset");
    await click("Use reset credit");
    expect(useSubscriptionReset).toHaveBeenCalledExactlyOnceWith({ accountId: "codex", actionToken: "confirmation-token" });
    expect(container.textContent).toContain("Reset applied");
  });
  it("disables reset actions for read-only clients and cached readings", async () => {
    await render({ settings: false });
    expect(button("Use reset").disabled).toBe(true);
    const cached = report(); cached.accounts[0]!.status = "cached";
    await render({ data: cached });
    expect(button("Use reset").disabled).toBe(true);
    expect(container.textContent).toContain("cached");
  });
  it("refreshes manually and on its five-minute schedule", async () => {
    const { getSubscriptionLimits } = await render();
    await click("Refresh");
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: true });
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(getSubscriptionLimits).toHaveBeenLastCalledWith({ refresh: false });
    expect(button("Use reset").disabled).toBe(true);
  });
  it("keeps failed reset outcomes visible without claiming the credit was consumed", async () => {
    const { useSubscriptionReset } = await render();
    useSubscriptionReset.mockRejectedValueOnce(new Error("Could not confirm. Retry to check the same request."));
    await click("Use reset"); await click("Use reset credit");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
    expect(container.textContent).not.toContain("Reset applied");
    expect(button("Use reset").disabled).toBe(false);
  });
});
