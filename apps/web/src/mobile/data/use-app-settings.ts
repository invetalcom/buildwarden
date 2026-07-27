import { useCallback, useState } from "react";
import { useMobileApp } from "./mobile-app-context";
import { errorMessage } from "../lib/format";

export interface AppSettingsWriter {
  /** Raw persisted value, or undefined when the key has never been written. */
  read: (key: string) => string | undefined;
  write: (key: string, value: string) => Promise<boolean>;
  /** Writes several keys as one logical change, refreshing the snapshot once at the end. */
  writeMany: (entries: ReadonlyArray<[key: string, value: string]>) => Promise<boolean>;
  saving: boolean;
  error: string | null;
  clearError: () => void;
  /** False when the paired session lacks the admin scope; every control should read this. */
  canWrite: boolean;
}

/**
 * Reads app settings straight off the snapshot and writes them through `setAppSetting`.
 *
 * The host is authoritative, so a write is followed by a snapshot refresh rather than optimistic
 * local state — settings are low-frequency, and showing a value the host rejected would be worse
 * than a brief round-trip.
 */
export const useAppSettings = (): AppSettingsWriter => {
  const { client, snapshot, snapshotStore } = useMobileApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((key: string) => snapshot.settings[key], [snapshot.settings]);

  const writeMany = useCallback(
    async (entries: ReadonlyArray<[string, string]>) => {
      setSaving(true);
      setError(null);
      try {
        for (const [key, value] of entries) {
          await client.setAppSetting(key, value);
        }
        await snapshotStore.refresh();
        return true;
      } catch (caught) {
        setError(errorMessage(caught, "The host did not accept that setting."));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client, snapshotStore],
  );

  const write = useCallback((key: string, value: string) => writeMany([[key, value]]), [writeMany]);

  return {
    read,
    write,
    writeMany,
    saving,
    error,
    clearError: () => setError(null),
    canWrite: client.capabilities.settings,
  };
};
