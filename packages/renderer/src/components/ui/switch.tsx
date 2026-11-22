import * as React from "react";
import { cn } from "../../lib/cn";

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked = false, disabled, onCheckedChange, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      data-ui="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-control-hover)]",
        className,
      )}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
      {...props}
    >
      <span
        className={cn(
          "block size-3.5 rounded-full bg-[var(--ec-switch-thumb)] shadow-sm transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0",
        )}
      />
    </button>
  ),
);

Switch.displayName = "Switch";
