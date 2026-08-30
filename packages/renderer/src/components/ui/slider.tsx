import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Input } from "./input";

export type SliderProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "min" | "max" | "step"
> & {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  allowManualInput?: boolean;
  showValue?: boolean;
  valueSuffix?: string;
  valueInputAriaLabel?: string;
  rangeClassName?: string;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
};

const decimalPlaces = (value: number): number => {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return text.includes(".") ? (text.split(".")[1]?.length ?? 0) : 0;
};

const normalizeValue = (value: number, min: number, max: number, step: number): number => {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const clamped = Math.min(upper, Math.max(lower, value));
  const snapped = lower + Math.round((clamped - lower) / safeStep) * safeStep;
  return Number(Math.min(upper, Math.max(lower, snapped)).toFixed(decimalPlaces(safeStep)));
};

const RANGE_VALUE_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"]);

export const Slider = forwardRef<HTMLInputElement, SliderProps>(({
  className,
  rangeClassName,
  value,
  min = 0,
  max = 100,
  step = 1,
  allowManualInput = false,
  showValue = true,
  valueSuffix = "",
  valueInputAriaLabel,
  onValueChange,
  onValueCommit,
  disabled,
  id,
  "aria-label": ariaLabel,
  ...props
}, ref) => {
  const [manualDraft, setManualDraft] = useState(String(value));
  const skipNextManualCommitRef = useRef(false);

  useEffect(() => setManualDraft(String(value)), [value]);

  const normalized = (next: number) => normalizeValue(next, min, max, step);
  const commit = (next: number) => {
    const safeValue = normalized(next);
    onValueChange(safeValue);
    onValueCommit?.(safeValue);
    setManualDraft(String(safeValue));
  };
  const commitManualDraft = () => {
    const parsed = Number(manualDraft);
    if (!manualDraft.trim() || !Number.isFinite(parsed)) {
      setManualDraft(String(value));
      return;
    }
    commit(parsed);
  };

  return (
    <div className={cn("flex w-full items-center gap-3", className)}>
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={`${value}${valueSuffix}`}
        onChange={(event) => onValueChange(normalized(Number(event.currentTarget.value)))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (RANGE_VALUE_KEYS.has(event.key)) commit(Number(event.currentTarget.value));
        }}
        className={cn("h-2 min-w-0 flex-1 cursor-pointer accent-[var(--ec-accent)] disabled:cursor-not-allowed disabled:opacity-50", rangeClassName)}
        {...props}
      />
      {showValue ? allowManualInput ? (
        <div className="flex shrink-0 items-center gap-1">
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            value={manualDraft}
            disabled={disabled}
            aria-label={valueInputAriaLabel ?? `${ariaLabel ?? "Slider"} value`}
            onChange={(event) => setManualDraft(event.currentTarget.value)}
            onBlur={() => {
              if (skipNextManualCommitRef.current) {
                skipNextManualCommitRef.current = false;
                return;
              }
              commitManualDraft();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                skipNextManualCommitRef.current = true;
                setManualDraft(String(value));
                event.currentTarget.blur();
              }
            }}
            className="h-8 w-16 px-2 text-right text-xs font-semibold tabular-nums"
          />
          {valueSuffix ? <span className="text-xs font-semibold text-[var(--ec-muted)]">{valueSuffix}</span> : null}
        </div>
      ) : (
        <output htmlFor={id} className="min-w-11 shrink-0 text-right text-xs font-semibold tabular-nums text-[var(--ec-text)]">{value}{valueSuffix}</output>
      ) : null}
    </div>
  );
});
Slider.displayName = "Slider";
