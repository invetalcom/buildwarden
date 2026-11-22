import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { LiveDot } from "./motion";

const variants: Record<string, string> = {
  // Run states read their own theme variable and fall back to the palette color they always had.
  queued: "bg-[var(--bw-state-waiting-soft,var(--ec-warning-soft))] text-[var(--bw-state-waiting,var(--ec-warning))]",
  preparing: "bg-[var(--bw-state-preparing-soft,var(--ec-info-soft))] text-[var(--bw-state-preparing,var(--ec-info))]",
  running: "bg-[var(--bw-state-running-soft,var(--ec-accent-soft))] text-[var(--bw-state-running,var(--ec-accent))]",
  completed: "bg-[var(--bw-state-completed-soft,var(--ec-success-soft))] text-[var(--bw-state-completed,var(--ec-success))]",
  failed: "bg-[var(--bw-state-failed-soft,var(--ec-danger-soft))] text-[var(--bw-state-failed,var(--ec-danger))]",
  cancelled: "bg-[var(--bw-state-cancelled-soft,var(--ec-muted-soft))] text-[var(--bw-state-cancelled,var(--ec-muted))]",
  neutral: "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof variants;
  /** Render a small tone-colored status dot before the label; running pulses. */
  dot?: boolean;
}

export const Badge = ({ className, tone = "queued", dot = false, children, ...props }: BadgeProps) => (
  <span
    data-ui="badge"
    data-tone={tone}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-0 ring-inset ring-transparent",
      variants[tone],
      className,
    )}
    {...props}
  >
    {dot ? <LiveDot active={tone === "running"} className={cn("size-1.5 shrink-0 rounded-full bg-current", tone === "running" && "running-pulse")} /> : null}
    {children}
  </span>
);
