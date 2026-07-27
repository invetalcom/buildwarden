import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxyProtocol,
  type NetworkProxySettingsSnapshot,
} from "@buildwarden/shared";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage } from "../../lib/format";
import { SelectRow, SettingGroup, TextRow, ToggleRow } from "../../components/SettingControls";
import { Button, CenteredSpinner, InlineError, Input } from "../../components/primitives";

const PROTOCOLS: ReadonlyArray<{ value: NetworkProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP proxy" },
  { value: "https", label: "HTTPS proxy" },
];

/**
 * Outbound proxy configuration for the host.
 *
 * The password is write-only: the host reports whether one is stored (`hasPassword`) but never
 * returns it, so the field stays blank and an empty value leaves the saved password alone.
 */
export const NetworkSection = () => {
  const { client } = useMobileApp();
  const action = useAction();
  const [snapshot, setSnapshot] = useState<NetworkProxySettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshot(await client.getNetworkProxySettings());
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorMessage(caught, "Could not read the proxy settings."));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = client.capabilities.settings;

  const save = async (patch: Partial<NetworkProxySettingsSnapshot>, options: { password?: string; clear?: boolean } = {}) => {
    const base = snapshot ?? { ...DEFAULT_NETWORK_PROXY_SETTINGS, hasPassword: false };
    const next = { ...base, ...patch };
    const saved = await action.run(
      () =>
        client.saveNetworkProxySettings({
          enabled: next.enabled,
          protocol: next.protocol,
          host: next.host,
          port: next.port,
          username: next.username,
          ...(options.password ? { password: options.password } : {}),
          ...(options.clear ? { clearSavedPassword: true } : {}),
        }),
      "The host rejected the proxy settings.",
    );
    if (saved) {
      setSnapshot(saved);
      setPassword("");
      setClearPassword(false);
    }
  };

  if (loadError) return <InlineError message={loadError} onRetry={() => void load()} />;
  if (!snapshot) return <CenteredSpinner label="Loading network settings" />;

  const disabled = !canEdit || action.busy;

  return (
    <>
      {action.error ? <InlineError message={action.error} /> : null}
      {!canEdit ? (
        <p className="px-4 pt-3 text-[11px] leading-4 text-[var(--ec-warning)]">
          This session was paired without the admin scope, so network settings are read-only.
        </p>
      ) : null}

      <SettingGroup title="Outbound proxy" hint="Used by the host for provider and Git traffic.">
        <ToggleRow
          title="Use a proxy"
          checked={snapshot.enabled}
          disabled={disabled}
          onChange={(enabled) => void save({ enabled })}
        />
        <SelectRow
          title="Protocol"
          value={snapshot.protocol}
          options={PROTOCOLS}
          disabled={disabled || !snapshot.enabled}
          onChange={(protocol) => void save({ protocol })}
        />
        <TextRow
          title="Host"
          value={snapshot.host}
          placeholder="proxy.internal"
          disabled={disabled || !snapshot.enabled}
          onCommit={(host) => void save({ host: host.trim() })}
        />
        <TextRow
          title="Port"
          value={snapshot.port}
          placeholder="8080"
          inputMode="numeric"
          disabled={disabled || !snapshot.enabled}
          invalid={(draft) => {
            if (!draft.trim()) return null;
            const parsed = Number(draft);
            return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? null : "Enter a port between 1 and 65535.";
          }}
          onCommit={(port) => void save({ port: port.trim() })}
        />
        <TextRow
          title="Username"
          value={snapshot.username}
          disabled={disabled || !snapshot.enabled}
          onCommit={(username) => void save({ username: username.trim() })}
        />
      </SettingGroup>

      <SettingGroup
        title="Proxy password"
        hint={snapshot.hasPassword ? "A password is stored on the host. Leave blank to keep it." : "No password stored."}
      >
        <div className="flex flex-col gap-2 px-4 py-2.5">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={snapshot.hasPassword ? "••••••••" : "Proxy password"}
            autoCapitalize="none"
            autoComplete="off"
            disabled={disabled || !snapshot.enabled}
            className="text-[13px]"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!password || disabled} busy={action.busy} onClick={() => void save({}, { password })}>
              Save password
            </Button>
            {snapshot.hasPassword ? (
              <Button
                size="sm"
                tone="danger"
                disabled={disabled}
                onClick={() => {
                  setClearPassword(true);
                  void save({}, { clear: true });
                }}
              >
                {clearPassword ? "Clearing…" : "Remove stored password"}
              </Button>
            ) : null}
          </div>
        </div>
      </SettingGroup>

      <SettingGroup title="Remote access">
        <p className="px-4 py-3 text-[11px] leading-4 text-[var(--ec-muted)]">
          Pairing codes and browser sessions are managed on the desktop app. A paired browser cannot mint new codes or
          revoke other sessions — only disconnect itself, from More → Disconnect.
        </p>
      </SettingGroup>

      <div className="h-6" />
    </>
  );
};
