import { useCallback } from "react";
import type { AppSnapshot, DeepLinkTarget } from "@buildwarden/shared";
import { useBuildWardenClient } from "./buildwarden-client";
import { resolveDeepLink, type DeepLinkLookup, type ResolvedDeepLink } from "./deep-links";
import { useInstanceContext } from "./instance-context";
import { useLatestRef } from "./use-latest-ref";

/** A browser may open a link before every paired host has connected; wait a little for the rest. */
const SETTLE_RETRY_DELAY_MS = 1_500;
const SETTLE_RETRY_ATTEMPTS = 6;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Resolves a link target against the current snapshot and hosts. The desktop app asks its own
 * host; the browser asks every connected instance, because a link carries no instance.
 */
export const useResolveDeepLink = (snapshot: Pick<AppSnapshot, "projects" | "chats">) => {
  const client = useBuildWardenClient();
  const instanceContext = useInstanceContext();
  const latest = useLatestRef({ client, instanceContext, snapshot });

  return useCallback(async (target: DeepLinkTarget): Promise<ResolvedDeepLink | null> => {
    for (let attempt = 0; ; attempt += 1) {
      const { client: current, instanceContext: instances, snapshot: currentSnapshot } = latest.current;
      const lookups: readonly DeepLinkLookup[] = instances
        ? instances.deepLinkLookups?.() ?? []
        : [{ client: current, scope: (id) => id }];
      const resolved = await resolveDeepLink(target, { snapshot: currentSnapshot, lookups });
      if (resolved) return resolved;
      const settling = instances?.instances.some((entry) => entry.status === "connecting") ?? false;
      if (!settling || attempt >= SETTLE_RETRY_ATTEMPTS) return null;
      await wait(SETTLE_RETRY_DELAY_MS);
    }
  }, [latest]);
};
