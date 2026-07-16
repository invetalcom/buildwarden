import { ChevronDown } from "lucide-react";
import { type AppMenuSection, type UiTheme } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

const MENU_SECTIONS: { id: AppMenuSection; label: string }[] = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "window", label: "Window" },
  { id: "help", label: "Help" },
];

type Props = {
  uiTheme: UiTheme;
  onOpenMenu: (section: AppMenuSection, anchor: HTMLButtonElement) => void;
  /** Windows frameless: use the same solid fill as Electron `titleBarOverlay` so caption buttons are not a different tile. */
  syncWindowsCaptionStrip?: boolean;
};

export const AppTitleBar = ({ onOpenMenu, syncWindowsCaptionStrip = false }: Props) => {
  return (
    <header
      style={syncWindowsCaptionStrip ? { backgroundColor: "var(--ec-titlebar)" } : undefined}
      className={cn(
        "flex h-10 shrink-0 items-center px-2.5 [-webkit-app-region:drag]",
        syncWindowsCaptionStrip
          ? "border-b border-[var(--ec-border)] text-[var(--ec-text)]"
          : "glass-titlebar text-[var(--ec-text)]",
      )}
    >
      <nav className="flex items-center gap-0.5 pr-[148px] [-webkit-app-region:no-drag]">
        {MENU_SECTIONS.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-md px-2 text-[12px] font-medium text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
            onClick={(event) => onOpenMenu(section.id, event.currentTarget)}
          >
            {section.label}
            <ChevronDown className="ml-1 size-3 text-[var(--ec-faint)]" />
          </Button>
        ))}
      </nav>
    </header>
  );
};
