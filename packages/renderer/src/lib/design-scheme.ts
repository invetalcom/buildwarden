import {
  DESIGN_COLOR_GROUPS,
  DESIGN_ELEMENTS,
  designCssProblem,
  designTitlebarColor,
  getDefaultDesignScheme,
  parseDesignSchemeJson,
  type DesignBackgroundImage,
  type DesignCustomization,
  type DesignScheme,
} from "@buildwarden/shared";

export const DESIGN_SCHEME_BROWSER_CACHE_KEY = "buildwarden.design-scheme.v1";
const CUSTOM_STYLE_ELEMENT_ID = "buildwarden-design-custom";

type Rgb = { r: number; g: number; b: number };

const hexToRgb = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

const rgba = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000})`;
};

const mixHex = (left: string, right: string, rightWeight: number): string => {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const channel = (x: number, y: number) => Math.round(x * (1 - rightWeight) + y * rightWeight).toString(16).padStart(2, "0");
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
};

const relativeLuminance = (hex: string): number => {
  const rgb = hexToRgb(hex);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
};

const contrastRatio = (left: string, right: string): number => {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
};

const readableForeground = (background: string): string => {
  const darkForeground = "#071018";
  const lightForeground = "#ffffff";
  return contrastRatio(background, darkForeground) >= contrastRatio(background, lightForeground)
    ? darkForeground
    : lightForeground;
};

/** Defaults for everything a scheme may leave unset. */
export const DESIGN_DEFAULTS = {
  radius: 1,
  borders: 1,
  blur: 24,
  glow: 0.5,
  /** Opacity of the content sheet. Transparent by default: pages sit on the window backdrop. */
  opacity: 0,
  opacityWithImage: 0.78,
  backgroundDim: 0.45,
  backgroundBlur: 0,
  shadow: 1,
  glowSize: 1,
  terminalSize: 12,
  scale: 1,
  composerWidth: 75,
  /** Height the prompt text area has on a run page when no theme sets one. The project page uses 80. */
  composerHeight: 56,
  /** Distance between a run's result buttons and the prompt box when no theme sets one. */
  runDockGap: 20,
  transcriptWidth: 100,
  scrollbar: 7,
  statusBarHeight: 28,
} as const;

/** Space between the bottom edge of a run's log area and the top edge of the prompt box. */
const RUN_DOCK_BOX_SPACING = 12;

/** Where the two backdrop glows start, per glow position. The default is the two bottom corners. */
const GLOW_POSITIONS = {
  bottom: ["0% 100%", "100% 100%"],
  top: ["0% 0%", "100% 0%"],
  left: ["0% 0%", "0% 100%"],
  right: ["100% 0%", "100% 100%"],
} as const;

/** A unitless multiplier for one radius group, or `initial` so the group follows the overall radius. */
const radiusOverride = (value: number | undefined): string => (value === undefined ? "initial" : String(value));

/**
 * Resolve every renderer token from the scheme's palette and customization.
 *
 * The look has three surface tiers. The window backdrop carries the title bar, sidebar and status
 * bar without fills or borders. One content sheet sits on it. Cards and controls inside the sheet
 * are neutral tints of the text color, so they need no border or shadow to read as grouped. The
 * dark tints stay faint: on a dark sheet a stronger tint reads as a gray block, not as grouping.
 */
export const designSchemeCssVariables = (scheme: DesignScheme): Record<string, string> => {
  const { colors, mode } = scheme;
  const custom = scheme.customization;
  const light = mode === "light";
  const accentForeground = readableForeground(colors.primary);
  const borders = custom?.shape?.borders ?? DESIGN_DEFAULTS.borders;
  const glow = custom?.glass?.glow ?? DESIGN_DEFAULTS.glow;
  const hasImage = Boolean(custom?.background?.image);
  const sheetOpacity = custom?.glass?.opacity ?? (hasImage ? DESIGN_DEFAULTS.opacityWithImage : DESIGN_DEFAULTS.opacity);
  const shadowStrength = custom?.shape?.shadow ?? DESIGN_DEFAULTS.shadow;
  const shadow = light ? rgba(colors.text, 0.18 * shadowStrength) : rgba("#000000", 0.5 * shadowStrength);
  const [glowStart, glowEnd] = GLOW_POSITIONS[custom?.glass?.glowPosition ?? "bottom"];
  const hairline = rgba(colors.border, (light ? 0.4 : 0.32) * borders);
  return {
    // The opaque color of the page as it looks: the backdrop with the sheet laid over it.
    "--ec-bg": mixHex(colors.background, colors.surface, sheetOpacity),
    "--ec-sheet": rgba(colors.surface, sheetOpacity),
    // The sheet repeats the backdrop glow only as far as it covers it.
    "--bw-sheet-glow": `${String(Math.round(sheetOpacity * 100))}%`,
    "--ec-bg-elevated": rgba(colors.surfaceElevated, 0.94),
    "--ec-dialog-bg": colors.surfaceElevated,
    "--ec-titlebar": designTitlebarColor(scheme),
    "--ec-sidebar-base": "transparent",
    "--ec-sidebar": "transparent",
    "--ec-sidebar-contrast-strength": "0%",
    "--ec-panel": rgba(colors.text, light ? 0.035 : 0.04),
    "--ec-panel-strong": rgba(colors.text, 0.07),
    "--ec-panel-soft": rgba(colors.text, light ? 0.022 : 0.025),
    "--ec-control": rgba(colors.text, light ? 0.06 : 0.065),
    "--ec-control-hover": rgba(colors.text, light ? 0.1 : 0.105),
    "--ec-hover": rgba(colors.text, 0.055),
    "--ec-input": light ? rgba(colors.surfaceElevated, 0.9) : rgba(colors.background, 0.42),
    "--ec-border": hairline,
    "--ec-border-strong": rgba(colors.border, (light ? 0.8 : 0.7) * borders),
    "--ec-text": colors.text,
    "--ec-muted": colors.textMuted,
    "--ec-faint": mixHex(colors.textMuted, colors.surface, light ? 0.3 : 0.34),
    "--ec-shadow": shadow,
    "--ec-accent": colors.primary,
    "--ec-accent-strong": mixHex(colors.primary, light ? "#000000" : "#ffffff", light ? 0.16 : 0.18),
    "--ec-accent-foreground": accentForeground,
    "--ec-accent-soft": rgba(colors.primary, light ? 0.12 : 0.16),
    "--ec-accent-ring": rgba(colors.primary, light ? 0.36 : 0.44),
    "--ec-secondary": colors.secondary,
    "--ec-secondary-soft": rgba(colors.secondary, light ? 0.12 : 0.16),
    "--ec-secondary-ring": rgba(colors.secondary, light ? 0.3 : 0.38),
    "--ec-user-input": colors.userInput,
    "--ec-user-input-soft": rgba(colors.userInput, light ? 0.13 : 0.17),
    "--ec-user-input-ring": rgba(colors.userInput, light ? 0.36 : 0.44),
    "--ec-reasoning": colors.reasoning,
    "--ec-reasoning-soft": rgba(colors.reasoning, light ? 0.14 : 0.15),
    "--ec-reasoning-ring": rgba(colors.reasoning, light ? 0.38 : 0.36),
    "--ec-openrouter-brand": colors.secondary,
    "--ec-ring": rgba(colors.primary, light ? 0.46 : 0.54),
    "--ec-success": colors.success,
    "--ec-success-soft": rgba(colors.success, light ? 0.13 : 0.15),
    "--ec-success-ring": rgba(colors.success, light ? 0.36 : 0.4),
    "--ec-warning": colors.warning,
    // For text and icons on a warning-colored fill, like the accent foreground on the accent.
    "--ec-warning-foreground": readableForeground(colors.warning),
    "--ec-warning-soft": rgba(colors.warning, 0.15),
    "--ec-warning-ring": rgba(colors.warning, light ? 0.4 : 0.36),
    "--ec-info": colors.secondary,
    "--ec-info-soft": rgba(colors.secondary, light ? 0.12 : 0.15),
    "--ec-info-ring": rgba(colors.secondary, light ? 0.3 : 0.36),
    "--ec-danger": colors.danger,
    "--ec-danger-strong": mixHex(colors.danger, light ? "#000000" : "#ffffff", light ? 0.16 : 0.18),
    "--ec-danger-soft": rgba(colors.danger, light ? 0.12 : 0.15),
    "--ec-danger-ring": rgba(colors.danger, light ? 0.32 : 0.4),
    "--ec-muted-soft": rgba(colors.textMuted, light ? 0.1 : 0.13),
    "--ec-switch-thumb": "#ffffff",
    "--ec-panel-shadow": "none",
    "--ec-popover-shadow": `0 0 0 1px ${hairline}, 0 16px 44px ${shadow}`,
    "--ec-action-shadow": "none",
    "--ec-terminal-bg": light ? colors.surfaceElevated : colors.background,
    "--ec-terminal-fg": colors.text,
    "--ec-terminal-cursor": colors.textMuted,
    "--ec-backdrop": colors.background,
    "--ec-backdrop-primary": rgba(custom?.glass?.glowPrimary ?? colors.primary, (light ? 0.34 : 0.4) * glow),
    "--ec-backdrop-secondary": rgba(custom?.glass?.glowSecondary ?? colors.secondary, (light ? 0.26 : 0.3) * glow),
    "--bw-glow-a-pos": glowStart,
    "--bw-glow-b-pos": glowEnd,
    "--bw-glow-size": String(custom?.glass?.glowSize ?? DESIGN_DEFAULTS.glowSize),
    "--ec-scrim": rgba(light ? colors.text : "#000000", light ? 0.28 : 0.56),
    "--app-scrollbar-track": "transparent",
    "--app-scrollbar-thumb-start": rgba(colors.textMuted, light ? 0.36 : 0.28),
    "--app-scrollbar-thumb-end": rgba(colors.textMuted, light ? 0.36 : 0.28),
    "--app-scrollbar-thumb-hover-start": rgba(colors.textMuted, 0.6),
    "--app-scrollbar-thumb-hover-end": rgba(colors.textMuted, 0.6),
    "--app-scrollbar-border": "transparent",
    "--m-backdrop": colors.background,
    "--m-scrim": rgba(light ? colors.text : "#000000", light ? 0.28 : 0.56),
    "--bw-radius": String(custom?.shape?.radius ?? DESIGN_DEFAULTS.radius),
    "--bw-radius-controls": radiusOverride(custom?.shape?.radiusControls),
    "--bw-radius-cards": radiusOverride(custom?.shape?.radiusCards),
    "--bw-radius-sheet": radiusOverride(custom?.shape?.radiusSheet),
    "--bw-radius-dialogs": radiusOverride(custom?.shape?.radiusDialogs),
    "--bw-terminal-font-size": String(custom?.fonts?.terminalSize ?? DESIGN_DEFAULTS.terminalSize),
    "--bw-scale": String(custom?.layout?.scale ?? DESIGN_DEFAULTS.scale),
    "--bw-composer-width": `${String(custom?.layout?.composerWidth ?? DESIGN_DEFAULTS.composerWidth)}%`,
    "--bw-composer-height": custom?.layout?.composerHeight === undefined ? "initial" : `${String(custom.layout.composerHeight)}px`,
    // The buttons sit in the log area, whose bottom edge is 12px above the prompt box.
    "--bw-run-dock-bottom": custom?.layout?.runDockGap === undefined ? "initial" : `${String(custom.layout.runDockGap - RUN_DOCK_BOX_SPACING)}px`,
    "--bw-run-dock-shift": custom?.layout?.runDockGap === undefined ? "initial" : `${String(custom.layout.runDockGap - DESIGN_DEFAULTS.runDockGap)}px`,
    "--bw-transcript-width": custom?.layout?.transcriptWidth === undefined ? "initial" : `${String(custom.layout.transcriptWidth)}%`,
    "--bw-scrollbar-size": `${String(custom?.layout?.scrollbar ?? DESIGN_DEFAULTS.scrollbar)}px`,
    "--bw-statusbar-height": `${String(custom?.layout?.statusBarHeight ?? DESIGN_DEFAULTS.statusBarHeight)}px`,
    "--bw-blur": `${String(custom?.glass?.blur ?? DESIGN_DEFAULTS.blur)}px`,
    "--bw-bg-dim": rgba(colors.background, hasImage ? custom?.background?.dim ?? DESIGN_DEFAULTS.backgroundDim : 0),
    "--bw-bg-blur": `${String(custom?.background?.blur ?? DESIGN_DEFAULTS.backgroundBlur)}px`,
    "--bw-bg-size": custom?.background?.fit === "contain" ? "contain" : custom?.background?.fit === "tile" ? "auto" : "cover",
    "--bw-bg-repeat": custom?.background?.fit === "tile" ? "repeat" : "no-repeat",
    "--bw-font-ui": custom?.fonts?.ui ?? "initial",
    "--bw-font-mono": custom?.fonts?.mono ?? "initial",
  };
};

/**
 * CSS for per-element colors, followed by the scheme's custom CSS. Element rules use !important so
 * a color chosen in the editor always wins over the app's utility classes. Custom CSS that could
 * load files is left out here as well, in case a stored scheme was edited by hand.
 */
export const designCustomizationCss = (customization: DesignCustomization | undefined): string => {
  if (!customization) return "";
  const rules: string[] = [];
  const variables: string[] = [];
  for (const definition of DESIGN_ELEMENTS) {
    const style = customization.elements?.[definition.key];
    if (!style) continue;
    const declarations: string[] = [];
    const elementVariables: Partial<Record<"background" | "text" | "border", string>> = ("variables" in definition ? definition.variables : undefined) ?? {};
    for (const property of definition.properties) {
      const color = style[property];
      if (!color) continue;
      const variable = elementVariables[property];
      if (variable) variables.push(`${variable}:${color} !important`);
      else if (property === "background") declarations.push(`background:${color} !important`);
      else if (property === "text") declarations.push(`color:${color} !important`);
      else declarations.push(`border-color:${color} !important`, `--ec-border:${color}`);
    }
    if (declarations.length > 0) rules.push(`${definition.selector}{${declarations.join(";")}}`);
  }
  if (variables.length > 0) rules.unshift(`:root,body{${variables.join(";")}}`);
  // Color sets: each set declares its variables where the app declares its own, so they win there.
  for (const group of DESIGN_COLOR_GROUPS) {
    const values = customization[group.key];
    if (!values) continue;
    const declarations: string[] = [];
    for (const definition of group.colors) {
      const color = values[definition.key];
      if (!color) continue;
      declarations.push(`${definition.variable}:${color} !important`);
      if ("soft" in definition && definition.soft) declarations.push(`${definition.soft}:${rgba(color.slice(0, 7), 0.15)} !important`);
    }
    if (declarations.length > 0) rules.push(`${group.scope}{${declarations.join(";")}}`);
  }
  const css = customization.css && designCssProblem(customization.css) === null ? customization.css : "";
  return [rules.join("\n"), css].filter(Boolean).join("\n\n");
};

let appliedBackgroundToken: string | null = null;
let appliedBackgroundUrl: string | null = null;

/** Show the stored background image, or remove it when the scheme no longer references one. */
export const applyDesignBackgroundImage = (image: DesignBackgroundImage | null): void => {
  if (typeof document === "undefined") return;
  if (image?.token === appliedBackgroundToken) return;
  if (appliedBackgroundUrl) URL.revokeObjectURL(appliedBackgroundUrl);
  appliedBackgroundToken = image?.token ?? null;
  appliedBackgroundUrl = null;
  if (!image) {
    document.body.style.removeProperty("--bw-bg-image");
    delete document.body.dataset.designBackground;
    return;
  }
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  appliedBackgroundUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  document.body.style.setProperty("--bw-bg-image", `url("${appliedBackgroundUrl}")`);
  document.body.dataset.designBackground = "image";
};

export const applyDesignSchemeToDocument = (scheme: DesignScheme, persistBrowserCache = true): void => {
  if (typeof document === "undefined") return;
  const variables = designSchemeCssVariables(scheme);
  const targets = [document.documentElement, document.body].filter(Boolean);
  for (const target of targets) {
    target.dataset.theme = scheme.mode;
    target.dataset.designScheme = scheme.id;
    // Layout choices that CSS switches on. The defaults leave every rule that reads them inactive.
    target.dataset.density = scheme.customization?.layout?.density ?? "compact";
    target.dataset.sidebarSide = scheme.customization?.layout?.sidebar ?? "left";
    // Page-level tabs join the sheet; without a sheet the active tab gets its own fill.
    if (variables["--bw-sheet-glow"] === "0%") target.dataset.sheet = "none";
    else delete target.dataset.sheet;
    if ((scheme.customization?.layout?.transcriptWidth ?? 100) < 100) target.dataset.transcript = "narrow";
    else delete target.dataset.transcript;
    // Below this distance the buttons reach past the log area, which must then stop clipping them.
    if ((scheme.customization?.layout?.runDockGap ?? DESIGN_DEFAULTS.runDockGap) < RUN_DOCK_BOX_SPACING) target.dataset.runDock = "overlap";
    else delete target.dataset.runDock;
    for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
  }
  let style = document.getElementById(CUSTOM_STYLE_ELEMENT_ID);
  const css = designCustomizationCss(scheme.customization);
  if (css) {
    if (!style) {
      style = document.createElement("style");
      style.id = CUSTOM_STYLE_ELEMENT_ID;
    }
    style.textContent = css;
    // Appended last so it follows every stylesheet the app injects later.
    document.head.append(style);
  } else {
    style?.remove();
  }
  // Bumped last, after the stylesheet is in place: code that reads theme variables (the terminal) watches it.
  for (const target of targets) target.dataset.designRevision = String(Number(target.dataset.designRevision ?? 0) + 1);
  if (!scheme.customization?.background?.image) applyDesignBackgroundImage(null);
  if (persistBrowserCache && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(DESIGN_SCHEME_BROWSER_CACHE_KEY, JSON.stringify(scheme));
    } catch {
      // Storage may be unavailable in hardened browser contexts; the host snapshot remains authoritative.
    }
  }
};

export const readCachedBrowserDesignScheme = (): DesignScheme => {
  if (typeof localStorage === "undefined") return getDefaultDesignScheme();
  try {
    return parseDesignSchemeJson(localStorage.getItem(DESIGN_SCHEME_BROWSER_CACHE_KEY)) ?? getDefaultDesignScheme();
  } catch {
    return getDefaultDesignScheme();
  }
};
