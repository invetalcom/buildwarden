import { cn } from "../../lib/cn";

export type SegmentedControlProps<Value extends string | number | null> = {
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

/** Compact single-choice toggle group for switching between a few views or modes. */
export const SegmentedControl = <Value extends string | number | null>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className,
}: SegmentedControlProps<Value>) => (
  <div
    className={cn("inline-flex items-center gap-0.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-0.5 text-xs", className)}
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
          "rounded-md px-2.5 py-1 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)] disabled:cursor-not-allowed disabled:opacity-50",
          value === option.value
            ? "bg-[var(--ec-accent-soft)] text-[color:var(--ec-text)]"
            : "text-[color:var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[color:var(--ec-text)]",
        )}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);
