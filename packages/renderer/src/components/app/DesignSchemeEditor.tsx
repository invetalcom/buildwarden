import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCustomDesignScheme,
  DESIGN_BACKGROUND_FITS,
  DESIGN_BACKGROUND_IMAGE_MAX_BYTES,
  DESIGN_BACKGROUND_IMAGE_MIME_TYPES,
  DESIGN_BACKGROUND_LIMITS,
  DESIGN_CSS_HOOKS,
  DESIGN_DENSITIES,
  DESIGN_ELEMENTS,
  DESIGN_FONT_LIMITS,
  DESIGN_GLASS_LIMITS,
  DESIGN_GLOW_POSITIONS,
  DESIGN_LAYOUT_LIMITS,
  DESIGN_RUN_HEADER_ITEMS,
  DESIGN_RUN_HEADER_STYLES,
  DEFAULT_RUN_HEADER_ITEMS,
  DESIGN_SCHEME_COLOR_KEYS,
  DESIGN_SCHEME_PRESETS,
  DESIGN_SHAPE_LIMITS,
  DESIGN_SIDEBAR_SIDES,
  designCssProblem,
  exportDesignScheme,
  getDefaultDesignScheme,
  getDesignSchemePreset,
  importDesignScheme,
  isDesignSchemeHexColor,
  normalizeDesignCustomization,
  normalizeDesignSchemeValue,
  type DesignBackgroundImage,
  type DesignBackgroundImageMimeType,
  type DesignColorGroupKey,
  type DesignCustomization,
  type DesignElementKey,
  type DesignElementProperty,
  type DesignRunHeaderItem,
  type DesignScheme,
  type DesignSchemeColors,
  type UiTheme,
} from "@buildwarden/shared";
import { ArrowDown, ArrowUp, Check, Download, ImagePlus, RotateCcw, Trash2, Undo2, Upload } from "lucide-react";
import { cn } from "../../lib/cn";
import { applyDesignBackgroundImage, applyDesignSchemeToDocument, DESIGN_DEFAULTS } from "../../lib/design-scheme";
import { DESIGN_COLOR_GROUP_DEFAULTS, DESIGN_ELEMENT_DEFAULT_COLORS, DESIGN_ELEMENT_DEFAULT_NOTES, useResolvedCssColors } from "../../lib/design-element-defaults";
// The probes for code and chart colors resolve against the variables these two sheets declare.
import "../ui/response-content.css";
import "./usage-charts.css";
import { Button } from "../ui/button";
import { ColorInput } from "../ui/color-input";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { DesignColorField } from "./DesignColorField";
import { DesignColorSetSections } from "./DesignColorSetSections";
import { SettingsRow, SettingsSection } from "./settings-layout";

const COLOR_LABELS: Record<keyof DesignSchemeColors, { label: string; hint: string }> = {
  background: { label: "Backdrop", hint: "Window behind the content" },
  surface: { label: "Surface", hint: "Content sheet" },
  surfaceElevated: { label: "Raised surface", hint: "Menus, dialogs, composer" },
  text: { label: "Text", hint: "Primary copy and icons" },
  textMuted: { label: "Muted text", hint: "Descriptions and labels" },
  primary: { label: "Primary", hint: "Actions, focus, selection" },
  secondary: { label: "Secondary", hint: "Information accents" },
  userInput: { label: "User input", hint: "Your messages" },
  reasoning: { label: "Reasoning", hint: "Agent reasoning" },
  border: { label: "Border", hint: "Dividers and outlines" },
  success: { label: "Success", hint: "Completed states" },
  warning: { label: "Warning", hint: "Attention states" },
  danger: { label: "Danger", hint: "Failures, destructive actions" },
};

const PROPERTY_LABELS: Record<DesignElementProperty, string> = { background: "Background", text: "Text", border: "Border" };

export type DesignBackgroundImageStore = {
  get: () => Promise<DesignBackgroundImage | null>;
  set: (image: { mimeType: DesignBackgroundImageMimeType; data: string } | null) => Promise<string | null>;
};

type Props = {
  scheme: DesignScheme;
  busy: boolean;
  onChange: (scheme: DesignScheme) => void | Promise<void>;
  /** Design the user had before agents changed it. Null when no agent change is left to undo. */
  previousScheme?: DesignScheme | null;
  /** Host storage for the background image. Omitted where the host cannot keep one. */
  backgroundImageStore?: DesignBackgroundImageStore;
};

const Swatches = ({ scheme }: { scheme: DesignScheme }) => (
  <span className="flex shrink-0 -space-x-1" aria-hidden="true">
    {[scheme.colors.background, scheme.colors.surface, scheme.colors.primary, scheme.colors.secondary].map((color, index) => (
      <span key={`${color}-${index}`} className="size-4 rounded-full shadow-[0_0_0_1px_var(--ec-border-strong)]" style={{ backgroundColor: color }} />
    ))}
  </span>
);

const RUN_HEADER_ITEM_LABELS: Record<DesignRunHeaderItem, { label: string; hint: string }> = {
  status: { label: "State", hint: "Done, Running, Failed, Waiting for input" },
  title: { label: "Title", hint: "Only where the window title bar does not already show it" },
  duration: { label: "Duration", hint: "How long the run took, or has been running" },
  model: { label: "Model", hint: "Model the run uses" },
  diff: { label: "Changed files", hint: "Number of files with added and removed lines" },
  branch: { label: "Branch", hint: "Branch or folder; also in the status bar" },
  tokens: { label: "Tokens", hint: "Token use; also in the status bar" },
  plan: { label: "Plan", hint: "Plan progress; also in the status bar" },
};

/** Switches run header items on and off and sets their order. Items at the end drop off first when space runs out. */
const RunHeaderItemsField = ({ value, disabled, onChange }: {
  value: readonly DesignRunHeaderItem[] | undefined;
  disabled: boolean;
  onChange: (items: DesignRunHeaderItem[] | undefined) => void;
}) => {
  const active = value ?? DEFAULT_RUN_HEADER_ITEMS;
  const rows = [...active, ...DESIGN_RUN_HEADER_ITEMS.filter((item) => !active.includes(item))];
  const move = (item: DesignRunHeaderItem, delta: number) => {
    const next = [...active];
    const index = next.indexOf(item);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <ul className="p-1" aria-label="Run header items">
      {rows.map((item) => {
        const index = active.indexOf(item);
        const on = index >= 0;
        const { label, hint } = RUN_HEADER_ITEM_LABELS[item];
        return (
          <li key={item} className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1">
            <Switch aria-label={`Show ${label} in the run header`} checked={on} disabled={disabled} onCheckedChange={(checked) => onChange(checked ? [...active, item] : active.filter((entry) => entry !== item))} />
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className={cn("font-medium", on ? "text-[var(--ec-text)]" : "text-[var(--ec-muted)]")}>{label}</span>
              <span className="ml-2 text-[var(--ec-faint)]">{hint}</span>
            </span>
            <Button type="button" size="icon" variant="ghost" className="size-6" disabled={disabled || !on || index === 0} aria-label={`Move ${label} earlier`} title="Move earlier" onClick={() => move(item, -1)}><ArrowUp className="size-3.5" aria-hidden /></Button>
            <Button type="button" size="icon" variant="ghost" className="size-6" disabled={disabled || !on || index === active.length - 1} aria-label={`Move ${label} later`} title="Move later" onClick={() => move(item, 1)}><ArrowDown className="size-3.5" aria-hidden /></Button>
          </li>
        );
      })}
    </ul>
  );
};

/** A slider for a setting that may be unset. "Reset" clears it, so it follows its default again. */
const OptionalSlider = ({ label, value, fallback, limits, step, suffix, resetTitle, disabled, onChange }: {
  label: string;
  value: number | undefined;
  fallback: number;
  limits: readonly [number, number];
  step: number;
  suffix?: string;
  resetTitle: string;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}) => (
  <div className="flex items-center gap-1.5">
    <Slider aria-label={label} value={value ?? fallback} min={limits[0]} max={limits[1]} step={step} showValue valueSuffix={suffix} disabled={disabled} onValueChange={onChange} />
    <Button type="button" size="xs" variant="ghost" disabled={disabled || value === undefined} title={resetTitle} onClick={() => onChange(undefined)}>Reset</Button>
  </div>
);

const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("Could not read the image."));
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.readAsDataURL(file);
});

const serialize = (name: string, mode: UiTheme, colors: DesignSchemeColors, customization: DesignCustomization | undefined): string =>
  JSON.stringify({ name: name.trim(), mode, colors: DESIGN_SCHEME_COLOR_KEYS.map((key) => colors[key].toLowerCase()), customization: normalizeDesignCustomization(customization) ?? null });

/**
 * Appearance editor. The whole app is the preview: every change restyles the window at once, and
 * nothing is saved until "Apply". Leaving without applying restores the saved design.
 */
export const DesignSchemeEditor = ({ scheme, busy, onChange, previousScheme = null, backgroundImageStore }: Props) => {
  const [colors, setColors] = useState<DesignSchemeColors>(scheme.colors);
  const [name, setName] = useState(scheme.name);
  const [mode, setMode] = useState<UiTheme>(scheme.mode);
  const [customization, setCustomization] = useState<DesignCustomization | undefined>(scheme.customization);
  const [css, setCss] = useState(scheme.customization?.css ?? "");
  const [error, setError] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const savedScheme = useRef(scheme);
  // True while the window shows a background the saved design does not have: another image, or none.
  const draftImageShown = useRef(false);
  const imageStore = useRef(backgroundImageStore);
  useEffect(() => { imageStore.current = backgroundImageStore; }, [backgroundImageStore]);

  useEffect(() => {
    savedScheme.current = scheme;
    setColors(scheme.colors);
    setName(scheme.name);
    setMode(scheme.mode);
    setCustomization(scheme.customization);
    setCss(scheme.customization?.css ?? "");
    setError("");
  }, [scheme]);

  const cssProblem = css.trim() ? designCssProblem(css) : null;
  const draftCustomization = useMemo(
    () => normalizeDesignCustomization({ ...customization, css: cssProblem ? undefined : css.trim() ? css : undefined }),
    [customization, css, cssProblem],
  );
  const invalidColor = DESIGN_SCHEME_COLOR_KEYS.find((key) => !isDesignSchemeHexColor(colors[key]));
  const dirty = serialize(name, mode, colors, draftCustomization) !== serialize(scheme.name, scheme.mode, scheme.colors, scheme.customization);
  const resetPreset = getDesignSchemePreset(scheme.id) ?? getDefaultDesignScheme(scheme.mode);

  // Live preview of the draft on the real window.
  useEffect(() => {
    if (invalidColor) return;
    // An untouched draft is the saved scheme, so it keeps that scheme's id on the document.
    const preview = normalizeDesignSchemeValue({ version: 1, id: dirty ? "custom" : scheme.id, name: name.trim() || scheme.name, description: scheme.description, mode, colors, customization: draftCustomization });
    if (preview) applyDesignSchemeToDocument(preview, false);
  }, [colors, dirty, draftCustomization, invalidColor, mode, name, scheme.description, scheme.id, scheme.name]);
  // Puts the saved design's image back on the window after a draft showed something else.
  const showSavedImage = useCallback(() => {
    if (!draftImageShown.current) return;
    draftImageShown.current = false;
    // The draft is gone: the host may drop the images it kept for it.
    void imageStore.current?.set(null).catch(() => undefined);
    const token = savedScheme.current.customization?.background?.image;
    if (!token || !imageStore.current) {
      applyDesignBackgroundImage(null);
      return;
    }
    void imageStore.current.get()
      .then((image) => applyDesignBackgroundImage(image?.token === token ? image : null))
      .catch(() => applyDesignBackgroundImage(null));
  }, []);
  useEffect(() => () => {
    applyDesignSchemeToDocument(savedScheme.current, false);
    showSavedImage();
  }, [showSavedImage]);
  // Read after the preview above is on the document, and again whenever the draft changes.
  const elementDefaults = useResolvedCssColors(JSON.stringify([mode, colors, draftCustomization]));

  const patchCustomization = <Key extends "shape" | "glass" | "background" | "fonts" | "layout">(key: Key, change: NonNullable<DesignCustomization[Key]>) =>
    setCustomization((current) => ({ ...current, [key]: { ...current?.[key], ...change } }));

  const setElementColor = (key: DesignElementKey, property: DesignElementProperty, value: string | undefined) =>
    setCustomization((current) => {
      const style = { ...current?.elements?.[key] };
      if (value) style[property] = value;
      else delete style[property];
      const elements = { ...current?.elements };
      if (Object.keys(style).length > 0) elements[key] = style;
      else delete elements[key];
      return { ...current, elements };
    });

  const setGroupColor = (group: DesignColorGroupKey, color: string, value: string | undefined) =>
    setCustomization((current) => {
      const values = { ...current?.[group] };
      if (value) values[color] = value;
      else delete values[color];
      return { ...current, [group]: values };
    });

  const run = async (action: () => Promise<void> | void, fallback: string) => {
    try {
      await action();
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    }
  };

  const applyCustom = () => run(async () => {
    if (invalidColor) throw new Error(`${COLOR_LABELS[invalidColor].label} must use a six-digit hex color.`);
    if (!name.trim()) throw new Error("Give the design scheme a name.");
    if (cssProblem) throw new Error(cssProblem);
    const base: DesignScheme = { version: scheme.version, id: scheme.id, name: scheme.name, description: scheme.description, mode: scheme.mode, colors: scheme.colors };
    const next = createCustomDesignScheme(draftCustomization ? { ...base, customization: draftCustomization } : base, colors, { name, mode });
    await onChange(next);
    // The draft is the saved design now. The host can drop images no design refers to any more.
    draftImageShown.current = false;
    await backgroundImageStore?.set(null).catch(() => undefined);
  }, "Could not apply the design scheme.");

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    await run(async () => {
      if (file.size > 200_000) throw new Error("Design-scheme files must be smaller than 200 KB.");
      await onChange(importDesignScheme(await file.text()));
    }, "Could not import the design scheme.");
    if (importRef.current) importRef.current.value = "";
  };

  const chooseImage = async (file: File | undefined) => {
    if (!file || !backgroundImageStore) return;
    setImageBusy(true);
    await run(async () => {
      const mimeType = DESIGN_BACKGROUND_IMAGE_MIME_TYPES.find((entry) => entry === file.type);
      if (!mimeType) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
      if (file.size > DESIGN_BACKGROUND_IMAGE_MAX_BYTES) throw new Error("The background image must be at most 8 MB.");
      const data = await readFileAsBase64(file);
      const token = await backgroundImageStore.set({ mimeType, data });
      if (!token) throw new Error("The image could not be stored.");
      applyDesignBackgroundImage({ token, mimeType, data });
      draftImageShown.current = true;
      patchCustomization("background", { image: token });
    }, "Could not use this image.");
    setImageBusy(false);
    if (imageRef.current) imageRef.current.value = "";
  };

  const removeImage = () => {
    applyDesignBackgroundImage(null);
    draftImageShown.current = true;
    setCustomization((current) => {
      const background = { ...current?.background };
      delete background.image;
      return { ...current, background };
    });
  };

  const resetToPreset = () => run(async () => {
    await onChange(resetPreset);
    setColors(resetPreset.colors);
    setName(resetPreset.name);
    setMode(resetPreset.mode);
    setCustomization(resetPreset.customization);
    setCss(resetPreset.customization?.css ?? "");
  }, "Could not reset the design scheme.");

  const download = () => {
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    let revokeScheduled = false;
    try {
      const blob = new Blob([exportDesignScheme(scheme)], { type: "application/json" });
      url = URL.createObjectURL(blob);
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${scheme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "buildwarden-design"}.buildwarden-theme.json`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      const exportedUrl = url;
      window.setTimeout(() => URL.revokeObjectURL(exportedUrl), 0);
      revokeScheduled = true;
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export the design scheme.");
    } finally {
      anchor?.remove();
      if (url && !revokeScheduled) URL.revokeObjectURL(url);
    }
  };

  const hasImage = Boolean(customization?.background?.image);
  const customizedElementCount = Object.keys(customization?.elements ?? {}).length;

  return (
    <div className="space-y-5">
      <SettingsSection title="Theme" scope="browser" actions={<>
        <input ref={importRef} type="file" accept=".json,.buildwarden-theme.json,application/json" className="sr-only" aria-label="Import design scheme" onChange={(event) => void importFile(event.target.files?.[0])} />
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void resetToPreset()} title={`Remove every customization and go back to the stock ${resetPreset.name} theme`}><RotateCcw className="size-3.5" />Reset to stock theme</Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => importRef.current?.click()}><Upload className="size-3.5" />Import</Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={download}><Download className="size-3.5" />Export theme</Button>
      </>}>
        <div className="grid gap-1.5 p-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Preconfigured design schemes">
          {DESIGN_SCHEME_PRESETS.map((preset) => {
            const selected = scheme.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                onClick={() => void run(() => onChange(scheme.customization ? { ...preset, customization: scheme.customization } : preset), "Could not apply the preset.")}
                className={cn("min-w-0 rounded-md px-2.5 py-2 text-left transition-colors", selected ? "bg-[var(--ec-control)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring)]" : "hover:bg-[var(--ec-hover)]")}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium text-[var(--ec-text)]">
                    {selected ? <Check className="size-3.5 shrink-0 text-[var(--ec-accent)]" /> : null}{preset.name}
                    <span className="text-[10px] font-normal text-[var(--ec-faint)]">{preset.mode}</span>
                  </span>
                  <Swatches scheme={preset} />
                </span>
                <span className="mt-1 block truncate text-xs text-[var(--ec-muted)]">{preset.description}</span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Palette" scope="browser" actions={
        <SegmentedControl label="Mode" value={mode} onChange={setMode} options={[{ value: "dark", label: "dark" }, { value: "light", label: "light" }]} />
      }>
        <div className="space-y-3 p-3">
          <label className="block max-w-sm">
            <span className="mb-1 block text-[11px] font-medium text-[var(--ec-muted)]">Scheme name</span>
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
            {DESIGN_SCHEME_COLOR_KEYS.map((key) => (
              <div key={key} className="min-w-0">
                <span className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--ec-text)]">{COLOR_LABELS[key].label}</span>
                  <span className="truncate text-[10px] text-[var(--ec-faint)]">{COLOR_LABELS[key].hint}</span>
                </span>
                <ColorInput value={colors[key]} ariaLabel={COLOR_LABELS[key].label} className="h-8" disabled={busy} onValueChange={(value) => setColors((current) => ({ ...current, [key]: value }))} />
              </div>
            ))}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Shape and glass" scope="browser">
        <SettingsRow title="Corner radius" description="0 is square, 1 is the default, 2 is very round.">
          <Slider aria-label="Corner radius" value={customization?.shape?.radius ?? DESIGN_DEFAULTS.radius} min={DESIGN_SHAPE_LIMITS.radius[0]} max={DESIGN_SHAPE_LIMITS.radius[1]} step={0.05} showValue disabled={busy} onValueChange={(radius) => patchCustomization("shape", { radius })} />
        </SettingsRow>
        <SettingsRow title="Dividers and outlines" description="0 hides them, 1 is the default, 2 is strong.">
          <Slider aria-label="Dividers and outlines" value={customization?.shape?.borders ?? DESIGN_DEFAULTS.borders} min={DESIGN_SHAPE_LIMITS.borders[0]} max={DESIGN_SHAPE_LIMITS.borders[1]} step={0.05} showValue disabled={busy} onValueChange={(borders) => patchCustomization("shape", { borders })} />
        </SettingsRow>
        <SettingsRow title="Shadows" description="Shadow under menus, dialogs and other floating surfaces. 0 removes it, 1 is the default.">
          <Slider aria-label="Shadows" value={customization?.shape?.shadow ?? DESIGN_DEFAULTS.shadow} min={DESIGN_SHAPE_LIMITS.shadow[0]} max={DESIGN_SHAPE_LIMITS.shadow[1]} step={0.05} showValue disabled={busy} onValueChange={(shadow) => patchCustomization("shape", { shadow })} />
        </SettingsRow>
        {([
          ["radiusControls", "Radius of controls", "Buttons, inputs and rows."],
          ["radiusCards", "Radius of cards", "Cards, panels and tabs."],
          ["radiusSheet", "Radius of the sheet", "The content sheet and the prompt box."],
          ["radiusDialogs", "Radius of dialogs", "Dialogs and the command palette."],
        ] as const).map(([key, title, description]) => (
          <SettingsRow key={key} title={title} description={`${description} Follows the corner radius until you set it.`}>
            <OptionalSlider label={title} value={customization?.shape?.[key]} fallback={customization?.shape?.radius ?? DESIGN_DEFAULTS.radius} limits={DESIGN_SHAPE_LIMITS.radius} step={0.05}
              resetTitle="Follow the corner radius again" disabled={busy} onChange={(value) => patchCustomization("shape", { [key]: value })} />
          </SettingsRow>
        ))}
        <SettingsRow title="Content opacity" description="Opacity of the sheet behind every page. 0 is transparent: pages sit directly on the window backdrop. Around 0.9 gives a distinct sheet.">
          <Slider aria-label="Content opacity" value={customization?.glass?.opacity ?? (hasImage ? DESIGN_DEFAULTS.opacityWithImage : DESIGN_DEFAULTS.opacity)} min={DESIGN_GLASS_LIMITS.opacity[0]} max={DESIGN_GLASS_LIMITS.opacity[1]} step={0.01} showValue disabled={busy} onValueChange={(opacity) => patchCustomization("glass", { opacity })} />
        </SettingsRow>
        <SettingsRow title="Glass blur" description="Blur behind menus, dialogs, and the content when a background image is set.">
          <Slider aria-label="Glass blur" value={customization?.glass?.blur ?? DESIGN_DEFAULTS.blur} min={DESIGN_GLASS_LIMITS.blur[0]} max={DESIGN_GLASS_LIMITS.blur[1]} step={1} showValue valueSuffix="px" disabled={busy} onValueChange={(blur) => patchCustomization("glass", { blur })} />
        </SettingsRow>
        <SettingsRow title="Backdrop glow" description="Strength of the primary and secondary color glow in the window backdrop.">
          <Slider aria-label="Backdrop glow" value={customization?.glass?.glow ?? DESIGN_DEFAULTS.glow} min={DESIGN_GLASS_LIMITS.glow[0]} max={DESIGN_GLASS_LIMITS.glow[1]} step={0.05} showValue disabled={busy} onValueChange={(glow) => patchCustomization("glass", { glow })} />
        </SettingsRow>
        <SettingsRow title="Glow position" description="Edge of the window the two glows start from.">
          <SegmentedControl label="Glow position" value={customization?.glass?.glowPosition ?? "bottom"} disabled={busy} onChange={(glowPosition) => patchCustomization("glass", { glowPosition })}
            options={DESIGN_GLOW_POSITIONS.map((position) => ({ value: position, label: position }))} />
        </SettingsRow>
        <SettingsRow title="Glow size" description="1 is the default; larger values reach further into the window.">
          <Slider aria-label="Glow size" value={customization?.glass?.glowSize ?? DESIGN_DEFAULTS.glowSize} min={DESIGN_GLASS_LIMITS.glowSize[0]} max={DESIGN_GLASS_LIMITS.glowSize[1]} step={0.05} showValue disabled={busy} onValueChange={(glowSize) => patchCustomization("glass", { glowSize })} />
        </SettingsRow>
        <SettingsRow title="Glow colors" description="Six-digit colors of the two glows. Empty uses the palette's primary and secondary color.">
          <div className="grid grid-cols-2 gap-2">
            <DesignColorField opaque label="First glow color" value={customization?.glass?.glowPrimary} fallback={elementDefaults.resolved["glow:primary"]} fallbackNote="primary" disabled={busy} onChange={(glowPrimary) => patchCustomization("glass", { glowPrimary })} />
            <DesignColorField opaque label="Second glow color" value={customization?.glass?.glowSecondary} fallback={elementDefaults.resolved["glow:secondary"]} fallbackNote="secondary" disabled={busy} onChange={(glowSecondary) => patchCustomization("glass", { glowSecondary })} />
          </div>
        </SettingsRow>
      </SettingsSection>

      {backgroundImageStore ? (
        <SettingsSection title="Background image" scope="browser">
          <SettingsRow title="Image" description="PNG, JPEG, WebP or GIF up to 8 MB. Shown behind the whole window.">
            <div className="relative flex flex-wrap items-center gap-2">
              <input ref={imageRef} type="file" accept={DESIGN_BACKGROUND_IMAGE_MIME_TYPES.join(",")} className="sr-only" aria-label="Choose background image" onChange={(event) => void chooseImage(event.target.files?.[0])} />
              <Button type="button" size="sm" variant="secondary" disabled={busy || imageBusy} onClick={() => imageRef.current?.click()}><ImagePlus className="size-3.5" />{hasImage ? "Replace image" : "Choose image"}</Button>
              {hasImage ? <Button type="button" size="sm" variant="ghost" disabled={busy || imageBusy} onClick={removeImage}><Trash2 className="size-3.5" />Remove</Button> : null}
              <span className="text-xs text-[var(--ec-muted)]">{hasImage ? "Image set" : "No image"}</span>
            </div>
          </SettingsRow>
          {hasImage ? <>
            <SettingsRow title="Dim" description="Tints the image with the backdrop color so text stays readable.">
              <Slider aria-label="Background dim" value={customization?.background?.dim ?? DESIGN_DEFAULTS.backgroundDim} min={DESIGN_BACKGROUND_LIMITS.dim[0]} max={DESIGN_BACKGROUND_LIMITS.dim[1]} step={0.01} showValue disabled={busy} onValueChange={(dim) => patchCustomization("background", { dim })} />
            </SettingsRow>
            <SettingsRow title="Image blur" description="Softens a busy image.">
              <Slider aria-label="Background image blur" value={customization?.background?.blur ?? DESIGN_DEFAULTS.backgroundBlur} min={DESIGN_BACKGROUND_LIMITS.blur[0]} max={DESIGN_BACKGROUND_LIMITS.blur[1]} step={1} showValue valueSuffix="px" disabled={busy} onValueChange={(blur) => patchCustomization("background", { blur })} />
            </SettingsRow>
            <SettingsRow title="Fit" description="Cover fills the window, contain shows the whole image, tile repeats it.">
              <SegmentedControl label="Background fit" value={customization?.background?.fit ?? "cover"} disabled={busy} onChange={(fit) => patchCustomization("background", { fit })}
                options={DESIGN_BACKGROUND_FITS.map((fit) => ({ value: fit, label: fit }))} />
            </SettingsRow>
          </> : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Element colors" scope="browser" actions={customizedElementCount > 0 ? (
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setCustomization((current) => ({ ...current, elements: {} }))}>Clear all ({customizedElementCount})</Button>
      ) : null}>
        <div className="p-2">
          <p className="px-1 pb-2 text-xs text-[var(--ec-muted)]">Override single element types. A dimmed value is the color the theme applies now; type over it to override. Eight-digit values such as #1c2330cc add transparency.</p>
          {/* Hidden probes: the browser resolves each default against the previewed theme. */}
          <div ref={elementDefaults.hostRef} aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden opacity-0">
            {DESIGN_ELEMENTS.flatMap((definition) => Object.entries(DESIGN_ELEMENT_DEFAULT_COLORS[definition.key]).map(([property, expression]) => (
              <span key={`${definition.key}.${property}`} data-probe={`${definition.key}.${property}`} style={{ color: expression }} />
            )))}
            <span data-probe="glow:primary" style={{ color: "var(--ec-accent)" }} />
            <span data-probe="glow:secondary" style={{ color: "var(--ec-secondary)" }} />
            {Object.entries(DESIGN_COLOR_GROUP_DEFAULTS).map(([group, defaults]) => (
              <span key={group} className={defaults.scope}>
                {Object.entries(defaults.colors).map(([color, expression]) => <span key={color} data-probe={`${group}:${color}`} style={{ color: expression }} />)}
              </span>
            ))}
          </div>
          {/* The four columns need about 28rem. In a narrower card the grid scrolls sideways, so the Border fields stay reachable. */}
          <div className="app-scrollbar grid grid-cols-[minmax(8rem,1.4fr)_repeat(3,minmax(6.5rem,1fr))] items-center gap-x-2 gap-y-1 overflow-x-auto pb-1">
            <span />
            {(["background", "text", "border"] as const).map((property) => <span key={property} className="px-1 text-[10px] text-[var(--ec-faint)]">{PROPERTY_LABELS[property]}</span>)}
            {DESIGN_ELEMENTS.map((definition) => (
              <div key={definition.key} className="contents">
                <span className="min-w-0 px-1" title={definition.description}>
                  <span className="block truncate text-xs font-medium text-[var(--ec-text)]">{definition.label}</span>
                </span>
                {(["background", "text", "border"] as const).map((property) => (definition.properties as readonly DesignElementProperty[]).includes(property) ? (
                  <DesignColorField
                    key={property}
                    label={`${definition.label} ${PROPERTY_LABELS[property].toLowerCase()}`}
                    value={customization?.elements?.[definition.key]?.[property]}
                    fallback={elementDefaults.resolved[`${definition.key}.${property}`]}
                    fallbackNote={DESIGN_ELEMENT_DEFAULT_NOTES[definition.key] ?? (property === "border" ? "none" : "default")}
                    disabled={busy}
                    onChange={(value) => setElementColor(definition.key, property, value)}
                  />
                ) : <span key={property} />)}
              </div>
            ))}
          </div>
        </div>
      </SettingsSection>

      <DesignColorSetSections
        customization={customization}
        resolved={elementDefaults.resolved}
        busy={busy}
        onChange={setGroupColor}
        onClear={(group) => setCustomization((current) => ({ ...current, [group]: {} }))}
      />

      <SettingsSection title="Layout" scope="browser">
        <SettingsRow title="Interface size" description="Size of everything in the window. Applied when you save; desktop app only.">
          <Slider aria-label="Interface size" value={customization?.layout?.scale ?? DESIGN_DEFAULTS.scale} min={DESIGN_LAYOUT_LIMITS.scale[0]} max={DESIGN_LAYOUT_LIMITS.scale[1]} step={0.05} showValue disabled={busy} onValueChange={(scale) => patchCustomization("layout", { scale })} />
        </SettingsRow>
        <SettingsRow title="Density" description="Height of sidebar rows, tabs, inputs, settings rows and the status bar. Compact is the default.">
          <SegmentedControl label="Density" value={customization?.layout?.density ?? "compact"} disabled={busy} onChange={(density) => patchCustomization("layout", { density })}
            options={DESIGN_DENSITIES.map((density) => ({ value: density, label: density }))} />
        </SettingsRow>
        <SettingsRow title="Sidebar side" description="Side of the window the sidebar sits on.">
          <SegmentedControl label="Sidebar side" value={customization?.layout?.sidebar ?? "left"} disabled={busy} onChange={(sidebar) => patchCustomization("layout", { sidebar })}
            options={DESIGN_SIDEBAR_SIDES.map((side) => ({ value: side, label: side }))} />
        </SettingsRow>
        <SettingsRow title="Sidebar to the bottom" description="On: the sidebar runs to the bottom edge of the window and the status bar starts next to it. Off: the status bar spans the whole window, under the sidebar. Applied when you save.">
          <Switch aria-label="Sidebar to the bottom" checked={customization?.layout?.sidebarFullHeight !== false} disabled={busy} onCheckedChange={(sidebarFullHeight) => patchCustomization("layout", { sidebarFullHeight })} />
        </SettingsRow>
        <SettingsRow title="Status bar" description="When off, branch, tokens and the inbox move back into the run page and the sidebar. Applied when you save.">
          <Switch aria-label="Status bar" checked={customization?.layout?.statusBar !== false} disabled={busy} onCheckedChange={(statusBar) => patchCustomization("layout", { statusBar })} />
        </SettingsRow>
        <SettingsRow title="Bottom bar height" description="Height of the status bar. The sidebar's bottom row of icons takes the same height while it sits beside the bar, so both stay in line.">
          <Slider aria-label="Bottom bar height" value={customization?.layout?.statusBarHeight ?? DESIGN_DEFAULTS.statusBarHeight} min={DESIGN_LAYOUT_LIMITS.statusBarHeight[0]} max={DESIGN_LAYOUT_LIMITS.statusBarHeight[1]} step={1} showValue valueSuffix="px" disabled={busy} onValueChange={(statusBarHeight) => patchCustomization("layout", { statusBarHeight })} />
        </SettingsRow>
        <SettingsRow title="Prompt box width" description="Width of the prompt box on run pages, in percent of the page.">
          <Slider aria-label="Prompt box width" value={customization?.layout?.composerWidth ?? DESIGN_DEFAULTS.composerWidth} min={DESIGN_LAYOUT_LIMITS.composerWidth[0]} max={DESIGN_LAYOUT_LIMITS.composerWidth[1]} step={1} showValue valueSuffix="%" disabled={busy} onValueChange={(composerWidth) => patchCustomization("layout", { composerWidth })} />
        </SettingsRow>
        <SettingsRow title="Prompt box height" description="Height of the text area you type prompts into, on run pages, the project page and in chats. Until you set it, run pages use 56px and the project page 80px.">
          <OptionalSlider label="Prompt box height" value={customization?.layout?.composerHeight} fallback={DESIGN_DEFAULTS.composerHeight} limits={DESIGN_LAYOUT_LIMITS.composerHeight} step={4} suffix="px"
            resetTitle="Use each page's own height again" disabled={busy} onChange={(composerHeight) => patchCustomization("layout", { composerHeight })} />
        </SettingsRow>
        <SettingsRow title="Result buttons distance" description="Distance between the buttons above the prompt box of a run (changed files, Validate, pull request) and the box. Negative values move them into the box.">
          <OptionalSlider label="Result buttons distance" value={customization?.layout?.runDockGap} fallback={DESIGN_DEFAULTS.runDockGap} limits={DESIGN_LAYOUT_LIMITS.runDockGap} step={1} suffix="px"
            resetTitle="Use the default distance again" disabled={busy} onChange={(runDockGap) => patchCustomization("layout", { runDockGap })} />
        </SettingsRow>
        <SettingsRow title="Transcript width" description="Width of the run and chat transcript, in percent of the page.">
          <Slider aria-label="Transcript width" value={customization?.layout?.transcriptWidth ?? DESIGN_DEFAULTS.transcriptWidth} min={DESIGN_LAYOUT_LIMITS.transcriptWidth[0]} max={DESIGN_LAYOUT_LIMITS.transcriptWidth[1]} step={1} showValue valueSuffix="%" disabled={busy} onValueChange={(transcriptWidth) => patchCustomization("layout", { transcriptWidth })} />
        </SettingsRow>
        <SettingsRow title="Scrollbar" description="Thickness of scrollbars.">
          <Slider aria-label="Scrollbar" value={customization?.layout?.scrollbar ?? DESIGN_DEFAULTS.scrollbar} min={DESIGN_LAYOUT_LIMITS.scrollbar[0]} max={DESIGN_LAYOUT_LIMITS.scrollbar[1]} step={1} showValue valueSuffix="px" disabled={busy} onValueChange={(scrollbar) => patchCustomization("layout", { scrollbar })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Run header" scope="browser" actions={customization?.layout?.runHeaderItems ? (
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => patchCustomization("layout", { runHeaderItems: undefined })}>Default items</Button>
      ) : null}>
        <SettingsRow title="Style" description="Chips shows the state as a colored chip followed by facts. Line shows one quiet sentence with icon-only buttons. Applied when you save.">
          <SegmentedControl label="Run header style" value={customization?.layout?.runHeader ?? "chips"} disabled={busy} onChange={(runHeader) => patchCustomization("layout", { runHeader })}
            options={DESIGN_RUN_HEADER_STYLES.map((style) => ({ value: style, label: style === "chips" ? "Chips" : "Line" }))} />
        </SettingsRow>
        <div className="border-t border-[var(--ec-border)]">
          <p className="px-3.5 pt-2.5 text-xs text-[var(--ec-muted)]">What the bar shows, in this order. When the window is narrow, items at the end drop off first. Applied when you save.</p>
          <RunHeaderItemsField value={customization?.layout?.runHeaderItems} disabled={busy} onChange={(runHeaderItems) => patchCustomization("layout", { runHeaderItems })} />
        </div>
      </SettingsSection>

      <SettingsSection title="Fonts" scope="browser">
        <SettingsRow title="Interface font" description="A font-family list of fonts installed on this machine. Empty uses the default.">
          <Input aria-label="Interface font" placeholder='Inter, "Segoe UI", sans-serif' value={customization?.fonts?.ui ?? ""} maxLength={200} disabled={busy}
            onChange={(event) => patchCustomization("fonts", { ui: event.target.value })} />
        </SettingsRow>
        <SettingsRow title="Code font" description="Used for code, paths, and other fixed-width text.">
          <Input aria-label="Code font" placeholder='"JetBrains Mono", Consolas, monospace' value={customization?.fonts?.mono ?? ""} maxLength={200} disabled={busy}
            onChange={(event) => patchCustomization("fonts", { mono: event.target.value })} />
        </SettingsRow>
        <SettingsRow title="Terminal text size" description="Text size of the embedded terminal.">
          <Slider aria-label="Terminal text size" value={customization?.fonts?.terminalSize ?? DESIGN_DEFAULTS.terminalSize} min={DESIGN_FONT_LIMITS.terminalSize[0]} max={DESIGN_FONT_LIMITS.terminalSize[1]} step={1} showValue valueSuffix="px" disabled={busy} onValueChange={(terminalSize) => patchCustomization("fonts", { terminalSize })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Custom CSS" scope="browser">
        <div className="space-y-2 p-3">
          <p className="text-xs text-[var(--ec-muted)]">Applied after the app's styles. It cannot load files: no @import and no url() other than data:image. Add !important when a rule has no effect.</p>
          <Textarea aria-label="Custom CSS" aria-invalid={Boolean(cssProblem)} spellCheck={false} value={css} disabled={busy} placeholder={'[data-ui="sidebar-item"][data-active="true"] {\n  box-shadow: inset 2px 0 0 var(--ec-accent);\n}'}
            className="min-h-32 font-mono text-xs" onChange={(event) => setCss(event.target.value)} />
          {cssProblem ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{cssProblem}</p> : null}
          <details className="text-xs text-[var(--ec-muted)]">
            <summary className="cursor-pointer select-none text-[var(--ec-text)]">Stable selectors</summary>
            <ul className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {DESIGN_CSS_HOOKS.map((hook) => (
                <li key={hook.selector} className="min-w-0 truncate" title={`${hook.selector}: ${hook.styles}`}>
                  <code className="font-mono text-[11px] text-[var(--ec-text)]">{hook.selector}</code> <span>{hook.styles}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </SettingsSection>

      <SettingsSection title="Let an agent restyle BuildWarden" scope="browser">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <p className="min-w-0 flex-1 text-xs leading-5 text-[var(--ec-muted)]">
            Ask in any agent run, for example <span className="text-[var(--ec-text)]">"make BuildWarden warmer with rounder corners"</span> or <span className="text-[var(--ec-text)]">"use this image as the background"</span>.
            The agent changes the same settings you see here. "Undo agent changes" brings back the design you had before the agent changed anything, however many changes it made.
          </p>
          <Button type="button" size="sm" variant="secondary" disabled={busy || !previousScheme} title={previousScheme ? `Restore "${previousScheme.name}", your design from before the agent's changes` : "No agent has changed the design since you last saved it"}
            onClick={() => previousScheme && void run(() => onChange(previousScheme), "Could not restore the previous design.")}>
            <Undo2 className="size-3.5" />Undo agent changes
          </Button>
        </div>
      </SettingsSection>

      {error ? <p role="alert" className="rounded-md bg-[var(--ec-danger-soft)] px-2.5 py-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 rounded-lg bg-[var(--ec-bg-elevated)] px-3 py-2 shadow-[var(--ec-popover-shadow)] backdrop-blur-md">
        <span className="mr-auto text-xs text-[var(--ec-muted)]">{dirty ? "Previewing unsaved changes" : "The window shows the saved design"}</span>
        <Button type="button" size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => {
          setColors(scheme.colors); setName(scheme.name); setMode(scheme.mode); setCustomization(scheme.customization); setCss(scheme.customization?.css ?? ""); setError("");
          showSavedImage();
        }}>Discard</Button>
        <Button type="button" size="sm" disabled={busy || !dirty || Boolean(invalidColor) || Boolean(cssProblem) || !name.trim()} onClick={() => void applyCustom()}>Apply custom scheme</Button>
      </div>
    </div>
  );
};
