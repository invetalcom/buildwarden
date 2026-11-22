import * as React from "react";
import { cn } from "../../lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-ui="input"
      className={cn(
        "app-input-surface flex h-8 w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-1 text-[13px] text-[var(--ec-text)] outline-none transition placeholder:text-[var(--ec-faint)] hover:border-[var(--ec-border-strong)] focus:border-[var(--ec-accent-ring)] focus:ring-2 focus:ring-[var(--ec-ring)]",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
