import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "../../lib/cn";
import { AnchorDropdownPortal, type AnchorDropdownAlign, type AnchorDropdownPlacement } from "./dropdown-portal";

type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type SelectProps = {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  optionClassName?: string;
  maxMenuHeightPx?: number;
  align?: AnchorDropdownAlign;
  placement?: AnchorDropdownPlacement;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

export const Select = ({
  value,
  options,
  onValueChange,
  disabled,
  placeholder = "Select...",
  emptyMessage = "No options",
  id,
  ariaLabel,
  className,
  triggerClassName,
  menuClassName,
  optionClassName,
  maxMenuHeightPx,
  align = "start",
  placement = "auto",
  onKeyDown,
}: SelectProps) => {
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const [open, setOpen] = useState(false);
  const [menuWidth, setMenuWidth] = useState(192);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? placeholder;
  const isDisabled = disabled || options.length === 0;

  const openMenu = () => {
    if (isDisabled) {
      return;
    }
    const width = anchorRef.current?.getBoundingClientRect().width ?? 192;
    setMenuWidth(Math.max(192, width));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
    }
  };

  return (
    <div className={cn("relative min-w-0", className)} ref={anchorRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={isDisabled}
        className={cn(
          "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-input)] px-3 text-left text-sm text-[var(--ec-text)] outline-none transition",
          "hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-control-hover)] focus:border-[var(--ec-accent-ring)] focus:ring-2 focus:ring-[var(--ec-ring)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
          triggerClassName,
        )}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={cn("min-w-0 truncate", selected ? "text-[var(--ec-text)]" : "text-[var(--ec-faint)]")}>
          {selectedLabel}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--ec-faint)] transition", open ? "rotate-180" : "")} />
      </button>

      <AnchorDropdownPortal
        open={open}
        anchorRef={anchorRef}
        align={align}
        placement={placement}
        widthPx={menuWidth}
        maxHeightPx={maxMenuHeightPx}
        onClose={() => setOpen(false)}
        className={cn(
          "glass-popover overflow-hidden",
          menuClassName,
        )}
      >
        <div id={listboxId} role="listbox" className="app-scrollbar app-dropdown-scrollbar overflow-y-auto p-1" style={{ maxHeight: "inherit" }}>
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--ec-muted)]">{emptyMessage}</div>
          ) : (
            options.map((option) => {
              const optionSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={optionSelected}
                  disabled={option.disabled}
                  className={cn(
                    "flex w-full min-w-0 items-start justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                    optionSelected
                      ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                      : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    optionClassName,
                  )}
                  onClick={() => {
                    if (option.disabled) {
                      return;
                    }
                    onValueChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-[var(--ec-muted)]">{option.description}</span>
                    ) : null}
                  </span>
                  {optionSelected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ec-accent)]" /> : null}
                </button>
              );
            })
          )}
        </div>
      </AnchorDropdownPortal>
    </div>
  );
};
