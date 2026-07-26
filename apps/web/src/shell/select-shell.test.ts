import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_MEDIA_QUERY,
  SHELL_STORAGE_KEY,
  matchesMobileViewport,
  readShellOverride,
  resolveShell,
  selectShell,
  type ShellWindowLike,
} from "./select-shell";

const createStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

const createWindow = (
  overrides: {
    search?: string;
    hash?: string;
    pathname?: string;
    storage?: ReturnType<typeof createStorage> | null;
    mobileViewport?: boolean;
    replaceState?: (data: unknown, unused: string, url: string) => void;
  } = {},
): ShellWindowLike => ({
  localStorage: overrides.storage === null ? null : overrides.storage ?? createStorage(),
  matchMedia: (query: string) => ({ matches: query === MOBILE_MEDIA_QUERY && (overrides.mobileViewport ?? false) }),
  location: { search: overrides.search ?? "", pathname: overrides.pathname ?? "/", hash: overrides.hash ?? "" },
  history: { replaceState: overrides.replaceState ?? (() => undefined) },
});

describe("readShellOverride", () => {
  it("reads the known preferences and ignores anything else", () => {
    expect(readShellOverride("?ui=mobile")).toBe("mobile");
    expect(readShellOverride("?ui=DESKTOP")).toBe("desktop");
    expect(readShellOverride("?ui=auto")).toBe("auto");
    expect(readShellOverride("?ui=tablet")).toBeNull();
    expect(readShellOverride("")).toBeNull();
  });
});

describe("resolveShell", () => {
  it("prefers an explicit override over the stored pin and the viewport", () => {
    expect(resolveShell({ override: "desktop", stored: "mobile", mobileViewport: true })).toBe("desktop");
    expect(resolveShell({ override: "mobile", stored: "desktop", mobileViewport: false })).toBe("mobile");
  });

  it("prefers the stored pin over the viewport", () => {
    expect(resolveShell({ override: null, stored: "desktop", mobileViewport: true })).toBe("desktop");
    expect(resolveShell({ override: null, stored: "mobile", mobileViewport: false })).toBe("mobile");
  });

  it("lets ?ui=auto discard the stored pin and fall back to the viewport", () => {
    expect(resolveShell({ override: "auto", stored: "desktop", mobileViewport: true })).toBe("mobile");
    expect(resolveShell({ override: "auto", stored: "mobile", mobileViewport: false })).toBe("desktop");
  });

  it("defaults to desktop when nothing indicates a touch device", () => {
    expect(resolveShell({ override: null, stored: null, mobileViewport: false })).toBe("desktop");
    expect(resolveShell({ override: null, stored: null, mobileViewport: true })).toBe("mobile");
  });
});

describe("matchesMobileViewport", () => {
  it("uses the media query when available", () => {
    expect(matchesMobileViewport(createWindow({ mobileViewport: true }))).toBe(true);
    expect(matchesMobileViewport(createWindow({ mobileViewport: false }))).toBe(false);
  });

  it("falls back to width and touch points when matchMedia is missing", () => {
    const narrow: ShellWindowLike = { innerWidth: 400, location: { search: "", pathname: "/", hash: "" } };
    const wideTouch: ShellWindowLike = {
      innerWidth: 1024,
      navigator: { maxTouchPoints: 5 },
      location: { search: "", pathname: "/", hash: "" },
    };
    const wideMouse: ShellWindowLike = {
      innerWidth: 1600,
      navigator: { maxTouchPoints: 0 },
      location: { search: "", pathname: "/", hash: "" },
    };
    expect(matchesMobileViewport(narrow)).toBe(true);
    expect(matchesMobileViewport(wideTouch)).toBe(true);
    expect(matchesMobileViewport(wideMouse)).toBe(false);
  });
});

describe("selectShell", () => {
  it("persists an explicit override and strips it from the URL", () => {
    const storage = createStorage();
    const replaceState = vi.fn();
    const win = createWindow({ search: "?ui=mobile", pathname: "/remote", storage, replaceState });

    expect(selectShell(win)).toBe("mobile");
    expect(storage.map.get(SHELL_STORAGE_KEY)).toBe("mobile");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/remote");
  });

  it("keeps other query parameters and the pairing fragment intact", () => {
    const replaceState = vi.fn();
    const win = createWindow({
      search: "?ui=mobile&mode=pair",
      hash: "#host=https%3A%2F%2Fdesktop.tailnet.ts.net&pair=AB12",
      pathname: "/remote",
      replaceState,
    });

    expect(selectShell(win)).toBe("mobile");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/remote?mode=pair#host=https%3A%2F%2Fdesktop.tailnet.ts.net&pair=AB12",
    );
  });

  it("clears the pin on ?ui=auto and re-reads the viewport", () => {
    const storage = createStorage({ [SHELL_STORAGE_KEY]: "desktop" });
    const win = createWindow({ search: "?ui=auto", storage, mobileViewport: true });

    expect(selectShell(win)).toBe("mobile");
    expect(storage.map.has(SHELL_STORAGE_KEY)).toBe(false);
  });

  it("survives storage being unavailable", () => {
    const win = createWindow({ search: "?ui=mobile", storage: null });
    expect(selectShell(win)).toBe("mobile");
  });

  it("does not touch history when no override is present", () => {
    const replaceState = vi.fn();
    const win = createWindow({ search: "?mode=pair", mobileViewport: true, replaceState });

    expect(selectShell(win)).toBe("mobile");
    expect(replaceState).not.toHaveBeenCalled();
  });
});
