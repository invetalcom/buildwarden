import { EventEmitter } from "node:events";
import type { App } from "electron";
import { describe, expect, it, vi } from "vitest";
import { bufferEarlyOpenUrls, takeEarlyOpenUrls } from "./early-open-url";

const fakeApp = () => new EventEmitter() as unknown as App & EventEmitter;

describe("early open-url buffering", () => {
  it("keeps links macOS delivers before the main module listens, then hands them over once", () => {
    const app = fakeApp();
    bufferEarlyOpenUrls(app);
    const first = { preventDefault: vi.fn() };
    app.emit("open-url", first, "buildwarden://run/a");
    app.emit("open-url", { preventDefault: vi.fn() }, "buildwarden://chat/b");

    expect(first.preventDefault).toHaveBeenCalled();
    expect(takeEarlyOpenUrls(app)).toEqual(["buildwarden://run/a", "buildwarden://chat/b"]);
    expect(app.listenerCount("open-url")).toBe(0);
    expect(takeEarlyOpenUrls(app)).toEqual([]);
  });
});
