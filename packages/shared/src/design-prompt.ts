/**
 * Look of the prompts you sent, in runs and chats: a bubble that hugs its text, with the files of
 * the prompt as thumbnails. Part of a design scheme's customization, so everything is optional and
 * an unset option keeps the default listed in `DESIGN_PROMPT_DEFAULTS`.
 */

/** Material of the bubble. The first one is the default. */
export const DESIGN_PROMPT_STYLES = ["glass", "soft", "solid", "outline"] as const;
export type DesignPromptStyle = (typeof DESIGN_PROMPT_STYLES)[number];
export const DESIGN_PROMPT_ALIGNS = ["right", "left"] as const;
export type DesignPromptAlign = (typeof DESIGN_PROMPT_ALIGNS)[number];
/** `hug` sizes the bubble to its text; `fill` always gives it the maximum width. */
export const DESIGN_PROMPT_FITS = ["hug", "fill"] as const;
export type DesignPromptFit = (typeof DESIGN_PROMPT_FITS)[number];
/** `tucked` makes the corner next to the edge of the transcript nearly square. */
export const DESIGN_PROMPT_CORNERS = ["round", "tucked"] as const;
export type DesignPromptCorner = (typeof DESIGN_PROMPT_CORNERS)[number];
/** When the line under the bubble (kind, mode, time, copy and undo) shows. */
export const DESIGN_PROMPT_DETAILS = ["hover", "always", "hidden"] as const;
export type DesignPromptDetails = (typeof DESIGN_PROMPT_DETAILS)[number];
/** What the line under the bubble can show. `kind` is "follow-up" or "steered"; chats have no mode. */
export const DESIGN_PROMPT_DETAIL_ITEMS = ["kind", "mode", "time"] as const;
export type DesignPromptDetailItem = (typeof DESIGN_PROMPT_DETAIL_ITEMS)[number];
/** Where the files of a prompt go: tiles over the bubble, tiles inside it, or plain names inside it. */
export const DESIGN_PROMPT_FILES = ["above", "inside", "names"] as const;
export type DesignPromptFiles = (typeof DESIGN_PROMPT_FILES)[number];
export const DESIGN_PROMPT_THUMBNAIL_SHAPES = ["wide", "square"] as const;
export type DesignPromptThumbnailShape = (typeof DESIGN_PROMPT_THUMBNAIL_SHAPES)[number];

export interface DesignPrompt {
  style?: DesignPromptStyle;
  align?: DesignPromptAlign;
  fit?: DesignPromptFit;
  corner?: DesignPromptCorner;
  /** Largest width of the bubble, in percent of the transcript. */
  maxWidth?: number;
  /** Text size in px. Unset follows the transcript. */
  textSize?: number;
  /** Font weight of the text, in steps of 100. */
  textWeight?: number;
  /** Scale of the space between the text and the edge of the bubble. 1 is the default. */
  padding?: number;
  /** Corner radius of the bubble in px. */
  radius?: number;
  /** Lines of a prompt that show before "Show more". 0 shows every prompt in full. */
  clampLines?: number;
  /** How strong the fill is (0 to 1). Unset uses the style's own: faint for glass and soft, full for solid, none for outline. */
  opacity?: number;
  /** How much of the palette's user input color the fill and the outline carry (0 to 1). */
  tint?: number;
  /** Glass only: blur of what lies behind the bubble, in px. */
  blur?: number;
  /** Glass only: strength of the light edge (0 to 1). */
  edge?: number;
  /** Strength of a soft shadow under the bubble (0 to 1). */
  shadow?: number;
  details?: DesignPromptDetails;
  /** What the line under the bubble shows, in this order. */
  detailItems?: DesignPromptDetailItem[];
  files?: DesignPromptFiles;
  /** Height of a file thumbnail in px. */
  thumbnailSize?: number;
  thumbnailShape?: DesignPromptThumbnailShape;
  /** Corner radius of a file thumbnail in px. */
  thumbnailRadius?: number;
  /** Whether a thumbnail carries its file type, and its length for audio and video. */
  thumbnailLabels?: boolean;
  /** Tiles a prompt shows. With more files, the last tile is "+N" and stands for the rest. */
  filesMax?: number;
}

export const DESIGN_PROMPT_LIMITS = {
  maxWidth: [30, 100],
  textSize: [11, 20],
  textWeight: [300, 700],
  padding: [0.5, 2],
  radius: [0, 28],
  clampLines: [0, 40],
  opacity: [0, 1],
  tint: [0, 1],
  blur: [0, 40],
  edge: [0, 1],
  shadow: [0, 1],
  thumbnailSize: [32, 160],
  thumbnailRadius: [0, 24],
  filesMax: [1, 24],
} as const;

/** Fill strength each style has until a theme sets one. */
export const DESIGN_PROMPT_STYLE_OPACITY: Record<DesignPromptStyle, number> = { glass: 0.08, soft: 0.09, solid: 1, outline: 0 };

/** Every prompt option with its default filled in. Only the text size may stay unset. */
export type ResolvedDesignPrompt = Required<Omit<DesignPrompt, "textSize" | "detailItems">> & {
  textSize: number | undefined;
  detailItems: readonly DesignPromptDetailItem[];
};

export const DESIGN_PROMPT_DEFAULTS: Omit<ResolvedDesignPrompt, "opacity" | "textSize"> = {
  style: "glass",
  align: "right",
  fit: "hug",
  corner: "round",
  maxWidth: 76,
  textWeight: 400,
  padding: 1,
  radius: 16,
  clampLines: 0,
  tint: 0,
  blur: 14,
  edge: 1,
  shadow: 0,
  details: "hover",
  detailItems: DESIGN_PROMPT_DETAIL_ITEMS,
  files: "above",
  thumbnailSize: 64,
  thumbnailShape: "wide",
  thumbnailRadius: 10,
  thumbnailLabels: true,
  filesMax: 6,
};

export const resolveDesignPrompt = (prompt: DesignPrompt | undefined): ResolvedDesignPrompt => {
  const set = Object.fromEntries(Object.entries(prompt ?? {}).filter(([, value]) => value !== undefined)) as DesignPrompt;
  const style = set.style ?? DESIGN_PROMPT_DEFAULTS.style;
  return {
    ...DESIGN_PROMPT_DEFAULTS,
    ...set,
    style,
    opacity: set.opacity ?? DESIGN_PROMPT_STYLE_OPACITY[style],
    textSize: set.textSize,
    detailItems: set.detailItems ?? DESIGN_PROMPT_DEFAULTS.detailItems,
  };
};

/** For agents: what `prompt` holds. Part of the theme guide. */
export const DESIGN_PROMPT_GUIDE = [
  "Your prompts (`prompt`, null resets all of it, a null field returns to its default): the bubble a prompt you sent shows in, in runs and chats.",
  `- \`prompt.style\` (${DESIGN_PROMPT_STYLES.join(", ")}): glass is a see-through fill with a blur and a light edge, soft a faint fill, solid a full fill with contrasting text, outline a thin ring without fill.`,
  "- `prompt.opacity` 0 to 1 is the strength of the fill (each style has its own until set). `prompt.tint` 0 to 1 mixes the palette's `userInput` color into the fill and the ring. `prompt.blur` 0 to 40 px and `prompt.edge` 0 to 1 tune the glass. `prompt.shadow` 0 to 1 adds a soft shadow.",
  "- For an exact color set `elements.userMessage.background`, `text` or `border`; an eight-digit background keeps the glass see-through.",
  `- Size: \`prompt.maxWidth\` 30 to 100 percent of the transcript, \`prompt.fit\` (${DESIGN_PROMPT_FITS.join(", ")}; fill always uses the maximum width), \`prompt.textSize\` 11 to 20 px, \`prompt.textWeight\` 300 to 700, \`prompt.padding\` 0.5 to 2, \`prompt.radius\` 0 to 28 px, \`prompt.corner\` (${DESIGN_PROMPT_CORNERS.join(", ")}), \`prompt.align\` (${DESIGN_PROMPT_ALIGNS.join(", ")}), \`prompt.clampLines\` 0 to 40 (lines before "Show more"; 0 shows everything).`,
  `- Line under the bubble: \`prompt.details\` (${DESIGN_PROMPT_DETAILS.join(", ")}) and \`prompt.detailItems\`, an ordered list of ${DESIGN_PROMPT_DETAIL_ITEMS.join(", ")}.`,
  `- Files: \`prompt.files\` (${DESIGN_PROMPT_FILES.join(", ")}), \`prompt.thumbnailSize\` 32 to 160 px high, \`prompt.thumbnailShape\` (${DESIGN_PROMPT_THUMBNAIL_SHAPES.join(", ")}), \`prompt.thumbnailRadius\` 0 to 24 px, \`prompt.thumbnailLabels\` (true, false), \`prompt.filesMax\` 1 to 24 tiles (with more files, the last tile is "+N" and stands for the rest).`,
].join("\n");
