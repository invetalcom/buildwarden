import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEventHandler, type ReactNode } from "react";
import { cn } from "../../lib/cn";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Scrim behind a dialog that is not a native `<dialog>`. It gives the dialog what a native one
 * has: focus moves into it when it opens, Tab stays inside it, and focus returns to the control
 * that opened it when it closes.
 */
export const DialogOverlay = ({ children, onKeyDown, onDismiss, className, position = "fixed" }: {
  children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /** Called when the scrim itself is pressed. */
  onDismiss?: () => void;
  className?: string;
  position?: "fixed" | "absolute";
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  // Read while rendering for the first time: once effects run, a field with autoFocus inside the
  // dialog already has focus, and the control that opened the dialog can no longer be told.
  const [opener] = useState(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!overlay.contains(document.activeElement)) {
      (overlay.querySelector<HTMLElement>(FOCUSABLE) ?? overlay.querySelector<HTMLElement>('[role="dialog"]'))?.focus({ preventScroll: true });
    }
    return () => {
      // StrictMode replays effects while the dialog is still mounted. Restore only after removal.
      if (overlay.isConnected) return;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  const containFocus: KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const overlay = event.currentTarget;
    // A popup that renders outside the overlay, such as a Select menu, moves focus on its own.
    if (!overlay.contains(document.activeElement)) return;
    const stops = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={overlayRef}
      className={cn("app-dialog-overlay inset-0 z-50 flex items-center justify-center p-6", position, className)}
      onKeyDown={containFocus}
      onMouseDown={onDismiss ? (event) => { if (event.target === event.currentTarget) onDismiss(); } : undefined}
    >
      {children}
    </div>
  );
};

export type DialogSurfaceProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  /** One line of context under the title. */
  description?: ReactNode;
  /** Icon shown in a tile next to the title. */
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "danger" | "warning";
  /** Right-aligned actions: Cancel first, then the one primary action. */
  footer?: ReactNode;
  /** Secondary action on the left of the footer, such as "Generate with AI". */
  footerStart?: ReactNode;
  onClose?: () => void;
  /** Id of the heading that names the dialog. One is generated when it is left out. */
  titleId?: string;
  bodyClassName?: string;
};

/**
 * The one dialog shape: an icon tile with title and description, a body of fields and inset
 * panels, and the actions right-aligned at the bottom. {@link ModalDialog} renders the same parts
 * in a native dialog; use this for overlays that manage their own focus.
 */
export const DialogSurface = ({ title, description, icon, tone = "neutral", footer, footerStart, onClose, titleId, bodyClassName, className, children, ...props }: DialogSurfaceProps) => {
  const generatedTitleId = useId();
  const headingId = titleId ?? generatedTitleId;
  return (
  <div data-ui="dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} className={cn("app-dialog flex max-h-[calc(100vh-3rem)] w-full max-w-xl flex-col focus:outline-none", className)} {...props}>
    <div data-ui="dialog-header" className="shrink-0">
      {icon ? <span data-ui="dialog-icon" data-tone={tone} aria-hidden>{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="text-sm font-semibold leading-5 text-[var(--ec-text)]">{title}</h3>
        {description ? <p className="mt-0.5 text-xs leading-5 text-[var(--ec-muted)]">{description}</p> : null}
      </div>
      {onClose ? (
        <button type="button" aria-label="Close dialog" title="Close" onClick={onClose}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]">
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
    {children !== undefined && children !== null && children !== false ? (
      <div data-ui="dialog-body" className={cn("app-scrollbar min-h-0 overflow-y-auto", bodyClassName)}>{children}</div>
    ) : null}
    {footer || footerStart ? (
      <div data-ui="dialog-footer" className="shrink-0">
        {footerStart ? <div className="mr-auto flex items-center gap-2">{footerStart}</div> : null}
        {footer}
      </div>
    ) : null}
  </div>
  );
};

/** Label above a field inside a dialog. */
export const DialogField = ({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) => (
  <label className={cn("block text-xs", className)}>
    <span className="mb-1 block font-medium text-[var(--ec-muted)]">{label}</span>
    {children}
  </label>
);
