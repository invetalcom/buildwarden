import { useEffect, useRef, useState } from "react";
import {
  createCustomDesignScheme,
  DESIGN_SCHEME_COLOR_KEYS,
  DESIGN_SCHEME_PRESETS,
  exportDesignScheme,
  getDefaultDesignScheme,
  getDesignSchemePreset,
  importDesignScheme,
  isDesignSchemeHexColor,
  type DesignScheme,
  type DesignSchemeColors,
  type UiTheme,
} from "@buildwarden/shared";
import { Check, Download, RotateCcw, Upload } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ColorInput } from "../ui/color-input";
import { Input } from "../ui/input";

const COLOR_LABELS: Record<keyof DesignSchemeColors, { label: string; hint: string }> = {
  background: { label: "Backdrop", hint: "Page and ambient background" },
  surface: { label: "Surface", hint: "Cards, sidebar, and panels" },
  surfaceElevated: { label: "Raised surface", hint: "Menus, dialogs, and popovers" },
  text: { label: "Text", hint: "Primary copy and icons" },
  textMuted: { label: "Muted text", hint: "Descriptions and secondary labels" },
  primary: { label: "Primary", hint: "Actions, focus, and selection" },
  secondary: { label: "Secondary", hint: "Information and supporting accents" },
  userInput: { label: "User input", hint: "User messages in chats and agent runs" },
  reasoning: { label: "Reasoning", hint: "Agent reasoning in chats and runs" },
  border: { label: "Border", hint: "Dividers and control outlines" },
  success: { label: "Success", hint: "Completed and positive states" },
  warning: { label: "Warning", hint: "Attention and caution states" },
  danger: { label: "Danger", hint: "Failures and destructive actions" },
};

type Props = {
  scheme: DesignScheme;
  busy: boolean;
  onChange: (scheme: DesignScheme) => void | Promise<void>;
};

const Swatches = ({ scheme }: { scheme: DesignScheme }) => (
  <span className="flex shrink-0 -space-x-1" aria-hidden="true">
    {[scheme.colors.background, scheme.colors.surface, scheme.colors.primary, scheme.colors.secondary].map((color, index) => (
      <span key={`${color}-${index}`} className="size-5 rounded-full border border-[var(--ec-border-strong)] shadow-sm" style={{ backgroundColor: color }} />
    ))}
  </span>
);

export const DesignSchemeEditor = ({ scheme, busy, onChange }: Props) => {
  const [colors, setColors] = useState<DesignSchemeColors>(scheme.colors);
  const [name, setName] = useState(scheme.name);
  const [mode, setMode] = useState<UiTheme>(scheme.mode);
  const [error, setError] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setColors(scheme.colors);
    setName(scheme.name);
    setMode(scheme.mode);
    setError("");
  }, [scheme]);

  const dirty = name.trim() !== scheme.name || mode !== scheme.mode || DESIGN_SCHEME_COLOR_KEYS.some((key) => colors[key].toLowerCase() !== scheme.colors[key]);
  const invalidColor = DESIGN_SCHEME_COLOR_KEYS.find((key) => !isDesignSchemeHexColor(colors[key]));
  const resetPreset = getDesignSchemePreset(scheme.id) ?? getDefaultDesignScheme(scheme.mode);

  const applyCustom = async () => {
    try {
      if (invalidColor) throw new Error(`${COLOR_LABELS[invalidColor].label} must use a six-digit hex color.`);
      if (!name.trim()) throw new Error("Give the design scheme a name.");
      await onChange(createCustomDesignScheme(scheme, colors, { name, mode }));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply the design scheme.");
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 100_000) throw new Error("Design-scheme files must be smaller than 100 KB.");
      const imported = importDesignScheme(await file.text());
      await onChange(imported);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import the design scheme.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const resetToPreset = async () => {
    try {
      await onChange(resetPreset);
      setColors(resetPreset.colors);
      setName(resetPreset.name);
      setMode(resetPreset.mode);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset the design scheme.");
    }
  };

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

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Preconfigured design schemes">
        {DESIGN_SCHEME_PRESETS.map((preset) => {
          const selected = scheme.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => void onChange(preset)}
              className={`min-w-0 rounded-md border px-3 py-2.5 text-left transition ${selected ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] shadow-[var(--ec-action-shadow)]" : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] hover:bg-[var(--ec-hover)]"}`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-[var(--ec-text)]">{selected ? <Check className="size-3.5 shrink-0 text-[var(--ec-accent)]" /> : null}{preset.name}</span>
                  <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">{preset.mode}</span>
                </span>
                <Swatches scheme={preset} />
              </span>
              <span className="mt-1.5 block text-xs leading-4 text-[var(--ec-muted)]">{preset.description}</span>
            </button>
          );
        })}
      </div>

      <Card className="p-3 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-[var(--ec-text)]">Customize semantic colors</h4>
            <p className="mt-0.5 text-xs text-[var(--ec-muted)]">Shared tokens update every page, control, status, terminal, and web shell.</p>
          </div>
          <div className="flex gap-1">
            {(["dark", "light"] as const).map((value) => (
              <button key={value} type="button" onClick={() => setMode(value)} className={`rounded-md border px-2.5 py-1 text-xs font-medium capitalize ${mode === value ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]"}`}>{value}</button>
            ))}
          </div>
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-medium text-[var(--ec-muted)]">Scheme name</span>
          <Input value={name} maxLength={80} className="h-9" onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {DESIGN_SCHEME_COLOR_KEYS.map((key) => (
            <div key={key} className="min-w-0 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-2">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-[var(--ec-text)]">{COLOR_LABELS[key].label}</span>
                <span className="truncate text-[9px] text-[var(--ec-faint)]">{COLOR_LABELS[key].hint}</span>
              </span>
              <ColorInput value={colors[key]} ariaLabel={COLOR_LABELS[key].label} className="mt-1.5" disabled={busy} onValueChange={(value) => setColors((current) => ({ ...current, [key]: value }))} />
            </div>
          ))}
        </div>
        {error ? <p role="alert" className="mt-2 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-2.5 py-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="relative flex gap-2">
            <input ref={importRef} type="file" accept=".json,.buildwarden-theme.json,application/json" className="sr-only" aria-label="Import design scheme" onChange={(event) => void importFile(event.target.files?.[0])} />
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void resetToPreset()} title={`Restore the original ${resetPreset.name} colors`}><RotateCcw className="size-3.5" />Reset defaults</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => importRef.current?.click()}><Upload className="size-3.5" />Import</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={download}><Download className="size-3.5" />Export theme</Button>
          </div>
          <Button type="button" size="sm" disabled={busy || !dirty || Boolean(invalidColor) || !name.trim()} onClick={() => void applyCustom()}>Apply custom scheme</Button>
        </div>
      </Card>
    </div>
  );
};
