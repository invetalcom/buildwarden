import type { ReactNode } from "react";
import { ChevronDown, PanelLeft } from "lucide-react";
import { type AppMenuSection, type UiTheme } from "@buildwarden/shared";
import { cn } from "../../lib/cn";

type Props = {
  uiTheme: UiTheme;
  onOpenMenu: (section: AppMenuSection, anchor: HTMLButtonElement) => void;
  /** Windows frameless: use the same solid fill as Electron `titleBarOverlay` so caption buttons are not a different tile. */
  syncWindowsCaptionStrip?: boolean;
  /** Where the user is: project and page or run title. */
  title?: ReactNode;
  /** Receives the element right after the title, where the open page places its title actions (rename). */
  titleActionsRef?: (element: HTMLElement | null) => void;
  /** Toggles the sidebar. The button keeps its place whether the sidebar is open or collapsed. */
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  /** Right-aligned controls placed just left of the window caption buttons. */
  trailing?: ReactNode;
};

const controlClassName = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-[var(--ec-muted)] transition-colors hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] [-webkit-app-region:no-drag]";

/** Icon button for the title bar, styled like the sidebar toggle. */
export const TitleBarButton = ({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" className={cn(controlClassName, "w-7 justify-center px-0")} onClick={onClick} aria-label={label} aria-pressed={pressed} title={label}>
    {children}
  </button>
);

/** One strip on the window backdrop: sidebar toggle, the app menu, and the current page title. */
export const AppTitleBar = ({ onOpenMenu, title, titleActionsRef, onToggleSidebar, sidebarCollapsed = false, trailing }: Props) => (
  <header
    data-ui="titlebar"
    // The window buttons keep their size when the interface is scaled, so the space kept free for them scales the other way.
    className="flex h-10 shrink-0 items-center gap-1 pl-2 pr-[calc(148px/var(--bw-scale,1))] text-[var(--ec-text)] [-webkit-app-region:drag]"
  >
    {onToggleSidebar ? (
      <button
        type="button"
        className={cn(controlClassName, "w-7 justify-center px-0")}
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <PanelLeft className="size-4" aria-hidden />
      </button>
    ) : null}
    <button
      type="button"
      className={controlClassName}
      aria-haspopup="menu"
      aria-label="BuildWarden menu"
      onClick={(event) => onOpenMenu("all", event.currentTarget)}
    >
      <span className="text-[var(--ec-text)]">BuildWarden</span>
      <ChevronDown className="size-3 text-[var(--ec-faint)]" aria-hidden />
    </button>
    <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5 px-3">
      <div className="min-w-0 truncate text-center text-[12px] text-[var(--ec-muted)]" data-ui="titlebar-title">{title}</div>
      <span ref={titleActionsRef} className="flex shrink-0 items-center [-webkit-app-region:no-drag]" />
    </div>
    {trailing ? <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">{trailing}</div> : null}
  </header>
);
