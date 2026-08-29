import { Pipette } from "lucide-react";
import { cn } from "../../lib/cn";

export type ColorInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
};

/** Shared native color picker + editable hex field used by every design-scheme editor. */
export const ColorInput = ({ value, onValueChange, ariaLabel, disabled, className }: ColorInputProps) => {
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <div
      className={cn(
        "flex h-9 min-w-0 items-center overflow-hidden rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] transition focus-within:border-[var(--ec-accent-ring)] focus-within:ring-2 focus-within:ring-[var(--ec-ring)]",
        className,
      )}
    >
      <label className="relative flex h-full w-10 shrink-0 cursor-pointer items-center justify-center border-r border-[var(--ec-border)]" title={`${ariaLabel} picker`}>
        <span className="absolute inset-1 rounded-sm border border-[var(--ec-border-strong)]" style={{ backgroundColor: pickerValue }} />
        <Pipette className="pointer-events-none relative size-3 text-white drop-shadow" />
        <input
          type="color"
          value={pickerValue}
          disabled={disabled}
          aria-label={`${ariaLabel} picker`}
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(event) => onValueChange(event.target.value)}
        />
      </label>
      <input
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        spellCheck={false}
        maxLength={7}
        className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs uppercase text-[var(--ec-text)] outline-none placeholder:text-[var(--ec-faint)]"
        onChange={(event) => onValueChange(event.target.value)}
      />
    </div>
  );
};
