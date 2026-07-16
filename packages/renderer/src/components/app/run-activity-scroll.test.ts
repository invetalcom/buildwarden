import { describe, expect, it, vi } from "vitest";
import { scrollVirtualTimelineToBoundary, type TimelineVirtualizer } from "./run-activity-scroll";

const virtualizer = (): TimelineVirtualizer => ({
  scrollToIndex: vi.fn(),
  scrollToEnd: vi.fn(),
});

describe("virtual timeline boundary scrolling", () => {
  it("routes top jumps through the virtualizer without smooth scrolling", () => {
    const target = virtualizer();

    scrollVirtualTimelineToBoundary(target, "top");

    expect(target.scrollToIndex).toHaveBeenCalledWith(0, { align: "start", behavior: "auto" });
    expect(target.scrollToEnd).not.toHaveBeenCalled();
  });

  it("routes bottom jumps through the virtualizer without smooth scrolling", () => {
    const target = virtualizer();

    scrollVirtualTimelineToBoundary(target, "bottom");

    expect(target.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
    expect(target.scrollToIndex).not.toHaveBeenCalled();
  });
});
