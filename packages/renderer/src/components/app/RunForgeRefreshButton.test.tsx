/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunForgeRefreshButton } from "./RunForgeRefreshButton";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); });

it("only requests an explicit manual refresh when clicked, including before a PR is linked", async () => {
  const refreshRunForgeRequest = vi.fn(async () => null);
  const client = { refreshRunForgeRequest } as unknown as BuildWardenClient;
  await act(() => root.render(<BuildWardenClientProvider client={client}><RunForgeRefreshButton runId="run" /></BuildWardenClientProvider>));
  expect(refreshRunForgeRequest).not.toHaveBeenCalled();
  await act(() => container.querySelector("button")!.click());
  expect(refreshRunForgeRequest).toHaveBeenCalledExactlyOnceWith("run");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("No matching PR/MR found.");
  expect(container.querySelector('[role="status"]')?.classList.contains("sr-only")).toBe(false);
});

it("reports lookup errors instead of calling them a missing PR", async () => {
  const client = { refreshRunForgeRequest: vi.fn(async () => { throw new Error("Add a hosting token"); }) } as unknown as BuildWardenClient;
  await act(() => root.render(<BuildWardenClientProvider client={client}><RunForgeRefreshButton runId="run" /></BuildWardenClientProvider>));
  await act(() => container.querySelector("button")!.click());
  expect(container.querySelector("button")?.title).toBe("Add a hosting token");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Add a hosting token");
});
