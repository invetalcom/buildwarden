/** @vitest-environment happy-dom */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseStorageInfo } from "@buildwarden/shared";
import { DatabaseCompactControl } from "./DatabaseCompactControl";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const MB = 1024 * 1024;
const storage = (totalMb: number, freeMb: number, walMb = 0): DatabaseStorageInfo => ({
  totalBytes: totalMb * MB,
  fileBytes: (totalMb - walMb) * MB,
  walBytes: walMb * MB,
  freeBytes: freeMb * MB,
});

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const render = async (element: ReactElement): Promise<HTMLDivElement> => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
};

const reclaimButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Reclaim space"));

describe("DatabaseCompactControl", () => {
  it("shows the footprint, compacts on request, and reports the reclaimed space", async () => {
    const onLoadInfo = vi.fn()
      .mockResolvedValueOnce(storage(120, 30, 4))
      .mockResolvedValueOnce(storage(70, 0));
    const onCompact = vi.fn(async () => ({ beforeBytes: 120 * MB, afterBytes: 70 * MB, reclaimedBytes: 50 * MB }));
    const host = await render(<DatabaseCompactControl disabled={false} onLoadInfo={onLoadInfo} onCompact={onCompact} />);

    expect(host.textContent).toContain("120 MB on disk (4 MB log) · 30 MB in free pages");
    await act(async () => reclaimButton(host)?.click());

    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Reclaimed 50 MB (120 MB → 70 MB).");
    expect(host.textContent).toContain("70 MB on disk");
    expect(host.textContent).not.toContain("log)");
    expect(host.textContent).not.toContain("free pages");
  });

  it("shows a compaction failure without losing the footprint", async () => {
    const onLoadInfo = vi.fn(async () => storage(10, 0));
    const onCompact = vi.fn(async () => { throw new Error("database or disk is full"); });
    const host = await render(<DatabaseCompactControl disabled={false} onLoadInfo={onLoadInfo} onCompact={onCompact} />);

    await act(async () => reclaimButton(host)?.click());

    expect(host.textContent).toContain("database or disk is full");
    expect(host.textContent).toContain("10 MB on disk");
    expect(reclaimButton(host)?.disabled).toBe(false);
  });
});
