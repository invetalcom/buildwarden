/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import { RunDiffPanel } from "./RunDiffPanel";
import { summarizeDiffStats } from "./git-diff-utils";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => <div data-diff-path={fileDiff.name}>Rendered diff</div>,
}));

const patch = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n+new\n+more\n`;
const added = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hello\n`;
const diff = patch("src/app/main.ts") + added("Cargo.toml");

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (props: Partial<Parameters<typeof RunDiffPanel>[0]> = {}) => root.render(
  <RunDiffPanel runId="run-1" diffText={diff} diffStats={summarizeDiffStats(diff)} diffLoaded diffPending={false}
    onRequestDiff={() => undefined} onOpenFile={() => undefined} review={null} {...props} />,
);
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const fileRows = () => [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].map((row) => row.title);

describe("RunDiffPanel", () => {
  it("summarizes the change set and labels each file with its git status", async () => {
    await act(async () => render());
    expect(container.textContent).toContain("2 files");
    expect(fileRows()).toEqual(["src/app/main.ts", "Cargo.toml"]);
    expect(container.querySelector('[aria-label="Modified"]')?.textContent).toBe("M");
    expect(container.querySelector('[aria-label="Added"]')?.textContent).toBe("A");
  });

  it("filters files and expands all visible files from the toolbar", async () => {
    await act(async () => render());
    await act(async () => button("Filter files").click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter changed files"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cargo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fileRows()).toEqual(["Cargo.toml"]);
    await act(async () => button("Expand all files").click());
    expect([...container.querySelectorAll("[data-diff-path]")].map((node) => node.getAttribute("data-diff-path"))).toEqual(["Cargo.toml"]);
    expect(button("Collapse all files")).toBeTruthy();
  });

  it("shows the loading status while the patch is pending", async () => {
    await act(async () => render({ diffText: "", diffLoaded: false, diffPending: true }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading file diffs");
  });
});
