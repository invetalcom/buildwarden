import { afterEach, describe, expect, it, vi } from "vitest";
import { pairingCodeFromFragment } from "./lib/remote-pairing-code";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("pairingCodeFromFragment", () => {
  it("removes the one-time pairing code immediately after reading it", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        history: { replaceState },
        location: { hash: "#pair=ab%2012", pathname: "/remote", search: "?mode=pair" },
      },
    });

    expect(pairingCodeFromFragment()).toBe("AB12");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/remote?mode=pair");
  });
});
