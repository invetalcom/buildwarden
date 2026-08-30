// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  APP_SETTING_KEYS,
  DESIGN_SCHEME_COLOR_KEYS,
  DESIGN_SCHEME_PRESETS,
  createCustomDesignScheme,
  exportDesignScheme,
  importDesignScheme,
  parseDesignScheme,
  serializeDesignScheme,
  type DesignScheme,
} from "@buildwarden/shared";
import { applyDesignSchemeToDocument, designSchemeCssVariables } from "./design-scheme";

describe("design schemes", () => {
  it("ships complete dark and light presets with distinct color pairs", () => {
    expect(DESIGN_SCHEME_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(DESIGN_SCHEME_PRESETS.some((scheme) => scheme.mode === "dark")).toBe(true);
    expect(DESIGN_SCHEME_PRESETS.some((scheme) => scheme.mode === "light")).toBe(true);
    for (const scheme of DESIGN_SCHEME_PRESETS) {
      expect(Object.keys(scheme.colors).sort()).toEqual([...DESIGN_SCHEME_COLOR_KEYS].sort());
      expect(scheme.colors.primary).not.toBe(scheme.colors.secondary);
    }
  });

  it("round-trips a customized exported scheme", () => {
    const custom = createCustomDesignScheme(DESIGN_SCHEME_PRESETS[0]!, { primary: "#123456" }, { name: "My Scheme" });
    const imported = importDesignScheme(exportDesignScheme(custom, "2026-08-29T12:00:00.000Z"));
    expect(imported.name).toBe("My Scheme");
    expect(imported.colors.primary).toBe("#123456");
    expect(imported.id).toBe("custom");
    expect(parseDesignScheme({ [APP_SETTING_KEYS.designScheme]: serializeDesignScheme(imported) })).toEqual(imported);
  });

  it("rejects malformed imports rather than partially applying them", () => {
    expect(() => importDesignScheme("not json")).toThrow("valid JSON");
    expect(() => importDesignScheme(JSON.stringify({ format: "something-else", scheme: {} }))).toThrow("not a BuildWarden");
  });

  it("derives and applies the complete semantic token contract", () => {
    const scheme = DESIGN_SCHEME_PRESETS[1]!;
    const variables = designSchemeCssVariables(scheme);
    expect(variables["--ec-accent"]).toBe(scheme.colors.primary);
    expect(variables["--ec-secondary"]).toBe(scheme.colors.secondary);
    expect(variables["--ec-user-input"]).toBe(scheme.colors.userInput);
    expect(variables["--ec-reasoning"]).toBe(scheme.colors.reasoning);
    expect(variables["--ec-terminal-bg"]).toBe(scheme.colors.background);

    applyDesignSchemeToDocument(scheme, false);
    expect(document.documentElement.dataset.designScheme).toBe(scheme.id);
    expect(document.documentElement.dataset.theme).toBe(scheme.mode);
    expect(document.documentElement.style.getPropertyValue("--ec-danger")).toBe(scheme.colors.danger);
  });

  it("automatically chooses readable text for primary action colors", () => {
    const foregrounds = DESIGN_SCHEME_PRESETS.map((scheme) =>
      designSchemeCssVariables(scheme)["--ec-accent-foreground"],
    );

    expect(foregrounds).toEqual([
      "#071018",
      "#071018",
      "#071018",
      "#071018",
      "#ffffff",
      "#071018",
    ]);
  });

  it("migrates older saved schemes to independent user-input and reasoning colors", () => {
    const legacy = structuredClone(DESIGN_SCHEME_PRESETS[0]!) as DesignScheme;
    const legacyColors = legacy.colors as Partial<DesignScheme["colors"]>;
    delete legacyColors.userInput;
    delete legacyColors.reasoning;
    const parsed = parseDesignScheme({ [APP_SETTING_KEYS.designScheme]: JSON.stringify(legacy) });

    expect(parsed.colors.userInput).toBe(legacy.colors.primary);
    expect(parsed.colors.reasoning).toBe(legacy.colors.warning);
  });
});
