import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export const SidebarUtilityButton = ({ label, icon: Icon, count = "", selected = false, collapsed = false, onClick }: {
  label: string;
  icon: LucideIcon;
  count?: string;
  selected?: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    aria-label={label}
    aria-description={count ? `${count} items` : undefined}
    title={collapsed ? `${label}${count ? ` (${count})` : ""}` : undefined}
    className={cn(
      "group relative flex rounded-md",
      collapsed ? "size-8 shrink-0" : "h-7 min-w-0 flex-1",
      // The selected entry is a neutral fill, like the navigation rows above it.
      selected && "bg-[var(--ec-control)] text-[var(--ec-text)]",
    )}
    onClick={onClick}
  >
    <Icon className={cn(collapsed ? "size-4" : "size-3.5", selected ? "text-[var(--ec-text)]" : !collapsed && "text-[var(--ec-faint)]")} />
    {!collapsed && count && (
      // Accent colored so the number reads as a count, not as part of the icon next to it.
      <span aria-hidden="true" data-ui="count" className="absolute left-1/2 top-0 ml-2 rounded-full px-0.5 text-center font-mono text-[8px] font-semibold leading-[0.8rem] tabular-nums text-[var(--ec-accent)]">
        {count}
      </span>
    )}
    {!collapsed && (
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--ec-bg-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--ec-text)] shadow-[var(--ec-popover-shadow)] group-hover:block group-focus-visible:block">
        {label}
      </span>
    )}
  </Button>
);
