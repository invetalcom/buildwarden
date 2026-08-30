import { describe, expect, it, vi } from "vitest";
import {
  captureVirtualPrependAnchor,
  restoreVirtualPrependAnchor,
  scrollVirtualTimelineToBoundary,
  type TimelineVirtualizer,
} from "./run-activity-scroll";

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

describe("virtual timeline history prepends", () => {
  it("restores the same visible stable key after older rows shift its index", () => {
    const anchor = captureVirtualPrependAnchor(
      ["turn-10", "turn-11", "turn-12"],
      [
        { index: 0, start: 0, end: 80 },
        { index: 1, start: 80, end: 180 },
      ],
      105,
    );
    expect(anchor).toEqual({ key: "turn-11", offsetWithinRow: 25 });

    const target = virtualizer();
    const adjustWithinRow = vi.fn();
    expect(restoreVirtualPrependAnchor(
      target,
      ["turn-0", "turn-1", "turn-10", "turn-11", "turn-12"],
      anchor!,
      adjustWithinRow,
    )).toBe(true);
    expect(target.scrollToIndex).toHaveBeenCalledWith(3, { align: "start", behavior: "auto" });
    expect(adjustWithinRow).toHaveBeenCalledWith(25);
  });
});
