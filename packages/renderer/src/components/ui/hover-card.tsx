import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

type HoverCardSide = "left" | "right";

interface HoverCardTriggerProps {
  "aria-describedby"?: string;
}

export interface HoverCardProps {
  children: ReactElement;
  content: ReactNode;
  className?: string;
  widthPx?: number;
  openDelayMs?: number;
  disabled?: boolean;
}

const VIEWPORT_PADDING = 10;
const TRIGGER_GAP = 10;

/**
 * Delayed, non-interactive hover content rendered outside clipping containers.
 * It also opens on keyboard focus so truncated navigation items remain readable.
 */
export const HoverCard = ({
  children,
  content,
  className,
  widthPx = 340,
  openDelayMs = 320,
  disabled = false,
}: HoverCardProps) => {
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: widthPx, side: "right" as HoverCardSide });

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const closeCard = useCallback(() => {
    clearOpenTimer();
    setOpen(false);
  }, [clearOpenTimer]);

  const openCard = useCallback((immediate = false) => {
    if (disabled) return;
    clearOpenTimer();
    if (immediate) {
      setOpen(true);
      return;
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, openDelayMs);
  }, [clearOpenTimer, disabled, openDelayMs]);

  useEffect(() => () => clearOpenTimer(), [clearOpenTimer]);

  useEffect(() => {
    if (!disabled) return;
    closeCard();
  }, [closeCard, disabled]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCard();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeCard, open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const triggerRect = trigger.getBoundingClientRect();
      const renderedWidth = Math.min(widthPx, Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2));
      const cardHeight = cardRef.current?.offsetHeight ?? 0;
      const roomOnRight = window.innerWidth - triggerRect.right - TRIGGER_GAP - VIEWPORT_PADDING;
      const roomOnLeft = triggerRect.left - TRIGGER_GAP - VIEWPORT_PADDING;
      const side: HoverCardSide = roomOnRight >= renderedWidth || roomOnRight >= roomOnLeft ? "right" : "left";
      const rawLeft = side === "right"
        ? triggerRect.right + TRIGGER_GAP
        : triggerRect.left - TRIGGER_GAP - renderedWidth;
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(rawLeft, window.innerWidth - renderedWidth - VIEWPORT_PADDING),
      );
      const rawTop = triggerRect.top - 8;
      const top = Math.max(
        VIEWPORT_PADDING,
        Math.min(rawTop, window.innerHeight - cardHeight - VIEWPORT_PADDING),
      );

      setPosition({ top, left, width: renderedWidth, side });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, widthPx]);

  const triggerElement = children as ReactElement<HoverCardTriggerProps>;
  const triggerDescription = triggerElement.props["aria-describedby"];
  const trigger = cloneElement(triggerElement, {
    "aria-describedby": open ? [triggerDescription, contentId].filter(Boolean).join(" ") : triggerDescription,
  });

  return (
    <div
      ref={triggerRef}
      className="w-full min-w-0"
      onPointerEnter={() => openCard()}
      onPointerLeave={() => {
        pointerDownRef.current = false;
        if (!triggerRef.current?.contains(document.activeElement)) closeCard();
      }}
      onPointerDownCapture={() => {
        pointerDownRef.current = true;
        closeCard();
      }}
      onPointerUpCapture={() => {
        pointerDownRef.current = false;
      }}
      onPointerCancel={() => {
        pointerDownRef.current = false;
        closeCard();
      }}
      onFocusCapture={() => {
        if (pointerDownRef.current) return;
        openCard(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeCard();
      }}
    >
      {trigger}
      {open
        ? createPortal(
            <div
              ref={cardRef}
              id={contentId}
              role="tooltip"
              data-hover-card-side={position.side}
              className={cn(
                "hover-card-enter pointer-events-none fixed z-[20000] overflow-hidden glass-popover",
                className,
              )}
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
