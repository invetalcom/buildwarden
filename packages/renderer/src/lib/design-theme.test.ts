// @vitest-environment happy-dom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESIGN_CSS_HOOKS,
  DESIGN_ELEMENTS,
  DESIGN_SCHEME_PRESETS,
  DESIGN_THEME_GUIDE,
  designCssLoadsFiles,
  designCssProblem,
  designTitlebarColor,
  mergeDesignCustomization,
  normalizeDesignCustomization,
  parseDesignSchemeJson,
  serializeDesignScheme,
  type DesignScheme,
} from "@buildwarden/shared";
import { applyDesignSchemeToDocument, designCustomizationCss, designSchemeCssVariables } from "./design-scheme";

const base = DESIGN_SCHEME_PRESETS[0]!;

describe("design customization", () => {
  it("keeps valid fields and drops invalid ones without discarding the rest", () => {
    expect(normalizeDesignCustomization({
      elements: { sidebar: { background: "#101820CC", text: "red", border: "#ffffff" }, unknown: { background: "#000000" } },
      shape: { radius: 9, borders: -3 },
      glass: { blur: 12.345, opacity: "0.5" },
      background: { image: "bg-1234", fit: "stretch", dim: 0.3 },
      fonts: { ui: 'Inter, "Segoe UI"', mono: "x; background: url(http://evil)" },
      css: "@import url(https://example.com/x.css);",
    })).toEqual({
      elements: { sidebar: { background: "#101820cc" } },
      shape: { radius: 2, borders: 0 },
      glass: { blur: 12.35 },
      background: { image: "bg-1234", dim: 0.3 },
      fonts: { ui: 'Inter, "Segoe UI"' },
    });
    expect(normalizeDesignCustomization({ shape: {}, elements: {} })).toBeUndefined();
  });

  it("merges changes and removes fields that are set to null", () => {
    const start = normalizeDesignCustomization({ elements: { card: { background: "#111111", text: "#eeeeee" } }, shape: { radius: 1.5 }, css: "a{}" });
    expect(mergeDesignCustomization(start, { elements: { card: { text: null }, button: { background: "#222222" } }, shape: { borders: 0.5 }, css: null })).toEqual({
      elements: { card: { background: "#111111" }, button: { background: "#222222" } },
      shape: { radius: 1.5, borders: 0.5 },
    });
    expect(mergeDesignCustomization(start, { elements: null, shape: null, css: "" })).toBeUndefined();
  });

  it("survives a round trip through the stored scheme and stays readable by older data", () => {
    const scheme: DesignScheme = { ...base, id: "custom", customization: { shape: { radius: 0.5 }, css: '[data-ui="card"]{outline:1px solid red}' } };
    expect(parseDesignSchemeJson(serializeDesignScheme(scheme))).toEqual(scheme);
    expect(parseDesignSchemeJson(serializeDesignScheme(base))).not.toHaveProperty("customization");
  });
});

describe("custom css safety", () => {
  it.each([
    "@import 'https://example.com/a.css';",
    "a { background: url(https://example.com/a.png) }",
    "a { background: URL( 'file:///c:/secret.png' ) }",
    "a { background: image-set('a.png' 1x) }",
    "@font-face { font-family: x; src: url(//example.com/f.woff2) }",
    "a { background: u\\72l(https://example.com/a.png) }",
    "a { background: /* */ url(/* */https://example.com/a.png) }",
    // "/*" inside a string opens no comment, so the rule between the two strings is live.
    'a::after { content: "/*" } .card { background: url(https://example.com/x.png) } a::after { content: "*/" }',
    // Nor does "/*" inside an unquoted url(): the token ends at ")", and the next rule is live.
    "a { background: url(data:image/png;base64,/*) } b { background: url(https://example.com/x.png) } /* */",
    "/* url(https://example.com) in a comment is refused too, because comments are not removed */ a { color: red }",
  ])("refuses css that could load a file: %s", (css) => {
    expect(designCssLoadsFiles(css)).toBe(true);
    expect(designCssProblem(css)).toMatch(/cannot load files/);
  });

  it.each([
    '[data-ui="sidebar"] { background: #101820 !important }',
    "a { background: url(data:image/png;base64,AAAA) }",
    "a { filter: url(#blur) }",
    "/* a plain comment */ a { color: red }",
  ])("accepts css that stays local: %s", (css) => {
    expect(designCssLoadsFiles(css)).toBe(false);
    expect(designCssProblem(css)).toBeNull();
  });

  it("never emits css that could load files, even from a hand-edited scheme", () => {
    expect(designCustomizationCss({ css: "a { background: url(https://example.com/a.png) }" })).toBe("");
  });
});

describe("applying a customized scheme", () => {
  it("turns element colors into rules on stable selectors and variables where a surface reads them in code", () => {
    const css = designCustomizationCss({ elements: { card: { background: "#112233", border: "#445566" }, terminal: { background: "#000000" }, window: { background: "#0a0a0a" } } });
    expect(css).toContain('[data-ui="card"]{background:#112233 !important;border-color:#445566 !important;--ec-border:#445566}');
    expect(css).toContain("--ec-terminal-bg:#000000 !important");
    expect(css).toContain("--ec-backdrop:#0a0a0a !important");
  });

  it("writes shape, glass and font tokens and injects the custom stylesheet last", () => {
    const scheme: DesignScheme = { ...base, id: "custom", customization: { shape: { radius: 1.5, borders: 0 }, glass: { blur: 8, opacity: 0.6 }, fonts: { ui: "Inter" }, css: '[data-ui="app"]{outline:0}' } };
    const variables = designSchemeCssVariables(scheme);
    expect(variables["--bw-radius"]).toBe("1.5");
    expect(variables["--bw-blur"]).toBe("8px");
    expect(variables["--bw-font-ui"]).toBe("Inter");
    expect(variables["--ec-border"]).toMatch(/, 0\)$/);
    expect(variables["--ec-sheet"]).toMatch(/, 0\.6\)$/);

    applyDesignSchemeToDocument(scheme, false);
    const style = document.getElementById("buildwarden-design-custom");
    expect(style?.textContent).toContain('[data-ui="app"]{outline:0}');
    expect(document.head.lastElementChild).toBe(style);

    applyDesignSchemeToDocument(base, false);
    expect(document.getElementById("buildwarden-design-custom")).toBeNull();
  });

  it("uses one title bar color for the page and the native window controls", () => {
    expect(designTitlebarColor(base)).toBe(base.colors.background);
    expect(designTitlebarColor({ ...base, customization: { elements: { titlebar: { background: "#123456cc" } } } })).toBe("#123456");
    expect(designSchemeCssVariables(base)["--ec-titlebar"]).toBe(base.colors.background);
  });
});

describe("theming hooks", () => {
  const sourceRoot = join(__dirname, "..");
  const sources: string[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) sources.push(readFileSync(full, "utf8"));
    }
  };
  collect(sourceRoot);
  const source = sources.join("\n");
  const hooks = [...new Set(DESIGN_CSS_HOOKS.flatMap((hook) => [...hook.selector.matchAll(/data-ui="([a-z-]+)"/g)].map((match) => match[1]!)))];

  // Themes and agents are told these selectors are stable. Renaming one breaks saved themes.
  it.each(hooks)('renders data-ui="%s" somewhere in the app', (name) => {
    expect(source).toMatch(new RegExp(`data-ui=(?:"${name}"|\\{[^}]*"${name}")`));
  });

  it("documents every element and hook in the agent guide", () => {
    for (const definition of DESIGN_ELEMENTS) expect(DESIGN_THEME_GUIDE).toContain(`- ${definition.key}: `);
    for (const hook of DESIGN_CSS_HOOKS) expect(DESIGN_THEME_GUIDE).toContain(hook.selector);
  });
});

describe("revised preset palettes", () => {
  const previousMidnightBlue = {
    background: "#090c11", surface: "#171d26", surfaceElevated: "#222b38", text: "#f4f7fb", textMuted: "#9aa8b8",
    primary: "#55a8ff", secondary: "#9b8cff", userInput: "#4f8edc", reasoning: "#d7a94f",
    border: "#3a4656", success: "#42d392", warning: "#f5c451", danger: "#ff6b7a",
  };
  const saved = (overrides: object) => JSON.stringify({ version: 1, id: "midnight-blue", name: "Midnight Blue", description: "Saved earlier", mode: "dark", colors: previousMidnightBlue, ...overrides });

  it("moves a saved scheme with an untouched earlier palette to the preset's current colors", () => {
    const parsed = parseDesignSchemeJson(saved({ customization: { shape: { radius: 1.5 } } }))!;
    expect(parsed.colors).toEqual(base.colors);
    expect(parsed.description).toBe(base.description);
    expect(parsed.customization).toEqual({ shape: { radius: 1.5 } });
  });

  it("leaves palettes alone once a color was changed or the scheme is custom", () => {
    const edited = { ...previousMidnightBlue, primary: "#ff8800" };
    expect(parseDesignSchemeJson(saved({ colors: edited }))!.colors).toEqual(edited);
    expect(parseDesignSchemeJson(saved({ id: "custom" }))!.colors).toEqual(previousMidnightBlue);
  });
});

describe("more theme options", () => {
  it("leaves every new token at the value the app had before, for each stock theme", () => {
    for (const preset of DESIGN_SCHEME_PRESETS) {
      const variables = designSchemeCssVariables(preset);
      expect(variables["--bw-glow-a-pos"]).toBe("0% 100%");
      expect(variables["--bw-glow-b-pos"]).toBe("100% 100%");
      expect(variables["--bw-glow-size"]).toBe("1");
      expect(variables["--bw-scale"]).toBe("1");
      expect(variables["--bw-composer-width"]).toBe("75%");
      expect(variables["--bw-composer-height"]).toBe("initial");
      expect(variables["--bw-run-dock-bottom"]).toBe("initial");
      expect(variables["--bw-run-dock-shift"]).toBe("initial");
      expect(variables["--bw-scrollbar-size"]).toBe("7px");
      expect(variables["--bw-statusbar-height"]).toBe("28px");
      expect(variables["--bw-terminal-font-size"]).toBe("12");
      // Unset groups hand over to the app's own fallback values.
      for (const name of ["--bw-radius-controls", "--bw-radius-cards", "--bw-radius-sheet", "--bw-radius-dialogs", "--bw-transcript-width"]) expect(variables[name]).toBe("initial");
      if (preset.mode === "dark") expect(variables["--ec-shadow"]).toBe("rgba(0, 0, 0, 0.5)");
      else expect(variables["--ec-shadow"]).toMatch(/, 0\.18\)$/);
      expect(designCustomizationCss(preset.customization)).toBe("");
    }
  });

  it("keeps valid layout, shape and glass options and drops invalid ones", () => {
    expect(normalizeDesignCustomization({
      layout: { scale: 9, density: "roomy", sidebar: "right", statusBar: false, sidebarFullHeight: "yes", composerWidth: 10, transcriptWidth: 80, scrollbar: "wide", statusBarHeight: 90 },
      shape: { shadow: 0.5, radiusCards: 5 },
      glass: { glowPosition: "top", glowSize: 0.1, glowPrimary: "#FF0000", glowSecondary: "#ff000080" },
      fonts: { terminalSize: 40 },
    })).toEqual({
      layout: { scale: 1.5, sidebar: "right", statusBar: false, composerWidth: 40, transcriptWidth: 80, statusBarHeight: 44 },
      shape: { shadow: 0.5, radiusCards: 2 },
      glass: { glowPosition: "top", glowSize: 0.5, glowPrimary: "#ff0000" },
      fonts: { terminalSize: 24 },
    });
  });

  it("keeps known colors of a color set and removes a set through a null patch", () => {
    const customization = normalizeDesignCustomization({ syntax: { keyword: "#FF7B72", nonsense: "#000000", string: "blue" }, terminal: { brightRed: "#ff0000" } });
    expect(customization).toEqual({ syntax: { keyword: "#ff7b72" }, terminal: { brightRed: "#ff0000" } });
    expect(mergeDesignCustomization(customization, { syntax: null, terminal: { brightRed: null, cursor: "#ffffff" } })).toEqual({ terminal: { cursor: "#ffffff" } });
  });

  it("declares color-set variables where the app declares its own", () => {
    const css = designCustomizationCss({ syntax: { keyword: "#ff7b72" }, states: { running: "#00ff00" }, charts: { series1: "#123456" } });
    expect(css).toContain(".response-code{--tok-keyword:#ff7b72 !important}");
    expect(css).toContain(":root, body{--bw-state-running:#00ff00 !important;--bw-state-running-soft:rgba(0, 255, 0, 0.15) !important}");
    expect(css).toContain(":root, :root[data-theme]{--usage-series-1:#123456 !important}");
  });

  it("turns layout and glow options into variables and document attributes", () => {
    const scheme: DesignScheme = { ...base, id: "custom", customization: {
      layout: { density: "spacious", sidebar: "right", transcriptWidth: 70, composerWidth: 60, scrollbar: 12, scale: 1.2 },
      glass: { glowPosition: "top", glowSize: 1.5, glowPrimary: "#ff0000" },
      shape: { shadow: 2, radiusDialogs: 0 },
    } };
    const variables = designSchemeCssVariables(scheme);
    expect(variables["--bw-glow-a-pos"]).toBe("0% 0%");
    expect(variables["--bw-glow-b-pos"]).toBe("100% 0%");
    expect(variables["--ec-backdrop-primary"]).toBe("rgba(255, 0, 0, 0.2)");
    expect(variables["--bw-radius-dialogs"]).toBe("0");
    expect(variables["--bw-transcript-width"]).toBe("70%");
    expect(variables["--ec-shadow"]).toBe("rgba(0, 0, 0, 1)");
    applyDesignSchemeToDocument(scheme, false);
    expect(document.documentElement.dataset.density).toBe("spacious");
    expect(document.documentElement.dataset.sidebarSide).toBe("right");
    expect(document.documentElement.dataset.transcript).toBe("narrow");
    applyDesignSchemeToDocument(base, false);
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.sidebarSide).toBe("left");
    expect(document.documentElement.dataset.transcript).toBeUndefined();
  });
});

describe("status bar styling", () => {
  it("colors the status bar and draws its top line from the element colors", () => {
    const css = designCustomizationCss({ elements: { statusbar: { background: "#101820", text: "#ffffff", border: "#55a8ff" } } });
    expect(css).toContain("--bw-statusbar-border:#55a8ff !important");
    expect(css).toContain('[data-ui="statusbar"]{background:#101820 !important;color:#ffffff !important}');
  });
});

describe("prompt box height", () => {
  it("keeps the height within its limits and writes it as a variable only when set", () => {
    expect(normalizeDesignCustomization({ layout: { composerHeight: 900 } })).toEqual({ layout: { composerHeight: 400 } });
    expect(normalizeDesignCustomization({ layout: { composerHeight: 10 } })).toEqual({ layout: { composerHeight: 56 } });
    expect(normalizeDesignCustomization({ layout: { composerHeight: "tall" } })).toBeUndefined();
    expect(designSchemeCssVariables({ ...base, id: "custom", customization: { layout: { composerHeight: 160 } } })["--bw-composer-height"]).toBe("160px");
  });
});

describe("result buttons distance", () => {
  it("keeps the distance within its limits, negative values included", () => {
    expect(normalizeDesignCustomization({ layout: { runDockGap: -200 } })).toEqual({ layout: { runDockGap: -48 } });
    expect(normalizeDesignCustomization({ layout: { runDockGap: 90 } })).toEqual({ layout: { runDockGap: 48 } });
    expect(normalizeDesignCustomization({ layout: { runDockGap: 0 } })).toEqual({ layout: { runDockGap: 0 } });
  });

  it("positions the buttons from the prompt box and lets them leave the log area only when they have to", () => {
    const withGap = (runDockGap: number): DesignScheme => ({ ...base, id: "custom", customization: { layout: { runDockGap } } });
    const raised = designSchemeCssVariables(withGap(30));
    expect(raised["--bw-run-dock-bottom"]).toBe("18px");
    expect(raised["--bw-run-dock-shift"]).toBe("10px");
    const inside = designSchemeCssVariables(withGap(-40));
    expect(inside["--bw-run-dock-bottom"]).toBe("-52px");
    expect(inside["--bw-run-dock-shift"]).toBe("-60px");
    applyDesignSchemeToDocument(withGap(30), false);
    expect(document.documentElement.dataset.runDock).toBeUndefined();
    applyDesignSchemeToDocument(withGap(-40), false);
    expect(document.documentElement.dataset.runDock).toBe("overlap");
    applyDesignSchemeToDocument(base, false);
    expect(document.documentElement.dataset.runDock).toBeUndefined();
  });
});

describe("run header options", () => {
  it("keeps the header style and the ordered item list, dropping unknown and repeated items", () => {
    expect(normalizeDesignCustomization({ layout: { runHeader: "line", runHeaderItems: ["diff", "status", "prompts", "diff", 3, "model"] } }))
      .toEqual({ layout: { runHeader: "line", runHeaderItems: ["diff", "status", "model"] } });
    expect(normalizeDesignCustomization({ layout: { runHeader: "tabs", runHeaderItems: "status" } })).toBeUndefined();
  });

  it("allows an empty item list and returns to the default list through a null patch", () => {
    const customization = normalizeDesignCustomization({ layout: { runHeaderItems: [] } });
    expect(customization).toEqual({ layout: { runHeaderItems: [] } });
    expect(mergeDesignCustomization(customization, { layout: { runHeaderItems: null } })).toBeUndefined();
  });
});
