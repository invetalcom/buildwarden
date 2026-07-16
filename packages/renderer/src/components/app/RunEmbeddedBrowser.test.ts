import { describe, expect, it } from "vitest";
import { mapRunBrowserFramePoint } from "./run-browser-coordinate-mapping";

describe("remote run browser coordinate mapping", () => {
  it("maps the rendered JPEG to source-frame coordinates", () => {
    expect(mapRunBrowserFramePoint(
      330,
      220,
      { left: 10, top: 20, width: 640, height: 400 },
      { width: 1_280, height: 800 },
    )).toEqual({ x: 640, y: 400 });
  });

  it("accounts for object-contain letterboxing and ignores input outside the frame", () => {
    const bounds = { left: 0, top: 0, width: 1_000, height: 1_000 };
    const frame = { width: 1_000, height: 500 };

    expect(mapRunBrowserFramePoint(500, 500, bounds, frame)).toEqual({ x: 500, y: 250 });
    expect(mapRunBrowserFramePoint(500, 100, bounds, frame)).toBeNull();
  });
});
