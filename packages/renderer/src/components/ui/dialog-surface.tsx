import { X } from "lucide-react";
import type { HTMLAttributes, KeyboardEventHandler, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Scrim behind a dialog that is not a native `<dialog>`. */
export const DialogOverlay = ({ children, onKeyDown, onDismiss, className, position = "fixed" }: {
  children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /** Called when the scrim itself is pressed. */
  onDismiss?: () => void;
  className?: string;
  position?: "fixed" | "absolute";
}) => (
  <div
    className={cn("app-dialog-overlay inset-0 z-50 flex items-center justify-center p-6", position, className)}
    onKeyDown={onKeyDown}
    onMouseDown={onDismiss ? (event) => { if (event.target === event.currentTarget) onDismiss(); } : undefined}
  >
    {children}
  </div>
);

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
  titleId?: string;
  bodyClassName?: string;
};

/**
 * The one dialog shape: an icon tile with title and description, a body of fields and inset
 * panels, and the actions right-aligned at the bottom. {@link ModalDialog} renders the same parts
 * in a native dialog; use this for overlays that manage their own focus.
 */
export const DialogSurface = ({ title, description, icon, tone = "neutral", footer, footerStart, onClose, titleId, bodyClassName, className, children, ...props }: DialogSurfaceProps) => (
  <div data-ui="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn("app-dialog flex max-h-[calc(100vh-3rem)] w-full max-w-xl flex-col", className)} {...props}>
    <div data-ui="dialog-header" className="shrink-0">
      {icon ? <span data-ui="dialog-icon" data-tone={tone} aria-hidden>{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <h3 id={titleId} className="text-sm font-semibold leading-5 text-[var(--ec-text)]">{title}</h3>
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

/** Label above a field inside a dialog. */
export const DialogField = ({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) => (
  <label className={cn("block text-xs", className)}>
    <span className="mb-1 block font-medium text-[var(--ec-muted)]">{label}</span>
    {children}
  </label>
);
