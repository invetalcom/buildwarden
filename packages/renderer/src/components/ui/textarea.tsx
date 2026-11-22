import * as React from "react";
import { cn } from "../../lib/cn";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      data-ui="input"
      className={cn(
        "app-input-surface flex min-h-24 w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-2 text-[13px] text-[var(--ec-text)] outline-none transition placeholder:text-[var(--ec-faint)] hover:border-[var(--ec-border-strong)] focus:border-[var(--ec-accent-ring)] focus:ring-2 focus:ring-[var(--ec-ring)]",
        className,
      )}
      {...props}
    />
  ),
);

Textarea.displayName = "Textarea";
