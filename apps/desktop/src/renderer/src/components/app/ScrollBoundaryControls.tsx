import { useCallback, useEffect, useState, type RefObject } from "react";
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { Button } from "../ui/button";

type ScrollBoundaryControlsProps = Readonly<{
  scrollElementRef: RefObject<HTMLDivElement | null>;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
}>;

type ScrollAvailability = {
  canScrollUp: boolean;
  canScrollDown: boolean;
};

const scrollEdgeTolerance = 2;

export const ScrollBoundaryControls = ({
  scrollElementRef,
  onScrollToTop,
  onScrollToBottom,
}: ScrollBoundaryControlsProps) => {
  const [availability, setAvailability] = useState<ScrollAvailability>({
    canScrollUp: false,
    canScrollDown: false,
  });

  const updateAvailability = useCallback(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const next = {
      canScrollUp: element.scrollTop > scrollEdgeTolerance,
      canScrollDown: element.scrollTop < maxScrollTop - scrollEdgeTolerance,
    };
    setAvailability((current) =>
      current.canScrollUp === next.canScrollUp && current.canScrollDown === next.canScrollDown ? current : next,
    );
  }, [scrollElementRef]);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }

    updateAvailability();
    element.addEventListener("scroll", updateAvailability, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateAvailability);
    resizeObserver?.observe(element);

    return () => {
      element.removeEventListener("scroll", updateAvailability);
      resizeObserver?.disconnect();
    };
  }, [scrollElementRef, updateAvailability]);

  useEffect(() => {
    updateAvailability();
  });

  const scrollTo = (boundary: "top" | "bottom") => {
    const boundaryHandler = boundary === "top" ? onScrollToTop : onScrollToBottom;
    if (boundaryHandler) {
      boundaryHandler();
      return;
    }

    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({
      top: boundary === "top" ? 0 : element.scrollHeight,
      behavior: "smooth",
    });
  };

  return (
    <div
      role="group"
      aria-label="Scroll controls"
      className="absolute right-2 top-1/2 z-30 flex -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-[var(--ec-border-strong)] bg-[var(--ec-bg-elevated)] shadow-[var(--ec-panel-shadow)] backdrop-blur-md"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-none border-b border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-control-hover)] hover:text-[var(--ec-text)] disabled:opacity-30"
        onClick={() => scrollTo("top")}
        disabled={!availability.canScrollUp}
        title="Scroll to top"
        aria-label="Scroll to top"
      >
        <ArrowUpToLine className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-none text-[var(--ec-muted)] hover:bg-[var(--ec-control-hover)] hover:text-[var(--ec-text)] disabled:opacity-30"
        onClick={() => scrollTo("bottom")}
        disabled={!availability.canScrollDown}
        title="Scroll to bottom"
        aria-label="Scroll to bottom"
      >
        <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
};
