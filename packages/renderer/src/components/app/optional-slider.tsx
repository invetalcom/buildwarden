import { Button } from "../ui/button";
import { Slider } from "../ui/slider";

/** A slider for a setting that may be unset. "Reset" clears it, so it follows its default again. */
export const OptionalSlider = ({ label, value, fallback, limits, step, suffix, resetTitle, disabled, onChange }: {
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
