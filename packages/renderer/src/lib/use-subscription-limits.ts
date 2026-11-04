import { useEffect, useSyncExternalStore } from "react";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { subscriptionLimitsStore } from "./subscription-limits-store";

export function useSubscriptionLimits(client: BuildWardenClient) {
  const store = subscriptionLimitsStore(client);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, refresh: store.refresh, replaceReport: store.replaceReport };
}

export function useSubscriptionLimitsStartup(client: BuildWardenClient, providerConfigKey: string, enabled = true) {
  const store = subscriptionLimitsStore(client);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void store.initialize(providerConfigKey);
    const recheck = () => { if (!document.hidden) void store.initialize(providerConfigKey, true); };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [store, providerConfigKey, enabled]);
  return enabled && Boolean(state.installed?.length);
}
