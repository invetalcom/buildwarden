import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  APP_SETTING_KEYS,
  DESIGN_BACKGROUND_IMAGE_MAX_BYTES,
  DESIGN_COLOR_GROUPS,
  DESIGN_DENSITIES,
  DESIGN_ELEMENTS,
  DESIGN_GLOW_POSITIONS,
  DESIGN_RUN_HEADER_ITEMS,
  DESIGN_RUN_HEADER_STYLES,
  DESIGN_SCHEME_COLOR_KEYS,
  DESIGN_SCHEME_PRESETS,
  DESIGN_SIDEBAR_SIDES,
  DESIGN_THEME_GUIDE,
  designCssProblem,
  isDesignElementColor,
  isDesignSchemeHexColor,
  isUiTheme,
  mergeDesignCustomization,
  normalizeDesignSchemeValue,
  parseDesignScheme,
  parseDesignSchemeJson,
  serializeDesignScheme,
  uiThemeToLegacyDarkMode,
  type DesignBackgroundImage,
  type DesignBackgroundImageMimeType,
  type DesignCustomization,
  type DesignScheme,
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
    description: "Read BuildWarden's own design: the active theme, the built-in presets, and the guide to restyle the app (color roles, element types, stable CSS selectors). Call this before buildwarden_theme_set.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "buildwarden_theme_set",
    description: "Restyle the BuildWarden app itself, only when the user asks for it. Changes merge into the active theme and apply immediately; omitted fields stay as they are. Read the guide with buildwarden_theme_read first. You cannot see the result, so describe the change and ask the user how it looks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        restorePrevious: { type: "boolean", description: "Undo the last change made with this tool. Other fields are ignored." },
        preset: { type: "string", description: "Start from a built-in preset id instead of the active theme." },
        resetCustomization: { type: "boolean", description: "Drop element colors, color sets, shape, glass, fonts, layout, background image and CSS before applying the rest." },
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
        css: { type: ["string", "null"], description: "Custom CSS that replaces the previous custom CSS; null or an empty string removes it." },
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
      if (token && token !== keep && !referenced.has(token) && !this.draftImages.has(token)) rmSync(join(this.options.dataDirPath, entry), { force: true });
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

  private read(): Record<string, unknown> {
    const current = parseDesignScheme(this.options.getSettings());
    return {
      current,
      hasBackgroundImage: this.getBackgroundImage() !== null,
      canRestorePrevious: parseDesignSchemeJson(this.options.getSettings()[APP_SETTING_KEYS.designSchemePrevious]) !== null,
      presets: DESIGN_SCHEME_PRESETS.map((scheme) => ({ id: scheme.id, name: scheme.name, mode: scheme.mode, description: scheme.description })),
      guide: DESIGN_THEME_GUIDE,
    };
  }

  private set(args: Record<string, unknown>): Record<string, unknown> {
    const settings = this.options.getSettings();
    const current = parseDesignScheme(settings);

    if (args.restorePrevious === true) {
      const previous = parseDesignSchemeJson(settings[APP_SETTING_KEYS.designSchemePrevious]);
      if (!previous) throw new Error("There is no earlier theme to restore.");
      this.applyScheme(previous, current);
      return { applied: true, restored: previous.name, mode: previous.mode };
    }

    let base = current;
    if (typeof args.preset === "string") {
      const preset = DESIGN_SCHEME_PRESETS.find((scheme) => scheme.id === args.preset);
      if (!preset) throw new Error(`Unknown preset "${args.preset}". Presets: ${DESIGN_SCHEME_PRESETS.map((scheme) => scheme.id).join(", ")}.`);
      base = { ...preset, ...(current.customization ? { customization: current.customization } : {}) };
    }
    if (args.mode !== undefined && !isUiTheme(args.mode)) throw new Error("mode must be dark or light.");

    const ignored: string[] = [];
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
    if (typeof args.css === "string" && args.css.trim()) {
      const problem = designCssProblem(args.css);
      if (problem) throw new Error(problem);
    }

    const background = isRecord(args.background) ? args.background : undefined;
    const patch: Record<string, unknown> = {};
    for (const key of ["elements", "shape", "glass", "fonts", "layout", "css", ...DESIGN_COLOR_GROUPS.map((group) => group.key)] as const) if (key in args) patch[key] = args[key];
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
      ...(ignored.length > 0 ? { ignored, ignoredReason: "Unknown key or invalid color" } : {}),
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
