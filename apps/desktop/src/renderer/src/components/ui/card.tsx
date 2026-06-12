import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "nested-glass rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-text)] shadow-[var(--ec-panel-shadow)]",
      className,
    )}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-sm font-semibold tracking-tight text-[var(--ec-text)]", className)} {...props} />
);

export const CardDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-xs leading-5 text-[var(--ec-muted)]", className)} {...props} />
);

export const CardAction = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("ml-auto flex items-center gap-2", className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-4 pt-0", className)} {...props} />
);

export const CardFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2 p-4 pt-0", className)} {...props} />
);
