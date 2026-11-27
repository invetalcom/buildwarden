import { useEffect, useRef, useState } from "react";
import type { DesignColorGroupKey, DesignElementKey, DesignElementProperty } from "@buildwarden/shared";

/** A color as the browser resolved it, for display next to an empty color field. */
export type ResolvedCssColor = {
  /** `#rrggbb`, or `#rrggbbaa` when the color is translucent. Valid as an element color. */
  hex: string;
  /** The same color in a form CSS accepts everywhere. */
  css: string;
  transparent: boolean;
};

const ALPHA = String.raw`(?:\s*[,/]\s*([\d.e+-]+%?))?`;
const RGB_PATTERN = new RegExp(String.raw`^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)${ALPHA}\s*\)$`, "i");
const SRGB_PATTERN = new RegExp(String.raw`^color\(\s*srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)${ALPHA}\s*\)$`, "i");

/** Parse a computed color: `rgb()`, `rgba()`, or the `color(srgb …)` form that `color-mix()` computes to. */
export const parseCssColor = (value: string): ResolvedCssColor | null => {
  const text = value.trim();
  const rgb = RGB_PATTERN.exec(text);
  const srgb = rgb ? null : SRGB_PATTERN.exec(text);
  const match = rgb ?? srgb;
  if (!match) return null;
  const scale = rgb ? 1 : 255;
  const channels = [match[1], match[2], match[3]].map((part) => Math.min(255, Math.max(0, Math.round(Number(part) * scale))));
  const rawAlpha = match[4];
  const alpha = rawAlpha === undefined ? 1 : Math.min(1, Math.max(0, rawAlpha.endsWith("%") ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)));
  if (channels.some((channel) => Number.isNaN(channel)) || Number.isNaN(alpha)) return null;
  const hexByte = (channel: number) => channel.toString(16).padStart(2, "0");
  const alphaByte = Math.round(alpha * 255);
  return {
    hex: `#${channels.map(hexByte).join("")}${alphaByte < 255 ? hexByte(alphaByte) : ""}`,
    css: `rgba(${channels.join(", ")}, ${String(Math.round(alpha * 1000) / 1000)})`,
    transparent: alphaByte === 0,
  };
};

/**
 * The color each element type has while its override is empty, written as the CSS the app's own
 * styles use. The browser resolves these against the previewed theme, so the editor can show the
 * real color instead of the word "default". A missing property has no color of its own (no border).
 */
export const DESIGN_ELEMENT_DEFAULT_COLORS: Record<DesignElementKey, Partial<Record<DesignElementProperty, string>>> = {
  window: { background: "var(--ec-backdrop)", text: "var(--ec-text)" },
  titlebar: { background: "var(--ec-titlebar)", text: "var(--ec-text)" },
  sidebar: { background: "transparent", text: "var(--ec-text)" },
  sidebarItem: { background: "var(--ec-control)", text: "var(--ec-text)" },
  content: { background: "var(--ec-sheet)", text: "var(--ec-text)" },
  card: { background: "var(--ec-panel)", text: "var(--ec-text)" },
  button: { background: "var(--ec-control)", text: "var(--ec-text)", border: "var(--ec-border-strong)" },
  primaryButton: { background: "var(--ec-accent)", text: "var(--ec-accent-foreground)" },
  input: { background: "var(--ec-input)", text: "var(--ec-text)", border: "var(--ec-border)" },
  tabs: { background: "var(--ec-panel)", text: "var(--ec-text)" },
  dialog: { background: "var(--ec-dialog-bg)", text: "var(--ec-text)", border: "var(--ec-border)" },
  popover: { background: "var(--ec-bg-elevated)", text: "var(--ec-text)", border: "var(--ec-border)" },
  composer: { background: "var(--ec-bg-elevated)", text: "var(--ec-text)", border: "var(--ec-border)" },
  userMessage: { background: "var(--bw-prompt-fill)", text: "var(--bw-prompt-fg)", border: "var(--bw-prompt-ring)" },
  assistantMessage: { background: "transparent", text: "var(--ec-text)" },
  toolRow: { background: "transparent", text: "var(--ec-text)" },
  codeBlock: { background: "transparent", text: "var(--ec-text)" },
  terminal: { background: "var(--ec-terminal-bg)", text: "var(--ec-terminal-fg)" },
  statusbar: { background: "transparent", text: "var(--ec-muted)" },
  badge: {},
  count: { background: "transparent", text: "var(--ec-faint)" },
  dangerButton: { background: "var(--ec-danger)", text: "#ffffff" },
  switchOff: { background: "var(--ec-control-hover)" },
  switchOn: { background: "var(--ec-accent)" },
  slider: { background: "var(--ec-accent)" },
  segmented: { background: "var(--ec-control)", text: "var(--ec-muted)" },
  segmentedActive: { background: "var(--ec-bg-elevated)", text: "var(--ec-text)" },
  link: {},
  inlineCode: {},
  table: {},
  quote: {},
  reasoning: { background: "transparent" },
  runStatus: { background: "transparent" },
  runDock: { background: "var(--ec-dialog-bg)", text: "var(--ec-text)" },
  taskLane: { background: "var(--ec-panel)", text: "var(--ec-text)" },
  taskCard: { background: "var(--ec-panel-strong)", text: "var(--ec-text)" },
  notification: { background: "var(--ec-panel)", text: "var(--ec-text)" },
  homeGreeting: { text: "var(--ec-text)" },
  homeStat: { text: "var(--ec-text)" },
  commandPalette: { background: "var(--ec-dialog-bg)", text: "var(--ec-text)", border: "var(--ec-border)" },
  selection: { background: "color-mix(in srgb, var(--ec-accent) 28%, transparent)" },
  runHeader: { background: "transparent", text: "var(--ec-text)" },
};

/** The terminal library's own 16 colors, used until a theme names one. */
const TERMINAL_DEFAULTS = {
  black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000", blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f", brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
};

/**
 * The color each entry of a color set has while it is unset, as CSS for the browser to resolve.
 * `scope` is a class the probe needs around it, where the app declares the variables on a class.
 */
export const DESIGN_COLOR_GROUP_DEFAULTS: Record<DesignColorGroupKey, { scope?: string; colors: Record<string, string> }> = {
  syntax: {
    scope: "response-code",
    colors: Object.fromEntries(["keyword", "string", "comment", "number", "definition", "type", "property", "meta", "inserted", "deleted", "heading"].map((key) => [key, `var(--tok-${key})`])),
  },
  terminal: { colors: { ...TERMINAL_DEFAULTS, cursor: "var(--ec-terminal-cursor)" } },
  diff: { colors: { added: "var(--ec-success)", removed: "var(--ec-danger)" } },
  states: {
    colors: {
      running: "var(--ec-accent)", preparing: "var(--ec-info)", waiting: "var(--ec-warning)",
      completed: "var(--ec-success)", failed: "var(--ec-danger)", cancelled: "var(--ec-faint)",
    },
  },
  charts: {
    colors: {
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((slot) => [`series${String(slot)}`, `var(--usage-series-${String(slot)})`])),
      other: "var(--usage-series-other)", unattributed: "var(--usage-series-unattributed)", surface: "var(--usage-chart-surface)",
    },
  },
};

/** Shown instead of a color where an element's default is not one color. */
export const DESIGN_ELEMENT_DEFAULT_NOTES: Partial<Record<DesignElementKey, string>> = {
  badge: "by status",
};

/**
 * Resolves the colors of probe elements inside `hostRef`. Each probe is an element with a
 * `data-probe` name whose `color` is the expression to resolve. Pass a `revision` that changes
 * whenever the previewed theme does; call this after the effect that applies the preview.
 */
export const useResolvedCssColors = (revision: string) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState<Record<string, ResolvedCssColor>>({});
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const next: Record<string, ResolvedCssColor> = {};
    for (const probe of host.querySelectorAll<HTMLElement>("[data-probe]")) {
      const color = parseCssColor(getComputedStyle(probe).color);
      if (color && probe.dataset.probe) next[probe.dataset.probe] = color;
    }
    setResolved((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [revision]);
  return { hostRef, resolved };
};
