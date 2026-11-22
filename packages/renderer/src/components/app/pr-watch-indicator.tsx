import { AlertTriangle, Eye } from "lucide-react";
import type { PrWatchView } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { prWatchIndicator } from "./pr-watch-ui";

const TONE_STYLES = {
  watching: "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]",
  working: "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]",
  paused: "bg-[var(--ec-warning)] text-[var(--ec-warning-foreground)]",
} as const;

/**
 * A small mark on a run's request icon while a watch is active. It stays still while watching,
 * pulses only while the agent works on what the watch found, and turns amber when it needs the user.
 */
export const PrWatchIndicator = ({ watch, className }: Readonly<{ watch: PrWatchView | null | undefined; className?: string }>) => {
  const indicator = prWatchIndicator(watch);
  if (!indicator) return null;
  const Icon = indicator.tone === "paused" ? AlertTriangle : Eye;
  return (
    <span
      data-pr-watch={indicator.tone}
      className={cn("pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-[11px] items-center justify-center rounded-full ring-2 ring-[var(--ec-bg)]", TONE_STYLES[indicator.tone], className)}
      aria-hidden
    >
      {indicator.tone === "working" ? <span className="absolute inset-0 rounded-full bg-[var(--ec-accent)] opacity-60 motion-safe:animate-ping" /> : null}
      <Icon className="relative size-[7px]" strokeWidth={3} />
    </span>
  );
};
