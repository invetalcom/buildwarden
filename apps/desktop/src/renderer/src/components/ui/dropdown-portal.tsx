import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export type AnchorDropdownAlign = "start" | "end";
export type AnchorDropdownPlacement = "auto" | "bottom" | "top";

/**
 * Fixed-position dropdown portaled to document.body so menus are not clipped by panels.
 */
export const AnchorDropdownPortal = ({
  open,
  anchorRef,
  onClose,
  align = "start",
  placement = "auto",
  widthPx = 192,
  className,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: AnchorDropdownAlign;
  placement?: AnchorDropdownPlacement;
  widthPx?: number;
  className?: string;
  children: ReactNode;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: 0 });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const updatePosition = () => {
      const el = anchorRef.current;
      if (!el) {
        return;
      }
      const r = el.getBoundingClientRect();
      const gap = 6;
      const pad = 8;
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const availableBelow = window.innerHeight - r.bottom - gap - pad;
      const availableAbove = r.top - gap - pad;
      const shouldOpenUp =
        placement === "top" ||
        (placement === "auto" && menuHeight > 0 && availableBelow < menuHeight && availableAbove > availableBelow);
      let left = align === "end" ? r.right - widthPx : r.left;
      left = Math.max(pad, Math.min(left, window.innerWidth - widthPx - pad));
      const rawTop = shouldOpenUp ? r.top - gap - menuHeight : r.bottom + gap;
      const top = Math.max(pad, Math.min(rawTop, window.innerHeight - Math.max(menuHeight, 1) - pad));
      const maxHeight = Math.max(120, shouldOpenUp ? availableAbove : availableBelow);
      setPos({ top, left, maxHeight });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, align, placement, widthPx, anchorRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocMouseDown = (event: MouseEvent) => {
      const t = event.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) {
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, onClose, anchorRef]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      className={cn("fixed z-[20000]", className)}
      style={{ top: pos.top, left: pos.left, width: widthPx, maxHeight: pos.maxHeight || undefined }}
    >
      {children}
    </div>,
    document.body,
  );
};
