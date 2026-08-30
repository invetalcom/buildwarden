import {
  getDefaultDesignScheme,
  parseDesignSchemeJson,
  type DesignScheme,
} from "@buildwarden/shared";

export const DESIGN_SCHEME_BROWSER_CACHE_KEY = "buildwarden.design-scheme.v1";

type Rgb = { r: number; g: number; b: number };

const hexToRgb = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

const rgba = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

/** Resolve every renderer color from the scheme's small, user-editable semantic palette. */
export const designSchemeCssVariables = (scheme: DesignScheme): Record<string, string> => {
  const { colors, mode } = scheme;
  const light = mode === "light";
  const accentForeground = readableForeground(colors.primary);
  const surfaceHighlight = light ? "#ffffff" : colors.text;
  const shadow = light ? rgba(colors.text, 0.24) : rgba("#000000", 0.58);
  const sidebar = rgba(colors.background, light ? 0.78 : 0.62);
  return {
    "--ec-bg": rgba(colors.background, light ? 0.78 : 0.68),
    "--ec-bg-elevated": rgba(colors.surfaceElevated, 0.98),
    "--ec-titlebar": colors.surface,
    "--ec-sidebar-base": sidebar,
    "--ec-sidebar": sidebar,
    "--ec-sidebar-contrast-strength": "0%",
    "--ec-panel": rgba(colors.surface, light ? 0.82 : 0.72),
    "--ec-panel-strong": rgba(colors.surfaceElevated, light ? 0.92 : 0.82),
    "--ec-panel-soft": rgba(colors.surface, light ? 0.62 : 0.56),
    "--ec-control": light ? rgba(colors.surfaceElevated, 0.86) : rgba(colors.text, 0.1),
    "--ec-control-hover": light ? colors.surfaceElevated : rgba(colors.text, 0.16),
    "--ec-hover": rgba(colors.primary, light ? 0.09 : 0.11),
    "--ec-input": rgba(light ? colors.surfaceElevated : colors.background, light ? 0.92 : 0.76),
    "--ec-border": rgba(colors.border, light ? 0.58 : 0.52),
    "--ec-border-strong": rgba(colors.border, light ? 0.9 : 0.82),
    "--ec-text": colors.text,
    "--ec-muted": colors.textMuted,
    "--ec-faint": mixHex(colors.textMuted, colors.background, light ? 0.18 : 0.22),
    "--ec-shadow": shadow,
    "--ec-accent": colors.primary,
    "--ec-accent-strong": mixHex(colors.primary, light ? "#000000" : "#ffffff", light ? 0.16 : 0.18),
    "--ec-accent-foreground": accentForeground,
    "--ec-accent-soft": rgba(colors.primary, light ? 0.13 : 0.17),
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
    "--ec-warning-soft": rgba(colors.warning, light ? 0.15 : 0.15),
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
    "--ec-panel-shadow": `inset 0 1px 0 ${rgba(surfaceHighlight, light ? 0.72 : 0.08)}, 0 10px 30px ${rgba(colors.background, light ? 0.16 : 0.36)}`,
    "--ec-popover-shadow": `inset 0 1px 0 ${rgba(surfaceHighlight, light ? 0.86 : 0.09)}, 0 18px 48px ${shadow}`,
    "--ec-action-shadow": `0 0 0 1px ${rgba(colors.primary, 0.25)}, 0 8px 24px ${rgba(colors.primary, light ? 0.24 : 0.3)}`,
    "--ec-terminal-bg": light ? colors.surfaceElevated : colors.background,
    "--ec-terminal-fg": colors.text,
    "--ec-terminal-cursor": colors.textMuted,
    "--ec-backdrop": colors.background,
    "--ec-backdrop-primary": rgba(colors.primary, light ? 0.3 : 0.34),
    "--ec-backdrop-secondary": rgba(colors.secondary, light ? 0.25 : 0.3),
    "--app-scrollbar-track": rgba(colors.text, light ? 0.06 : 0.04),
    "--app-scrollbar-thumb-start": rgba(colors.textMuted, light ? 0.42 : 0.32),
    "--app-scrollbar-thumb-end": rgba(colors.textMuted, light ? 0.34 : 0.24),
    "--app-scrollbar-thumb-hover-start": rgba(colors.primary, 0.58),
    "--app-scrollbar-thumb-hover-end": rgba(colors.primary, 0.46),
    "--app-scrollbar-border": "transparent",
    "--m-backdrop": colors.background,
    "--m-scrim": rgba(colors.background, light ? 0.45 : 0.68),
  };
};

export const applyDesignSchemeToDocument = (scheme: DesignScheme, persistBrowserCache = true): void => {
  if (typeof document === "undefined") return;
  const variables = designSchemeCssVariables(scheme);
  const targets = [document.documentElement, document.body].filter(Boolean);
  for (const target of targets) {
    target.dataset.theme = scheme.mode;
    target.dataset.designScheme = scheme.id;
    for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
  }
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
