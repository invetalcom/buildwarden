import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const variants: Record<string, string> = {
  queued: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  preparing: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  running: "bg-cyan-500/10 text-cyan-300 ring-cyan-400/30",
  completed: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  failed: "bg-rose-500/10 text-rose-300 ring-rose-400/30",
  cancelled: "bg-zinc-500/10 text-zinc-300 ring-zinc-400/30",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof variants;
}

export const Badge = ({ className, tone = "queued", ...props }: BadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
      variants[tone],
      className,
    )}
    {...props}
  />
);
