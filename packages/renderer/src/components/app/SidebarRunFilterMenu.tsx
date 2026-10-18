import { useId, useRef, useState } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { AnchorDropdownPortal } from "../ui/dropdown-portal";

export const SidebarRunFilterMenu = <Value extends string,>({ value, options, onChange, icon: Icon, label, menuLabel, active, width = 180 }: {
  value: Value;
  options: { id: Value; label: string; count?: number; title?: string }[];
  onChange: (value: Value) => void;
  icon: LucideIcon;
  label: string;
  menuLabel: string;
  active: boolean;
  width?: number;
}) => {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selectedLabel = options.find((option) => option.id === value)?.label;
  const closeAndFocus = () => { setOpen(false); anchor.current?.focus(); };

  return <>
    <Button ref={anchor} type="button" size="icon" variant="ghost" aria-label={label}
      title={`${label}: ${selectedLabel}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      className={cn("h-6 w-6 shrink-0", active && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]")}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}><Icon className="size-3.5" /></Button>
    <AnchorDropdownPortal open={open} anchorRef={anchor} onClose={() => setOpen(false)} align="end" widthPx={width} maxHeightPx={280} className="glass-popover app-scrollbar overflow-y-auto p-1">
      <div id={menuId} role="menu" aria-label={menuLabel} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAndFocus(); return; }
        if (event.key === "Tab") { closeAndFocus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const index = items.findIndex((option) => option === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
        {options.map((option) => <button key={option.id} type="button" role="menuitemradio"
          aria-checked={value === option.id} autoFocus={value === option.id} tabIndex={-1}
          title={option.title ?? option.label}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)] focus-visible:bg-[var(--ec-hover)] focus-visible:outline-none",
            value === option.id && "bg-[var(--ec-accent-soft)]")}
          onClick={() => { onChange(option.id); closeAndFocus(); }}>
          <Check className={cn("size-3.5 shrink-0 text-[var(--ec-accent)]", value !== option.id && "invisible")} />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.count !== undefined && <span className="font-mono text-[var(--ec-muted)]">{option.count}</span>}
        </button>)}
      </div>
    </AnchorDropdownPortal>
  </>;
};
