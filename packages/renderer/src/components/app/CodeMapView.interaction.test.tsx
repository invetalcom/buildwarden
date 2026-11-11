/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCodeMapResult } from "@buildwarden/shared";
import { CodeMapView } from "./CodeMapView";
import { buildCodeMapTree, codeMapChangesFromDiff, layoutCodeMap } from "./code-map-model";

const WIDTH = 800;
const HEIGHT = 600;
const scan: WorkspaceCodeMapResult = {
  files: [
    { path: "src/app/main.ts", lines: 300, imports: [1] },
    { path: "src/app/util.ts", lines: 200 },
    { path: "docs/guide.md", lines: 500 },
  ],
  truncated: false,
  workspaceUnavailable: false,
};
const diff = "diff --git a/src/app/util.ts b/src/app/util.ts\n--- a/src/app/util.ts\n+++ b/src/app/util.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  // happy-dom lays nothing out, so the surface size is supplied the way a browser would report it.
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback([{ contentRect: { width: WIDTH, height: HEIGHT } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (props: Partial<Parameters<typeof CodeMapView>[0]> = {}) => {
  const onSelectChange = vi.fn();
  await act(async () => root.render(
    <CodeMapView load={async () => scan} diffText={diff} onSelectChange={onSelectChange} {...props} />,
  ));
  return onSelectChange;
};
const surface = () => container.querySelector<HTMLDivElement>('[role="group"]')!;
const pointAt = (path: string, focusPath = "") => {
  const tree = buildCodeMapTree(scan.files, codeMapChangesFromDiff(diff));
  const rect = layoutCodeMap(tree.folders.get(focusPath)!, WIDTH, HEIGHT).find((entry) => entry.node.path === path)!;
  // Folders are hit on their label strip; their body belongs to the files inside.
  return { clientX: rect.x + rect.width / 2, clientY: rect.y + (rect.node.children ? 5 : rect.height / 2) };
};
const mouse = async (type: string, point: { clientX: number; clientY: number }) => {
  await act(async () => surface().dispatchEvent(new MouseEvent(type, { bubbles: true, ...point })));
};

describe("CodeMapView", () => {
  it("summarizes the scanned workspace and its changed files", async () => {
    await render();
    expect(container.textContent).toContain("1.0k lines");
    expect(container.textContent).toContain("3 files");
    expect(container.textContent).toContain("1 changed");
    expect(surface().getAttribute("aria-label")).toContain("3 files, 1 changed");
  });

  it("describes the hovered file and opens a changed file when it is clicked", async () => {
    const onSelectChange = await render();
    await mouse("mousemove", pointAt("src/app/util.ts"));
    expect(container.textContent).toContain("src/app/util.ts");
    expect(container.textContent).toContain("+2");
    expect(container.textContent).toContain("imported by 1");
    await mouse("click", pointAt("src/app/util.ts"));
    expect(onSelectChange).toHaveBeenCalledExactlyOnceWith("src/app/util.ts");
    await mouse("click", pointAt("src/app/main.ts"));
    expect(onSelectChange).toHaveBeenCalledTimes(1);
  });

  it("zooms into a clicked folder and back out through the breadcrumb or Escape", async () => {
    await render();
    await mouse("click", pointAt("src/app"));
    const zoomOut = container.querySelector<HTMLButtonElement>('button[title="Zoom out to the repository"]')!;
    expect(zoomOut.textContent).toBe("repo");
    expect(container.textContent).toContain("src/app");
    await act(async () => zoomOut.click());
    expect(container.querySelector('button[title="Zoom out to the repository"]')).toBeNull();

    await mouse("click", pointAt("src/app"));
    await act(async () => surface().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('button[title="Zoom out to the repository"]')).toBeNull();
  });

  it("explains an unavailable workspace and a failed scan, and rescans on request", async () => {
    await render({ load: async () => ({ files: [], truncated: false, workspaceUnavailable: true }) });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("not available");

    const load = vi.fn<(refresh: boolean) => Promise<WorkspaceCodeMapResult>>().mockRejectedValueOnce(new Error("scan failed")).mockResolvedValue(scan);
    await render({ load });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("scan failed");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Rescan the repository"]')!.click());
    // Opening the map accepts a scan the caller already has; only the rescan button demands a new one.
    expect(load.mock.calls).toEqual([[false], [true]]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("3 files");
  });
});
