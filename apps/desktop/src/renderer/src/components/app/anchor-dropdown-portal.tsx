import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export type AnchorDropdownAlign = "start" | "end";

/**
 * Fixed-position dropdown portaled to `document.body` so it opens below the anchor and is not clipped
 * or covered by sibling header controls (overflow / paint order).
 */
export const AnchorDropdownPortal = ({
  open,
  anchorRef,
  onClose,
  align = "start",
  widthPx = 192,
  className,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: AnchorDropdownAlign;
  widthPx?: number;
  className?: string;
  children: ReactNode;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

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
      let left = align === "end" ? r.right - widthPx : r.left;
      left = Math.max(pad, Math.min(left, window.innerWidth - widthPx - pad));
      setPos({ top: r.bottom + gap, left });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, align, widthPx, anchorRef]);

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
      style={{ top: pos.top, left: pos.left, width: widthPx }}
    >
      {children}
    </div>,
    document.body,
  );
};
