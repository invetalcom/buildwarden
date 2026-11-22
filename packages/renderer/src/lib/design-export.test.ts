import { describe, expect, it } from "vitest";
import {
  DESIGN_ASSET_MAX_BYTES,
  DESIGN_ASSETS_MAX_TOTAL_BYTES,
  DESIGN_COLOR_GROUPS,
  DESIGN_CUSTOM_CSS_MAX_LENGTH,
  DESIGN_ELEMENTS,
  DESIGN_INDICATORS,
  DESIGN_RUN_HEADER_ITEMS,
  DESIGN_BACKGROUND_IMAGE_MAX_BYTES,
  DESIGN_SCHEME_FILE_MAX_BYTES,
  DESIGN_SCHEME_FILE_WITH_IMAGE_MAX_BYTES,
  DESIGN_SCHEME_PRESETS,
  exportDesignScheme,
  importDesignScheme,
  importDesignSchemeExport,
  withDesignBackgroundImage,
  normalizeDesignCustomization,
  type DesignAsset,
  type DesignCustomization,
  type DesignScheme,
} from "@buildwarden/shared";
import { designCustomizationCss, designIndicatorAttributes, designSchemeCssVariables } from "./design-scheme";

const svg = (size = 0): DesignAsset => ({ type: "image/svg+xml", data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(size)}</svg>`).toString("base64") });

/** A customization that sets every option a theme has, built from the option lists so a new option cannot be left out. */
const everything = (): DesignCustomization => ({
  elements: Object.fromEntries(DESIGN_ELEMENTS.map((definition, index) => [
    definition.key,
    Object.fromEntries(definition.properties.map((property, offset) => [property, `#${(0x101010 + index * 0x030201 + offset).toString(16).padStart(6, "0")}${offset === 0 ? "cc" : ""}`])),
  ])),
  shape: { radius: 1.4, borders: 0.6, shadow: 1.5, radiusControls: 0.5, radiusCards: 1.2, radiusSheet: 1.8, radiusDialogs: 0.2 },
  glass: { blur: 12, opacity: 0.85, glow: 0.3, glowPosition: "top", glowSize: 1.6, glowPrimary: "#ff8800", glowSecondary: "#0088ff" },
  background: { image: "bg-0123456789abcdef", dim: 0.3, blur: 6, fit: "tile" },
  fonts: { ui: '"Segoe UI", sans-serif', mono: "Consolas, monospace", terminalSize: 14 },
  layout: {
    scale: 1.1, density: "comfortable", sidebar: "right", statusBar: false, sidebarFullHeight: false, composerWidth: 60, composerHeight: 120,
    runDockGap: -8, transcriptWidth: 80, scrollbar: 10, runHeader: "line", runHeaderItems: [...DESIGN_RUN_HEADER_ITEMS].reverse(), statusBarHeight: 36,
  },
  ...Object.fromEntries(DESIGN_COLOR_GROUPS.map((group, index) => [
    group.key,
    Object.fromEntries(group.colors.map((color, offset) => [color.key, `#${(0x204060 + index * 0x101010 + offset * 3).toString(16).padStart(6, "0")}`])),
  ])),
  motion: { speed: 1.75, reduce: "system" },
  // The last style of every indicator: never the app's own, and for some an image style.
  indicators: Object.fromEntries(DESIGN_INDICATORS.map((definition) => [definition.key, definition.styles[definition.styles.length - 1]!.key])),
  assets: { "run-status": svg(), "run-status-failed": svg(40), "live-dot": svg(80), working: svg(120), spinner: svg(160), stars: svg(200) },
  css: '@keyframes drift { to { transform: translateX(4px) } }\n[data-ui="spinner"] { animation: drift 1s infinite }',
});

const scheme = (customization: DesignCustomization): DesignScheme => ({ ...DESIGN_SCHEME_PRESETS[1]!, id: "custom", name: "Everything", description: "All options set", customization });

describe("theme export and import", () => {
  it("the test theme really sets every option", () => {
    const customization = everything();
    // Nothing in it is dropped by validation, so the comparison below covers all of it.
    expect(normalizeDesignCustomization(customization)).toEqual(customization);
    const sections = Object.keys(customization).sort();
    expect(sections).toEqual(["assets", "background", "charts", "css", "diff", "elements", "fonts", "glass", "indicators", "layout", "motion", "shape", "states", "syntax", "terminal"]);
    expect(Object.keys(customization.elements!)).toHaveLength(DESIGN_ELEMENTS.length);
    expect(Object.keys(customization.indicators!)).toHaveLength(DESIGN_INDICATORS.length);
  });

  it("brings back every option of an exported theme", () => {
    const original = scheme(everything());
    const imported = importDesignScheme(exportDesignScheme(original, "2026-11-22T00:00:00.000Z"));
    expect(imported.customization).toEqual(original.customization);
    expect(imported.colors).toEqual(original.colors);
    expect(imported.mode).toBe(original.mode);
    expect(imported.name).toBe(original.name);
    // An imported theme is always a custom one.
    expect(imported.id).toBe("custom");
  });

  it("looks the same after the round trip: same variables, same attributes, same stylesheet", () => {
    const original = scheme(everything());
    const imported = importDesignScheme(exportDesignScheme(original));
    expect(designSchemeCssVariables(imported)).toEqual(designSchemeCssVariables(original));
    expect(designIndicatorAttributes(imported.customization)).toEqual(designIndicatorAttributes(original.customization));
    expect(designCustomizationCss(imported.customization)).toBe(designCustomizationCss(original.customization));
  });

  it("exports a stock theme without any customization and imports it unchanged", () => {
    for (const preset of DESIGN_SCHEME_PRESETS) {
      const imported = importDesignScheme(exportDesignScheme(preset));
      expect(imported.customization).toBeUndefined();
      expect(imported.colors).toEqual(preset.colors);
    }
  });

  it("keeps the largest theme a user can build within the size an import accepts", () => {
    const full = svg(DESIGN_ASSET_MAX_BYTES - 60);
    const assets = Object.fromEntries(Array.from({ length: DESIGN_ASSETS_MAX_TOTAL_BYTES / DESIGN_ASSET_MAX_BYTES }, (_, index) => [`image-${String(index)}`, full]));
    // Three bytes per character is the most a character of custom CSS can take in the file.
    const css = `/*${"€".repeat(DESIGN_CUSTOM_CSS_MAX_LENGTH - 4)}*/`;
    const largest = scheme({ ...everything(), assets, css });
    expect(Object.keys(largest.customization!.assets!)).toHaveLength(4);
    const file = exportDesignScheme(largest);
    expect(new TextEncoder().encode(file).byteLength).toBeLessThan(DESIGN_SCHEME_FILE_MAX_BYTES);
    expect(importDesignScheme(file).customization).toEqual(normalizeDesignCustomization(largest.customization));
    expect(Object.keys(importDesignScheme(file).customization!.assets!)).toHaveLength(4);
  });
});

describe("theme export and import: background image", () => {
  const image = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };

  it("carries the image's bytes in the file and hands them back on import", () => {
    const original = scheme(everything());
    const file = exportDesignScheme(original, "2026-11-22T00:00:00.000Z", { token: "bg-0123456789abcdef", ...image } as typeof image);
    const parsed = JSON.parse(file) as { backgroundImage?: unknown; scheme: unknown };
    // Only what another host needs: the bytes and their type, not this host's token.
    expect(parsed.backgroundImage).toEqual(image);
    const imported = importDesignSchemeExport(file);
    expect(imported.backgroundImage).toEqual(image);
    expect(imported.scheme.customization).toEqual(original.customization);
  });

  it("leaves the image out of a theme that has no background image, and reads older files without one", () => {
    const withoutImage = scheme({ shape: { radius: 1.2 } });
    const file = exportDesignScheme(withoutImage, undefined, image);
    expect(file).not.toContain("backgroundImage");
    expect(importDesignSchemeExport(file).backgroundImage).toBeNull();
    // A file written before images were exported still names its image by token.
    const older = exportDesignScheme(scheme(everything()));
    expect(importDesignSchemeExport(older).backgroundImage).toBeNull();
    expect(importDesignSchemeExport(older).scheme.customization?.background?.image).toBe("bg-0123456789abcdef");
  });

  it("gives an imported theme the token of the host that stored its image, or no image at all", () => {
    const imported = importDesignScheme(exportDesignScheme(scheme(everything())));
    expect(withDesignBackgroundImage(imported, "bg-fedcba9876543210").customization?.background).toEqual({ image: "bg-fedcba9876543210", dim: 0.3, blur: 6, fit: "tile" });
    expect(withDesignBackgroundImage(imported, null).customization?.background).toEqual({ dim: 0.3, blur: 6, fit: "tile" });
    // A theme whose only customization was the image has none left without it.
    expect(withDesignBackgroundImage(scheme({ background: { image: "bg-0123456789abcdef" } }), null).customization).toBeUndefined();
  });

  it("refuses a file whose image is not one it could have exported", () => {
    const file = (backgroundImage: unknown) => JSON.stringify({ ...JSON.parse(exportDesignScheme(scheme(everything()))), backgroundImage });
    expect(() => importDesignSchemeExport(file({ mimeType: "image/svg+xml", data: image.data }))).toThrow(/not a valid PNG, JPEG, WebP or GIF/);
    expect(() => importDesignSchemeExport(file({ mimeType: "image/png", data: 'x" onerror="' }))).toThrow(/not a valid/);
    expect(() => importDesignSchemeExport(file({ mimeType: "image/png" }))).toThrow(/not a valid/);
    expect(() => importDesignSchemeExport(file("data:image/png;base64,AAAA"))).toThrow(/not a valid/);
    // The scheme alone is still readable from such a file.
    expect(importDesignScheme(file({ mimeType: "image/png", data: "%%%" })).name).toBe("Everything");
  });

  it("leaves room in the import limit for the largest background image", () => {
    const largest = "A".repeat(Math.ceil(DESIGN_BACKGROUND_IMAGE_MAX_BYTES / 3) * 4);
    const file = exportDesignScheme(scheme(everything()), undefined, { mimeType: "image/png", data: largest });
    expect(file.length).toBeLessThan(DESIGN_SCHEME_FILE_WITH_IMAGE_MAX_BYTES);
    expect(importDesignSchemeExport(file).backgroundImage?.data).toHaveLength(largest.length);
    expect(() => importDesignSchemeExport(file.replace(largest, largest + "AAAA"))).toThrow(/up to 8 MB/);
  });
});
