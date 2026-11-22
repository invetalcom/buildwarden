import type { Dispatch, RefObject, SetStateAction } from "react";
import { RUN_TIMELINE_DENSITIES, type RunTimelineDensity, type RunWorkspacePanelId } from "@buildwarden/shared";
import { Check, ChevronDown, PanelsTopLeft, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { RunHeaderMenu } from "./RunHeaderMenu";

export interface RunPanelToggleItem {
  key: RunWorkspacePanelId;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  subtitle: string;
  onClick: () => void;
}

export interface RunPanelsMenuProps {
  runTimelineDensity: RunTimelineDensity;
  onRunTimelineDensityChange: (density: RunTimelineDensity) => void;
  runPanelToggleItems: readonly RunPanelToggleItem[];
  runWorkspaceVisiblePanelCount: number;
  runPanelsMenuOpen: boolean;
  setRunPanelsMenuOpen: Dispatch<SetStateAction<boolean>>;
  runPanelsMenuAnchorRef: RefObject<HTMLDivElement | null>;
  /** Icon-only trigger, for the one-line run header. */
  compact?: boolean;
}

export const RunPanelsMenu = ({
  runTimelineDensity,
  onRunTimelineDensityChange,
  runPanelToggleItems,
  runWorkspaceVisiblePanelCount,
  runPanelsMenuOpen,
  setRunPanelsMenuOpen,
  runPanelsMenuAnchorRef,
  compact = false,
}: RunPanelsMenuProps) => {
  return (
    <div ref={runPanelsMenuAnchorRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className={compact ? "size-8 shrink-0 p-0" : "h-8 shrink-0 gap-1.5 px-2.5 text-xs"}
        aria-label={compact ? "View" : undefined}
        onClick={() => setRunPanelsMenuOpen((current) => !current)}
        aria-expanded={runPanelsMenuOpen}
        aria-haspopup="menu"
        title={`View settings: ${runWorkspaceVisiblePanelCount} visible panels`}
      >
        {compact ? <PanelsTopLeft className="size-4 shrink-0" aria-hidden /> : <>
          <PanelsTopLeft className="size-3.5 shrink-0" aria-hidden />
          View
          <ChevronDown className={`size-3 shrink-0 opacity-70 transition ${runPanelsMenuOpen ? "rotate-180" : ""}`} aria-hidden />
        </>}
      </Button>
      <AnchorDropdownPortal
        open={runPanelsMenuOpen}
        anchorRef={runPanelsMenuAnchorRef}
        onClose={() => setRunPanelsMenuOpen(false)}
        align="end"
        widthPx={272}
        className="glass-popover overflow-y-auto py-1"
      >
        <RunHeaderMenu label="Run view settings" onClose={() => {
          setRunPanelsMenuOpen(false);
          runPanelsMenuAnchorRef.current?.querySelector("button")?.focus();
        }}>
          <div role="group" aria-label="Timeline density" className="border-b border-[var(--ec-border)] px-3 pb-2 pt-1.5">
            <p className="mb-1.5 text-[10px] font-medium text-[var(--ec-muted)]">Timeline density</p>
            <div className="flex gap-1 rounded-md bg-[var(--ec-panel-soft)] p-0.5">
              {RUN_TIMELINE_DENSITIES.map((density) => (
                <button key={density} type="button" role="menuitemradio" aria-checked={density === runTimelineDensity}
                  className={cn("flex-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
                    density === runTimelineDensity ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]")}
                  onClick={() => onRunTimelineDensityChange(density)}>
                  {density === "comfortable" ? "Comfort" : density === "compact" ? "Compact" : "Detailed"}
                </button>
              ))}
            </div>
          </div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-medium text-[var(--ec-muted)]">Panels · {runWorkspaceVisiblePanelCount} visible</p>
          {runPanelToggleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.active}
                disabled={item.disabled}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]",
                  item.disabled ? "cursor-not-allowed text-[var(--ec-faint)]" : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                )}
                onClick={() => {
                  item.onClick();
                }}
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--ec-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs">{item.label}</div>
                  <div className="text-[10px] text-[var(--ec-muted)]">{item.subtitle}</div>
                </div>
                {item.active ? <Check className="size-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden /> : null}
              </button>
            );
          })}
        </RunHeaderMenu>
      </AnchorDropdownPortal>
    </div>
  );
};
