import type { ProviderType } from "./index";

/** Local CLI providers whose installed version BuildWarden can compare against a published release. */
export const PROVIDER_CLI_UPDATE_PROVIDER_TYPES = ["claude-code", "codex-cli", "cursor-agent"] as const satisfies readonly ProviderType[];

export type ProviderCliUpdateProviderType = (typeof PROVIDER_CLI_UPDATE_PROVIDER_TYPES)[number];

export const PROVIDER_CLI_LABELS: Record<ProviderCliUpdateProviderType, string> = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  "cursor-agent": "Cursor Agent",
};

export const isProviderCliUpdateProviderType = (value: unknown): value is ProviderCliUpdateProviderType =>
  typeof value === "string" && (PROVIDER_CLI_UPDATE_PROVIDER_TYPES as readonly string[]).includes(value);

/**
 * Stored under `APP_SETTING_KEYS.providerCliUpdates`. Checks are opt-in: while
 * `enabled` is false BuildWarden sends no version requests and runs no updaters.
 */
export interface ProviderCliUpdateSettings {
  enabled: boolean;
  /** Show a desktop notification once per newly published version. */
  notify: boolean;
}

export const parseProviderCliUpdateSettings = (value?: string): ProviderCliUpdateSettings => {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? "{}"); } catch { parsed = {}; }
  const settings = parsed && typeof parsed === "object" ? parsed as Partial<ProviderCliUpdateSettings> : {};
  return { enabled: settings.enabled === true, notify: settings.notify !== false };
};

export const serializeProviderCliUpdateSettings = (settings: ProviderCliUpdateSettings): string =>
  JSON.stringify({ enabled: settings.enabled === true, notify: settings.notify !== false });

/**
 * How the CLI was installed. Package managers are used only when the executable's
 * real path proves they own it; otherwise the CLI's own updater runs.
 */
export type ProviderCliInstallMethod =
  | "npm" | "pnpm" | "bun" | "yarn" | "volta" | "homebrew" | "native" | "self-updater" | "mise" | "winget" | "unknown";

export const PROVIDER_CLI_INSTALL_METHOD_LABELS: Record<ProviderCliInstallMethod, string> = {
  npm: "npm", pnpm: "pnpm", bun: "Bun", yarn: "Yarn", volta: "Volta", homebrew: "Homebrew", native: "Native installer",
  "self-updater": "CLI updater", mise: "mise", winget: "winget", unknown: "Unknown",
};

export type ProviderCliUpdateState =
  | "checking" | "current" | "update-available" | "updating" | "not-installed" | "unknown" | "error";

export interface ProviderCliUpdateStatus {
  providerType: ProviderCliUpdateProviderType;
  label: string;
  binaryPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  state: ProviderCliUpdateState;
  installMethod: ProviderCliInstallMethod;
  /** Command BuildWarden runs, or that the user can run in a terminal when updates are manual. */
  updateCommand: string | null;
  /** False for manual-only installs (mise, winget, folders BuildWarden cannot write to). */
  canAutoUpdate: boolean;
  manualReason: string | null;
  /** Active runs or chats use this CLI; updates wait until they finish. */
  inUse: boolean;
  /** The inbox notice for `latestVersion` was dismissed. */
  dismissed: boolean;
  message: string | null;
  checkedAt: string | null;
}

export interface ProviderCliUpdateSnapshot {
  enabled: boolean;
  notify: boolean;
  checking: boolean;
  lastCheckedAt: string | null;
  providers: ProviderCliUpdateStatus[];
}

export const PROVIDER_CLI_UPDATE_ATTENTION_PREFIX = "provider-update:";

/** Keyed by version so dismissing one release does not hide the next one. */
export const providerCliUpdateAttentionId = (providerType: ProviderCliUpdateProviderType, latestVersion: string): string =>
  `${PROVIDER_CLI_UPDATE_ATTENTION_PREFIX}${providerType}:${latestVersion}`;

export const isProviderCliUpdateAttentionId = (id: string): boolean => id.startsWith(PROVIDER_CLI_UPDATE_ATTENTION_PREFIX);

const versionParts = (version: string): { numbers: number[]; prerelease: string } | null => {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;
  return { numbers: match[1].split(".").map(Number), prerelease: match[2] ?? "" };
};

/**
 * Compares semver (`2.1.303`) and Cursor's date versions (`2026.10.18-ea085cb`) by their
 * numeric segments. A semver prerelease sorts before its release; Cursor build hashes are
 * not ordered, so equal dates compare equal. Unparseable input compares equal.
 */
export const compareProviderCliVersions = (left: string, right: string): number => {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const isHash = (value: string) => /^[0-9a-f]{6,}$/i.test(value);
  if (a.prerelease === b.prerelease || isHash(a.prerelease) || isHash(b.prerelease)) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
};

export const createDisabledProviderCliUpdateSnapshot = (): ProviderCliUpdateSnapshot => ({
  enabled: false, notify: true, checking: false, lastCheckedAt: null, providers: [],
});
