import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  APP_SETTING_KEYS,
  DESIGN_ASSET_MAX_BYTES,
  DESIGN_BACKGROUND_IMAGE_MAX_BYTES,
  DESIGN_COLOR_GROUPS,
  DESIGN_DENSITIES,
  DESIGN_ELEMENTS,
  DESIGN_GLOW_POSITIONS,
  DESIGN_INDICATORS,
  DESIGN_MOTION_REDUCE,
  DESIGN_RUN_HEADER_ITEMS,
  DESIGN_RUN_HEADER_STYLES,
  DESIGN_SCHEME_COLOR_KEYS,
  DESIGN_SCHEME_PRESETS,
  DESIGN_SIDEBAR_SIDES,
  DESIGN_THEME_GUIDE,
  HOME_CHART_METRICS,
  HOME_CHART_RANGES,
  HOME_LIMITS,
  HOME_POSITIONS,
  HOME_SECTIONS,
  HOME_STATS,
  designAssetAdditionProblem,
  designAssetBytes,
  designCssProblem,
  detectDesignAssetType,
  isDesignElementColor,
  isDesignSchemeHexColor,
  isUiTheme,
  mergeDesignCustomization,
  mergeHomeLayout,
  normalizeDesignSchemeValue,
  parseDesignScheme,
  parseDesignSchemeJson,
  parseHomeLayout,
  serializeDesignScheme,
  serializeHomeLayout,
  uiThemeToLegacyDarkMode,
  type DesignAsset,
  type DesignBackgroundImage,
  type DesignBackgroundImageMimeType,
  type DesignCustomization,
  type DesignScheme,
  type HomeLayout,
  type RunToolDefinition,
  type RunToolResult,
  type ThemeToolName,
} from "@buildwarden/shared";

/** One file per image, named after the token designs refer to it by. */
const IMAGE_TOKEN = /^bg-[0-9a-f]{16}$/;
const IMAGE_FILE = /^design-background-(bg-[0-9a-f]{16})\.bin$/;

/** Identify an image by its first bytes; the declared type and the file name are not trusted. */
export const detectDesignImageMimeType = (bytes: Uint8Array): DesignBackgroundImageMimeType | null => {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const luminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (left: string, right: string): number => {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
};

const colorSchema = { type: "string", description: "#rrggbb" };
const elementColorSchema = { type: ["string", "null"], description: "#rrggbb or #rrggbbaa; null removes the override" };

export const THEME_TOOLS: RunToolDefinition[] = [
  {
    name: "buildwarden_theme_read",
    description: "Read BuildWarden's own design: the active theme, the layout of the Home page, the built-in presets, and the guide to restyle the app (color roles, element types, stable CSS selectors). Call this before buildwarden_theme_set.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "buildwarden_theme_set",
    description: "Restyle the BuildWarden app itself or rearrange its Home page, only when the user asks for it. Changes merge into the active theme and Home layout and apply immediately; omitted fields stay as they are. Read the guide with buildwarden_theme_read first. You cannot see the result, so describe the change and ask the user how it looks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        restorePrevious: { type: "boolean", description: "Undo the last change made with this tool, including a change to the Home page. Other fields are ignored." },
        preset: { type: "string", description: "Start from a built-in preset id instead of the active theme." },
        resetCustomization: { type: "boolean", description: "Drop element colors, color sets, shape, glass, fonts, layout, motion, indicator looks, theme images, background image and CSS before applying the rest." },
        name: { type: "string", description: "Display name of the resulting theme." },
        mode: { type: "string", enum: ["dark", "light"] },
        colors: {
          type: "object",
          additionalProperties: false,
          description: "Base palette roles to change.",
          properties: Object.fromEntries(DESIGN_SCHEME_COLOR_KEYS.map((key) => [key, colorSchema])),
        },
        elements: {
          type: "object",
          additionalProperties: false,
          description: "Colors for single element types. Set an element to null to clear it.",
          properties: Object.fromEntries(DESIGN_ELEMENTS.map((entry) => [entry.key, {
            type: ["object", "null"],
            additionalProperties: false,
            description: entry.description,
            properties: Object.fromEntries(entry.properties.map((property) => [property, elementColorSchema])),
          }])),
        },
        shape: {
          type: "object", additionalProperties: false,
          properties: Object.fromEntries(["radius", "borders", "shadow", "radiusControls", "radiusCards", "radiusSheet", "radiusDialogs"].map((key) => [key, { type: ["number", "null"], minimum: 0, maximum: 2 }])),
        },
        glass: {
          type: "object", additionalProperties: false,
          properties: {
            blur: { type: "number", minimum: 0, maximum: 40 },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            glow: { type: "number", minimum: 0, maximum: 1 },
            glowPosition: { type: ["string", "null"], enum: [...DESIGN_GLOW_POSITIONS, null] },
            glowSize: { type: ["number", "null"], minimum: 0.5, maximum: 2 },
            glowPrimary: { type: ["string", "null"], description: "#rrggbb" },
            glowSecondary: { type: ["string", "null"], description: "#rrggbb" },
          },
        },
        fonts: {
          type: "object", additionalProperties: false,
          properties: { ui: { type: "string" }, mono: { type: "string" }, terminalSize: { type: ["number", "null"], minimum: 9, maximum: 24 } },
        },
        layout: {
          type: "object", additionalProperties: false,
          properties: {
            scale: { type: ["number", "null"], minimum: 0.8, maximum: 1.5 },
            density: { type: ["string", "null"], enum: [...DESIGN_DENSITIES, null] },
            sidebar: { type: ["string", "null"], enum: [...DESIGN_SIDEBAR_SIDES, null] },
            statusBar: { type: ["boolean", "null"] },
            sidebarFullHeight: { type: ["boolean", "null"] },
            composerWidth: { type: ["number", "null"], minimum: 40, maximum: 100 },
            composerHeight: { type: ["number", "null"], minimum: 56, maximum: 400 },
            runDockGap: { type: ["number", "null"], minimum: -48, maximum: 48 },
            transcriptWidth: { type: ["number", "null"], minimum: 50, maximum: 100 },
            scrollbar: { type: ["number", "null"], minimum: 4, maximum: 16 },
            statusBarHeight: { type: ["number", "null"], minimum: 20, maximum: 44 },
            runHeader: { type: ["string", "null"], enum: [...DESIGN_RUN_HEADER_STYLES, null] },
            runHeaderItems: { type: ["array", "null"], items: { type: "string", enum: [...DESIGN_RUN_HEADER_ITEMS] } },
          },
        },
        ...Object.fromEntries(DESIGN_COLOR_GROUPS.map((group) => [group.key, {
          type: ["object", "null"],
          description: `${group.description}. Null removes the whole set.`,
          additionalProperties: false,
          properties: Object.fromEntries(group.colors.map((color) => [color.key, elementColorSchema])),
        }])),
        background: {
          type: "object", additionalProperties: false,
          properties: {
            imagePath: { type: "string", description: "Absolute path to a PNG, JPEG, WebP or GIF of up to 8 MB to use as the background image." },
            remove: { type: "boolean", description: "Remove the background image." },
            dim: { type: "number", minimum: 0, maximum: 1 },
            blur: { type: "number", minimum: 0, maximum: 40 },
            fit: { type: "string", enum: ["cover", "contain", "tile"] },
          },
        },
        motion: {
          type: "object", additionalProperties: false,
          description: "Speed of the activity indicators and when they stop moving.",
          properties: {
            speed: { type: ["number", "null"], minimum: 0.25, maximum: 4 },
            reduce: { type: ["string", "null"], enum: [...DESIGN_MOTION_REDUCE, null] },
          },
        },
        indicators: {
          type: "object", additionalProperties: false,
          description: "Built-in look of each activity indicator. The first style listed is the app's own; null returns to it.",
          properties: Object.fromEntries(DESIGN_INDICATORS.map((entry) => [entry.key, {
            type: ["string", "null"],
            enum: [...entry.styles.map((style) => style.key), null],
            description: entry.description,
          }])),
        },
        assets: {
          type: "array",
          description: "Small images the theme carries, usually animated. Give each a name and either its SVG source or the path of an image file; remove deletes one.",
          items: {
            type: "object", additionalProperties: false, required: ["name"],
            properties: {
              name: { type: "string", description: "Lower-case words joined by dashes, such as spinner or run-status-running." },
              svg: { type: "string", description: "SVG source. It may animate itself with SMIL or a <style> block." },
              path: { type: "string", description: "Absolute path to an SVG, GIF, PNG (APNG) or WebP file of up to 64 KB." },
              remove: { type: "boolean" },
            },
          },
        },
        css: { type: ["string", "null"], description: "Custom CSS that replaces the previous custom CSS; null or an empty string removes it." },
        home: {
          type: ["object", "null"], additionalProperties: false,
          description: "What the Home page shows. Stored apart from the theme, so presets and resetCustomization leave it alone. Null resets the whole page; a null field returns that field to its default.",
          properties: {
            sections: { type: ["array", "null"], description: "Middle sections that show, in display order.", items: { type: "string", enum: HOME_SECTIONS.map((entry) => entry.key) } },
            stats: { type: ["array", "null"], minItems: 1, description: "Figures of the stats section, in display order.", items: { type: "string", enum: HOME_STATS.map((entry) => entry.key) } },
            recentRuns: { type: ["number", "null"], minimum: HOME_LIMITS.recentRuns[0], maximum: HOME_LIMITS.recentRuns[1] },
            greetingText: { type: ["string", "null"], maxLength: HOME_LIMITS.greetingText, description: "Replaces the greeting. Empty greets by time of day." },
            bootMessage: { type: ["boolean", "null"], description: "The joke line in the top left corner." },
            chart: {
              type: ["object", "null"], additionalProperties: false,
              description: "Activity chart along the bottom edge. Each metric is a lane with its own scale.",
              properties: {
                show: { type: ["boolean", "null"] },
                metrics: { type: ["array", "null"], minItems: 1, items: { type: "string", enum: HOME_CHART_METRICS.map((entry) => entry.key) } },
                range: { type: ["number", "null"], enum: [...HOME_CHART_RANGES, null], description: "Days the chart covers." },
              },
            },
            width: { type: ["number", "null"], minimum: HOME_LIMITS.width[0], maximum: HOME_LIMITS.width[1], description: "Width of the middle sections in percent of the page." },
            position: { type: ["string", "null"], enum: [...HOME_POSITIONS, null] },
          },
        },
      },
    },
  },
];

export interface DesignThemeServiceOptions {
  /** Directory for the stored background image. */
  dataDirPath: string;
  getSettings: () => Record<string, string>;
  setSetting: (key: string, value: string) => void;
  /** Called after the active design changed, so native chrome and open windows can follow. */
  onDesignChanged: () => void;
}

/** Stores the design's background image and lets agents read and change the app's design. */
export class DesignThemeService {
  /** Images the appearance editor stored for a draft that is neither saved nor discarded yet. */
  private readonly draftImages = new Set<string>();

  constructor(private readonly options: DesignThemeServiceOptions) {}

  private imageFile(token: string): string { return join(this.options.dataDirPath, `design-background-${token}.bin`); }

  /** Tokens of the images that the active design and the two undo snapshots refer to. */
  private referencedImages(): Set<string> {
    const settings = this.options.getSettings();
    const schemes = [
      parseDesignScheme(settings),
      parseDesignSchemeJson(settings[APP_SETTING_KEYS.designSchemePrevious]),
      parseDesignSchemeJson(settings[APP_SETTING_KEYS.designSchemeBeforeAgent]),
    ];
    return new Set(schemes.flatMap((scheme) => scheme?.customization?.background?.image ?? []));
  }

  /**
   * Deletes stored images that no design refers to any more. An image stays as long as the active
   * design, an undo snapshot or an open draft names it, so neither undoing a change nor applying a
   * draft leads to a missing image. `keep` protects an image that was just stored for a design
   * that is about to be saved.
   */
  private pruneImages(keep?: string): void {
    const referenced = this.referencedImages();
    let entries: string[];
    try {
      entries = readdirSync(this.options.dataDirPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const token = IMAGE_FILE.exec(entry)?.[1];
      if (!token || token === keep || referenced.has(token) || this.draftImages.has(token)) continue;
      try {
        rmSync(join(this.options.dataDirPath, entry), { force: true });
      } catch {
        // Clearing old images is housekeeping. A file that cannot be deleted now, for example
        // because it is in use, is tried again the next time, and never fails the change itself.
      }
    }
  }

  /** The image of the active design, or of the given token. */
  getBackgroundImage(token: string | undefined = parseDesignScheme(this.options.getSettings()).customization?.background?.image): DesignBackgroundImage | null {
    if (!token || !IMAGE_TOKEN.test(token)) return null;
    try {
      const bytes = readFileSync(this.imageFile(token));
      const mimeType = detectDesignImageMimeType(bytes);
      return mimeType ? { token, mimeType, data: bytes.toString("base64") } : null;
    } catch {
      return null;
    }
  }

  /**
   * Stores image bytes for a draft in the appearance editor and returns the token designs refer to
   * them by. The image of the saved design is left alone, and the new one is kept until the editor
   * reports that the draft was saved or discarded: that is what null does. It stores nothing,
   * releases the draft images and clears the ones no design refers to.
   */
  setBackgroundImage(image: { mimeType?: unknown; data?: unknown } | null): string | null {
    if (image === null) {
      this.draftImages.clear();
      this.pruneImages();
      return null;
    }
    if (typeof image.data !== "string" || image.data.length > Math.ceil(DESIGN_BACKGROUND_IMAGE_MAX_BYTES / 3) * 4 + 4) {
      throw new Error("The background image must be at most 8 MB.");
    }
    const token = this.storeBytes(Buffer.from(image.data, "base64"));
    this.draftImages.add(token);
    return token;
  }

  private storeBytes(bytes: Buffer): string {
    if (bytes.byteLength === 0 || bytes.byteLength > DESIGN_BACKGROUND_IMAGE_MAX_BYTES) throw new Error("The background image must be at most 8 MB.");
    const mimeType = detectDesignImageMimeType(bytes);
    if (!mimeType) throw new Error("The background image must be a PNG, JPEG, WebP or GIF file.");
    const token = `bg-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
    mkdirSync(this.options.dataDirPath, { recursive: true });
    writeFileSync(this.imageFile(token), bytes);
    this.pruneImages(token);
    return token;
  }

  private storeFile(path: string): string {
    if (!isAbsolute(path)) throw new Error("background.imagePath must be an absolute path.");
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No image file at ${path}.`);
    if (statSync(path).size > DESIGN_BACKGROUND_IMAGE_MAX_BYTES) throw new Error("The background image must be at most 8 MB.");
    return this.storeBytes(readFileSync(path));
  }

  /** Turns one entry of the tool's `assets` list into a theme image; null means "remove it". */
  private readAsset(entry: unknown, current: Record<string, DesignAsset>): { name: string; asset: DesignAsset | null } {
    if (!isRecord(entry) || typeof entry.name !== "string") throw new Error("Each entry of assets needs a name.");
    const name = entry.name;
    if (entry.remove === true) return { name, asset: null };
    let asset: DesignAsset;
    if (typeof entry.svg === "string") {
      asset = { type: "image/svg+xml", data: Buffer.from(entry.svg, "utf8").toString("base64") };
    } else if (typeof entry.path === "string") {
      if (!isAbsolute(entry.path)) throw new Error(`assets "${name}": path must be an absolute path.`);
      if (!existsSync(entry.path) || !statSync(entry.path).isFile()) throw new Error(`assets "${name}": no image file at ${entry.path}.`);
      if (statSync(entry.path).size > DESIGN_ASSET_MAX_BYTES) throw new Error(`assets "${name}": a theme image is limited to ${String(DESIGN_ASSET_MAX_BYTES / 1024)} KB.`);
      const data = readFileSync(entry.path).toString("base64");
      const type = detectDesignAssetType(data);
      if (!type) throw new Error(`assets "${name}": the file must be an SVG, GIF, PNG or WebP image.`);
      asset = { type, data };
    } else {
      throw new Error(`assets "${name}" needs svg, path or remove.`);
    }
    const problem = designAssetAdditionProblem(current, name, asset);
    if (problem) throw new Error(`assets "${name}": ${problem}`);
    return { name, asset };
  }

  private applyScheme(next: DesignScheme, previous: DesignScheme): void {
    // Keep the design the user had before the first agent change. Later agent changes must not
    // replace it, or "Undo agent changes" would only step back to an earlier agent design.
    if (!parseDesignSchemeJson(this.options.getSettings()[APP_SETTING_KEYS.designSchemeBeforeAgent])) {
      this.options.setSetting(APP_SETTING_KEYS.designSchemeBeforeAgent, serializeDesignScheme(previous));
    }
    this.options.setSetting(APP_SETTING_KEYS.designSchemePrevious, serializeDesignScheme(previous));
    this.options.setSetting(APP_SETTING_KEYS.designScheme, serializeDesignScheme(next));
    this.options.setSetting(APP_SETTING_KEYS.uiTheme, next.mode);
    this.options.setSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next.mode));
    this.pruneImages();
    this.options.onDesignChanged();
  }

  /**
   * Saves a Home layout an agent asked for and keeps the one before it for `restorePrevious`. A
   * call that leaves Home alone clears that snapshot instead, so undoing a later theme change never
   * takes back what the user arranged on Home in the meantime.
   */
  private storeHome(next: HomeLayout | null, before: string | undefined): void {
    if (!next) {
      this.options.setSetting(APP_SETTING_KEYS.homeLayoutPrevious, "");
      return;
    }
    this.options.setSetting(APP_SETTING_KEYS.homeLayoutPrevious, serializeHomeLayout(parseHomeLayout(before)));
    this.options.setSetting(APP_SETTING_KEYS.homeLayout, serializeHomeLayout(next));
  }

  private read(): Record<string, unknown> {
    const current = parseDesignScheme(this.options.getSettings());
    // The images' bytes would only fill the agent's context. It gets their names, types and sizes.
    const assets = Object.entries(current.customization?.assets ?? {}).map(([name, asset]) => ({ name, type: asset.type, bytes: designAssetBytes(asset.data) }));
    const customization = current.customization ? { ...current.customization } : undefined;
    if (customization) delete customization.assets;
    return {
      current: { ...current, ...(customization ? { customization } : {}) },
      home: parseHomeLayout(this.options.getSettings()[APP_SETTING_KEYS.homeLayout]),
      assets,
      hasBackgroundImage: this.getBackgroundImage() !== null,
      canRestorePrevious: parseDesignSchemeJson(this.options.getSettings()[APP_SETTING_KEYS.designSchemePrevious]) !== null,
      presets: DESIGN_SCHEME_PRESETS.map((scheme) => ({ id: scheme.id, name: scheme.name, mode: scheme.mode, description: scheme.description })),
      guide: DESIGN_THEME_GUIDE,
    };
  }

  private set(args: Record<string, unknown>): Record<string, unknown> {
    const settings = this.options.getSettings();
    const current = parseDesignScheme(settings);
    const homeBefore = settings[APP_SETTING_KEYS.homeLayout];

    if (args.restorePrevious === true) {
      const previous = parseDesignSchemeJson(settings[APP_SETTING_KEYS.designSchemePrevious]);
      if (!previous) throw new Error("There is no earlier theme to restore.");
      const previousHome = settings[APP_SETTING_KEYS.homeLayoutPrevious];
      // Swapped like the theme, so a second restorePrevious brings the undone change back.
      if (previousHome) this.storeHome(parseHomeLayout(previousHome), homeBefore);
      // After a call that changed only Home, the snapshot is the theme itself. Applying it would
      // record an agent change to the design that never happened.
      if (serializeDesignScheme(previous) === serializeDesignScheme(current)) this.options.onDesignChanged();
      else this.applyScheme(previous, current);
      return { applied: true, restored: previous.name, mode: previous.mode, ...(previousHome ? { homeRestored: true } : {}) };
    }

    const ignored: string[] = [];
    let home: HomeLayout | null = null;
    if ("home" in args) {
      if (args.home !== null && !isRecord(args.home)) throw new Error("home must be an object, or null to reset the Home page.");
      const merged = mergeHomeLayout(parseHomeLayout(args.home === null ? undefined : homeBefore), args.home ?? {});
      home = merged.layout;
      ignored.push(...merged.ignored.map((key) => `home.${key}`));
    }
    // A flag sent with its default value asks for nothing, so it does not make this a theme change.
    const asksNothing = (key: string, value: unknown) => (key === "restorePrevious" || key === "resetCustomization") && value !== true;
    if (home && Object.entries(args).every(([key, value]) => key === "home" || asksNothing(key, value))) {
      // Only Home changes. The theme is kept as it is, and its undo snapshot is set to the same
      // theme so that restorePrevious takes back exactly this call.
      this.options.setSetting(APP_SETTING_KEYS.designSchemePrevious, serializeDesignScheme(current));
      this.storeHome(home, homeBefore);
      this.options.onDesignChanged();
      return {
        applied: true,
        home,
        ...(ignored.length > 0 ? { ignored, ignoredReason: "Unknown key or invalid value" } : {}),
        note: "Applied to the Home page. You cannot see the app: tell the user what changed and ask how it looks. restorePrevious: true undoes this change.",
      };
    }

    let base = current;
    if (typeof args.preset === "string") {
      const preset = DESIGN_SCHEME_PRESETS.find((scheme) => scheme.id === args.preset);
      if (!preset) throw new Error(`Unknown preset "${args.preset}". Presets: ${DESIGN_SCHEME_PRESETS.map((scheme) => scheme.id).join(", ")}.`);
      base = { ...preset, ...(current.customization ? { customization: current.customization } : {}) };
    }
    if (args.mode !== undefined && !isUiTheme(args.mode)) throw new Error("mode must be dark or light.");

    const colors = { ...base.colors };
    if (isRecord(args.colors)) {
      for (const [key, value] of Object.entries(args.colors)) {
        const role = DESIGN_SCHEME_COLOR_KEYS.find((entry) => entry === key);
        if (!role || !isDesignSchemeHexColor(value)) ignored.push(`colors.${key}`);
        else colors[role] = value.trim().toLowerCase();
      }
    }
    if (isRecord(args.elements)) {
      for (const [key, style] of Object.entries(args.elements)) {
        const definition = DESIGN_ELEMENTS.find((entry) => entry.key === key);
        if (!definition) { ignored.push(`elements.${key}`); continue; }
        if (!isRecord(style)) continue;
        for (const [property, color] of Object.entries(style)) {
          const known = (definition.properties as readonly string[]).includes(property);
          if (!known || (color !== null && !isDesignElementColor(color))) ignored.push(`elements.${key}.${property}`);
        }
      }
    }
    for (const group of DESIGN_COLOR_GROUPS) {
      const values = args[group.key];
      if (!isRecord(values)) continue;
      for (const [key, color] of Object.entries(values)) {
        const known = group.colors.some((entry) => entry.key === key);
        if (!known || (color !== null && !isDesignElementColor(color))) ignored.push(`${group.key}.${key}`);
      }
    }
    if (isRecord(args.indicators)) {
      for (const [key, style] of Object.entries(args.indicators)) {
        const definition = DESIGN_INDICATORS.find((entry) => entry.key === key);
        if (!definition || (style !== null && !definition.styles.some((entry) => entry.key === style))) ignored.push(`indicators.${key}`);
      }
    }
    if (typeof args.css === "string" && args.css.trim()) {
      const problem = designCssProblem(args.css);
      if (problem) throw new Error(problem);
    }

    const background = isRecord(args.background) ? args.background : undefined;
    const patch: Record<string, unknown> = {};
    for (const key of ["elements", "shape", "glass", "fonts", "layout", "motion", "indicators", "css", ...DESIGN_COLOR_GROUPS.map((group) => group.key)] as const) if (key in args) patch[key] = args[key];
    if (Array.isArray(args.assets) && args.assets.length > 0) {
      // Checked one by one against what the theme will hold, so the count and size limits apply to the result.
      const held: Record<string, DesignAsset> = { ...(args.resetCustomization === true ? undefined : base.customization?.assets) };
      const changes: Record<string, DesignAsset | null> = {};
      for (const entry of args.assets) {
        const { name, asset } = this.readAsset(entry, held);
        changes[name] = asset;
        if (asset) held[name] = asset;
        else delete held[name];
      }
      patch.assets = changes;
    }
    if (background) {
      // imagePath and remove are handled below; only the tuning fields are merged.
      const tuning: Record<string, unknown> = { ...background };
      delete tuning.imagePath;
      delete tuning.remove;
      patch.background = tuning;
    }
    let customization: DesignCustomization | undefined = mergeDesignCustomization(args.resetCustomization === true ? undefined : base.customization, patch);

    // The image file itself stays until no design or undo snapshot refers to it.
    if (args.resetCustomization === true || background?.remove === true) {
      customization = mergeDesignCustomization(customization, { background: { image: null } });
    }
    if (typeof background?.imagePath === "string") {
      const token = this.storeFile(background.imagePath);
      customization = mergeDesignCustomization(customization, { background: { image: token } });
    }

    const changedDesign = isRecord(args.colors) || "mode" in args || Object.keys(patch).length > 0 || args.resetCustomization === true
      || background?.remove === true || typeof background?.imagePath === "string";
    const presetOnly = typeof args.preset === "string" && !changedDesign;
    const next = normalizeDesignSchemeValue({
      version: 1,
      id: presetOnly ? base.id : "custom",
      name: typeof args.name === "string" && args.name.trim() ? args.name : presetOnly || base.id === "custom" ? base.name : `${base.name} Custom`,
      description: presetOnly ? base.description : "Custom BuildWarden design scheme.",
      mode: isUiTheme(args.mode) ? args.mode : base.mode,
      colors,
      ...(customization ? { customization } : {}),
    });
    if (!next) throw new Error("The resulting theme is not valid.");

    this.storeHome(home, homeBefore);
    this.applyScheme(next, current);
    const warnings: string[] = [];
    if (contrast(next.colors.text, next.colors.surface) < 4.5 || contrast(next.colors.text, next.colors.background) < 4.5) {
      warnings.push("Text has low contrast against the surface or background color; body text may be hard to read.");
    }
    if ((luminance(next.colors.background) > 0.4) !== (next.mode === "light")) warnings.push(`mode is ${next.mode}, but the background color looks ${next.mode === "light" ? "dark" : "light"}. Set mode to match.`);
    return {
      applied: true,
      name: next.name,
      mode: next.mode,
      customized: Object.keys(next.customization ?? {}),
      ...(home ? { home } : {}),
      ...(ignored.length > 0 ? { ignored, ignoredReason: "Unknown key or invalid value" } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      note: "Applied. You cannot see the app: tell the user what changed and ask how it looks. restorePrevious: true undoes this change.",
    };
  }

  executeTool(callId: string, name: ThemeToolName, args: Record<string, unknown>): RunToolResult {
    try {
      const result = name === "buildwarden_theme_read" ? this.read() : this.set(args);
      return { toolCallId: callId, name, ok: true, content: JSON.stringify(result) };
    } catch (error) {
      return { toolCallId: callId, name, ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }
}
