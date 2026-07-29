import { useEffect, type ReactNode } from "react";

/**
 * Left drawer for the project switcher. Project switching is frequent but not a top-level
 * destination, so it lives behind the app-bar title rather than taking one of the four tab slots.
 */
export const Drawer = ({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        className="m-drawer-enter m-safe-top m-safe-bottom relative flex w-[min(21rem,86vw)] flex-col border-r border-[var(--ec-border)] bg-[var(--ec-bg-elevated)] shadow-2xl"
      >
        {children}
      </aside>
      <button type="button" aria-label="Close projects" onClick={onClose} className="m-scrim-enter flex-1 bg-[var(--m-scrim)]" />
    </div>
  );
};
