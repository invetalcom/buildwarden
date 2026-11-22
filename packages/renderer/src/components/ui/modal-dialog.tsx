import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface ModalDialogProps {
  title: ReactNode;
  showCloseButton?: boolean;
  /** Short context line under the title. */
  description?: ReactNode;
  /** Icon shown in a tile next to the title. */
  icon?: ReactNode;
  /** Colors the icon tile; use danger for destructive confirmations. */
  tone?: "neutral" | "accent" | "danger" | "warning";
  /** Right-aligned actions: Cancel first, then the one primary action. */
  footer?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
}

/** Native dialog supplies focus trapping and Escape handling in both shells. */
export const ModalDialog = ({
  title, description, icon, tone = "neutral", footer, children, onClose, showCloseButton = true, returnFocusTo, fallbackFocusRef, className, bodyClassName,
}: ModalDialogProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const fallback = fallbackFocusRef?.current;
    // Focus sits on the body when the opener unmounted first, for example a menu item; use the fallback then.
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const target = returnFocusTo ?? active;
    dialog?.showModal();
    return () => {
      // StrictMode replays effects while the dialog is still mounted. Restore only after removal.
      if (dialog?.isConnected) return;
      const destination = target?.isConnected ? target : fallback;
      if (destination?.isConnected) destination.focus({ preventScroll: true });
    };
  }, [returnFocusTo, fallbackFocusRef]);
  return createPortal(
    <dialog
      ref={ref}
      data-ui="dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("fixed inset-0 m-auto max-h-[92vh] w-[min(26rem,95vw)] overflow-y-auto", className)}
    >
      <div data-ui="dialog-header">
        {icon ? <span data-ui="dialog-icon" data-tone={tone} aria-hidden>{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold leading-5">{title}</h2>
          {description ? <p id={descriptionId} className="mt-0.5 text-xs leading-5 text-[var(--ec-muted)]">{description}</p> : null}
        </div>
        {showCloseButton ? (
          <button type="button" aria-label="Close dialog" title="Close" onClick={onClose}
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]">
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {children !== undefined && children !== null && children !== false ? <div data-ui="dialog-body" className={bodyClassName}>{children}</div> : null}
      {footer ? <div data-ui="dialog-footer">{footer}</div> : null}
    </dialog>,
    document.body,
  );
};
