import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** A grouped section: a neutral tint on the content sheet, without border or shadow. */
export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-ui="card"
    className={cn(
      "nested-glass rounded-lg border border-transparent bg-[var(--ec-panel)] text-[var(--ec-text)]",
      className,
    )}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 p-3.5", className)} {...props} />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-[13px] font-semibold text-[var(--ec-text)]", className)} {...props} />
);

export const CardDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-xs leading-5 text-[var(--ec-muted)]", className)} {...props} />
);

export const CardAction = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("ml-auto flex items-center gap-2", className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-3.5 pt-0", className)} {...props} />
);
