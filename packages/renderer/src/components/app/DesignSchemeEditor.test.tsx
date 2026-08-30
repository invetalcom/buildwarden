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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("downloads an attached theme file before revoking its URL", async () => {
    vi.useFakeTimers();
    const scheme = getDesignSchemePreset("midnight-blue")!;
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:theme");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(document.body.contains(this)).toBe(true);
      expect(this.download).toBe("midnight-blue.buildwarden-theme.json");
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={vi.fn()} />));
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Export theme"));
    await act(async () => exportButton?.click());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[href="blob:theme"]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => vi.runAllTimers());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:theme");
  });

  it("shows export validation errors inline", async () => {
    const scheme = {
      ...getDesignSchemePreset("midnight-blue")!,
      colors: { ...getDesignSchemePreset("midnight-blue")!.colors, primary: "invalid" },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<DesignSchemeEditor scheme={scheme} busy={false} onChange={vi.fn()} />));
    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Export theme"));
    await act(async () => exportButton?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("invalid or incomplete colors");
  });
});
