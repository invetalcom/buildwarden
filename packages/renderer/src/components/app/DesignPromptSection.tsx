import {
  DESIGN_PROMPT_ALIGNS,
  DESIGN_PROMPT_CORNERS,
  DESIGN_PROMPT_DEFAULTS,
  DESIGN_PROMPT_DETAIL_ITEMS,
  DESIGN_PROMPT_DETAILS,
  DESIGN_PROMPT_FILES,
  DESIGN_PROMPT_FITS,
  DESIGN_PROMPT_LIMITS,
  DESIGN_PROMPT_STYLE_OPACITY,
  DESIGN_PROMPT_STYLES,
  DESIGN_PROMPT_THUMBNAIL_SHAPES,
  resolveDesignPrompt,
  type DesignPrompt,
  type DesignPromptDetailItem,
  type StoredChatAttachment,
} from "@buildwarden/shared";
import { Copy } from "lucide-react";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { OptionalSlider } from "./optional-slider";
import { OrderedToggleList } from "./ordered-toggle-list";
import { SettingsRow, SettingsSection } from "./settings-layout";
import { PromptAction, UserPrompt } from "./user-prompt";

const labelled = <Value extends string>(values: readonly Value[], labels: Record<Value, string>) => values.map((value) => ({ value, label: labels[value] }));

const STYLE_OPTIONS = labelled(DESIGN_PROMPT_STYLES, { glass: "Glass", soft: "Soft", solid: "Solid", outline: "Outline" });
const ALIGN_OPTIONS = labelled(DESIGN_PROMPT_ALIGNS, { right: "Right", left: "Left" });
const FIT_OPTIONS = labelled(DESIGN_PROMPT_FITS, { hug: "Fits the text", fill: "Full width" });
const CORNER_OPTIONS = labelled(DESIGN_PROMPT_CORNERS, { round: "Round", tucked: "Tucked" });
const DETAILS_OPTIONS = labelled(DESIGN_PROMPT_DETAILS, { hover: "On hover", always: "Always", hidden: "Hidden" });
const FILES_OPTIONS = labelled(DESIGN_PROMPT_FILES, { above: "Over the bubble", inside: "In the bubble", names: "Names only" });
const SHAPE_OPTIONS = labelled(DESIGN_PROMPT_THUMBNAIL_SHAPES, { wide: "Wide", square: "Square" });
const WEIGHT_OPTIONS = [{ value: 400, label: "Regular" }, { value: 500, label: "Medium" }, { value: 600, label: "Semibold" }];

const DETAIL_ITEM_LABELS: Record<DesignPromptDetailItem, { label: string; hint: string }> = {
  kind: { label: "Kind", hint: "Follow-up or steered; a first prompt has none" },
  mode: { label: "Mode", hint: "Mode the prompt ran in; runs only" },
  time: { label: "Time", hint: "When you sent it" },
};
const DETAIL_ITEM_ROWS = DESIGN_PROMPT_DETAIL_ITEMS.map((item) => ({ key: item, ...DETAIL_ITEM_LABELS[item] }));

/** Text size the slider shows while the prompt follows the transcript. */
const TRANSCRIPT_TEXT_SIZE = 13;

const encode = (text: string): string => btoa(text);
const SAMPLE_PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 60"><rect width="84" height="60" fill="#8fb6de"/><circle cx="62" cy="17" r="7" fill="#f5d77a"/><path d="M0 44 22 24 40 40 56 28 84 48V60H0Z" fill="#3d7a58"/><path d="M0 52 26 38 50 50 70 42 84 50V60H0Z" fill="#2c5c43"/></svg>`;
/** Files of the sample prompt: a picture, a text file, and enough others to show the "+N" tile. */
const SAMPLE_FILES: StoredChatAttachment[] = [
  { fileName: "sketch.svg", mimeType: "image/svg+xml", dataBase64: encode(SAMPLE_PICTURE) },
  { fileName: "notes.md", mimeType: "text/markdown", dataBase64: encode("# Header\n\n- smaller title\n- breadcrumb above it\n- actions on the right\n\nKeep the old subtitle.") },
  { fileName: "icons.zip", mimeType: "application/zip", dataBase64: encode("sample") },
];
const SAMPLE_NAMES = ["report.pdf", "walkthrough.mp4", "voice-note.m4a", "data.csv", "layout.fig"];
const SAMPLE_TEXT = "Make the header match the dashboard style we use on the Reports page: smaller title, breadcrumb above it, actions on the right. Keep the old subtitle.";

/**
 * Appearance options for the prompts you sent. The sample at the top is the real component, so it
 * shows every change at once, like the rest of the window does for the other sections.
 */
export const DesignPromptSection = ({ prompt, busy, onChange, onReset }: {
  prompt: DesignPrompt | undefined;
  busy: boolean;
  onChange: (change: DesignPrompt) => void;
  onReset: () => void;
}) => {
  const resolved = resolveDesignPrompt(prompt);
  const glass = resolved.style === "glass";
  const limits = DESIGN_PROMPT_LIMITS;
  const slider = (key: "maxWidth" | "padding" | "radius" | "clampLines" | "tint" | "blur" | "edge" | "shadow" | "thumbnailSize" | "thumbnailRadius" | "filesMax", label: string, step: number, suffix?: string, disabled = false) => (
    <Slider aria-label={label} value={resolved[key]} min={limits[key][0]} max={limits[key][1]} step={step} showValue valueSuffix={suffix} disabled={busy || disabled} onValueChange={(value) => onChange({ [key]: value })} />
  );

  return (
    <>
      <SettingsSection title="Your prompts" scope="browser" actions={prompt ? (
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onReset}>Defaults</Button>
      ) : null}>
        <div className="border-b border-[var(--ec-border)] px-3.5 py-3">
          <UserPrompt text={SAMPLE_TEXT} attachments={SAMPLE_FILES} fallbackNames={SAMPLE_NAMES} kind="follow-up" time="21:54" mode="Code"
            actions={<PromptAction label="Copy prompt (sample)" onClick={() => undefined}><Copy className="h-3.5 w-3.5" /></PromptAction>} />
        </div>
        <SettingsRow title="Style" description="Glass is see-through with a blur and a light edge. Soft is a faint fill, Solid a full fill with contrasting text, Outline a thin ring.">
          <SegmentedControl label="Prompt style" value={resolved.style} disabled={busy} onChange={(style) => onChange({ style })} options={STYLE_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Fill strength" description="How strong the fill is. Each style has its own until you set one. For an exact color use Element colors, Your messages.">
          <OptionalSlider label="Prompt fill strength" value={prompt?.opacity} fallback={DESIGN_PROMPT_STYLE_OPACITY[resolved.style]} limits={limits.opacity} step={0.01}
            resetTitle="Use the style's own strength again" disabled={busy} onChange={(opacity) => onChange({ opacity })} />
        </SettingsRow>
        <SettingsRow title="Tint" description="How much of the palette's User input color the fill and the outline carry. 0 is neutral.">
          {slider("tint", "Prompt tint", 0.01)}
        </SettingsRow>
        <SettingsRow title="Glass blur" description="Blur of what lies behind the bubble. It shows with a backdrop glow or a background image. Glass only.">
          {slider("blur", "Prompt glass blur", 1, "px", !glass)}
        </SettingsRow>
        <SettingsRow title="Glass edge" description="Strength of the light edge around the bubble. Glass only.">
          {slider("edge", "Prompt glass edge", 0.05, undefined, !glass)}
        </SettingsRow>
        <SettingsRow title="Shadow" description="A soft shadow under the bubble. 0 is none.">
          {slider("shadow", "Prompt shadow", 0.05)}
        </SettingsRow>
        <SettingsRow title="Side" description="Side of the transcript your prompts sit on.">
          <SegmentedControl label="Prompt side" value={resolved.align} disabled={busy} onChange={(align) => onChange({ align })} options={ALIGN_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Width" description="Whether the bubble is as wide as its text or always takes the largest width.">
          <SegmentedControl label="Prompt width" value={resolved.fit} disabled={busy} onChange={(fit) => onChange({ fit })} options={FIT_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Largest width" description="How wide the bubble may get, in percent of the transcript.">
          {slider("maxWidth", "Prompt largest width", 1, "%")}
        </SettingsRow>
        <SettingsRow title="Text size" description="Follows the transcript until you set it.">
          <OptionalSlider label="Prompt text size" value={prompt?.textSize} fallback={TRANSCRIPT_TEXT_SIZE} limits={limits.textSize} step={0.5} suffix="px"
            resetTitle="Follow the transcript again" disabled={busy} onChange={(textSize) => onChange({ textSize })} />
        </SettingsRow>
        <SettingsRow title="Text weight" description="Weight of the prompt text.">
          <SegmentedControl label="Prompt text weight" value={resolved.textWeight} disabled={busy} onChange={(textWeight) => onChange({ textWeight })} options={WEIGHT_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Padding" description="Space between the text and the edge of the bubble. 1 is the default.">
          {slider("padding", "Prompt padding", 0.05)}
        </SettingsRow>
        <SettingsRow title="Corner radius" description="Roundness of the bubble. The overall corner radius under Shape and glass scales it.">
          {slider("radius", "Prompt corner radius", 1, "px")}
        </SettingsRow>
        <SettingsRow title="Corner" description="Tucked makes the corner next to the edge of the transcript nearly square, like a speech bubble.">
          <SegmentedControl label="Prompt corner" value={resolved.corner} disabled={busy} onChange={(corner) => onChange({ corner })} options={CORNER_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Long prompts" description="Lines that show before Show more. 0 shows every prompt in full.">
          {slider("clampLines", "Prompt lines before Show more", 1)}
        </SettingsRow>
        <SettingsRow title="Details" description="When the line under the bubble shows. It holds the items below and the copy and undo buttons.">
          <SegmentedControl label="Prompt details" value={resolved.details} disabled={busy} onChange={(details) => onChange({ details })} options={DETAILS_OPTIONS} />
        </SettingsRow>
        <div className="border-t border-[var(--ec-border)]">
          <OrderedToggleList items={DETAIL_ITEM_ROWS} active={resolved.detailItems} label="Prompt detail items" switchLabel={(label) => `Show ${label} under a prompt`}
            disabled={busy || resolved.details === "hidden"} onChange={(detailItems) => onChange({ detailItems })} />
        </div>
      </SettingsSection>

      <SettingsSection title="Prompt files" scope="browser">
        <SettingsRow title="Place" description="Thumbnails over the bubble, thumbnails inside it, or plain file names inside it.">
          <SegmentedControl label="Prompt files place" value={resolved.files} disabled={busy} onChange={(files) => onChange({ files })} options={FILES_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Thumbnail size" description="Height of a thumbnail.">
          {slider("thumbnailSize", "Prompt thumbnail size", 2, "px", resolved.files === "names")}
        </SettingsRow>
        <SettingsRow title="Thumbnail shape" description="Wide suits screenshots; square packs more files into a row.">
          <SegmentedControl label="Prompt thumbnail shape" value={resolved.thumbnailShape} disabled={busy || resolved.files === "names"} onChange={(thumbnailShape) => onChange({ thumbnailShape })} options={SHAPE_OPTIONS} />
        </SettingsRow>
        <SettingsRow title="Thumbnail radius" description="Roundness of a thumbnail. The overall corner radius scales it.">
          {slider("thumbnailRadius", "Prompt thumbnail radius", 1, "px", resolved.files === "names")}
        </SettingsRow>
        <SettingsRow title="Labels" description="File type on a thumbnail, and the length of a video or a recording.">
          <Switch aria-label="Prompt thumbnail labels" checked={resolved.thumbnailLabels} disabled={busy || resolved.files === "names"} onCheckedChange={(thumbnailLabels) => onChange({ thumbnailLabels })} />
        </SettingsRow>
        <SettingsRow title="Files in a row" description={`Files that show before the rest collapse into a +N tile. The default is ${String(DESIGN_PROMPT_DEFAULTS.filesMax)}.`}>
          {slider("filesMax", "Prompt files before +N", 1)}
        </SettingsRow>
      </SettingsSection>
    </>
  );
};
