import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Empty = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex min-h-48 flex-col items-center justify-center gap-3 p-8 text-center", className)} {...props} />
);

export const EmptyHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col items-center gap-1", className)} {...props} />
);

export const EmptyTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-sm font-semibold text-[var(--ec-text)]", className)} {...props} />
);

export const EmptyDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("max-w-md text-sm leading-6 text-[var(--ec-muted)]", className)} {...props} />
);
