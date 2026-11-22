/**
 * Motion options of a design scheme: the look of the app's activity indicators (status dots, the
 * spinner, "Agent is working", loading and progress bars), their speed, and small images a theme
 * carries with it. Like the rest of the customization, everything is optional and an unset option
 * keeps the app's own look.
 */

interface DesignIndicatorDefinition {
  key: string;
  label: string;
  description: string;
  /** Stable selector of the indicator. Themes may rely on it. */
  selector: string;
  /** Built-in looks. The first one is the app's own look and applies when the theme sets nothing. */
  styles: ReadonlyArray<{ key: string; label: string }>;
  /** Name of the theme image that the `image` and `shape` styles show. */
  asset?: string;
}

const indicator = <Key extends string>(
  key: Key,
  label: string,
  description: string,
  selector: string,
  styles: ReadonlyArray<readonly [key: string, label: string]>,
  asset?: string,
) => ({
  key,
  label,
  description,
  selector,
  styles: [
    ...styles.map(([styleKey, styleLabel]) => ({ key: styleKey, label: styleLabel })),
    ...(asset ? [{ key: "image", label: "Image" }, { key: "shape", label: "Image, filled with the indicator's color" }] : []),
  ],
  ...(asset ? { asset } : {}),
}) satisfies DesignIndicatorDefinition;

/** The six run states an indicator can tell apart. They match the keys of the `states` color set. */
export const DESIGN_RUN_STATES = ["running", "preparing", "waiting", "completed", "failed", "cancelled"] as const;
export type DesignRunState = (typeof DESIGN_RUN_STATES)[number];

/** Indicators whose look a theme can choose. The order is the order shown in the editor. */
export const DESIGN_INDICATORS = [
  indicator("runStatus", "Run status", "State dot of a run in the sidebar and in the run header. Only a running or preparing run moves", '[data-ui="status-dot"]', [
    ["dot", "Still dot"], ["pulse", "Pulse"], ["ripple", "Ripple"], ["breathe", "Breathe"], ["blink", "Blink"],
  ], "run-status"),
  indicator("liveDot", "Live dots", "Small dot next to something that is active: a chat, a process, a subagent or a browser session", '[data-ui="live-dot"]', [
    ["pulse", "Pulse"], ["still", "Still dot"], ["ripple", "Ripple"], ["breathe", "Breathe"], ["blink", "Blink"],
  ], "live-dot"),
  indicator("prWatch", "Pull request watch", "Mark on a run's pull request icon while the agent works on what a watch found", '[data-ui="pr-watch"]', [
    ["ripple", "Ripple"], ["still", "Still"], ["pulse", "Pulse"], ["breathe", "Breathe"],
  ]),
  indicator("working", "Agent is working", "Block at the end of a run or chat while the agent works", '[data-ui="working"]', [
    ["card", "Full block"], ["compact", "Spinner and text"], ["text", "Text only"], ["bar", "Bar only"],
  ], "working"),
  indicator("loadingBar", "Loading bar", "Thin moving bar in the \"Agent is working\" block and under the header of the diff panel", '[data-ui="loading-bar"]', [
    ["shimmer", "Shimmer"], ["slide", "Sliding bar"], ["pulse", "Pulse"], ["stripes", "Moving stripes"], ["none", "Hidden"],
  ]),
  indicator("spinner", "Spinner", "Loading spinner on buttons, rows and panels", '[data-ui="spinner"]', [
    ["circle", "Circle"], ["ring", "Ring"], ["dots", "Dots"], ["bars", "Bars"], ["pulse", "Pulse"],
  ], "spinner"),
  indicator("toolLive", "Running tool", "Label of a tool call that is still running", '[data-ui="tool-live"]', [
    ["glow", "Glow"], ["pulse", "Pulse"], ["shimmer", "Shimmer"], ["still", "Still"],
  ]),
  indicator("activityRail", "Chat activity line", "Line under the header of a chat while it is active", '[data-ui="detail-header"]', [
    ["sweep", "Moving line"], ["pulse", "Pulse"], ["still", "Still line"], ["none", "Hidden"],
  ]),
  indicator("progress", "Progress bars and rings", "Usage limits, check progress, and the token and context rings", '[data-ui="progress"]', [
    ["plain", "Plain"], ["smooth", "Smooth changes"], ["stripes", "Moving stripes"], ["sheen", "Sheen"],
  ]),
] as const;

export type DesignIndicatorKey = (typeof DESIGN_INDICATORS)[number]["key"];
export type DesignIndicatorStyles = Partial<Record<DesignIndicatorKey, string>>;

/** The app's own look of an indicator: the first style in its list. */
export const defaultDesignIndicatorStyle = (key: DesignIndicatorKey): string =>
  DESIGN_INDICATORS.find((entry) => entry.key === key)!.styles[0]!.key;

/** When indicators stop moving. Unset keeps the app's own behavior, where only a few of them follow the system setting. */
export const DESIGN_MOTION_REDUCE = ["system", "always"] as const;
export type DesignMotionReduce = (typeof DESIGN_MOTION_REDUCE)[number];

export interface DesignMotion {
  /** Speed of the indicators' animations (0.25 to 4, 1 is the default). 2 is twice as fast. */
  speed?: number;
  /** `system` stops every indicator when the system asks for reduced motion; `always` stops them. */
  reduce?: DesignMotionReduce;
}

export const DESIGN_MOTION_LIMITS = { speed: [0.25, 4] } as const;

export const DESIGN_ASSET_MIME_TYPES = ["image/svg+xml", "image/gif", "image/png", "image/webp"] as const;
export type DesignAssetMimeType = (typeof DESIGN_ASSET_MIME_TYPES)[number];

/**
 * A small image a theme carries with it, usually an animated one (SVG, GIF, APNG or WebP). It is
 * stored inside the scheme, so it travels with an exported theme and shows in the web version too.
 * The app only ever uses it as a CSS image, where an SVG can neither run scripts nor load files.
 */
export interface DesignAsset {
  type: DesignAssetMimeType;
  /** Base64 encoded image bytes. */
  data: string;
}

export const DESIGN_ASSET_MAX_BYTES = 64 * 1024;
export const DESIGN_ASSETS_MAX_COUNT = 16;
export const DESIGN_ASSETS_MAX_TOTAL_BYTES = 256 * 1024;

/** Largest theme file an import accepts: room for the scheme, its custom CSS and all of its images. */
export const DESIGN_SCHEME_FILE_MAX_BYTES = 600_000;

/** Asset names are lower-case words joined by dashes. Each becomes the CSS variable `--bw-asset-<name>`. */
export const isDesignAssetName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 32;

/** A name for an image, made from its file name: lower-case words joined by dashes. */
export const designAssetNameFromFile = (fileName: string): string => {
  const words = fileName.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = (/^[a-z]/.test(words) ? words : `image-${words}`).slice(0, 32).replace(/-+$/, "");
  return isDesignAssetName(name) ? name : "image";
};

export const designAssetBytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

const decodedStart = (data: string): string => {
  try {
    // 1368 base64 characters are the first 1026 bytes: enough for every signature and an SVG prolog.
    return atob(data.slice(0, 1368));
  } catch {
    return "";
  }
};

const matchesSignature = (type: DesignAssetMimeType, data: string): boolean => {
  const start = decodedStart(data);
  if (type === "image/gif") return start.startsWith("GIF87a") || start.startsWith("GIF89a");
  if (type === "image/png") return start.startsWith("\u0089PNG\r\n\u001a\n");
  if (type === "image/webp") return start.startsWith("RIFF") && start.slice(8, 12) === "WEBP";
  return /<svg[\s>]/i.test(start);
};

/** The image type the bytes belong to, judged by how they start, or null when it is none of the supported ones. */
export const detectDesignAssetType = (data: string): DesignAssetMimeType | null =>
  DESIGN_ASSET_MIME_TYPES.find((type) => matchesSignature(type, data)) ?? null;

/** Why a value cannot be a theme image, or null when it can. */
export const designAssetProblem = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "A theme image needs a type and its data.";
  const { type, data } = value as { type?: unknown; data?: unknown };
  const mimeType = DESIGN_ASSET_MIME_TYPES.find((entry) => entry === type);
  if (!mimeType) return "A theme image must be an SVG, GIF, PNG or WebP.";
  if (typeof data !== "string" || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return "The image data is not valid base64.";
  if (designAssetBytes(data) > DESIGN_ASSET_MAX_BYTES) return `A theme image is limited to ${String(DESIGN_ASSET_MAX_BYTES / 1024)} KB.`;
  if (!matchesSignature(mimeType, data)) return "The image data does not match its type.";
  return null;
};

/** Keep the valid images, in their order, up to the count and total size a scheme may carry. */
export const normalizeDesignAssets = (value: unknown): Record<string, DesignAsset> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const assets: Record<string, DesignAsset> = {};
  let total = 0;
  let count = 0;
  for (const [name, raw] of Object.entries(value)) {
    if (count >= DESIGN_ASSETS_MAX_COUNT) break;
    if (!isDesignAssetName(name) || designAssetProblem(raw) !== null) continue;
    const { type, data } = raw as DesignAsset;
    const bytes = designAssetBytes(data);
    if (total + bytes > DESIGN_ASSETS_MAX_TOTAL_BYTES) continue;
    assets[name] = { type, data };
    total += bytes;
    count += 1;
  }
  return count > 0 ? assets : undefined;
};

/** Why an image cannot be added to the images a scheme already has, or null when it can. */
export const designAssetAdditionProblem = (current: Record<string, DesignAsset> | undefined, name: string, asset: unknown): string | null => {
  if (!isDesignAssetName(name)) return "Image names are lower-case words joined by dashes, such as run-status or my-spinner (32 characters at most).";
  const problem = designAssetProblem(asset);
  if (problem) return problem;
  const others = Object.entries(current ?? {}).filter(([existing]) => existing !== name);
  if (others.length >= DESIGN_ASSETS_MAX_COUNT) return `A theme can carry ${String(DESIGN_ASSETS_MAX_COUNT)} images at most.`;
  const total = others.reduce((sum, [, entry]) => sum + designAssetBytes(entry.data), 0) + designAssetBytes((asset as DesignAsset).data);
  if (total > DESIGN_ASSETS_MAX_TOTAL_BYTES) return `The images of a theme are limited to ${String(DESIGN_ASSETS_MAX_TOTAL_BYTES / 1024)} KB together.`;
  return null;
};

/** The names an indicator's `image` and `shape` styles look for: one image for all, or one per run state. */
export const designIndicatorAssetNames = (key: DesignIndicatorKey): string[] => {
  const definition = DESIGN_INDICATORS.find((entry) => entry.key === key);
  const asset = definition && "asset" in definition ? definition.asset : undefined;
  if (!asset) return [];
  return key === "runStatus" ? [asset, ...DESIGN_RUN_STATES.map((state) => `${asset}-${state}`)] : [asset];
};

/**
 * The style an indicator actually shows: the theme's choice when it is known and usable, else the
 * app's own. An image style without its image falls back, so an indicator never ends up invisible.
 */
export const resolveDesignIndicatorStyle = (
  key: DesignIndicatorKey,
  styles: DesignIndicatorStyles | undefined,
  assets: Record<string, DesignAsset> | undefined,
): string => {
  const definition = DESIGN_INDICATORS.find((entry) => entry.key === key)!;
  const fallback = definition.styles[0]!.key;
  const chosen = styles?.[key];
  if (!chosen || !definition.styles.some((style) => style.key === chosen)) return fallback;
  if ((chosen === "image" || chosen === "shape") && !designIndicatorAssetNames(key).some((name) => assets?.[name])) return fallback;
  return chosen;
};
