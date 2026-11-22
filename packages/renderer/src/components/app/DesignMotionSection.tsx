import { useRef, useState, type ReactNode } from "react";
import {
  DESIGN_ASSET_MAX_BYTES,
  DESIGN_ASSET_MIME_TYPES,
  DESIGN_INDICATORS,
  DESIGN_MOTION_LIMITS,
  DESIGN_RUN_STATES,
  defaultDesignIndicatorStyle,
  designAssetAdditionProblem,
  designAssetBytes,
  designAssetNameFromFile,
  designIndicatorAssetNames,
  detectDesignAssetType,
  type DesignAsset,
  type DesignCustomization,
  type DesignIndicatorKey,
  type DesignMotion,
} from "@buildwarden/shared";
import { ImagePlus, X } from "lucide-react";
import { AgentWorkingIndicator } from "../ui/agent-working-indicator";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { LiveDot, LoadingBar, Spinner, StatusDot } from "../ui/motion";
import { SegmentedControl } from "../ui/segmented-control";
import { Select } from "../ui/select";
import { Slider } from "../ui/slider";
import { runStatusDotClassName } from "./run-display-status";
import { SettingsRow, SettingsSection } from "./settings-layout";

const ASSET_ACCEPT = [...DESIGN_ASSET_MIME_TYPES, ".svg", ".gif", ".png", ".apng", ".webp"].join(",");

const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("Could not read the image."));
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.readAsDataURL(file);
});

const formatBytes = (bytes: number): string => (bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 102.4) / 10)} KB`);

/** A live sample of an indicator, drawn with the real component, so the chosen look shows at once. */
const IndicatorSample = ({ indicator }: { indicator: DesignIndicatorKey }): ReactNode => {
  if (indicator === "runStatus") return <StatusDot state="running" className={`size-1.5 shrink-0 rounded-full ${runStatusDotClassName("running")}`} />;
  if (indicator === "liveDot") return <LiveDot active className="running-pulse size-1.5 shrink-0 rounded-full bg-[var(--ec-accent)]" />;
  if (indicator === "spinner") return <Spinner className="size-4 text-[var(--ec-accent)]" aria-hidden />;
  if (indicator === "loadingBar") return <LoadingBar className="w-20" />;
  if (indicator === "working") return <AgentWorkingIndicator className="!m-0 w-44" label="Agent is working..." />;
  if (indicator === "progress") {
    return (
      <div data-ui="progress" className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
        <div data-ui="progress-fill" className="h-full rounded-full" style={{ width: "62%", background: "var(--ec-accent)" }} />
      </div>
    );
  }
  return null;
};

const AssetSlot = ({ name, label, asset, disabled, onChoose, onRemove }: {
  name: string;
  label: string;
  asset: DesignAsset | undefined;
  disabled: boolean;
  onChoose: (file: File | undefined) => void;
  onRemove: () => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="relative inline-flex items-center gap-0.5 rounded-md bg-[var(--ec-control)] pl-1">
      {/* An image element shows an SVG without running anything in it, like a CSS image does. */}
      {asset ? <img alt="" src={`data:${asset.type};base64,${asset.data}`} className="size-5 object-contain" /> : null}
      <input ref={input} type="file" accept={ASSET_ACCEPT} className="sr-only" aria-label={`Choose image: ${name}`}
        onChange={(event) => { onChoose(event.target.files?.[0]); event.target.value = ""; }} />
      <Button type="button" size="xs" variant="ghost" disabled={disabled} title={`Image "${name}"${asset ? `, ${formatBytes(designAssetBytes(asset.data))}` : ""}`} onClick={() => input.current?.click()}>
        {asset ? label : <><ImagePlus className="size-3" />{label}</>}
      </Button>
      {asset ? (
        <Button type="button" size="xs" variant="ghost" disabled={disabled} aria-label={`Remove image: ${name}`} title="Remove this image" onClick={onRemove}><X className="size-3" /></Button>
      ) : null}
    </span>
  );
};

const stateLabel = (name: string): string => {
  const state = DESIGN_RUN_STATES.find((entry) => name.endsWith(`-${entry}`));
  return state ? state[0]!.toUpperCase() + state.slice(1) : "All states";
};

/**
 * Motion options of the appearance editor: speed, reduced motion, the look of each activity
 * indicator, and the small images a theme carries.
 */
export const DesignMotionSection = ({ customization, busy, onMotion, onIndicator, onAsset, onReset, onError }: {
  customization: DesignCustomization | undefined;
  busy: boolean;
  onMotion: (change: DesignMotion) => void;
  /** `undefined` returns the indicator to the app's own look. */
  onIndicator: (indicator: DesignIndicatorKey, style: string | undefined) => void;
  onAsset: (name: string, asset: DesignAsset | null) => void;
  onReset: () => void;
  onError: (message: string) => void;
}) => {
  const [newName, setNewName] = useState("");
  const addInput = useRef<HTMLInputElement>(null);
  const assets = customization?.assets;
  const assetEntries = Object.entries(assets ?? {});
  const changed = Boolean(customization?.motion) || Boolean(customization?.indicators);

  const chooseAsset = async (name: string, file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > DESIGN_ASSET_MAX_BYTES) throw new Error(`A theme image is limited to ${String(DESIGN_ASSET_MAX_BYTES / 1024)} KB.`);
      const data = await readFileAsBase64(file);
      const type = detectDesignAssetType(data);
      if (!type) throw new Error("Choose an SVG, GIF, PNG or WebP image.");
      const asset: DesignAsset = { type, data };
      const problem = designAssetAdditionProblem(assets, name, asset);
      if (problem) throw new Error(problem);
      onAsset(name, asset);
      onError("");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not use this image.");
    }
  };

  return (
    <SettingsSection title="Motion" scope="browser" actions={changed ? (
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onReset}>Default motion</Button>
    ) : null}>
      <SettingsRow title="Speed" description="Speed of the indicators below. 1 is the default, 2 is twice as fast.">
        <Slider aria-label="Motion speed" value={customization?.motion?.speed ?? 1} min={DESIGN_MOTION_LIMITS.speed[0]} max={DESIGN_MOTION_LIMITS.speed[1]} step={0.05} showValue disabled={busy}
          onValueChange={(speed) => onMotion({ speed: speed === 1 ? undefined : speed })} />
      </SettingsRow>
      <SettingsRow title="Reduce motion" description="When the indicators below stop moving. By default most of them keep moving even when the system asks for less motion. While they stand still, an image look shows the default look instead, because an animated image cannot be paused.">
        <SegmentedControl label="Reduce motion" value={customization?.motion?.reduce ?? "default"} disabled={busy}
          onChange={(reduce) => onMotion({ reduce: reduce === "default" ? undefined : reduce })}
          options={[{ value: "default", label: "default" }, { value: "system", label: "follow system" }, { value: "always", label: "always" }]} />
      </SettingsRow>
      {DESIGN_INDICATORS.map((definition) => {
        const fallback = defaultDesignIndicatorStyle(definition.key);
        const chosen = customization?.indicators?.[definition.key] ?? fallback;
        const usesImage = chosen === "image" || chosen === "shape";
        const names = designIndicatorAssetNames(definition.key);
        return (
          <SettingsRow key={definition.key} title={definition.label} description={`${definition.description}.`}>
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              <span className="flex min-h-5 items-center justify-center"><IndicatorSample indicator={definition.key} /></span>
              <Select ariaLabel={`${definition.label} style`} className="w-56 max-w-full" value={chosen} disabled={busy}
                options={definition.styles.map((style) => ({ value: style.key, label: style.key === fallback ? `${style.label} (default)` : style.label }))}
                onValueChange={(style) => onIndicator(definition.key, style === fallback ? undefined : style)} />
              {usesImage ? (
                <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
                  {names.map((name) => (
                    <AssetSlot key={name} name={name} label={names.length > 1 ? stateLabel(name) : "Image"} asset={assets?.[name]} disabled={busy}
                      onChoose={(file) => void chooseAsset(name, file)} onRemove={() => onAsset(name, null)} />
                  ))}
                  {!names.some((name) => assets?.[name]) ? <span className="w-full text-right text-[11px] text-[var(--ec-muted)]">Choose an image. Until then the default look stays.</span> : null}
                </div>
              ) : null}
            </div>
          </SettingsRow>
        );
      })}
      <SettingsRow align="start" title="Theme images"
        description={`Small images that travel with the theme, usually animated: SVG, GIF, PNG (APNG) or WebP, up to ${String(DESIGN_ASSET_MAX_BYTES / 1024)} KB each. Custom CSS can paint with any of them as var(--bw-asset-name).`}>
        <div className="space-y-2">
          {assetEntries.length > 0 ? (
            <ul className="space-y-1">
              {assetEntries.map(([name, asset]) => (
                <li key={name} className="flex items-center gap-2 text-xs">
                  <img alt="" src={`data:${asset.type};base64,${asset.data}`} className="size-6 shrink-0 object-contain" />
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ec-text)]" title={`var(--bw-asset-${name})`}>{name}</code>
                  <span className="shrink-0 tabular-nums text-[var(--ec-muted)]">{formatBytes(designAssetBytes(asset.data))}</span>
                  <Button type="button" size="xs" variant="ghost" disabled={busy} aria-label={`Remove image: ${name}`} title="Remove this image" onClick={() => onAsset(name, null)}><X className="size-3" /></Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="relative flex items-center justify-end gap-2">
            <Input aria-label="Name of the new image" className="h-7 w-40" placeholder="name (optional)" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
            <input ref={addInput} type="file" accept={ASSET_ACCEPT} className="sr-only" aria-label="Add theme image"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void chooseAsset(newName.trim() || designAssetNameFromFile(file.name), file).then(() => setNewName(""));
              }} />
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => addInput.current?.click()}><ImagePlus className="size-3.5" />Add image</Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
};
