import { ChevronDown } from "lucide-react";
import { WINDOWS_TITLEBAR_OVERLAY_BACKGROUND, type AppMenuSection, type UiTheme } from "@easycode/shared";
import appIcon from "../../assets/app-icon.png";
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

export const AppTitleBar = ({ uiTheme, onOpenMenu, syncWindowsCaptionStrip = false }: Props) => {
  const chromaticDark = uiTheme !== "light";
  const captionFill = WINDOWS_TITLEBAR_OVERLAY_BACKGROUND[uiTheme];
  return (
    <header
      style={syncWindowsCaptionStrip ? { backgroundColor: captionFill } : undefined}
      className={cn(
        "flex h-10 shrink-0 items-center px-2.5 [-webkit-app-region:drag]",
        syncWindowsCaptionStrip
          ? chromaticDark
            ? "border-b border-white/10 text-zinc-100"
            : "border-b border-slate-400/60 text-slate-800"
          : chromaticDark
            ? "glass-titlebar text-zinc-100"
            : "border-b border-slate-400/60 bg-slate-300/85 text-slate-800 backdrop-blur-xl",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 pr-3">
        <img
          src={appIcon}
          alt="Easycode"
          className="h-6 w-6 rounded-md object-cover shadow-[0_0_14px_rgba(34,211,238,0.18)]"
          draggable={false}
        />
        <span className={`truncate text-sm font-medium tracking-tight ${chromaticDark ? "text-zinc-200" : "text-slate-800"}`}>Easycode</span>
      </div>

      <nav className="flex items-center gap-0.5 pr-[148px] [-webkit-app-region:no-drag]">
        {MENU_SECTIONS.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="ghost"
            size="sm"
            className={`h-7 rounded-md px-2 text-[12px] font-medium ${
              chromaticDark
                ? "text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-50"
                : "text-slate-700 hover:bg-slate-500/12 hover:text-slate-950"
            }`}
            onClick={(event) => onOpenMenu(section.id, event.currentTarget)}
          >
            {section.label}
            <ChevronDown className={`ml-1 h-3 w-3 ${chromaticDark ? "text-zinc-500" : "text-slate-500"}`} />
          </Button>
        ))}
      </nav>
    </header>
  );
};
