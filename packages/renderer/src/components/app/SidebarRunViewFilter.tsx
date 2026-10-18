import { useId, useRef, useState } from "react";
import { Check, ListFilter } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "../ui/dropdown-portal";
import { SIDEBAR_RUN_VIEWS, type SidebarRunView } from "./sidebar-run-sections";

export const SidebarRunViewFilter = ({ value, counts, recentRunDays, onChange }: {
  value: SidebarRunView;
  counts: Record<string, number>;
  recentRunDays: number;
  onChange: (view: SidebarRunView) => void;
}) => {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = SIDEBAR_RUN_VIEWS.find((view) => view.id === value)?.label ?? "All";
  const closeAndFocus = () => { setOpen(false); anchor.current?.focus(); };

  return <>
    <Button ref={anchor} type="button" size="icon" variant="ghost" aria-label="Filter runs"
      title={`Filter runs: ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      className={cn("h-6 w-6", value !== "all" && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]")}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}><ListFilter className="size-3.5" /></Button>
    <AnchorDropdownPortal open={open} anchorRef={anchor} onClose={() => setOpen(false)} align="end" widthPx={180} className="glass-popover p-1">
      <div id={menuId} role="menu" aria-label="Run views" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAndFocus(); return; }
        if (event.key === "Tab") { closeAndFocus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const index = options.findIndex((option) => option === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }}>
        {SIDEBAR_RUN_VIEWS.map((view) => <button key={view.id} type="button" role="menuitemradio"
          aria-checked={value === view.id} autoFocus={value === view.id} tabIndex={-1}
          title={view.id === "recent" ? `User activity in the last ${recentRunDays} days` : undefined}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)] focus-visible:bg-[var(--ec-hover)] focus-visible:outline-none",
            value === view.id && "bg-[var(--ec-accent-soft)]")}
          onClick={() => { onChange(view.id); closeAndFocus(); }}>
          <Check className={cn("size-3.5 shrink-0 text-[var(--ec-accent)]", value !== view.id && "invisible")} />
          <span className="flex-1">{view.label}</span><span className="font-mono text-[var(--ec-muted)]">{counts[view.id] ?? 0}</span>
        </button>)}
      </div>
    </AnchorDropdownPortal>
  </>;
};
