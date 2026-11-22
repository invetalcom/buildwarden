import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESIGN_ASSET_MAX_BYTES,
  DESIGN_ASSETS_MAX_COUNT,
  DESIGN_CSS_HOOKS,
  DESIGN_INDICATORS,
  DESIGN_SCHEME_PRESETS,
  DESIGN_THEME_GUIDE,
  defaultDesignIndicatorStyle,
  designAssetAdditionProblem,
  designAssetNameFromFile,
  designAssetProblem,
  detectDesignAssetType,
  mergeDesignCustomization,
  normalizeDesignCustomization,
  parseDesignSchemeJson,
  resolveDesignIndicatorStyle,
  serializeDesignScheme,
  type DesignAsset,
} from "@buildwarden/shared";
import { designCustomizationCss, designIndicatorAttributes, designSchemeCssVariables } from "./design-scheme";

const base64 = (text: string): string => Buffer.from(text, "latin1").toString("base64");
const svg = (body = ""): DesignAsset => ({ type: "image/svg+xml", data: base64(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`) });
const gif: DesignAsset = { type: "image/gif", data: base64("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;") };

describe("motion options: stock themes", () => {
  it("sets no indicator attribute, no speed and no extra CSS for any stock theme", () => {
    for (const preset of DESIGN_SCHEME_PRESETS) {
      expect(Object.values(designIndicatorAttributes(preset.customization)).every((value) => value === null)).toBe(true);
      expect(designSchemeCssVariables(preset)["--bw-motion-speed"]).toBe("initial");
      expect(designCustomizationCss(preset.customization)).toBe("");
    }
  });

  it("treats the first style of every indicator as the app's own look", () => {
    for (const definition of DESIGN_INDICATORS) {
      const fallback = defaultDesignIndicatorStyle(definition.key);
      expect(fallback).toBe(definition.styles[0]!.key);
      // Choosing the app's own look by name is the same as choosing nothing.
      expect(designIndicatorAttributes({ indicators: { [definition.key]: fallback } })).toEqual(designIndicatorAttributes(undefined));
    }
  });

  it("only changes an indicator through a rule that a theme's choice switches on", () => {
    const css = readFileSync(join(__dirname, "..", "components", "ui", "motion.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.replace(/@media[^{]*\{/, "").trim(), body: match[2]!.trim() })).filter((rule) => rule.selector && !rule.selector.startsWith("@"));
    expect(rules.length).toBeGreaterThan(40);
    const ungated = rules.filter((rule) => !/^:root(?:\[data-(?:ind|motion)-|:is\(\[data-ind-)/.test(rule.selector));
    for (const rule of ungated) {
      // Without a gate a rule may only keep the app's own loading bar or declare a color for later use.
      const declaresColorOnly = rule.body.split(";").map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith("--bw-dot:"));
      expect(rule.selector === ".run-activity-loading-bar" || declaresColorOnly, rule.selector).toBe(true);
    }
    // Every part of a selector list carries the gate, not only the first.
    for (const rule of rules.filter((entry) => !ungated.includes(entry))) {
      for (const part of rule.selector.split(/,\s*\n/)) expect(part.trim(), rule.selector).toMatch(/^:root(?:\[data-(?:ind|motion)-|:is\(\[data-ind-)/);
    }
  });
});

describe("motion options: validation", () => {
  it("keeps known indicator styles, speed and reduce, and drops the rest", () => {
    expect(normalizeDesignCustomization({
      indicators: { spinner: "dots", runStatus: "sparkle", unknown: "pulse", loadingBar: "none" },
      motion: { speed: 9, reduce: "sometimes" },
    })).toEqual({ indicators: { spinner: "dots", loadingBar: "none" }, motion: { speed: 4 } });
    expect(normalizeDesignCustomization({ motion: { speed: 0.01, reduce: "system" } })).toEqual({ motion: { speed: 0.25, reduce: "system" } });
  });

  it("changes one indicator at a time and removes a choice through null", () => {
    const customization = mergeDesignCustomization(undefined, { indicators: { spinner: "dots", liveDot: "ripple" }, motion: { speed: 2 } });
    expect(customization).toEqual({ indicators: { spinner: "dots", liveDot: "ripple" }, motion: { speed: 2 } });
    // An unknown style never replaces a valid one.
    expect(mergeDesignCustomization(customization, { indicators: { spinner: "sparkle" } })?.indicators?.spinner).toBe("dots");
    expect(mergeDesignCustomization(customization, { indicators: { spinner: null }, motion: null })).toEqual({ indicators: { liveDot: "ripple" } });
  });

  it("accepts images by what their bytes are and refuses the rest", () => {
    expect(designAssetProblem(svg())).toBeNull();
    expect(designAssetProblem(gif)).toBeNull();
    expect(detectDesignAssetType(svg().data)).toBe("image/svg+xml");
    expect(detectDesignAssetType(gif.data)).toBe("image/gif");
    expect(detectDesignAssetType(base64("\u0089PNG\r\n\u001a\n0000"))).toBe("image/png");
    expect(detectDesignAssetType(base64("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(detectDesignAssetType(base64("<html><body>no image</body></html>"))).toBeNull();
    expect(designAssetProblem({ type: "image/gif", data: svg().data })).toMatch(/does not match/);
    expect(designAssetProblem({ type: "text/html", data: svg().data })).toMatch(/SVG, GIF, PNG or WebP/);
    expect(designAssetProblem({ type: "image/svg+xml", data: 'x" onload="alert(1)' })).toMatch(/base64/);
    expect(designAssetProblem({ type: "image/svg+xml", data: base64(`<svg>${"x".repeat(DESIGN_ASSET_MAX_BYTES)}</svg>`) })).toMatch(/limited to 64 KB/);
  });

  it("keeps a theme's images within their count and total size", () => {
    const many = Object.fromEntries(Array.from({ length: DESIGN_ASSETS_MAX_COUNT + 3 }, (_, index) => [`image-${String(index)}`, svg()]));
    expect(Object.keys(normalizeDesignCustomization({ assets: many })!.assets!)).toHaveLength(DESIGN_ASSETS_MAX_COUNT);
    const big = svg("x".repeat(60 * 1024));
    const kept = normalizeDesignCustomization({ assets: { a: big, b: big, c: big, d: big, e: big, small: svg() } })!.assets!;
    expect(Object.keys(kept)).toEqual(["a", "b", "c", "d", "small"]);
    expect(designAssetAdditionProblem(kept, "e", big)).toMatch(/256 KB together/);
    expect(designAssetAdditionProblem(kept, "a", big)).toBeNull();
    expect(designAssetAdditionProblem(undefined, "Not A Name", svg())).toMatch(/lower-case words/);
    expect(normalizeDesignCustomization({ assets: { "Bad Name": svg(), ok: svg(), broken: { type: "image/gif", data: "AAAA" } } })).toEqual({ assets: { ok: svg() } });
  });

  it("adds and removes single images through a patch and survives a save", () => {
    const customization = mergeDesignCustomization(undefined, { assets: { spinner: svg(), stars: gif } });
    expect(Object.keys(customization!.assets!)).toEqual(["spinner", "stars"]);
    const next = mergeDesignCustomization(customization, { assets: { spinner: null, broken: { type: "image/png", data: "AAAA" } } });
    expect(next).toEqual({ assets: { stars: gif } });
    expect(mergeDesignCustomization(next, { assets: null })).toBeUndefined();
    const scheme = { ...DESIGN_SCHEME_PRESETS[0]!, id: "custom", customization };
    expect(parseDesignSchemeJson(serializeDesignScheme(scheme))!.customization).toEqual(customization);
  });

  it("makes a usable name from a file name", () => {
    expect(designAssetNameFromFile("My Spinner (final).GIF")).toBe("my-spinner-final");
    expect(designAssetNameFromFile("3d-cube.svg")).toBe("image-3d-cube");
    expect(designAssetNameFromFile("???.png")).toBe("image");
    expect(designAssetNameFromFile(`${"a".repeat(60)}.svg`)).toHaveLength(32);
  });
});

describe("motion options: applied to the window", () => {
  it("turns choices into root attributes and a speed variable", () => {
    const customization = normalizeDesignCustomization({ indicators: { spinner: "dots", activityRail: "none", runStatus: "dot" }, motion: { speed: 2, reduce: "system" } });
    expect(designIndicatorAttributes(customization)).toEqual({
      indRunStatus: null, indLiveDot: null, indPrWatch: null, indWorking: null, indLoadingBar: null, indSpinner: "dots",
      indToolLive: null, indActivityRail: "none", indProgress: null, motionSpeed: "custom", motionReduce: "system",
    });
    expect(designSchemeCssVariables({ ...DESIGN_SCHEME_PRESETS[0]!, customization })["--bw-motion-speed"]).toBe("2");
    expect(designIndicatorAttributes({ motion: { speed: 1 } }).motionSpeed).toBeNull();
  });

  it("keeps the app's own look while an image style has no image", () => {
    expect(resolveDesignIndicatorStyle("spinner", { spinner: "image" }, undefined)).toBe("circle");
    expect(resolveDesignIndicatorStyle("spinner", { spinner: "image" }, { "live-dot": svg() })).toBe("circle");
    expect(resolveDesignIndicatorStyle("spinner", { spinner: "shape" }, { spinner: svg() })).toBe("shape");
    expect(resolveDesignIndicatorStyle("runStatus", { runStatus: "image" }, { "run-status-running": svg() })).toBe("image");
    expect(designIndicatorAttributes({ indicators: { spinner: "image" } }).indSpinner).toBeNull();
    expect(designIndicatorAttributes({ indicators: { spinner: "image" }, assets: { spinner: svg() } }).indSpinner).toBe("image");
  });

  it("declares every image as a variable and names the image of each run state", () => {
    const css = designCustomizationCss({ indicators: { runStatus: "image" }, assets: { "run-status": svg(), "run-status-failed": gif, stars: gif } });
    expect(css).toContain(`--bw-asset-run-status:url("data:image/svg+xml;base64,${svg().data}")`);
    expect(css).toContain(`--bw-asset-stars:url("data:image/gif;base64,${gif.data}")`);
    expect(css).toContain('[data-ui="status-dot"][data-state="running"]{--bw-indicator-image:var(--bw-asset-run-status);');
    expect(css).toContain('[data-ui="status-dot"][data-state="failed"]{--bw-indicator-image:var(--bw-asset-run-status-failed);');
    // A state without an image keeps its dot: no rule hides it.
    const perState = designCustomizationCss({ indicators: { runStatus: "shape" }, assets: { "run-status-running": svg() } });
    expect(perState).toContain('[data-state="running"]');
    expect(perState).not.toContain('[data-state="completed"]');
    // Without the image style the images are only declared.
    expect(designCustomizationCss({ assets: { "run-status": svg() } })).not.toContain("status-dot");
  });

  it("never writes an invalid image into the stylesheet", () => {
    const css = designCustomizationCss({ assets: { ok: svg(), evil: { type: "image/svg+xml", data: '");}body{display:none}/*' } } });
    expect(css).toContain("--bw-asset-ok:");
    expect(css).not.toContain("evil");
    expect(css).not.toContain("display:none");
  });
});

describe("motion options: guide and source", () => {
  it("tells agents about every indicator, its styles and its selector", () => {
    for (const definition of DESIGN_INDICATORS) {
      expect(DESIGN_THEME_GUIDE).toContain(`- ${definition.key}: `);
      expect(DESIGN_THEME_GUIDE).toContain(definition.selector);
      expect(DESIGN_CSS_HOOKS.some((hook) => hook.selector === definition.selector)).toBe(true);
    }
    expect(DESIGN_THEME_GUIDE).toContain("var(--bw-asset-<name>)");
  });

  it("leaves spinning to the shared Spinner", () => {
    const offenders: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { if (entry !== "node_modules") collect(full); continue; }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || full.endsWith(join("ui", "motion.tsx"))) continue;
        if (readFileSync(full, "utf8").includes("animate-spin")) offenders.push(full);
      }
    };
    collect(join(__dirname, ".."));
    collect(join(__dirname, "..", "..", "..", "..", "apps", "web", "src"));
    // A hand-made spinner has no hook, so a theme's spinner look, speed and reduced motion pass it by.
    expect(offenders).toEqual([]);
  });
});

describe("motion options: looks that depend on each other", () => {
  const css = readFileSync(join(__dirname, "..", "components", "ui", "motion.css"), "utf8").replace(/\r\n/g, "\n");
  const ruleFor = (selector: string): string => {
    const start = css.indexOf(selector + " {");
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start) + 1);
  };

  it("turns only active live dots into the theme's image, so the others keep their status color", () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].flatMap((match) => match[1]!.split(/,\s*\n/)).map((selector) => selector.trim());
    const imageLooks = selectors.filter((selector) => /data-ind-live-dot="(?:image|shape)"/.test(selector));
    expect(imageLooks.length).toBeGreaterThanOrEqual(5);
    // A stopping or failed process is a live dot that is not active: its warning or danger color must stay.
    for (const selector of imageLooks) expect(selector).toContain('[data-ui="live-dot"][data-active="true"]');
    // The chat header's dot takes the header's own color, like a badge's dot.
    expect(css).toContain('[data-ui="detail-header"] [data-ui="live-dot"] {\n  --bw-dot: currentColor;');
  });

  it("keeps the bar of a bar-only working block when loading bars are hidden", () => {
    // Both choices are valid on their own; together they must not leave an empty block.
    expect(normalizeDesignCustomization({ indicators: { working: "bar", loadingBar: "none" } })).toEqual({ indicators: { working: "bar", loadingBar: "none" } });
    expect(ruleFor(':root[data-ind-loading-bar="none"] [data-ui="loading-bar"]')).toContain("display: none");
    expect(ruleFor(':root[data-ind-working="bar"][data-ind-loading-bar="none"] [data-ui="working"] > [data-ui="loading-bar"]')).toContain("display: block");
  });
});
