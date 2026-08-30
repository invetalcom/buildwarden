export type TimelineScrollBoundary = "top" | "bottom";

type VirtualScrollBehavior = ScrollBehavior | "instant";

export type TimelineVirtualizer = {
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: VirtualScrollBehavior;
    },
  ) => void;
  scrollToEnd: (options?: { behavior?: VirtualScrollBehavior }) => void;
};

export type VirtualPrependAnchor = { key: string; offsetWithinRow: number };

export const captureVirtualPrependAnchor = (
  itemKeys: readonly string[],
  virtualItems: readonly { index: number; start: number; end: number }[],
  scrollTop: number,
): VirtualPrependAnchor | null => {
  const firstVisible = virtualItems.find((item) => item.end > scrollTop);
  const key = firstVisible ? itemKeys[firstVisible.index] : undefined;
  return firstVisible && key ? { key, offsetWithinRow: scrollTop - firstVisible.start } : null;
};

export const restoreVirtualPrependAnchor = (
  virtualizer: TimelineVirtualizer,
  itemKeys: readonly string[],
  anchor: VirtualPrependAnchor,
  adjustWithinRow: (offset: number) => void,
): boolean => {
  const nextIndex = itemKeys.indexOf(anchor.key);
  if (nextIndex < 0) return false;
  virtualizer.scrollToIndex(nextIndex, { align: "start", behavior: "auto" });
  adjustWithinRow(anchor.offsetWithinRow);
  return true;
};

export const scrollVirtualTimelineToBoundary = (
  virtualizer: TimelineVirtualizer,
  boundary: TimelineScrollBoundary,
) => {
  if (boundary === "top") {
    virtualizer.scrollToIndex(0, { align: "start", behavior: "auto" });
    return;
  }
  virtualizer.scrollToEnd({ behavior: "auto" });
};
