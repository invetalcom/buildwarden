import type { Dispatch, RefObject, SetStateAction } from "react";
import { RUN_TIMELINE_DENSITIES, type RunTimelineDensity } from "@buildwarden/shared";
import { Check, SlidersHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

const RUN_TIMELINE_DENSITY_LABELS: Record<RunTimelineDensity, string> = {
  compact: "Compact",
  comfortable: "Comfort",
  detailed: "Detailed",
};

export interface RunDensityMenuProps {
  runTimelineDensity: RunTimelineDensity;
  onRunTimelineDensityChange: (density: RunTimelineDensity) => void;
  runDensityMenuOpen: boolean;
  setRunDensityMenuOpen: Dispatch<SetStateAction<boolean>>;
  runDensityMenuAnchorRef: RefObject<HTMLDivElement | null>;
}

export const RunDensityMenu = ({
  runTimelineDensity,
  onRunTimelineDensityChange,
  runDensityMenuOpen,
  setRunDensityMenuOpen,
  runDensityMenuAnchorRef,
}: RunDensityMenuProps) => {
  return (
    <div ref={runDensityMenuAnchorRef} className="relative shrink-0">
      <Button
        variant="secondary"
        size="sm"
        className="h-8 w-8 shrink-0 p-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
        onClick={() => setRunDensityMenuOpen((current) => !current)}
        aria-expanded={runDensityMenuOpen}
        aria-haspopup="menu"
        aria-label={`Run timeline density: ${RUN_TIMELINE_DENSITY_LABELS[runTimelineDensity]}`}
        title={`Run timeline density: ${RUN_TIMELINE_DENSITY_LABELS[runTimelineDensity]}`}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden />
      </Button>
      <AnchorDropdownPortal
        open={runDensityMenuOpen}
        anchorRef={runDensityMenuAnchorRef}
        onClose={() => setRunDensityMenuOpen(false)}
        align="end"
        widthPx={180}
        className="glass-popover overflow-hidden py-1"
      >
        <div role="menu" aria-label="Run timeline density">
          {RUN_TIMELINE_DENSITIES.map((density) => {
            const selected = runTimelineDensity === density;
            return (
              <button
                key={density}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition",
                  selected
                    ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                    : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                )}
                onClick={() => {
                  onRunTimelineDensityChange(density);
                  setRunDensityMenuOpen(false);
                }}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                    selected
                      ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent)] text-[var(--ec-bg)]"
                      : "border-[var(--ec-border)] bg-[var(--ec-panel)] text-transparent",
                  )}
                >
                  {selected ? <Check className="h-3 w-3" aria-hidden /> : null}
                </span>
                <span className="font-medium">{RUN_TIMELINE_DENSITY_LABELS[density]}</span>
              </button>
            );
          })}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};
