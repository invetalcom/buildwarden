import { cn } from "../../lib/cn";

export type SegmentedControlProps<Value extends string | number | null> = {
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  variant?: "segmented" | "outlined";
};

/** Compact single-choice toggle group for switching between a few views or modes. */
export const SegmentedControl = <Value extends string | number | null>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className,
  variant = "segmented",
}: SegmentedControlProps<Value>) => (
  <div
    data-ui="segmented"
    className={cn("inline-flex items-center text-xs", variant === "outlined" ? "gap-1" : "gap-0.5 rounded-md bg-[var(--ec-control)] p-0.5", className)}
    role="group"
    aria-label={label}
  >
    {options.map((option) => (
      <button
        key={String(option.value)}
        type="button"
        aria-pressed={value === option.value}
        disabled={disabled}
        className={cn(
          "rounded-sm px-2 py-1 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)] disabled:cursor-not-allowed disabled:opacity-50",
          variant === "outlined" ? [
            value === option.value
              ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
              : "bg-[var(--ec-control)] text-[var(--ec-muted)] hover:bg-[var(--ec-control-hover)] hover:text-[var(--ec-text)]",
          ] : value === option.value
            ? "bg-[var(--ec-bg-elevated)] text-[color:var(--ec-text)] shadow-[0_0_0_1px_var(--ec-border)]"
            : "text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]",
        )}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);
