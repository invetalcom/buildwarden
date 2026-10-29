import type { Dispatch, RefObject, SetStateAction } from "react";
import type { RunWorkspacePanelId } from "@buildwarden/shared";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

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
  runPanelToggleItems: readonly RunPanelToggleItem[];
  runWorkspaceVisiblePanelCount: number;
  runPanelsMenuOpen: boolean;
  setRunPanelsMenuOpen: Dispatch<SetStateAction<boolean>>;
  runPanelsMenuAnchorRef: RefObject<HTMLDivElement | null>;
}

export const RunPanelsMenu = ({
  runPanelToggleItems,
  runWorkspaceVisiblePanelCount,
  runPanelsMenuOpen,
  setRunPanelsMenuOpen,
  runPanelsMenuAnchorRef,
}: RunPanelsMenuProps) => {
  return (
    <div ref={runPanelsMenuAnchorRef} className="relative shrink-0">
      <Button
        variant="secondary"
        size="sm"
        className="h-8 shrink-0 gap-2 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)]"
        onClick={() => setRunPanelsMenuOpen((current) => !current)}
        aria-expanded={runPanelsMenuOpen}
        aria-haspopup="menu"
        title="Choose visible run panels"
      >
        Panels
        <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1.5 text-[10px] text-[var(--ec-text)]">
          {runWorkspaceVisiblePanelCount}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${runPanelsMenuOpen ? "rotate-180" : ""}`} />
      </Button>
      <AnchorDropdownPortal
        open={runPanelsMenuOpen}
        anchorRef={runPanelsMenuAnchorRef}
        onClose={() => setRunPanelsMenuOpen(false)}
        align="start"
        widthPx={240}
        className="glass-popover overflow-hidden py-1"
      >
        <div role="menu">
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
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                  item.disabled ? "cursor-not-allowed text-[var(--ec-faint)]" : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                )}
                onClick={() => {
                  item.onClick();
                }}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px]",
                    item.active
                      ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                      : "border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-faint)]",
                  )}
                >
                  {item.active ? "ON" : ""}
                </span>
                <Icon className="h-4 w-4 shrink-0 text-[var(--ec-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{item.label}</div>
                  <div className="text-[10px] text-[var(--ec-muted)]">{item.subtitle}</div>
                </div>
              </button>
            );
          })}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};
