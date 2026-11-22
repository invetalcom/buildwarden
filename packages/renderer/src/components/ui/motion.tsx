import type { ComponentProps, HTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import "./motion.css";

/**
 * The app's activity indicators. A theme can pick another look for each (`indicators` in a design
 * scheme) or restyle it in custom CSS through its `data-ui` hook, so every place that shows
 * activity uses one of these instead of animating an element of its own.
 */

/** The six run states a theme can tell apart. */
export type IndicatorRunState = "running" | "preparing" | "waiting" | "completed" | "failed" | "cancelled";

/**
 * Loading spinner. Pass another `icon` for a glyph that only spins while something is busy, and
 * `spinning={false}` while it is idle: the icon then shows as itself and is no spinner to a theme.
 */
export const Spinner = ({ className, icon: Icon = Loader2, spinning = true, ...props }: ComponentProps<LucideIcon> & { icon?: LucideIcon; spinning?: boolean }) => (
  <Icon data-ui={spinning ? "spinner" : undefined} className={cn(spinning && "animate-spin", className)} {...props} />
);

/** State dot of a run. The caller's classes give it its size and color. */
export const StatusDot = ({ state, className, ...props }: HTMLAttributes<HTMLSpanElement> & { state: IndicatorRunState }) => (
  <span aria-hidden data-ui="status-dot" data-state={state} className={className} {...props} />
);

/** Small dot next to something that can be active. The caller's classes give it its size, color and pulse. */
export const LiveDot = ({ active, className, ...props }: HTMLAttributes<HTMLSpanElement> & { active: boolean }) => (
  <span aria-hidden data-ui="live-dot" data-active={active} className={className} {...props} />
);

/** Thin moving bar that says something is loading. */
export const LoadingBar = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div aria-hidden data-ui="loading-bar" className={cn("run-activity-loading-bar", className)} {...props} />
);
