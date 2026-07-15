import { useCallback, useEffect, useState } from "react";
import {
  APP_SETTING_KEYS,
  type NetworkProxyProtocol,
  type RemoteAccessStatus,
  type RemoteAccessPairingGrant,
  type RemoteAccessPairingInput,
  type RemoteAccessSession,
} from "@buildwarden/shared";
import { Copy, ExternalLink, Globe, Info, KeyRound, Loader2, Network, ShieldCheck, Unplug, Wifi } from "lucide-react";
import QRCode from "qrcode";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

export type NetworkProxyDraft = {
  enabled: boolean;
  protocol: NetworkProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  hasPassword: boolean;
  clearSavedPassword: boolean;
};

export type NetworkSettingsTabProps = {
  draft: NetworkProxyDraft;
  dirty: boolean;
  saving: boolean;
  onDraftChange: (next: NetworkProxyDraft) => void;
  onSave: () => void | Promise<void>;
  onReset: () => void;
  remoteAccessEnabled: boolean;
  onRemoteAccessEnabledChange: (enabled: boolean) => Promise<void>;
  onCreateRemoteAccessPairing: (input?: RemoteAccessPairingInput) => Promise<RemoteAccessPairingGrant>;
  onListRemoteAccessSessions: () => Promise<RemoteAccessSession[]>;
  onRevokeRemoteAccessSession: (sessionId: string) => Promise<void>;
};

const PROXY_PROTOCOL_OPTIONS: Array<{ value: NetworkProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP proxy" },
  { value: "https", label: "HTTPS proxy" },
];

const formatTimestamp = (value: string): string => new Date(value).toLocaleString([], {
  dateStyle: "medium",
  timeStyle: "short",
});

const RemoteAccessSettings = ({
  enabled,
  onEnabledChange,
  onCreatePairing,
  onListSessions,
  onRevokeSession,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onCreatePairing: (input?: RemoteAccessPairingInput) => Promise<RemoteAccessPairingGrant>;
  onListSessions: () => Promise<RemoteAccessSession[]>;
  onRevokeSession: (sessionId: string) => Promise<void>;
}) => {
  const [sessions, setSessions] = useState<RemoteAccessSession[]>([]);
  const [pairing, setPairing] = useState<RemoteAccessPairingGrant | null>(null);
  const [pairingQrCode, setPairingQrCode] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null);
  const [allowRemoteControl, setAllowRemoteControl] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buildwarden = useBuildWardenClient();

  const refreshSessions = useCallback(async () => {
    setSessions(await onListSessions());
  }, [onListSessions]);

  const refreshRemoteStatus = useCallback(async () => {
    setRemoteStatus(await buildwarden.getRemoteAccessStatus());
  }, [buildwarden]);

  useEffect(() => {
    void Promise.all([refreshSessions(), refreshRemoteStatus()]).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Could not load paired devices.");
    });
  }, [refreshRemoteStatus, refreshSessions]);

  useEffect(() => {
    let disposed = false;
    setPairingQrCode(null);
    if (!pairing?.pairingUrl) return;
    void QRCode.toDataURL(pairing.pairingUrl, {
      width: 176,
      margin: 1,
      color: { dark: "#18181b", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).then((dataUrl) => {
      if (!disposed) setPairingQrCode(dataUrl);
    }).catch(() => {
      if (!disposed) setPairingQrCode(null);
    });
    return () => {
      disposed = true;
    };
  }, [pairing?.pairingUrl]);

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Remote access could not be updated.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-emerald-300">
            <Wifi className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Remote access</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-zinc-100">Authenticated loopback server</p>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${
                enabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}>
                {enabled ? "Enabled" : "Off"}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              Opt in to a local-only server, then issue single-use pairing codes for revocable read sessions.
            </p>
          </div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-zinc-300">
          <input
            className="h-4 w-4 accent-[var(--ec-accent)]"
            type="checkbox"
            checked={enabled}
            disabled={working}
            onChange={(event) => void run(async () => {
              await onEnabledChange(event.target.checked);
              await refreshRemoteStatus();
              if (!event.target.checked) setPairing(null);
            })}
          />
          Enable
        </label>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/45 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Network className="mt-0.5 size-4 shrink-0 text-cyan-300" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-zinc-200">Tailscale Serve</p>
                {remoteStatus ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    remoteStatus.tailscale.verified
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : remoteStatus.tailscale.state === "error" || remoteStatus.tailscale.state === "conflict"
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                        : "border-zinc-700 bg-zinc-900 text-zinc-400"
                  }`}>{remoteStatus.tailscale.state.replace("-", " ")}</span>
                ) : <Loader2 className="size-3.5 animate-spin text-zinc-500" />}
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-400">
                {remoteStatus?.tailscale.message ?? "Checking the local Tailscale installation…"}
              </p>
            </div>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-zinc-300">
            <input
              className="size-4 accent-[var(--ec-accent)]"
              type="checkbox"
              checked={remoteStatus?.tailscale.desired ?? false}
              disabled={!enabled || working || !remoteStatus}
              onChange={(event) => void run(async () => {
                await buildwarden.setAppSetting(APP_SETTING_KEYS.remoteAccessTailscaleEnabled, String(event.target.checked));
                await refreshRemoteStatus();
                setPairing(null);
              })}
            />
            Expose to tailnet
          </label>
        </div>

        {remoteStatus?.tailscale.verified && remoteStatus.tailscale.endpoint ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
            <code className="min-w-0 flex-1 truncate text-xs text-cyan-200">{remoteStatus.tailscale.endpoint}</code>
            <Button type="button" variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(remoteStatus.tailscale.endpoint ?? "")}>
              <Copy className="mr-2 size-3.5" />
              Copy URL
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void buildwarden.openExternalUrl(remoteStatus.tailscale.endpoint ?? "")}>
              <ExternalLink className="mr-2 size-3.5" />
              Open
            </Button>
          </div>
        ) : remoteStatus?.tailscale.enableCommand ? (
          <div className="mt-3 border-t border-zinc-800 pt-3">
            <p className="text-[11px] text-zinc-500">Manual command</p>
            <code className="mt-1 block overflow-x-auto rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-300">{remoteStatus.tailscale.enableCommand}</code>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
        <Button
          type="button"
          size="sm"
          disabled={!enabled || working}
          onClick={() => void run(async () => {
            setPairing(await onCreatePairing({ scopes: allowRemoteControl
              ? ["state:read", "run:operate", "chat:operate", "approval:respond", "git:write", "terminal:operate", "admin"]
              : ["state:read"] }));
            await refreshSessions();
            await refreshRemoteStatus();
          })}
        >
          {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Create pairing code
        </Button>
        <label className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-300">
          <input
            className="size-3.5 accent-[var(--ec-accent)]"
            type="checkbox"
            checked={allowRemoteControl}
            disabled={!enabled || working}
            onChange={(event) => setAllowRemoteControl(event.target.checked)}
          />
          Allow runs, chats, approvals, Git, projects, and terminal
        </label>
        <span className="text-xs text-zinc-500">Codes expire after five minutes and work once.</span>
      </div>

      {pairing ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-base font-semibold tracking-wider text-emerald-100">{pairing.code}</p>
            <p className="mt-0.5 text-[11px] text-emerald-200/70">Expires {formatTimestamp(pairing.expiresAt)}</p>
            {pairing.pairingUrl ? <p className="mt-1 truncate font-mono text-[10px] text-emerald-200/70">{pairing.pairingUrl}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {pairingQrCode ? <img className="size-24 rounded bg-white p-1" src={pairingQrCode} alt="Pair this device with BuildWarden" /> : null}
            <div className="flex flex-col gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(pairing.code)}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy code
              </Button>
              {pairing.pairingUrl ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(pairing.pairingUrl ?? "")}>
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy link
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-xs text-red-300">{error}</p> : null}

      <div className="mt-4 border-t border-zinc-800 pt-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Paired devices</p>
          <Button type="button" variant="ghost" size="sm" disabled={working} onClick={() => void run(refreshSessions)}>
            Refresh
          </Button>
        </div>
        {sessions.length ? (
          <div className="mt-2 divide-y divide-zinc-800">
            {sessions.map((session) => {
              const active = !session.revokedAt && session.expiresAt > new Date().toISOString();
              return (
                <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-200">{session.label}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {active ? `Last used ${formatTimestamp(session.lastUsedAt)}` : session.revokedAt ? "Revoked" : "Expired"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-zinc-600">{session.scopes.join(" · ")}</p>
                  </div>
                  {active ? (
                    <Button type="button" variant="secondary" size="sm" disabled={working} onClick={() => void run(async () => {
                      await onRevokeSession(session.id);
                      await refreshSessions();
                    })}>
                      <Unplug className="mr-2 h-3.5 w-3.5" />
                      Revoke
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-xs text-zinc-500">No devices have been paired.</p>
        )}
      </div>

      <p className="mt-3 border-l border-amber-500/30 pl-3 text-xs leading-5 text-amber-200/75">
        The BuildWarden server always stays on loopback. Tailscale Serve is optional and BuildWarden removes only the exact root handler it created.
      </p>
    </Card>
  );
};

export const NetworkSettingsTab = ({
  draft,
  dirty,
  saving,
  onDraftChange,
  onSave,
  onReset,
  remoteAccessEnabled,
  onRemoteAccessEnabledChange,
  onCreateRemoteAccessPairing,
  onListRemoteAccessSessions,
  onRevokeRemoteAccessSession,
}: NetworkSettingsTabProps) => (
  <div className="grid gap-3">
    <RemoteAccessSettings
      enabled={remoteAccessEnabled}
      onEnabledChange={onRemoteAccessEnabledChange}
      onCreatePairing={onCreateRemoteAccessPairing}
      onListSessions={onListRemoteAccessSessions}
      onRevokeSession={onRevokeRemoteAccessSession}
    />

    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-cyan-300">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Outbound proxy</p>
            <p className="mt-2 text-sm font-medium text-zinc-100">App-wide network proxy</p>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">Route provider and agent network calls through a proxy.</p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={!dirty || saving} onClick={onReset}>
            Reset
          </Button>
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void onSave()}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save proxy"
            )}
          </Button>
        </div>
      </div>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
        <input
          className="mt-1 h-4 w-4 accent-[var(--ec-accent)]"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">Enable network proxy</p>
          <p className="mt-1 text-xs text-zinc-500">When off, BuildWarden connects directly even if host details are filled in below.</p>
        </div>
      </label>

      <div className="mt-4 flex flex-wrap gap-3">
        <label className="min-w-48 flex-[0_1_12rem] space-y-1.5">
          <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Protocol</span>
          <Select
            value={draft.protocol}
            onValueChange={(value) => onDraftChange({ ...draft, protocol: value as NetworkProxyProtocol })}
            options={PROXY_PROTOCOL_OPTIONS}
          />
        </label>

        <label className="min-w-64 flex-[1_1_24rem] space-y-1.5">
          <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Host</span>
          <Input
            value={draft.host}
            onChange={(event) => onDraftChange({ ...draft, host: event.target.value })}
            placeholder="proxy.company.net"
            spellCheck={false}
          />
        </label>

        <label className="min-w-32 flex-[0_1_8rem] space-y-1.5">
          <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Port</span>
          <Input
            value={draft.port}
            onChange={(event) => onDraftChange({ ...draft, port: event.target.value })}
            placeholder="8080"
            inputMode="numeric"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <label className="min-w-64 flex-[1_1_20rem] space-y-1.5">
          <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Username</span>
          <Input
            value={draft.username}
            onChange={(event) => onDraftChange({ ...draft, username: event.target.value })}
            placeholder="Optional"
            autoComplete="username"
            spellCheck={false}
          />
        </label>

        <label className="min-w-64 flex-[1_1_20rem] space-y-1.5">
          <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Password</span>
          <Input
            type="password"
            value={draft.password}
            onChange={(event) =>
              onDraftChange({
                ...draft,
                password: event.target.value,
                clearSavedPassword: false,
              })
            }
            placeholder={draft.hasPassword && !draft.clearSavedPassword ? "Saved securely. Enter a new password to replace it." : "Optional"}
            autoComplete="current-password"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        {draft.hasPassword && !draft.clearSavedPassword ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-emerald-200">
            <ShieldCheck className="h-3.5 w-3.5" />
            Password saved securely
          </span>
        ) : null}
        {draft.hasPassword ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={saving}
            onClick={() =>
              onDraftChange({
                ...draft,
                password: "",
                hasPassword: false,
                clearSavedPassword: true,
              })
            }
          >
            Clear saved password
          </Button>
        ) : null}
      </div>
    </Card>

    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-zinc-500">
        <Info className="h-4 w-4 text-cyan-300" />
        Notes
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3 text-xs leading-5 text-zinc-400">
        <p className="min-w-52 flex-[1_1_14rem] border-l border-zinc-800 pl-3">
          Applied in the Electron main process and provider workers, so runs and chats share this setting.
        </p>
        <p className="min-w-52 flex-[1_1_14rem] border-l border-zinc-800 pl-3">
          Proxy passwords stay in BuildWarden&apos;s encrypted secret store, never in the SQLite settings database.
        </p>
        <p className="min-w-52 flex-[1_1_14rem] border-l border-zinc-800 pl-3">
          <code className="rounded bg-zinc-900 px-1 py-0.5 text-[11px]">localhost</code>,{" "}
          <code className="rounded bg-zinc-900 px-1 py-0.5 text-[11px]">127.0.0.1</code>, and{" "}
          <code className="rounded bg-zinc-900 px-1 py-0.5 text-[11px]">::1</code> bypass the proxy automatically.
        </p>
      </div>
    </Card>
  </div>
);
