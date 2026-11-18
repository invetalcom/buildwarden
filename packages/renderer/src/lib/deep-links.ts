import {
  buildDeepLinkUrl,
  buildWebDeepLinkUrl,
  DEEP_LINK_SCHEME,
  DEV_DEEP_LINK_SCHEME,
  parseDeepLinkHash,
  parseDeepLinkUrl,
  type AppSnapshot,
  type DeepLinkRunSegment,
  type DeepLinkTarget,
} from "@buildwarden/shared";
import { createContext, useContext } from "react";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { parseScopedId } from "./instance-identity";

/** A link target expressed in this UI's IDs (instance-scoped in the browser, plain on the desktop). */
export type ResolvedDeepLink =
  | { kind: "run"; runId: string; projectId: string; segment?: DeepLinkRunSegment }
  | { kind: "chat"; chatId: string }
  | { kind: "project"; projectId: string };

/** One host that may own a link's ID, plus how this UI names that host's IDs. */
export interface DeepLinkLookup {
  client: Pick<BuildWardenClient, "getRunDetail" | "getChatDetail">;
  scope: (id: string) => string;
}

type DeepLinkSnapshot = Pick<AppSnapshot, "projects" | "chats">;

/** Links carry host-local IDs; the browser UI prefixes them with their instance. */
export const rawEntityId = (id: string): string => parseScopedId(id)?.id ?? id;
const matchesRawId = (id: string, raw: string): boolean => id === raw || parseScopedId(id)?.id === raw;

const findRunInSnapshot = (snapshot: DeepLinkSnapshot, raw: string): { id: string; projectId: string } | null => {
  for (const entry of snapshot.projects) {
    for (const list of [entry.activeRuns, entry.recentRuns, entry.runs, entry.forLaterRuns, entry.orchestratedRuns]) {
      const run = list?.find((candidate) => matchesRawId(candidate.id, raw));
      if (run) return { id: run.id, projectId: run.projectId };
    }
  }
  return null;
};

/** Matches the remote client's background-read budget. */
export const DEEP_LINK_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Gives up on a lookup after the deadline. Detail requests take no abort signal, so a host that
 * never answers keeps its request open, but it can no longer hold the link open.
 */
const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lookup timed out.")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });

const firstFound = async <T>(lookups: readonly DeepLinkLookup[], find: (lookup: DeepLinkLookup) => Promise<T>): Promise<T | null> => {
  if (lookups.length === 0) return null;
  try {
    return await Promise.any(lookups.map((lookup) => withDeadline(find(lookup), DEEP_LINK_LOOKUP_TIMEOUT_MS)));
  } catch {
    return null;
  }
};

/**
 * Finds what a link points at. The loaded snapshot answers most links without a request; anything
 * older is asked of each host, and the first host that knows the ID wins (IDs are UUIDs).
 */
export const resolveDeepLink = async (
  target: DeepLinkTarget,
  { snapshot, lookups }: { snapshot: DeepLinkSnapshot; lookups: readonly DeepLinkLookup[] },
): Promise<ResolvedDeepLink | null> => {
  switch (target.kind) {
    case "run": {
      const segment = target.segment ? { segment: target.segment } : {};
      const known = findRunInSnapshot(snapshot, target.runId);
      if (known) return { kind: "run", runId: known.id, projectId: known.projectId, ...segment };
      return firstFound(lookups, async ({ client, scope }) => {
        const detail = await client.getRunDetail(target.runId);
        return { kind: "run" as const, runId: scope(detail.run.id), projectId: scope(detail.run.projectId), ...segment };
      });
    }
    case "chat": {
      const known = snapshot.chats.find((chat) => matchesRawId(chat.id, target.chatId));
      if (known) return { kind: "chat", chatId: known.id };
      return firstFound(lookups, async ({ client, scope }) => {
        const detail = await client.getChatDetail(target.chatId);
        return { kind: "chat" as const, chatId: scope(detail.chat.id) };
      });
    }
    case "project": {
      const known = snapshot.projects.find((entry) => matchesRawId(entry.project.id, target.projectId));
      return known ? { kind: "project", projectId: known.project.id } : null;
    }
  }
};

export const deepLinkTargetFor = (kind: "run" | "chat" | "project", id: string): DeepLinkTarget => {
  const raw = rawEntityId(id);
  if (kind === "run") return { kind, runId: raw };
  if (kind === "chat") return { kind, chatId: raw };
  return { kind, projectId: raw };
};

const desktopScheme = (): string => (import.meta.env.DEV ? DEV_DEEP_LINK_SCHEME : DEEP_LINK_SCHEME);

/**
 * The link to share: `buildwarden://…` from the desktop app, or this page's address with a
 * `#/run/…` route from a browser, which opens in either web shell.
 */
export const shareableDeepLink = (target: DeepLinkTarget, platform: "electron" | "web", pageUrl?: string): string =>
  platform === "electron"
    ? buildDeepLinkUrl(target, desktopScheme())
    : buildWebDeepLinkUrl(target, pageUrl ?? window.location.href);

/** Recognizes links to this app in rendered content: either scheme, or this page with a `#/…` route. */
export const deepLinkTargetFromHref = (href: string | null | undefined, pageOrigin?: string): DeepLinkTarget | null => {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith("#/")) return parseDeepLinkHash(trimmed);
  const viaScheme = parseDeepLinkUrl(trimmed, { schemes: [DEEP_LINK_SCHEME, DEV_DEEP_LINK_SCHEME] });
  if (viaScheme) return viaScheme;
  const origin = pageOrigin ?? (typeof window === "undefined" ? undefined : window.location.origin);
  if (!origin || !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.origin === origin && url.hash ? parseDeepLinkHash(url.hash) : null;
  } catch {
    return null;
  }
};

/** Opens a link target inside the current UI. Absent outside an app shell (e.g. isolated previews). */
export const DeepLinkNavigationContext = createContext<((target: DeepLinkTarget) => void) | null>(null);
export const useDeepLinkNavigation = () => useContext(DeepLinkNavigationContext);
