/**
 * Optional customization layered on top of a design scheme's base palette: per-element colors,
 * shape, glass, a background image, fonts and custom CSS. Everything here is optional, so a scheme
 * saved by an older version stays valid, and an older version ignores what it does not know.
 *
 * Users edit this in Settings > Appearance. Agents edit it through the `buildwarden_theme_*` tools.
 */

export const DESIGN_ELEMENT_PROPERTIES = ["background", "text", "border"] as const;
export type DesignElementProperty = (typeof DESIGN_ELEMENT_PROPERTIES)[number];
export type DesignElementStyle = Partial<Record<DesignElementProperty, string>>;

interface DesignElementDefinition {
  key: string;
  label: string;
  description: string;
  /** Stable selector that themes may rely on. Other class names change between releases. */
  selector: string;
  properties: readonly DesignElementProperty[];
  /** Properties that set a CSS variable instead of a rule, for surfaces that read colors in code. */
  variables?: Partial<Record<DesignElementProperty, string>>;
}

const element = <Key extends string>(
  key: Key,
  label: string,
  description: string,
  selector: string,
  properties: readonly DesignElementProperty[] = DESIGN_ELEMENT_PROPERTIES,
  variables?: Partial<Record<DesignElementProperty, string>>,
) => ({ key, label, description, selector, properties, ...(variables ? { variables } : {}) }) satisfies DesignElementDefinition;

/** Element types whose colors can be set one by one. The order is the order shown in the editor. */
export const DESIGN_ELEMENTS = [
  element("window", "Window", "Backdrop behind the sidebar, title bar and status bar", '[data-ui="app"]', ["background", "text"], { background: "--ec-backdrop" }),
  element("titlebar", "Title bar", "Top bar with the app menu and the page title", '[data-ui="titlebar"]', ["background", "text"], { background: "--ec-titlebar" }),
  element("sidebar", "Sidebar", "Navigation and run list", '[data-ui="sidebar"]', ["background", "text"]),
  element("sidebarItem", "Sidebar selection", "Selected row in the sidebar", '[data-ui="sidebar-item"][data-active="true"]', ["background", "text"]),
  element("content", "Content area", "Main sheet that holds the open page", '[data-ui="content"]', DESIGN_ELEMENT_PROPERTIES, { background: "--ec-sheet" }),
  element("card", "Cards", "Grouped sections inside a page", '[data-ui="card"]'),
  element("button", "Buttons", "Secondary and outline buttons", '[data-ui="button"]:not([data-variant="default"]):not([data-variant="danger"]):not([data-variant="ghost"])'),
  element("primaryButton", "Primary button", "Main action of a page or dialog", '[data-ui="button"][data-variant="default"]', ["background", "text"]),
  element("input", "Inputs", "Text fields, text areas and selects", '[data-ui="input"]'),
  element("tabs", "Active tab", "Selected tab and the panel it is joined to", '[data-ui="tab"][data-active="true"], [data-ui="tab-panel"]', ["background", "text"]),
  element("dialog", "Dialogs", "Modal dialogs", '[data-ui="dialog"]'),
  element("popover", "Menus and popovers", "Dropdowns, menus, tooltips and hover cards", '[data-ui="popover"], .glass-popover'),
  element("composer", "Composer", "Prompt input for runs and chats", '[data-ui="composer"]'),
  element("userMessage", "Your messages", "Prompts you sent", '[data-ui="message-user"]'),
  element("assistantMessage", "Agent answers", "Final answers from the agent", '[data-ui="message-assistant"]'),
  element("toolRow", "Tool calls", "Tool call rows in the run timeline", '[data-ui="tool-row"]', ["background", "text"]),
  element("codeBlock", "Code blocks", "Code in answers", '[data-ui="code-block"] > pre'),
  element("terminal", "Terminal", "Embedded run terminal", '[data-ui="terminal"]', ["background", "text"], { background: "--ec-terminal-bg", text: "--ec-terminal-fg" }),
  element("statusbar", "Status bar", "Bottom bar with workspace and app status; the border is a line along its top edge", '[data-ui="statusbar"]', DESIGN_ELEMENT_PROPERTIES, { border: "--bw-statusbar-border" }),
  element("badge", "Badges", "Status and count badges", '[data-ui="badge"]'),
  element("count", "Counts", "Small numbers next to sidebar entries, run sections and tabs", '[data-ui="count"]', ["background", "text"]),
  element("dangerButton", "Danger button", "Destructive actions such as Delete", '[data-ui="button"][data-variant="danger"]', ["background", "text"]),
  element("switchOff", "Toggle (off)", "Track of a switch that is off", '[data-ui="switch"][aria-checked="false"]', ["background"]),
  element("switchOn", "Toggle (on)", "Track of a switch that is on", '[data-ui="switch"][aria-checked="true"]', ["background"]),
  element("slider", "Sliders", "Filled part and handle of a slider", '[data-ui="slider"]', ["background"], { background: "--bw-slider" }),
  element("segmented", "Segmented switch", "Group of a few options, such as dark or light", '[data-ui="segmented"]', ["background", "text"]),
  element("segmentedActive", "Segmented switch selection", "Selected option of a segmented switch", '[data-ui="segmented"] > [aria-pressed="true"]', ["background", "text"]),
  element("link", "Links", "Links in answers", '[data-ui="markdown"] a', ["text"]),
  element("inlineCode", "Inline code", "Code within a sentence of an answer", '[data-ui="markdown"] :not(pre) > code', ["background", "text"]),
  element("table", "Tables", "Tables in answers", '[data-ui="markdown"] table'),
  element("quote", "Quotes", "Block quotes in answers", '[data-ui="markdown"] blockquote'),
  element("reasoning", "Reasoning", "The agent's reasoning text in the run timeline", '[data-ui="reasoning"]', ["background", "text"]),
  element("runStatus", "Run status lines", "Lines such as Run queued and Run completed", '[data-ui="run-status"]', ["background", "text"]),
  element("runDock", "Run result buttons", "Changed files, Validate and pull request buttons above the composer", '[data-ui="run-dock-item"]', ["background", "text"]),
  element("taskLane", "Task board lanes", "Columns of the task board", '[data-ui="task-lane"]'),
  element("taskCard", "Task board cards", "Cards on the task board", '[data-ui="task-card"]'),
  element("notification", "Notifications", "Approval and error notices in the corner of the window", '[data-ui="notification"]'),
  element("commandPalette", "Command palette", "Search and command dialog", '[data-ui="dialog"][data-kind="command-palette"]'),
  element("selection", "Text selection", "Highlight of selected text", "::selection", ["background", "text"]),
  element("runHeader", "Run header", "Bar at the top of a run with its state, facts and actions", '[data-ui="run-header"]'),
] as const;

export type DesignElementKey = (typeof DESIGN_ELEMENTS)[number]["key"];
export const DESIGN_ELEMENT_KEYS: readonly DesignElementKey[] = DESIGN_ELEMENTS.map((entry) => entry.key);

/** Further stable hooks for custom CSS that have no color controls of their own. */
export const DESIGN_CSS_HOOKS: ReadonlyArray<{ selector: string; styles: string }> = [
  ...DESIGN_ELEMENTS.map((entry) => ({ selector: entry.selector, styles: entry.description })),
  { selector: '[data-ui="sidebar-item"]', styles: "Any sidebar row" },
  { selector: '[data-ui="sidebar-footer"]', styles: "Row of icons at the bottom of the sidebar (Home, All Runs, Chats, Bookmarks, Settings)" },
  { selector: '[data-ui="button"][data-variant="ghost"]', styles: "Borderless icon and text buttons" },
  { selector: '[data-ui="tab-list"]', styles: "Row of tabs" },
  { selector: '[data-ui="tab"]', styles: "Any tab" },
  { selector: '[data-ui="tab-panel"]', styles: "Content area under a tab row. On Settings it is a transparent layer over the page sheet; give it a background for a third tone" },
  { selector: '[data-ui="page-sheet"]', styles: "Sheet of a page whose tabs sit on the window backdrop (Settings); filled like the content area" },
  { selector: '[data-ui="dialog-header"]', styles: "Dialog title area with its icon tile" },
  { selector: '[data-ui="dialog-footer"]', styles: "Dialog button row" },
  { selector: '[data-ui="switch"]', styles: "Toggle switch; [aria-checked=\"true\"] when on" },
  { selector: '[data-ui="page-header"]', styles: "Title row at the top of a page" },
  { selector: '[data-ui="settings-row"]', styles: "One setting with its label and control" },
  { selector: '[data-ui="run-timeline"]', styles: "Scrolling run and chat transcript" },
  { selector: '[data-ui="run-state"]', styles: "State of the run in the run header; [data-state] is running, preparing, waiting, completed, failed or cancelled" },
  { selector: '[data-ui="run-fact"]', styles: "One fact in the run header; [data-fact] is title, duration, model, diff, branch, tokens or plan" },
  { selector: '[data-ui="run-actions"]', styles: "Group of buttons on the right of the run header (View, Changes, more)" },
  { selector: '[data-ui="run-dock"]', styles: "Row of result buttons above the prompt box of a run" },
  { selector: '[data-ui="statusbar-item"]', styles: "One segment of the status bar; [data-tone] is ok, warn or bad when it needs attention" },
];

interface DesignColorGroupDefinition {
  key: string;
  label: string;
  description: string;
  /** Selector the variables are declared on. The app's own values sit there, so a rule on `:root` alone could lose. */
  scope: string;
  colors: ReadonlyArray<{ key: string; label: string; variable: string; /** Variable for a faint fill of the same color. */ soft?: string }>;
}

const colorGroup = <Key extends string>(key: Key, label: string, description: string, scope: string, colors: DesignColorGroupDefinition["colors"]) =>
  ({ key, label, description, scope, colors }) satisfies DesignColorGroupDefinition;

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/**
 * Sets of named colors that are not tied to one element: code tokens, the terminal palette, diff
 * lines, run states and chart series. Each color sets a CSS variable; an unset color keeps the
 * app's own value.
 */
export const DESIGN_COLOR_GROUPS = [
  colorGroup("syntax", "Code highlighting", "Token colors in code blocks", ".response-code", [
    { key: "keyword", label: "Keywords", variable: "--tok-keyword" },
    { key: "string", label: "Strings", variable: "--tok-string" },
    { key: "comment", label: "Comments", variable: "--tok-comment" },
    { key: "number", label: "Numbers", variable: "--tok-number" },
    { key: "definition", label: "Definitions", variable: "--tok-definition" },
    { key: "type", label: "Types", variable: "--tok-type" },
    { key: "property", label: "Properties", variable: "--tok-property" },
    { key: "meta", label: "Meta", variable: "--tok-meta" },
    { key: "inserted", label: "Inserted", variable: "--tok-inserted" },
    { key: "deleted", label: "Deleted", variable: "--tok-deleted" },
    { key: "heading", label: "Headings", variable: "--tok-heading" },
  ]),
  colorGroup("terminal", "Terminal palette", "The 16 colors programs print with, and the cursor", ":root, body", [
    ...ANSI_NAMES.map((name) => ({ key: name, label: name[0]!.toUpperCase() + name.slice(1), variable: `--bw-term-${name}` })),
    ...ANSI_NAMES.map((name) => ({ key: `bright${name[0]!.toUpperCase()}${name.slice(1)}`, label: `Bright ${name}`, variable: `--bw-term-bright-${name}` })),
    { key: "cursor", label: "Cursor", variable: "--ec-terminal-cursor" },
  ]),
  colorGroup("diff", "Diff lines", "Added and removed lines in answers and in the diff viewer", ":root, body", [
    { key: "added", label: "Added", variable: "--bw-diff-added" },
    { key: "removed", label: "Removed", variable: "--bw-diff-removed" },
  ]),
  colorGroup("states", "Run states", "Status dots and badges of runs", ":root, body", [
    ...(["running", "preparing", "waiting", "completed", "failed", "cancelled"] as const).map((key) => ({
      key, label: key[0]!.toUpperCase() + key.slice(1), variable: `--bw-state-${key}`, soft: `--bw-state-${key}-soft`,
    })),
  ]),
  colorGroup("charts", "Charts", "Series colors and background of the usage charts", ":root, :root[data-theme]", [
    ...[1, 2, 3, 4, 5, 6, 7].map((slot) => ({ key: `series${String(slot)}`, label: `Series ${String(slot)}`, variable: `--usage-series-${String(slot)}` })),
    { key: "other", label: "Other", variable: "--usage-series-other" },
    { key: "unattributed", label: "Unattributed", variable: "--usage-series-unattributed" },
    { key: "surface", label: "Chart background", variable: "--usage-chart-surface" },
  ]),
] as const;

export type DesignColorGroupKey = (typeof DESIGN_COLOR_GROUPS)[number]["key"];
export type DesignColorGroupValues = Partial<Record<string, string>>;

export const DESIGN_DENSITIES = ["compact", "comfortable", "spacious"] as const;
export type DesignDensity = (typeof DESIGN_DENSITIES)[number];
export const DESIGN_SIDEBAR_SIDES = ["left", "right"] as const;
export type DesignSidebarSide = (typeof DESIGN_SIDEBAR_SIDES)[number];
export const DESIGN_GLOW_POSITIONS = ["bottom", "top", "left", "right"] as const;
/** Looks of the bar at the top of a run: colored chip and facts, or one quiet sentence. */
export const DESIGN_RUN_HEADER_STYLES = ["chips", "line"] as const;
export type DesignRunHeaderStyle = (typeof DESIGN_RUN_HEADER_STYLES)[number];
/** What the run header can show. `title` only appears where the window title bar does not already name the run. */
export const DESIGN_RUN_HEADER_ITEMS = ["status", "title", "duration", "model", "diff", "branch", "tokens", "plan"] as const;
export type DesignRunHeaderItem = (typeof DESIGN_RUN_HEADER_ITEMS)[number];
export const DEFAULT_RUN_HEADER_ITEMS: readonly DesignRunHeaderItem[] = ["status", "title", "duration", "model"];
export type DesignGlowPosition = (typeof DESIGN_GLOW_POSITIONS)[number];

export const DESIGN_BACKGROUND_FITS = ["cover", "contain", "tile"] as const;
export type DesignBackgroundFit = (typeof DESIGN_BACKGROUND_FITS)[number];

export interface DesignCustomization {
  /** Colors for single element types. Values are `#rrggbb` or `#rrggbbaa`. */
  elements?: Partial<Record<DesignElementKey, DesignElementStyle>>;
  shape?: {
    /** Corner radius scale. 0 is square, 1 is the default, 2 is very round. */
    radius?: number;
    /** Divider and outline strength. 0 hides them, 1 is the default, 2 is strong. */
    borders?: number;
    /** Shadow strength of menus, dialogs and other floating surfaces. 0 removes it, 1 is the default. */
    shadow?: number;
    /** Corner radius of controls (buttons, inputs, rows), on the same 0 to 2 scale. Follows `radius` when unset. */
    radiusControls?: number;
    /** Corner radius of cards, panels and tabs. Follows `radius` when unset. */
    radiusCards?: number;
    /** Corner radius of the content sheet and the composer. Follows `radius` when unset. */
    radiusSheet?: number;
    /** Corner radius of dialogs. Follows `radius` when unset. */
    radiusDialogs?: number;
  };
  glass?: {
    /** Blur behind the sidebar, popovers and dialogs, in px (0 to 40). */
    blur?: number;
    /** Opacity of the content sheet behind every page (0 to 1). 0, the default, leaves it transparent so pages sit on the window backdrop. */
    opacity?: number;
    /** Strength of the colored glow in the window backdrop (0 to 1). */
    glow?: number;
    /** Edge of the window the two glows start from. The default is the bottom. */
    glowPosition?: DesignGlowPosition;
    /** Size of the glows (0.5 to 2, 1 is the default). */
    glowSize?: number;
    /** Color of the first glow (`#rrggbb`). The palette's primary color when unset. */
    glowPrimary?: string;
    /** Color of the second glow (`#rrggbb`). The palette's secondary color when unset. */
    glowSecondary?: string;
  };
  background?: {
    /** Token of the stored background image. The image itself is kept by the host, not in the scheme. */
    image?: string;
    /** Darkens (dark mode) or lightens (light mode) the image so text stays readable (0 to 1). */
    dim?: number;
    /** Blur of the image in px (0 to 40). */
    blur?: number;
    fit?: DesignBackgroundFit;
  };
  fonts?: {
    /** CSS font-family list for the interface. Only fonts installed on the machine can be used. */
    ui?: string;
    /** CSS font-family list for code and other fixed-width text. */
    mono?: string;
    /** Text size of the embedded terminal in px (9 to 24, 12 is the default). */
    terminalSize?: number;
  };
  layout?: {
    /** Size of the whole interface (0.8 to 1.5, 1 is the default). Applied by the desktop app only. */
    scale?: number;
    /** Height of rows, buttons, inputs and tabs. Compact is the default. */
    density?: DesignDensity;
    /** Side of the window the sidebar sits on. */
    sidebar?: DesignSidebarSide;
    /** Whether the status bar shows. Its items move back into the page and sidebar when it is hidden. */
    statusBar?: boolean;
    /** Whether the sidebar runs to the bottom edge of the window, with the status bar starting next to it (the default). When false the status bar spans the whole window under the sidebar. */
    sidebarFullHeight?: boolean;
    /** Width of the prompt box on run pages, in percent of the page (40 to 100, 75 is the default). */
    composerWidth?: number;
    /** Height of the prompt text area on run, project and chat pages, in px. Unset keeps each page's own height. */
    composerHeight?: number;
    /** Distance in px between a run's result buttons and the prompt box below them. Negative values move the buttons into the box. */
    runDockGap?: number;
    /** Width of the run and chat transcript, in percent of the page (50 to 100, 100 is the default). */
    transcriptWidth?: number;
    /** Scrollbar thickness in px (4 to 16, 7 is the default). */
    scrollbar?: number;
    /** Look of the bar at the top of a run. `chips` is the default. */
    runHeader?: DesignRunHeaderStyle;
    /** What the run header shows, in this order. Items at the end drop off first when space runs out. An empty list leaves only the buttons. */
    runHeaderItems?: DesignRunHeaderItem[];
    /** Height of the status bar in px (20 to 44, 28 is the default). The sidebar's bottom row of icons takes the same height while it sits beside the bar, so the two stay in line. */
    statusBarHeight?: number;
  };
  /** Token colors in code blocks. */
  syntax?: DesignColorGroupValues;
  /** The terminal's 16 ANSI colors and its cursor. */
  terminal?: DesignColorGroupValues;
  /** Added and removed lines. */
  diff?: DesignColorGroupValues;
  /** Colors of run states. */
  states?: DesignColorGroupValues;
  /** Chart series colors. */
  charts?: DesignColorGroupValues;
  /** Extra CSS applied after the app's styles. It cannot load remote files. */
  css?: string;
}

export const DESIGN_CUSTOM_CSS_MAX_LENGTH = 60_000;
export const DESIGN_BACKGROUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const DESIGN_BACKGROUND_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type DesignBackgroundImageMimeType = (typeof DESIGN_BACKGROUND_IMAGE_MIME_TYPES)[number];

export const DESIGN_SHAPE_LIMITS = { radius: [0, 2], borders: [0, 2], shadow: [0, 2] } as const;
export const DESIGN_GLASS_LIMITS = { blur: [0, 40], opacity: [0, 1], glow: [0, 1], glowSize: [0.5, 2] } as const;
export const DESIGN_FONT_LIMITS = { terminalSize: [9, 24] } as const;
export const DESIGN_LAYOUT_LIMITS = { scale: [0.8, 1.5], composerWidth: [40, 100], composerHeight: [56, 400], runDockGap: [-48, 48], transcriptWidth: [50, 100], scrollbar: [4, 16], statusBarHeight: [20, 44] } as const;
export const DESIGN_BACKGROUND_LIMITS = { dim: [0, 1], blur: [0, 40] } as const;

export const isDesignElementColor = (value: unknown): value is string =>
  typeof value === "string" && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const clamped = (value: unknown, [min, max]: readonly [number, number]): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 100) / 100)) : undefined;

/** A font-family list of plain names. Anything that could carry a URL or end the declaration is refused. */
const fontFamily = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 200);
  return trimmed && /^[\w\s,'"-]+$/.test(trimmed) ? trimmed : undefined;
};

const oneOf = <Value extends string>(value: unknown, allowed: readonly Value[]): Value | undefined =>
  allowed.find((entry) => entry === value);

const opaqueColor = (value: unknown): string | undefined =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;

const compact = <T extends object>(value: T): T | undefined => {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) as T : undefined;
};

/**
 * Whether custom CSS could load a file from the network or the disk. Such CSS is refused as a
 * whole. The check is deliberately blunt: comments are removed first, then any `@import`,
 * `image-set(`, `src(` or `url(` that is not a `data:` image or a `#fragment` counts, and so does
 * any backslash, because a CSS escape can spell those words without matching them.
 */
export const designCssLoadsFiles = (css: string): boolean => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (code.includes("\\")) return true;
  if (/@import|image-set\s*\(|\bsrc\s*\(/i.test(code)) return true;
  return /url\s*\((?![ \t\n\f\r]*["']?(?:data:image\/|#))/i.test(code);
};

/** Why custom CSS is refused, or null when it can be applied. */
export const designCssProblem = (css: string): string | null => {
  if (css.length > DESIGN_CUSTOM_CSS_MAX_LENGTH) return `Custom CSS is limited to ${String(DESIGN_CUSTOM_CSS_MAX_LENGTH)} characters.`;
  if (designCssLoadsFiles(css)) {
    return "Custom CSS cannot load files: remove @import, image-set(), src(), backslash escapes, and any url() that is not a data:image or #id.";
  }
  return null;
};

/** Keep what is valid and drop the rest, so one bad field never discards a whole scheme. */
export const normalizeDesignCustomization = (value: unknown): DesignCustomization | undefined => {
  if (!isRecord(value)) return undefined;
  const result: DesignCustomization = {};

  if (isRecord(value.elements)) {
    const elements: Partial<Record<DesignElementKey, DesignElementStyle>> = {};
    for (const definition of DESIGN_ELEMENTS) {
      const raw = value.elements[definition.key];
      if (!isRecord(raw)) continue;
      const style: DesignElementStyle = {};
      for (const property of definition.properties) {
        const color = raw[property];
        if (isDesignElementColor(color)) style[property] = color.trim().toLowerCase();
      }
      if (Object.keys(style).length > 0) elements[definition.key] = style;
    }
    if (Object.keys(elements).length > 0) result.elements = elements;
  }

  if (isRecord(value.shape)) {
    const shape = compact({
      radius: clamped(value.shape.radius, DESIGN_SHAPE_LIMITS.radius),
      borders: clamped(value.shape.borders, DESIGN_SHAPE_LIMITS.borders),
      shadow: clamped(value.shape.shadow, DESIGN_SHAPE_LIMITS.shadow),
      radiusControls: clamped(value.shape.radiusControls, DESIGN_SHAPE_LIMITS.radius),
      radiusCards: clamped(value.shape.radiusCards, DESIGN_SHAPE_LIMITS.radius),
      radiusSheet: clamped(value.shape.radiusSheet, DESIGN_SHAPE_LIMITS.radius),
      radiusDialogs: clamped(value.shape.radiusDialogs, DESIGN_SHAPE_LIMITS.radius),
    });
    if (shape) result.shape = shape;
  }

  if (isRecord(value.glass)) {
    const glass = compact({
      blur: clamped(value.glass.blur, DESIGN_GLASS_LIMITS.blur),
      opacity: clamped(value.glass.opacity, DESIGN_GLASS_LIMITS.opacity),
      glow: clamped(value.glass.glow, DESIGN_GLASS_LIMITS.glow),
      glowPosition: oneOf(value.glass.glowPosition, DESIGN_GLOW_POSITIONS),
      glowSize: clamped(value.glass.glowSize, DESIGN_GLASS_LIMITS.glowSize),
      glowPrimary: opaqueColor(value.glass.glowPrimary),
      glowSecondary: opaqueColor(value.glass.glowSecondary),
    });
    if (glass) result.glass = glass;
  }

  if (isRecord(value.background)) {
    const image = typeof value.background.image === "string" && /^[\w-]{1,64}$/.test(value.background.image) ? value.background.image : undefined;
    const rawFit = value.background.fit;
    const fit = DESIGN_BACKGROUND_FITS.find((entry) => entry === rawFit);
    const background = compact({
      image,
      dim: clamped(value.background.dim, DESIGN_BACKGROUND_LIMITS.dim),
      blur: clamped(value.background.blur, DESIGN_BACKGROUND_LIMITS.blur),
      fit,
    });
    if (background) result.background = background;
  }

  if (isRecord(value.fonts)) {
    const fonts = compact({
      ui: fontFamily(value.fonts.ui),
      mono: fontFamily(value.fonts.mono),
      terminalSize: clamped(value.fonts.terminalSize, DESIGN_FONT_LIMITS.terminalSize),
    });
    if (fonts) result.fonts = fonts;
  }

  if (isRecord(value.layout)) {
    const layout = compact({
      scale: clamped(value.layout.scale, DESIGN_LAYOUT_LIMITS.scale),
      density: oneOf(value.layout.density, DESIGN_DENSITIES),
      sidebar: oneOf(value.layout.sidebar, DESIGN_SIDEBAR_SIDES),
      statusBar: typeof value.layout.statusBar === "boolean" ? value.layout.statusBar : undefined,
      sidebarFullHeight: typeof value.layout.sidebarFullHeight === "boolean" ? value.layout.sidebarFullHeight : undefined,
      composerWidth: clamped(value.layout.composerWidth, DESIGN_LAYOUT_LIMITS.composerWidth),
      composerHeight: clamped(value.layout.composerHeight, DESIGN_LAYOUT_LIMITS.composerHeight),
      runDockGap: clamped(value.layout.runDockGap, DESIGN_LAYOUT_LIMITS.runDockGap),
      transcriptWidth: clamped(value.layout.transcriptWidth, DESIGN_LAYOUT_LIMITS.transcriptWidth),
      scrollbar: clamped(value.layout.scrollbar, DESIGN_LAYOUT_LIMITS.scrollbar),
      statusBarHeight: clamped(value.layout.statusBarHeight, DESIGN_LAYOUT_LIMITS.statusBarHeight),
      runHeader: oneOf(value.layout.runHeader, DESIGN_RUN_HEADER_STYLES),
      runHeaderItems: Array.isArray(value.layout.runHeaderItems)
        ? [...new Set(value.layout.runHeaderItems)].filter((item): item is DesignRunHeaderItem => DESIGN_RUN_HEADER_ITEMS.some((known) => known === item))
        : undefined,
    });
    if (layout) result.layout = layout;
  }

  for (const group of DESIGN_COLOR_GROUPS) {
    const raw = value[group.key];
    if (!isRecord(raw)) continue;
    const colors: DesignColorGroupValues = {};
    for (const definition of group.colors) {
      const color = raw[definition.key];
      if (isDesignElementColor(color)) colors[definition.key] = color.trim().toLowerCase();
    }
    if (Object.keys(colors).length > 0) result[group.key] = colors;
  }

  if (typeof value.css === "string" && value.css.trim() && designCssProblem(value.css) === null) result.css = value.css;

  return Object.keys(result).length > 0 ? result : undefined;
};

/** Merge a partial change into a customization. A null field or element removes it. */
export const mergeDesignCustomization = (base: DesignCustomization | undefined, patch: unknown): DesignCustomization | undefined => {
  if (!isRecord(patch)) return base;
  const next: Record<string, unknown> = { ...base };
  for (const key of ["shape", "glass", "background", "fonts", "layout", ...DESIGN_COLOR_GROUPS.map((group) => group.key)] as const) {
    if (!(key in patch)) continue;
    const change = patch[key];
    if (change === null) delete next[key];
    else if (isRecord(change)) {
      const merged: Record<string, unknown> = { ...(base?.[key] as Record<string, unknown> | undefined) };
      for (const [field, fieldValue] of Object.entries(change)) {
        if (fieldValue === null) delete merged[field];
        else merged[field] = fieldValue;
      }
      next[key] = merged;
    }
  }
  if ("elements" in patch) {
    if (patch.elements === null) delete next.elements;
    else if (isRecord(patch.elements)) {
      const elements: Record<string, unknown> = { ...base?.elements };
      for (const [key, change] of Object.entries(patch.elements)) {
        if (change === null) delete elements[key];
        else if (isRecord(change)) {
          const merged: Record<string, unknown> = { ...(elements[key] as Record<string, unknown> | undefined) };
          for (const [property, color] of Object.entries(change)) {
            if (color === null) delete merged[property];
            else merged[property] = color;
          }
          elements[key] = merged;
        }
      }
      next.elements = elements;
    }
  }
  if ("css" in patch) {
    if (patch.css === null || patch.css === "") delete next.css;
    else if (typeof patch.css === "string") next.css = patch.css;
  }
  return normalizeDesignCustomization(next);
};

/** What an agent needs to restyle the app. `buildwarden_theme_read` returns it. */
export const DESIGN_THEME_GUIDE = [
  "A BuildWarden theme is a base palette plus optional customization. Prefer the palette, then element colors, then CSS.",
  "",
  "Palette (`colors`, each `#rrggbb`): background, surface, surfaceElevated, text, textMuted, primary, secondary, userInput, reasoning, border, success, warning, danger.",
  "`mode` is `dark` or `light` and must match the palette: light text on dark surfaces, or the reverse.",
  "",
  "Element colors (`elements.<key>.background|text|border`, `#rrggbb` or `#rrggbbaa`, null removes one):",
  ...DESIGN_ELEMENTS.map((entry) => `- ${entry.key}: ${entry.description} (${entry.properties.join(", ")})`),
  "",
  "Color sets (each value `#rrggbb` or `#rrggbbaa`, null removes one, unset keeps the app's color):",
  ...DESIGN_COLOR_GROUPS.map((group) => `- ${group.key}: ${group.description}. Keys: ${group.colors.map((color) => color.key).join(", ")}`),
  "",
  "Shape: `shape.radius` 0 to 2 (1 is default), `shape.borders` 0 to 2 (0 hides dividers), `shape.shadow` 0 to 2 for floating surfaces. `shape.radiusControls`, `radiusCards`, `radiusSheet` and `radiusDialogs` set the radius of one kind of element and follow `radius` when unset.",
  "Glass: `glass.blur` 0 to 40 px, `glass.opacity` 0 to 1 for the content sheet behind every page (0, the default, is transparent; 0.9 gives a distinct sheet), `glass.glow` 0 to 1 for the colored backdrop glow, `glass.glowPosition` (bottom, top, left, right), `glass.glowSize` 0.5 to 2, `glass.glowPrimary` and `glass.glowSecondary` (`#rrggbb`) for its two colors.",
  "Fonts: `fonts.ui` and `fonts.mono` are font-family lists of fonts installed on the machine. `fonts.terminalSize` is the terminal text size in px (9 to 24).",
  "Layout: `layout.scale` 0.8 to 1.5 sizes the whole interface, `layout.density` (compact, comfortable, spacious) sets row and control height, `layout.sidebar` (left, right), `layout.statusBar` (true, false), `layout.sidebarFullHeight` (true by default: the sidebar reaches the bottom edge and the status bar starts next to it; false puts the status bar under the sidebar too), `layout.composerHeight` 56 to 400 (height in px of the prompt text area on run, project and chat pages; unset keeps today's heights: 56 on run pages, 80 on the project page), `layout.runDockGap` -48 to 48 (distance in px between a run's result buttons, such as changed files, Validate and the pull request, and the prompt box; the default is 20 and negative values move the buttons into the box), `layout.composerWidth` 40 to 100 and `layout.transcriptWidth` 50 to 100 in percent of the page, `layout.scrollbar` 4 to 16 px, `layout.statusBarHeight` 20 to 44 px for the status bar and the sidebar's bottom row of icons beside it (28 is the default). `layout.runHeader` (chips, line) picks the look of the bar at the top of a run, and `layout.runHeaderItems` is the ordered list of what it shows: any of status, title, duration, model, diff, branch, tokens, plan (items at the end drop off first when space runs out; title only shows where the window title bar does not name the run).",
  "Background image: pass `background.imagePath` with an absolute path to a PNG, JPEG, WebP or GIF of up to 8 MB. `background.dim` (0 to 1), `background.blur` (px) and `background.fit` (cover, contain, tile) tune it; `background.remove` deletes it. Lower `glass.opacity` so the image shows through the content.",
  "",
  "CSS (`css`) applies after the app's styles and replaces the previous custom CSS. It cannot load files: no @import, no image-set(), no backslash escapes, and url() only with data:image or #id.",
  "The app's own rules can be more specific. If a rule has no effect, add !important.",
  "Use `:root[data-theme=\"dark\"]` or `:root[data-theme=\"light\"]` to target one mode.",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...DESIGN_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "Theme variables you can read or override in CSS: --ec-backdrop, --ec-text, --ec-muted, --ec-faint, --ec-accent, --ec-border, --ec-panel, --ec-hover, --ec-success, --ec-warning, --ec-danger.",
  "",
  "You cannot see the result. Make focused changes, say what you changed, and ask the user how it looks.",
  "To undo your last change call `buildwarden_theme_set` with `restorePrevious: true`. To go back to a stock look pass `preset`.",
].join("\n");
