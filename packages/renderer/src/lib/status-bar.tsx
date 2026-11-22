import { forwardRef, useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { StatusBarSlotsContext, type StatusBarSlot } from "./status-bar-slots";

export const StatusBarSlotsProvider = StatusBarSlotsContext.Provider;

/**
 * Renders children into a status bar slot. Without a status bar (component tests, embedded views)
 * the children render in place, so nothing a user can read ever disappears.
 */
export const StatusBarPortal = ({ slot, children }: { slot: StatusBarSlot; children: ReactNode }) => {
  const slots = useContext(StatusBarSlotsContext);
  if (!slots) return <>{children}</>;
  const target = slots[slot];
  return target ? createPortal(children, target) : null;
};

export type StatusBarTone = "ok" | "warn" | "bad" | "accent";

/** One segment of the status bar. Colored only when it needs attention. */
export const StatusBarItem = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: StatusBarTone; icon?: ReactNode }>(
  ({ tone, icon, className, children, onClick, ...props }, ref) => onClick || props["aria-haspopup"] ? (
    <button ref={ref} type="button" data-ui="statusbar-item" data-tone={tone} className={cn("[&_svg]:size-3 [&_svg]:shrink-0", className)} onClick={onClick} {...props}>
      {icon}{children}
    </button>
  ) : (
    <span data-ui="statusbar-item" data-tone={tone} className={cn("[&_svg]:size-3 [&_svg]:shrink-0", className)} title={props.title} aria-label={props["aria-label"]}>
      {icon}{children}
    </span>
  ),
);

StatusBarItem.displayName = "StatusBarItem";
