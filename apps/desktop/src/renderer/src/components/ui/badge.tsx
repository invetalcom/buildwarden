import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const variants: Record<string, string> = {
  queued: "bg-[var(--ec-warning-soft)] text-[var(--ec-warning)] ring-[var(--ec-warning-ring)]",
  preparing: "bg-[var(--ec-info-soft)] text-[var(--ec-info)] ring-[var(--ec-info-ring)]",
  running: "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ring-[var(--ec-accent-ring)]",
  completed: "bg-[var(--ec-success-soft)] text-[var(--ec-success)] ring-[var(--ec-success-ring)]",
  failed: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] ring-[var(--ec-danger-ring)]",
  cancelled: "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)] ring-[var(--ec-border)]",
  neutral: "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)] ring-[var(--ec-border)]",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof variants;
  /** Render a small tone-colored status dot before the label; running pulses. */
  dot?: boolean;
}

export const Badge = ({ className, tone = "queued", dot = false, children, ...props }: BadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
      variants[tone],
      className,
    )}
    {...props}
  >
    {dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", tone === "running" && "running-pulse")} /> : null}
    {children}
  </span>
);
