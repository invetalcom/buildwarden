import * as React from "react";
import { cn } from "../../lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "app-input-surface flex h-10 w-full rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-cyan-400",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
