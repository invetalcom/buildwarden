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
