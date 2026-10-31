/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { RelativeTime } from "./DetailHeader";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.useRealTimers());

it("refreshes the relative label while mounted and stops on unmount", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() => root.render(<RelativeTime value="2026-01-01T12:00:00.000Z" prefix="saved" />));
  expect(container.textContent).toBe("saved just now");

  await act(() => { vi.advanceTimersByTime(3 * 60_000); });
  expect(container.textContent).toBe("saved 3m ago");

  await act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
