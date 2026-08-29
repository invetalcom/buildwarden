/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDesignSchemePreset } from "@buildwarden/shared";
import { DesignSchemeEditor } from "./DesignSchemeEditor";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("DesignSchemeEditor", () => {
  it("resets a predefined scheme to its original palette", async () => {
    const scheme = getDesignSchemePreset("crimson-grove")!;
    const onChange = vi.fn(async () => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={onChange} />));
    const resetButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Reset defaults"));

    expect(resetButton).toBeTruthy();
    await act(async () => resetButton?.click());
    expect(onChange).toHaveBeenCalledWith(scheme);
  });
});
