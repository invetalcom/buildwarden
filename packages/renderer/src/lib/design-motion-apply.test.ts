/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_SCHEME_PRESETS, type DesignAsset, type DesignScheme } from "@buildwarden/shared";
import { applyDesignSchemeToDocument } from "./design-scheme";

const svg: DesignAsset = { type: "image/svg+xml", data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') };
const scheme = (reduce?: "system" | "always"): DesignScheme => ({
  ...DESIGN_SCHEME_PRESETS[0]!,
  id: "custom",
  customization: { indicators: { spinner: "image", runStatus: "image" }, assets: { spinner: svg, "run-status": svg }, ...(reduce ? { motion: { reduce } } : {}) },
});

afterEach(() => {
  vi.unstubAllGlobals();
  applyDesignSchemeToDocument(DESIGN_SCHEME_PRESETS[0]!, false);
});

describe("image looks on the window under reduced motion", () => {
  it("gives way to the still look when the system setting turns on, and comes back when it turns off", () => {
    const listeners: Array<() => void> = [];
    const query = { matches: false, addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); } };
    vi.stubGlobal("matchMedia", () => query);
    const customCss = () => document.getElementById("buildwarden-design-custom")?.textContent ?? "";

    applyDesignSchemeToDocument(scheme("system"), false);
    expect(document.documentElement.dataset.indSpinner).toBe("image");
    expect(customCss()).toContain("status-dot");
    expect(listeners).toHaveLength(1);

    query.matches = true;
    listeners[0]!();
    expect(document.documentElement.dataset.indSpinner).toBeUndefined();
    expect(document.documentElement.dataset.motionReduce).toBe("system");
    expect(customCss()).not.toContain("status-dot");

    query.matches = false;
    listeners[0]!();
    expect(document.documentElement.dataset.indSpinner).toBe("image");

    // A theme that does not follow the system is left alone by the change, and "always" never shows the image.
    applyDesignSchemeToDocument(scheme(), false);
    query.matches = true;
    listeners[0]!();
    expect(document.documentElement.dataset.indSpinner).toBe("image");
    applyDesignSchemeToDocument(scheme("always"), false);
    expect(document.documentElement.dataset.indSpinner).toBeUndefined();
    // Watching the system setting is set up once, not with every scheme that is applied.
    expect(listeners).toHaveLength(1);
  });
});
