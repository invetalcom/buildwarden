import { useEffect } from "react";
import { parseDeepLinkHash, type DeepLinkTarget } from "@buildwarden/shared";
import { useBuildWardenClient } from "./buildwarden-client";
import { useLatestRef } from "./use-latest-ref";

/**
 * Feeds incoming links to `onTarget` once `enabled` (after the first snapshot, so startup selection
 * restore cannot overwrite the link's page).
 *
 * - Desktop: the main process holds links the OS delivered; pull on mount and whenever it pings.
 * - Browser: links arrive as a `#/run/…` route in the page URL, at load or pasted into the tab.
 */
export const useDeepLinkSources = ({ enabled, onTarget }: { enabled: boolean; onTarget: (target: DeepLinkTarget) => void }) => {
  const client = useBuildWardenClient();
  const onTargetRef = useLatestRef(onTarget);
  // The browser swaps clients when the active instance changes; links are not instance-bound.
  const clientRef = useLatestRef(client);
  const platform = client.capabilities.platform;

  useEffect(() => {
    if (!enabled) return;
    if (platform === "electron") {
      // Not cancelled on cleanup: the main process already cleared the link, so dropping it would lose it.
      const pull = () => {
        void clientRef.current.consumePendingDeepLink()
          .then((payload) => { if (payload) onTargetRef.current(payload.target); })
          .catch(() => undefined);
      };
      const unsubscribe = clientRef.current.onDeepLinkReceived(pull);
      pull();
      return unsubscribe;
    }
    const fromHash = () => {
      const target = parseDeepLinkHash(window.location.hash);
      if (!target) return;
      // This UI keeps navigation in state, not the URL; drop the route so a reload does not reopen it.
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
      onTargetRef.current(target);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [enabled, platform, clientRef, onTargetRef]);
};
