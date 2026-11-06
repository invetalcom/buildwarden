/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDetail, RunRewindResult } from "@buildwarden/shared";
import { RunRewindControls } from "./RunRewindControls";

vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => ({
  capabilities: { runMutations: true, gitMutations: true }, getRunRewindHistory: async () => [],
}) }));
const point = { id: "point", stepId: "step", prompt: "Original prompt", createdAt: "2026-11-05T00:00:00Z", commandType: "follow-up" as const, filesAvailable: true };
const detail = { run: { id: "run" }, promptRestorePoints: [point] } as RunDetail;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function mount(props: Partial<Parameters<typeof RunRewindControls>[0]> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const result: RunRewindResult = { prompt: "Original prompt", attachments: [], providerStrategy: "fresh-session" };
  const onRewind = vi.fn(async () => result);
  const onPrepared = vi.fn();
  await act(async () => root.render(<RunRewindControls detail={detail} disabled={false} onRewind={onRewind} onPrepared={onPrepared} {...props} />));
  cleanups.push(async () => { await act(async () => root.unmount()); });
  return { container, onRewind, onPrepared, result };
}

describe("rewind controls", () => {
  it("makes the mode explicit and returns the original prompt for editing", async () => {
    const h = await mount();
    const select = h.container.querySelector<HTMLSelectElement>('[aria-label="Rewind mode"]')!;
    expect(select.value).toBe("conversation");
    await act(async () => { select.value = "conversation-and-files"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => h.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(h.onRewind).toHaveBeenCalledWith({ runId: "run", restorePointId: "point", mode: "conversation-and-files" });
    expect(h.onPrepared).toHaveBeenCalledWith(h.result);
    expect(h.container.textContent).toContain("fresh session");
  });
  it("locks a pending retry to its original boundary and mode", async () => {
    const pendingRewind = { runId: "run", restorePointId: "point", mode: "conversation-and-files" as const };
    const h = await mount({ detail: { ...detail, pendingRewind } });
    expect(h.container.querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
    expect([...h.container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
    await act(async () => h.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(h.onRewind).toHaveBeenCalledWith(pendingRewind);
  });
  it("does not edit the draft when restoration fails", async () => {
    const onRewind = vi.fn(async () => { throw new Error("Workspace has new commits"); });
    const h = await mount({ onRewind });
    await act(async () => h.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(h.onPrepared).not.toHaveBeenCalled();
    expect(h.container.textContent).toContain("new commits");
  });
});
