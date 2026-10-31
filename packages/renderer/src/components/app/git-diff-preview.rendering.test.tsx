/** @vitest-environment happy-dom */

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { disposeHighlighter, isHighlighterNull } from "@pierre/diffs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffPreview } from "./git-diff-preview";

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  await disposeHighlighter();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await disposeHighlighter();
  delete document.body.dataset.theme;
});

// Keep the real Pierre custom element and highlighter: mocking FileDiff hides this startup race.
describe.each(["dark", "light"])("first diff expansion in %s theme", (theme) => {
  it.each([
    ["ts", "const before = 1;", "const after = 2;"],
    ["css", ".card { color: red; }", ".card { color: blue; }"],
    ["html", "<p>Before</p>", "<p>After</p>"],
  ])("renders %s changes without reopening when the highlighter is cold", async (extension, before, after) => {
    document.body.dataset.theme = theme;
    expect(isHighlighterNull()).toBe(true);
    const path = `src/main.${extension}`;
    const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
    await act(async () => root.render(<StrictMode><GitDiffPreview diffText={diff} emptyMessage="Empty" /></StrictMode>));
    const header = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => header.click());
    await act(async () => {
      await vi.waitFor(() => {
        const code = container.querySelector("diffs-container")?.shadowRoot?.querySelector("code");
        expect(code?.textContent).toContain(after);
        expect(code?.textContent).toContain(before);
      });
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");

    await act(async () => header.click());
    expect(container.querySelector("diffs-container")).toBeNull();
    await act(async () => header.click());
    expect(container.querySelector("diffs-container")?.shadowRoot?.querySelector("code")?.textContent).toContain(after);
  });
});
