/**
 * Deep links to runs, chats, and projects.
 *
 * Two spellings carry the same target:
 * - `buildwarden://run/<runId>[/<segment>]` opens the desktop app through the OS URL handler.
 * - `<web origin>/#/run/<runId>[/<segment>]` opens the browser UI. The hash form matches the mobile
 *   router so one link works in both web shells.
 *
 * Links only ever navigate. They never start work, carry prompts, or change state, because anyone can
 * put a link in front of the user. IDs in a link are host-local transport IDs (UUIDs), never the
 * instance-scoped IDs the web client uses internally.
 */

export const DEEP_LINK_SCHEME = "buildwarden";
/** Development builds register their own scheme so they never take links meant for the installed app. */
export const DEV_DEEP_LINK_SCHEME = "buildwarden-dev";

const DEEP_LINK_RUN_SEGMENTS = ["activity", "agents", "validation", "diff", "terminal", "browser", "processes", "notes", "chat", "pull-request", "files"] as const;
export type DeepLinkRunSegment = (typeof DEEP_LINK_RUN_SEGMENTS)[number];

export type DeepLinkTarget =
  | { kind: "run"; runId: string; segment?: DeepLinkRunSegment }
  | { kind: "chat"; chatId: string }
  | { kind: "project"; projectId: string };

/** Payload main sends to the renderer when the OS hands the app a link. */
export interface DeepLinkOpenedPayload {
  target: DeepLinkTarget;
  url: string;
}

const MAX_DEEP_LINK_LENGTH = 2048;
/** Entity IDs are UUIDs today; this also admits older or imported IDs without allowing separators or markup. */
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const isDeepLinkRunSegment = (value: string): value is DeepLinkRunSegment =>
  (DEEP_LINK_RUN_SEGMENTS as readonly string[]).includes(value);

const isDeepLinkEntityId = (value: string): boolean => ENTITY_ID_PATTERN.test(value);

const decodeSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** Parses path segments such as `["run", "<id>", "diff"]`. Unknown kinds and malformed IDs return null. */
const parseDeepLinkPath = (rawSegments: readonly string[]): DeepLinkTarget | null => {
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (!raw) continue;
    const decoded = decodeSegment(raw);
    if (decoded === null) return null;
    segments.push(decoded);
  }
  const [kind, id, extra, ...rest] = segments;
  if (!kind || !id || !isDeepLinkEntityId(id) || rest.length > 0) return null;
  switch (kind.toLowerCase()) {
    case "run":
      if (extra === undefined) return { kind: "run", runId: id };
      return isDeepLinkRunSegment(extra) ? { kind: "run", runId: id, segment: extra } : { kind: "run", runId: id };
    case "chat":
      return extra === undefined ? { kind: "chat", chatId: id } : null;
    case "project":
      return extra === undefined ? { kind: "project", projectId: id } : null;
    default:
      return null;
  }
};

/**
 * Parses `buildwarden://…` (or the dev scheme when allowed). Hostnames are case-insensitive in URL
 * parsers, so `buildwarden://run/<id>` puts the kind in the host and the ID in the path; both
 * `buildwarden://run/<id>` and `buildwarden:///run/<id>` are accepted.
 */
export const parseDeepLinkUrl = (
  value: string,
  options: { schemes?: readonly string[] } = {},
): DeepLinkTarget | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DEEP_LINK_LENGTH) return null;
  const trimmed = value.trim();
  const separator = trimmed.indexOf("://");
  if (separator <= 0) return null;
  const scheme = trimmed.slice(0, separator).toLowerCase();
  const schemes = options.schemes ?? [DEEP_LINK_SCHEME];
  if (!schemes.includes(scheme)) return null;
  // Query strings and fragments are ignored: links never carry parameters.
  const rest = trimmed.slice(separator + 3).split(/[?#]/, 1)[0] ?? "";
  return parseDeepLinkPath(rest.split("/"));
};

/** Parses a web hash such as `#/run/<id>/diff`. Pairing fragments (`#pair=…`) and other hashes return null. */
export const parseDeepLinkHash = (hash: string): DeepLinkTarget | null => {
  if (typeof hash !== "string" || hash.length > MAX_DEEP_LINK_LENGTH) return null;
  const path = hash.replace(/^#/, "");
  if (!path.startsWith("/")) return null;
  return parseDeepLinkPath(path.split(/[?]/, 1)[0]!.split("/"));
};

/** The path both link forms share, e.g. `run/<id>/diff`. */
const deepLinkPath = (target: DeepLinkTarget): string => {
  switch (target.kind) {
    case "run":
      return `run/${encodeURIComponent(target.runId)}${target.segment ? `/${target.segment}` : ""}`;
    case "chat":
      return `chat/${encodeURIComponent(target.chatId)}`;
    case "project":
      return `project/${encodeURIComponent(target.projectId)}`;
  }
};

export const buildDeepLinkUrl = (target: DeepLinkTarget, scheme: string = DEEP_LINK_SCHEME): string =>
  `${scheme}://${deepLinkPath(target)}`;

/** Builds a browser link. `base` is the page URL without its hash, e.g. `https://host:7777/`. */
export const buildWebDeepLinkUrl = (target: DeepLinkTarget, base: string): string =>
  `${base.split("#", 1)[0]}#/${deepLinkPath(target)}`;

/**
 * Finds a deep link among process arguments. Windows and Linux start a second process with the URL
 * somewhere among Chromium switches, so the position is not fixed.
 */
export const findDeepLinkInArgv = (
  argv: readonly string[],
  schemes: readonly string[] = [DEEP_LINK_SCHEME],
): { url: string; target: DeepLinkTarget } | null => {
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.startsWith("--")) continue;
    const target = parseDeepLinkUrl(arg, { schemes });
    if (target) return { url: arg, target };
  }
  return null;
};
