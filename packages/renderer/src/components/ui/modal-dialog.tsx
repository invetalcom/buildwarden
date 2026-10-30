import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface ModalDialogProps {
  title: ReactNode;
  /** Short context line under the title. */
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/** Native dialog supplies focus trapping and Escape handling in both shells. */
export const ModalDialog = ({ title, description, children, onClose, returnFocusTo, fallbackFocusRef, className }: ModalDialogProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const fallback = fallbackFocusRef?.current;
    const target = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        "fixed inset-0 m-auto w-[min(26rem,95vw)] rounded-xl border border-[var(--ec-border)] bg-[var(--ec-dialog-bg)] p-4 text-[var(--ec-text)] shadow-xl backdrop:bg-black/50",
        className,
      )}
    >
      <h2 id={titleId} className={cn("text-sm font-semibold", description ? "mb-1" : "mb-3")}>{title}</h2>
      {description ? <p id={descriptionId} className="mb-3 text-xs leading-5 text-[var(--ec-muted)]">{description}</p> : null}
      {children}
    </dialog>,
    document.body,
  );
};
