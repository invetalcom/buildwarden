/** @vitest-environment happy-dom */

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import { GitDiffPreview, type GitDiffPreviewHandle } from "./git-diff-preview";

// Exercise our loading/state behavior without starting the syntax highlighter in happy-dom.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => <div data-diff-path={fileDiff.name}>Rendered diff</div>,
}));

const patch = (path: string, text = "new") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;

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
  delete document.body.dataset.theme;
});

const header = (path: string) => container.querySelector<HTMLButtonElement>(`button[title="${path}"]`)!;
const expandedPaths = () => [...container.querySelectorAll("[data-diff-path]")].map((node) => node.getAttribute("data-diff-path"));

describe("GitDiffPreview loading and expansion", () => {
  it.each(["light", "dark"])("remembers an expansion requested before the patch arrives in %s theme", async (theme) => {
    document.body.dataset.theme = theme;
    const pendingFiles = [{ path: "src/a.ts", previousPath: null, additions: 1, deletions: 1 }];
    await act(async () => root.render(<GitDiffPreview diffText="" pendingFiles={pendingFiles} loading emptyMessage="Empty" />));
    await act(async () => header("src/a.ts").click());
    expect(header("src/a.ts").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Loading file diff");

    await act(async () => root.render(<GitDiffPreview diffText={patch("src/a.ts")} emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual(["src/a.ts"]);
    expect(container.textContent).not.toContain("Loading file diff");
  });

  it("keeps the button and expanded file mounted during refresh and unrelated rerenders", async () => {
    const render = (loading = false, className = "") => root.render(
      <GitDiffPreview diffText={patch("src/a.ts")} loading={loading} className={className} emptyMessage="Empty" />,
    );
    await act(async () => render());
    const button = header("src/a.ts");
    await act(async () => button.click());
    const body = container.querySelector("[data-diff-path]");
    await act(async () => render(true, "updated"));
    expect(header("src/a.ts")).toBe(button);
    expect(container.querySelector("[data-diff-path]")).toBe(body);
    expect(expandedPaths()).toEqual(["src/a.ts"]);
  });

  it("preserves expansion through patch changes, inserted files, and filters", async () => {
    await act(async () => root.render(<GitDiffPreview diffText={patch("src/a.ts")} emptyMessage="Empty" />));
    await act(async () => header("src/a.ts").click());
    const updated = patch("src/b.ts") + patch("src/a.ts", "updated");
    await act(async () => root.render(<GitDiffPreview diffText={updated} emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual(["src/a.ts"]);
    await act(async () => root.render(<GitDiffPreview diffText={updated} filePathQuery="b.ts" emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual([]);
    await act(async () => root.render(<GitDiffPreview diffText={updated} emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual(["src/a.ts"]);
  });

  it("keeps staged and unstaged sections for the same path independently expandable", async () => {
    await act(async () => root.render(<GitDiffPreview diffText={patch("src/a.ts") + patch("src/a.ts", "staged")} emptyMessage="Empty" />));
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[title="src/a.ts"]');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1]!.click());
    expect(buttons[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(expandedPaths()).toEqual(["src/a.ts"]);
  });

  it("honors expand-all before loading and clears expansion when switching runs", async () => {
    const ref = createRef<GitDiffPreviewHandle>();
    const pendingFiles = ["src/a.ts", "src/b.ts"].map((path) => ({ path, previousPath: null, additions: 1, deletions: 1 }));
    await act(async () => root.render(<GitDiffPreview key="run-1" ref={ref} diffText="" pendingFiles={pendingFiles} loading emptyMessage="Empty" />));
    await act(async () => ref.current?.toggleExpandAllFiles());
    const diff = patch("src/b.ts") + patch("src/a.ts");
    await act(async () => root.render(<GitDiffPreview key="run-1" ref={ref} diffText={diff} emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual(["src/b.ts", "src/a.ts"]);
    await act(async () => root.render(<GitDiffPreview key="run-2" ref={ref} diffText={diff} emptyMessage="Empty" />));
    expect(expandedPaths()).toEqual([]);
  });

  it("keeps duplicate pending paths independent through expand-all and patch arrival", async () => {
    const ref = createRef<GitDiffPreviewHandle>();
    const onExpanded = vi.fn();
    const pendingFiles = [0, 1].map(() => ({ path: "src/a.ts", previousPath: null, additions: 1, deletions: 1 }));
    await act(async () => root.render(<GitDiffPreview ref={ref} diffText="" pendingFiles={pendingFiles} loading
      onAllFilesExpandedChange={onExpanded} emptyMessage="Empty" />));
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[title="src/a.ts"]');
    await act(async () => buttons[1]!.click());
    expect(buttons[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(onExpanded).toHaveBeenLastCalledWith(false);

    await act(async () => ref.current?.toggleExpandAllFiles());
    expect([...buttons].map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    await act(async () => ref.current?.toggleExpandAllFiles());
    expect([...buttons].map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    await act(async () => buttons[1]!.click());
    await act(async () => root.render(<GitDiffPreview ref={ref} diffText={patch("src/a.ts") + patch("src/a.ts", "staged")} emptyMessage="Empty" />));
    const loadedButtons = container.querySelectorAll<HTMLButtonElement>('button[title="src/a.ts"]');
    expect([...loadedButtons].map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(expandedPaths()).toEqual(["src/a.ts"]);
  });
});
