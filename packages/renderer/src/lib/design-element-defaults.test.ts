import { describe, expect, it } from "vitest";
import { DESIGN_ELEMENTS, isDesignElementColor } from "@buildwarden/shared";
import { DESIGN_ELEMENT_DEFAULT_COLORS, parseCssColor } from "./design-element-defaults";

describe("parseCssColor", () => {
  it("reads the forms a browser computes colors to", () => {
    expect(parseCssColor("rgb(14, 17, 22)")).toEqual({ hex: "#0e1116", css: "rgba(14, 17, 22, 1)", transparent: false });
    expect(parseCssColor("rgba(241, 244, 248, 0.04)")).toEqual({ hex: "#f1f4f80a", css: "rgba(241, 244, 248, 0.04)", transparent: false });
    expect(parseCssColor("color(srgb 0.333333 0.658824 1 / 0.12)")).toEqual({ hex: "#55a8ff1f", css: "rgba(85, 168, 255, 0.12)", transparent: false });
    expect(parseCssColor("color(srgb 1 1 1)")?.hex).toBe("#ffffff");
    expect(parseCssColor("rgb(85 168 255 / 50%)")?.hex).toBe("#55a8ff80");
    expect(parseCssColor("rgba(0, 0, 0, 0)")?.transparent).toBe(true);
  });

  it("rejects what it cannot read, and only produces values the fields accept", () => {
    expect(parseCssColor("var(--ec-panel)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    expect(isDesignElementColor(parseCssColor("rgba(241, 244, 248, 0.04)")!.hex)).toBe(true);
  });
});

describe("element default colors", () => {
  it("only names properties the element can be given", () => {
    for (const definition of DESIGN_ELEMENTS) {
      for (const property of Object.keys(DESIGN_ELEMENT_DEFAULT_COLORS[definition.key])) {
        expect(definition.properties as readonly string[], `${definition.key}.${property}`).toContain(property);
      }
    }
  });
});
