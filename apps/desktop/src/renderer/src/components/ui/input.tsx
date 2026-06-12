import * as React from "react";
import { cn } from "../../lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "app-input-surface flex h-10 w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 py-2 text-sm text-[var(--ec-text)] outline-none transition placeholder:text-[var(--ec-faint)] focus:border-[var(--ec-accent-ring)] focus:ring-2 focus:ring-[var(--ec-ring)]",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
