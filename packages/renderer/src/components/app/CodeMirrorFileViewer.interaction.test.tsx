/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadLanguageExtension = vi.hoisted(() => vi.fn());

vi.mock("./code-mirror-languages", () => ({
  loadCodeMirrorLanguageExtensionForPath: loadLanguageExtension,
}));

import { CodeMirrorFileViewer } from "./CodeMirrorFileViewer";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  loadLanguageExtension.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CodeMirrorFileViewer", () => {
  it("creates a plain editor when the language extension fails to load", async () => {
    loadLanguageExtension.mockRejectedValue(new Error("language loader failed"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<CodeMirrorFileViewer content="plain text" filePath="example.unknown" />);
      await Promise.resolve();
    });

    expect(loadLanguageExtension).toHaveBeenCalledWith("example.unknown");
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(container.textContent).toContain("plain text");
  });
});
