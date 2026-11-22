import { useEffect, useState } from "react";
import { isDesignElementColor } from "@buildwarden/shared";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ResolvedCssColor } from "../../lib/design-element-defaults";

/**
 * Optional color of one element property. Empty means "follow the theme": the field then shows
 * the color the theme applies (`fallback`), dimmed, so an empty field never looks like black.
 */
export const DesignColorField = ({ value, label, disabled, onChange, fallback, fallbackNote }: {
  value: string | undefined;
  label: string;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
  /** Color in effect while the field is empty. */
  fallback?: ResolvedCssColor;
  /** Shown while the field is empty and no single color applies, such as "none". */
  fallbackNote: string;
}) => {
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);
  const valid = text === "" || isDesignElementColor(text);
  const showsFallbackColor = Boolean(fallback && !fallback.transparent);
  const placeholder = fallback ? (fallback.transparent ? "transparent" : fallback.hex) : fallbackNote;
  const swatch = value ?? (showsFallbackColor ? fallback?.css : undefined);
  return (
    <div className={cn("flex h-7 min-w-0 items-center gap-1.5 rounded-md border bg-[var(--ec-input)] pl-1.5 pr-0.5 focus-within:border-[var(--ec-accent-ring)]", valid ? "border-[var(--ec-border)]" : "border-[var(--ec-danger-ring)]")}>
      {/* The swatch sits on the sheet color, so a translucent tint looks the way it does on a page. */}
      <label className="relative size-3.5 shrink-0 cursor-pointer overflow-hidden rounded-[4px] shadow-[0_0_0_1px_var(--ec-border-strong)]" style={{ background: swatch ? `linear-gradient(${swatch}, ${swatch}), var(--ec-bg)` : "transparent" }} title={`${label} picker`}>
        <input type="color" aria-label={`${label} picker`} disabled={disabled} value={(value ?? fallback?.hex ?? "#000000").slice(0, 7)} className="absolute inset-0 cursor-pointer opacity-0" onChange={(event) => onChange(event.target.value)} />
      </label>
      <input
        aria-label={label}
        aria-invalid={!valid}
        value={text}
        placeholder={placeholder}
        title={value ? undefined : fallback && !fallback.transparent ? `${fallback.hex} comes from the theme. Type a color to override it.` : `This element has no ${fallbackNote === "none" ? "border" : "color of its own"} in the theme. Type a color to set one.`}
        maxLength={9}
        spellCheck={false}
        disabled={disabled}
        className={cn("h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[var(--ec-text)] outline-none placeholder:text-[var(--ec-faint)]", !showsFallbackColor && "placeholder:font-sans")}
        onChange={(event) => {
          const next = event.target.value.trim();
          setText(next);
          if (next === "") onChange(undefined);
          else if (isDesignElementColor(next)) onChange(next.toLowerCase());
        }}
      />
      {value ? (
        <button type="button" aria-label={`Clear ${label}`} title="Use the palette color" disabled={disabled} onClick={() => onChange(undefined)}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--ec-faint)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]">
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
};
