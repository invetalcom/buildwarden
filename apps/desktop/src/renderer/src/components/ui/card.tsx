import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "nested-glass rounded-2xl border border-white/[0.06] bg-zinc-950/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-md",
      className,
    )}
    {...props}
  />
);
