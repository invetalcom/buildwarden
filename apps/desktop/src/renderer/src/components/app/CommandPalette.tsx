import { useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Command, Search, X, type LucideProps } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type CommandPaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  section: string;
  keywords?: string[];
  icon?: ComponentType<LucideProps>;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
};

const normalizeSearchText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

const matchesCommand = (item: CommandPaletteItem, terms: string[]) => {
  if (terms.length === 0) {
    return true;
  }
  const haystack = normalizeSearchText(
    [item.title, item.subtitle, item.section, ...(item.keywords ?? [])].filter(Boolean).join(" "),
  );
  return terms.every((term) => haystack.includes(term));
};

export const CommandPalette = ({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  const filteredItems = useMemo(() => {
    const terms = normalizeSearchText(deferredQuery).split(" ").filter(Boolean);
    return items.filter((item) => matchesCommand(item, terms)).slice(0, 12);
  }, [deferredQuery, items]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [deferredQuery]);

  if (!open) {
    return null;
  }

  const selectedItem = filteredItems[activeIndex] ?? filteredItems[0] ?? null;

  const runCommand = (item: CommandPaletteItem | null) => {
    if (!item || item.disabled) {
      return;
    }
    void item.onSelect();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-black/45 px-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="glass-popover w-full max-w-2xl overflow-hidden rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) => Math.min(filteredItems.length - 1, current + 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => Math.max(0, current - 1));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            runCommand(selectedItem);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--ec-border)] px-3 py-2">
          <Command className="h-4 w-4 shrink-0 text-[var(--ec-accent)]" aria-hidden />
          <Search className="h-4 w-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, projects, runs..."
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--ec-text)] outline-none placeholder:text-[var(--ec-faint)]"
          />
          <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose} aria-label="Close command palette">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="app-scrollbar max-h-[min(60vh,30rem)] overflow-y-auto p-1.5">
          {filteredItems.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-[var(--ec-muted)]">No matching commands.</div>
          ) : (
            filteredItems.map((item, index) => {
              const Icon = item.icon;
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition",
                    active ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]",
                    item.disabled && "cursor-not-allowed opacity-45",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runCommand(item)}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-accent)]">
                    {Icon ? <Icon className="h-4 w-4" aria-hidden /> : <Command className="h-4 w-4" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--ec-text)]">{item.title}</span>
                    {item.subtitle ? <span className="block truncate text-[11px] text-[var(--ec-muted)]">{item.subtitle}</span> : null}
                  </span>
                  <span className="shrink-0 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ec-faint)]">
                    {item.section}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
