import { useCallback, useEffect, useState } from "react";
import {
  providerCliUpdateAttentionId,
  type ProviderCliUpdateProviderType,
  type ProviderCliUpdateSnapshot,
  type ProviderCliUpdateStatus,
} from "@buildwarden/shared";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";

export const PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY = "buildwarden:provider-cli-update-toasts:v1";
const REMEMBERED_TOAST_LIMIT = 50;

const toastKey = (status: ProviderCliUpdateStatus): string | null =>
  status.latestVersion ? providerCliUpdateAttentionId(status.providerType, status.latestVersion) : null;

const readShownKeys = (): string[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
};

const writeShownKeys = (keys: string[]): void => {
  try {
    window.localStorage.setItem(PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY, JSON.stringify(keys.slice(-REMEMBERED_TOAST_LIMIT)));
  } catch {
    // Storage can be unavailable (private mode); the toast then shows again next visit.
  }
};

const isAnnounceable = (snapshot: ProviderCliUpdateSnapshot, status: ProviderCliUpdateStatus): boolean =>
  snapshot.enabled && snapshot.notify && status.announced && !status.dismissed &&
  (status.state === "update-available" || status.state === "updating");

/**
 * In-app "update available" toasts for versions a background check announced, driven by the
 * host's live update status. Each version shows once per client (desktop app or browser),
 * including releases announced while that client was closed. Manual checks never toast.
 */
export const useProviderCliUpdateToasts = (
  client: BuildWardenClient | null | undefined,
  onError: (message: string) => void,
) => {
  const [snapshot, setSnapshot] = useState<ProviderCliUpdateSnapshot | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const [updatingType, setUpdatingType] = useState<ProviderCliUpdateProviderType | null>(null);
  const active = Boolean(client && client.capabilities.settings);

  useEffect(() => {
    if (!client || !active) return;
    let disposed = false;
    const receive = (next: ProviderCliUpdateSnapshot) => {
      if (disposed) return;
      setSnapshot(next);
      const shown = readShownKeys();
      const fresh = next.providers
        .filter((status) => isAnnounceable(next, status))
        .map(toastKey)
        .filter((key): key is string => key !== null && !shown.includes(key));
      if (!fresh.length) return;
      writeShownKeys([...shown, ...fresh]);
      setVisibleKeys((current) => [...current, ...fresh.filter((key) => !current.includes(key))]);
    };
    void client.getProviderCliUpdates().then(receive).catch(() => undefined);
    const unsubscribe = client.onProviderCliUpdatesChanged(receive);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, client]);

  // Toasts follow the live status: they reflect in-use changes and close once the CLI is current.
  const toasts = snapshot
    ? snapshot.providers.filter((status) => {
      const key = toastKey(status);
      return key !== null && visibleKeys.includes(key) && isAnnounceable(snapshot, status);
    })
    : [];

  const dismiss = useCallback((providerType: ProviderCliUpdateProviderType) => {
    setVisibleKeys((current) => current.filter((key) => !key.startsWith(providerCliUpdateAttentionId(providerType, ""))));
  }, []);

  const update = useCallback(async (providerType: ProviderCliUpdateProviderType) => {
    if (!client) return;
    setUpdatingType(providerType);
    try {
      await client.runProviderCliUpdate(providerType);
      dismiss(providerType);
    } catch (error) {
      onError(formatAppErrorMessage(error, "The update failed."));
    } finally {
      setUpdatingType(null);
    }
  }, [client, dismiss, onError]);

  return { toasts, updatingType, dismiss, update };
};
