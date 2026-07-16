import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteHostOrigin, pairingDetailsFromFragment } from "./remote-pairing-code";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("hosted pairing fragment", () => {
  it("reads the host and one-time code, then removes both immediately", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        history: { replaceState },
        location: {
          hash: "#host=https%3A%2F%2Fdesktop.tailnet.ts.net&pair=ab%2012",
          pathname: "/remote",
          search: "?mode=pair",
        },
      },
    });

    expect(pairingDetailsFromFragment()).toEqual({
      code: "AB12",
      hostOrigin: "https://desktop.tailnet.ts.net",
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/remote?mode=pair");
  });

  it("accepts Tailscale HTTPS and loopback development hosts only", () => {
    expect(normalizeRemoteHostOrigin("https://desktop.tailnet.ts.net/")).toBe("https://desktop.tailnet.ts.net");
    expect(normalizeRemoteHostOrigin("http://127.0.0.1:47831")).toBe("http://127.0.0.1:47831");
    expect(normalizeRemoteHostOrigin("https://example.com")).toBeNull();
    expect(normalizeRemoteHostOrigin("https://desktop.tailnet.ts.net/path")).toBeNull();
  });
});
