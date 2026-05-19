import * as React from "react";
import { cn } from "../../lib/cn";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "app-input-surface flex min-h-28 w-full rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-cyan-400",
        className,
      )}
      {...props}
    />
  ),
);

Textarea.displayName = "Textarea";
