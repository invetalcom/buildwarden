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
    className={cn("flex items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-0.5 text-xs", className)}
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
          "rounded px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-50",
          value === option.value
            ? "bg-[var(--ec-accent-soft)] font-medium text-[color:var(--ec-text)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring)]"
            : "text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]",
        )}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);
