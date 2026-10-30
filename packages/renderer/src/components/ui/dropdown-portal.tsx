import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
  maxHeightPx,
  className,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: AnchorDropdownAlign;
  placement?: AnchorDropdownPlacement;
  widthPx?: number;
  maxHeightPx?: number;
  className?: string;
  children: ReactNode;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    container: Element | null;
    focusScopeId: string | undefined;
  }>({ top: 0, left: 0, maxHeight: 0, container: null, focusScopeId: undefined });

  const updatePosition = useCallback(() => {
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
    const menuHeightForPlacement = menuHeight > 0 ? Math.min(menuHeight, maxHeightPx ?? menuHeight) : 0;
    const shouldOpenUp =
      placement === "top" ||
      (placement === "auto" && menuHeightForPlacement > 0 && availableBelow < menuHeightForPlacement && availableAbove > availableBelow);
    let left = align === "end" ? r.right - widthPx : r.left;
    left = Math.max(pad, Math.min(left, window.innerWidth - widthPx - pad));
    const availableHeight = shouldOpenUp ? availableAbove : availableBelow;
    const maxHeight = Math.max(120, maxHeightPx ? Math.min(availableHeight, maxHeightPx) : availableHeight);
    const renderedHeight = Math.max(1, menuHeight > 0 ? Math.min(menuHeight, maxHeight) : maxHeight);
    const rawTop = shouldOpenUp ? r.top - gap - renderedHeight : r.bottom + gap;
    const top = Math.max(pad, Math.min(rawTop, window.innerHeight - renderedHeight - pad));
    // Resolve the committed anchor's scope and modal target with its geometry.
    // Native modal dialogs make body-level portals inert.
    const container = el.closest("dialog[open]") ?? document.body;
    const focusScopeId = el.closest<HTMLElement>("[data-focus-scope-id]")?.dataset.focusScopeId;
    setPos({ top, left, maxHeight, container, focusScopeId });
  }, [align, placement, widthPx, maxHeightPx, anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition, pos.container]);

  // A parent anchor's ref is attached after this child's layout effects on mount.
  // Retry after all refs are committed; the next layout pass measures the menu.
  useEffect(() => {
    if (open && !pos.container) updatePosition();
  }, [open, pos.container, updatePosition]);

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

  if (!open || !pos.container) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      data-focus-scope-portal-id={pos.focusScopeId}
      className={cn("fixed z-[20000]", className)}
      style={{ top: pos.top, left: pos.left, width: widthPx, maxHeight: pos.maxHeight || undefined }}
    >
      {children}
    </div>,
    pos.container,
  );
};
