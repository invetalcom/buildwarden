import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./primitives";

/**
 * Bottom sheets replace every desktop dropdown, popover and dialog. On a phone a centred modal
 * fights the on-screen keyboard and puts its controls out of thumb reach, so everything slides up
 * from the bottom edge instead.
 */

const useScrollLock = (active: boolean) => {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
};

const useEscapeKey = (active: boolean, onClose: () => void) => {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);
};

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Blocks scrim/Escape dismissal while a mutation is in flight. */
  dismissable?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  /** Fills the viewport instead of hugging its content — used for composers and diff viewers. */
  full?: boolean;
}

export const Sheet = ({ open, onClose, title, dismissable = true, children, footer, full = false }: SheetProps) => {
  useScrollLock(open);
  useEscapeKey(open && dismissable, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={dismissable ? onClose : undefined}
        className="m-scrim-enter absolute inset-0 bg-[var(--m-scrim)]"
      />
      <section
        role="dialog"
        aria-modal="true"
        className={cn(
          "m-sheet-enter relative flex min-h-0 flex-col rounded-t-2xl border-t border-[var(--ec-border)]",
          "bg-[var(--ec-bg-elevated)] shadow-[var(--ec-popover-shadow)]",
          full ? "h-[100dvh] rounded-t-none" : "max-h-[88dvh]",
        )}
        style={{ paddingBottom: "var(--m-safe-bottom)" }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ec-border)] px-2 py-1.5">
          {full ? null : <span className="absolute inset-x-0 -top-2 mx-auto h-1 w-9 rounded-full bg-[var(--ec-border-strong)]" />}
          <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        </header>
        <div className="m-scroll min-h-0 flex-1">{children}</div>
        {footer ? (
          <footer className="shrink-0 border-t border-[var(--ec-border)] px-4 py-3">{footer}</footer>
        ) : null}
      </section>
    </div>
  );
};

export interface SheetAction {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** iOS-style action list; the mobile replacement for the desktop `⋯` dropdown menus. */
export const ActionSheet = ({
  open,
  onClose,
  title,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions: readonly SheetAction[];
}) => (
  <Sheet open={open} onClose={onClose} title={title ?? "Actions"}>
    <div className="flex flex-col py-1">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled}
          onClick={() => {
            onClose();
            action.onSelect();
          }}
          className={cn(
            "m-tap flex items-center gap-3 px-4 py-3 text-left text-sm transition active:bg-[var(--ec-hover)]",
            "disabled:opacity-40",
            action.danger ? "text-[var(--ec-danger)]" : "text-[var(--ec-text)]",
          )}
        >
          {action.icon ? <span className="shrink-0 text-[var(--ec-muted)]">{action.icon}</span> : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{action.label}</span>
            {action.hint ? <span className="truncate text-xs text-[var(--ec-faint)]">{action.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>
  </Sheet>
);

export const ConfirmSheet = ({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) => (
  <Sheet open={open} onClose={onClose} title={title} dismissable={!busy}>
    <p className="m-wrap-anywhere px-4 py-4 text-sm leading-6 text-[var(--ec-muted)]">{message}</p>
    <div className="flex gap-2 px-4 pb-4">
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="m-tap flex-1 rounded-md border border-[var(--ec-border)] text-sm font-medium text-[var(--ec-muted)] disabled:opacity-40"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={cn(
          "m-tap flex-1 rounded-md text-sm font-semibold disabled:opacity-40",
          danger
            ? "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] border border-[var(--ec-danger-ring)]"
            : "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]",
        )}
      >
        {busy ? "Working…" : confirmLabel}
      </button>
    </div>
  </Sheet>
);
