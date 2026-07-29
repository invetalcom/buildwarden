/**
 * Chooses which UI shell the browser entry mounts: the desktop remote UI (`RemoteWebApp`) or the
 * mobile UI (`mobile/MobileWebApp`).
 *
 * Both shells live behind one `index.html`. A path-based mobile route is deliberately avoided:
 * the desktop host serves the embedded build with `serveStaticAsset`, which resolves real files
 * only and 404s unknown paths, so `/m` would break exactly in the phone-over-Tailscale case that
 * matters most.
 *
 * Precedence:
 *   1. `?ui=mobile|desktop` — pins the choice, `?ui=auto` clears the pin
 *   2. the stored pin
 *   3. viewport / pointer heuristics ({@link MOBILE_MEDIA_QUERY})
 *   4. desktop
 */

export type ShellKind = "mobile" | "desktop";
export type ShellPreference = ShellKind | "auto";

export const SHELL_STORAGE_KEY = "buildwarden.web.shell";
export const SHELL_QUERY_PARAM = "ui";

/**
 * Phone-width screens, plus touch screens up to tablet width so iPadOS "Request desktop site"
 * (which reports a desktop user agent at 1024px) still lands on the touch UI. Deliberately no
 * user-agent sniffing.
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 820px), (pointer: coarse) and (max-width: 1180px)";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ShellWindowLike {
  localStorage?: StorageLike | null;
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { maxTouchPoints?: number };
  innerWidth?: number;
  location: { search: string; pathname: string; hash: string };
  history?: { replaceState: (data: unknown, unused: string, url: string) => void };
}

const isShellPreference = (value: string | null | undefined): value is ShellPreference =>
  value === "mobile" || value === "desktop" || value === "auto";

/** Reads `?ui=` from a query string. Returns null when absent or not a known value. */
export const readShellOverride = (search: string): ShellPreference | null => {
  const raw = new URLSearchParams(search).get(SHELL_QUERY_PARAM)?.trim().toLowerCase();
  return isShellPreference(raw) ? raw : null;
};

export const readStoredShellPreference = (storage: StorageLike | null | undefined): ShellKind | null => {
  try {
    const raw = storage?.getItem(SHELL_STORAGE_KEY);
    return raw === "mobile" || raw === "desktop" ? raw : null;
  } catch {
    return null;
  }
};

export const writeStoredShellPreference = (storage: StorageLike | null | undefined, preference: ShellPreference): void => {
  try {
    if (preference === "auto") {
      storage?.removeItem(SHELL_STORAGE_KEY);
    } else {
      storage?.setItem(SHELL_STORAGE_KEY, preference);
    }
  } catch {
    // Private-mode browsers can refuse storage; the heuristic still works, it just will not stick.
  }
};

/** True when the viewport or pointer looks like a phone / touch tablet. */
export const matchesMobileViewport = (win: ShellWindowLike): boolean => {
  const matchMedia = win.matchMedia?.bind(win);
  if (matchMedia) {
    return matchMedia(MOBILE_MEDIA_QUERY).matches;
  }
  const width = win.innerWidth ?? Number.POSITIVE_INFINITY;
  const touch = (win.navigator?.maxTouchPoints ?? 0) > 1;
  return width <= 820 || (touch && width <= 1180);
};

export interface ResolveShellInput {
  override: ShellPreference | null;
  stored: ShellKind | null;
  mobileViewport: boolean;
}

/** Pure precedence resolution; {@link selectShell} adds the browser IO around it. */
export const resolveShell = ({ override, stored, mobileViewport }: ResolveShellInput): ShellKind => {
  if (override === "mobile" || override === "desktop") {
    return override;
  }
  if (override !== "auto" && stored) {
    return stored;
  }
  return mobileViewport ? "mobile" : "desktop";
};

/**
 * Removes `?ui=` once it has been applied so the pin lives in storage rather than in every shared
 * link. Other query parameters are preserved, as is the hash — the hosted pairing deep link
 * (`#pair=…&host=…`) is consumed later by `pairingDetailsFromFragment`.
 */
const stripShellOverrideFromUrl = (win: ShellWindowLike): void => {
  const params = new URLSearchParams(win.location.search);
  if (!params.has(SHELL_QUERY_PARAM)) {
    return;
  }
  params.delete(SHELL_QUERY_PARAM);
  const query = params.toString();
  win.history?.replaceState(null, "", `${win.location.pathname}${query ? `?${query}` : ""}${win.location.hash}`);
};

/**
 * Reading the `localStorage` property itself throws `SecurityError` when the browser blocks site
 * data (cookies off, opaque origin, some private modes) — before any of the guarded getItem /
 * setItem calls below can run. Without this the whole app fails to boot for those users.
 */
const storageOf = (win: { localStorage?: StorageLike | null }): StorageLike | null => {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
};

export const selectShell = (win: ShellWindowLike): ShellKind => {
  const override = readShellOverride(win.location.search);
  const storage = storageOf(win);
  if (override) {
    writeStoredShellPreference(storage, override);
  }
  const shell = resolveShell({
    override,
    stored: readStoredShellPreference(storage),
    mobileViewport: matchesMobileViewport(win),
  });
  if (override) {
    stripShellOverrideFromUrl(win);
  }
  return shell;
};

/** Navigates to the other shell. A reload is intentional: the session survives in IndexedDB. */
export const switchShell = (win: Window, preference: ShellPreference): void => {
  writeStoredShellPreference(storageOf(win), preference);
  win.location.reload();
};
