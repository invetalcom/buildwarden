/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunForgeRequestSummary } from "@buildwarden/shared";
import { RunForgeBadge } from "./RunForgeBadge";

let container: HTMLDivElement;
let root: Root;
const request = {
  state: "open", provider: "github", number: 42, title: "Improve discovery",
  url: "https://github.com/acme/repo/pull/42", readiness: "pending", draft: false,
  checks: { completed: 1, total: 2 }, lastSyncedAt: "2026-10-31T10:00:00.000Z", stale: false,
} as RunForgeRequestSummary;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it.each([null, { ...request, state: "closed" as const }, { ...request, state: "merged" as const }])("hides absent and terminal requests (%j)", async (value) => {
  await act(() => root.render(<RunForgeBadge request={value} onOpen={vi.fn()} />));
  expect(container.querySelector("button")).toBeNull();
});

it("opens the request without activating the run, and labels draft/stale status", async () => {
  const onOpen = vi.fn(async () => ({ ok: true }));
  const onSelect = vi.fn();
  await act(() => root.render(<div onClick={onSelect}>
    <RunForgeBadge request={{ ...request, draft: true, stale: true }} onOpen={onOpen} />
  </div>));
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Open draft PR #42: Improve discovery, Waiting, 1/2 checks (status may be outdated)");
  expect(button.title).toContain("1/2 checks");
  expect(button.tabIndex).toBe(0);
  await act(() => button.click());
  expect(onOpen).toHaveBeenCalledWith(request.url);
  expect(onSelect).not.toHaveBeenCalled();
});

it.each([false, true])("announces failed opens, including rejected promises (%s)", async (reject) => {
  const onOpen = vi.fn(async () => { if (reject) throw new Error("Failed"); return { ok: false }; });
  await act(() => root.render(<RunForgeBadge request={{ ...request, provider: "gitlab" }} onOpen={onOpen} />));
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toContain("MR #42");
  await act(() => button.click());
  expect(button.title).toContain("Could not open the request");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Could not open the request. Try again.");
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  onOpen.mockResolvedValue({ ok: true });
  await act(() => button.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
});

it("does not announce unchecked counts as current status", async () => {
  await act(() => root.render(<RunForgeBadge request={{ ...request, statusLastSyncedAt: null }} onOpen={vi.fn()} />));
  const label = container.querySelector("button")!.getAttribute("aria-label");
  expect(label).toContain("Detailed status not checked");
  expect(label).not.toContain("1/2 checks");
});
