import { useCallback, useEffect, useState } from "react";
import {
  APP_SETTING_KEYS,
  normalizeRemoteAccessWebOrigin,
  parseRemoteAccessWebOriginsSetting,
  serializeRemoteAccessWebOriginsSetting,
  type NetworkProxyProtocol,
  type RemoteAccessScope,
  type RemoteAccessStatus,
  type RemoteAccessPairingGrant,
  type RemoteAccessPairingInput,
  type RemoteAccessSession,
} from "@buildwarden/shared";
import { Copy, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck, Unplug, X } from "lucide-react";
import QRCode from "qrcode";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Badge, type BadgeProps } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { ProviderCliUpdatesSettings } from "./settings-provider-cli-updates";
import { SettingsRow, SettingsSection } from "./settings-layout";

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
  showRemoteAccess: boolean;
  usageCostTrackingEnabled: boolean;
  onUsageCostTrackingEnabledChange: (enabled: boolean) => Promise<void>;
};

const PROXY_PROTOCOL_OPTIONS: Array<{ value: NetworkProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP proxy" },
  { value: "https", label: "HTTPS proxy" },
];

const READ_ONLY_SCOPES: RemoteAccessScope[] = ["state:read"];
const FULL_CONTROL_SCOPES: RemoteAccessScope[] = [
  "state:read", "run:operate", "chat:operate", "approval:respond", "git:write", "terminal:operate", "browser:operate", "admin",
];

const PAIRING_TARGET_OPTIONS = [
  { value: "hosted", label: "Hosted website" },
  { value: "host", label: "Host-served" },
] as const;

const PAIRING_ACCESS_OPTIONS = [
  { value: "read", label: "Read only" },
  { value: "full", label: "Full control" },
] as const;

const compactBadgeClass = "px-2 py-0.5 text-[11px]";
const rowControlClass = "flex w-full items-center justify-start gap-2 md:justify-end";
/** Full-width block inside a settings card, matching SettingsRow spacing and dividers. */
const settingsBlockClass = "border-b border-[var(--ec-border)] px-4 py-3 last:border-b-0";

const formatTimestamp = (value: string): string => new Date(value).toLocaleString([], {
  dateStyle: "medium",
  timeStyle: "short",
});

const errorMessage = (caught: unknown, fallback: string): string => caught instanceof Error ? caught.message : fallback;

const tailscaleTone = (status: RemoteAccessStatus["tailscale"]): BadgeProps["tone"] => {
  if (status.verified) return "completed";
  if (status.state === "error" || status.state === "conflict") return "queued";
  return "neutral";
};

const PairedDeviceRow = ({
  session,
  working,
  onRevoke,
}: {
  session: RemoteAccessSession;
  working: boolean;
  onRevoke: () => void;
}) => {
  const active = !session.revokedAt && session.expiresAt > new Date().toISOString();
  const fullControl = session.scopes.some((scope) => scope !== "state:read");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`truncate text-sm ${active ? "text-[var(--ec-text)]" : "text-[var(--ec-muted)]"}`}>{session.label}</span>
          <Badge tone={fullControl ? "running" : "neutral"} className={compactBadgeClass} title={session.scopes.join(" · ")}>
            {fullControl ? "Full control" : "Read only"}
          </Badge>
          <span className="text-[11px] text-[var(--ec-muted)]">
            {active ? `Last used ${formatTimestamp(session.lastUsedAt)}` : session.revokedAt ? "Revoked" : "Expired"}
          </span>
        </div>
        {session.clientOrigin ? <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--ec-faint)]">{session.clientOrigin}</p> : null}
      </div>
      {active ? (
        <Button type="button" variant="secondary" size="xs" disabled={working} onClick={onRevoke}>
          <Unplug className="mr-1.5 size-3.5" />
          Revoke
        </Button>
      ) : null}
    </div>
  );
};

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
  const [showInactiveSessions, setShowInactiveSessions] = useState(false);
  const [pairing, setPairing] = useState<RemoteAccessPairingGrant | null>(null);
  const [pairingQrCode, setPairingQrCode] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null);
  const [pairingAccess, setPairingAccess] = useState<"read" | "full">("read");
  const [pairingTarget, setPairingTarget] = useState<"host" | "hosted">("hosted");
  const [webOrigins, setWebOrigins] = useState<string[]>([]);
  const [webOriginDraft, setWebOriginDraft] = useState("");
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
    void Promise.all([
      refreshSessions(),
      refreshRemoteStatus(),
      buildwarden.getSnapshot().then((snapshot) => {
        const origins = parseRemoteAccessWebOriginsSetting(snapshot.settings[APP_SETTING_KEYS.remoteAccessWebOrigins]);
        setWebOrigins(origins);
        setWebOriginDraft((current) => current || origins[0] || "");
      }),
    ]).catch((caught) => {
      setError(errorMessage(caught, "Could not load paired devices."));
    });
  }, [buildwarden, refreshRemoteStatus, refreshSessions]);

  useEffect(() => {
    let disposed = false;
    setPairingQrCode(null);
    if (!pairing?.pairingUrl) return;
    const rootStyles = getComputedStyle(document.documentElement);
    const qrForeground = rootStyles.getPropertyValue("--ec-terminal-fg").trim() || "#18181b";
    const qrBackground = rootStyles.getPropertyValue("--ec-terminal-bg").trim() || "#ffffff";
    void QRCode.toDataURL(pairing.pairingUrl, {
      width: 176,
      margin: 1,
      color: { dark: qrForeground, light: qrBackground },
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
      setError(errorMessage(caught, "Remote access could not be updated."));
    } finally {
      setWorking(false);
    }
  };

  const saveWebOrigins = async (next: string[]) => {
    const serialized = serializeRemoteAccessWebOriginsSetting(next);
    await buildwarden.setAppSetting(APP_SETTING_KEYS.remoteAccessWebOrigins, serialized);
    setWebOrigins(parseRemoteAccessWebOriginsSetting(serialized));
  };

  // The host only accepts hosted pairings for trusted origins, so pairing trusts the entered origin first.
  const createPairing = () => void run(async () => {
    let clientOrigin: string | undefined;
    if (pairingTarget === "hosted") {
      const origin = normalizeRemoteAccessWebOrigin(webOriginDraft);
      if (!origin) throw new Error("Enter the hosted website's exact HTTPS origin, without a path or wildcard.");
      if (!webOrigins.includes(origin)) await saveWebOrigins([...webOrigins, origin]);
      setWebOriginDraft(origin);
      clientOrigin = origin;
    }
    setPairing(await onCreatePairing({
      scopes: pairingAccess === "full" ? FULL_CONTROL_SCOPES : READ_ONLY_SCOPES,
      ...(clientOrigin ? { clientOrigin } : {}),
    }));
    await refreshSessions();
    await refreshRemoteStatus();
  });

  const removeWebOrigin = (origin: string) => void run(async () => {
    await saveWebOrigins(webOrigins.filter((candidate) => candidate !== origin));
    setPairing(null);
  });

  const tailscale = remoteStatus?.tailscale ?? null;
  const tailscaleEndpoint = tailscale?.verified ? tailscale.endpoint : null;
  const hostedPairingBlocked = pairingTarget === "hosted" && (!tailscaleEndpoint || !webOriginDraft.trim());
  const now = new Date().toISOString();
  const activeSessions = sessions.filter((session) => !session.revokedAt && session.expiresAt > now);
  const inactiveSessions = sessions.filter((session) => !activeSessions.includes(session));
  const visibleSessions = showInactiveSessions ? sessions : activeSessions;

  return (
    <SettingsSection title="Remote access">
      <SettingsRow
        title={(
          <span className="flex flex-wrap items-center gap-2">
            Remote access server
            <Badge tone={enabled ? "completed" : "neutral"} className={compactBadgeClass}>{enabled ? "On" : "Off"}</Badge>
          </span>
        )}
        description="An authenticated server that always stays on loopback. Devices connect with single-use pairing codes and receive revocable sessions."
      >
        <div className={rowControlClass}>
          <Switch
            checked={enabled}
            disabled={working}
            aria-label="Enable remote access"
            onCheckedChange={(next) => void run(async () => {
              await onEnabledChange(next);
              await refreshRemoteStatus();
              if (!next) setPairing(null);
            })}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        align="start"
        title={(
          <span className="flex flex-wrap items-center gap-2">
            Tailscale Serve
            {tailscale ? (
              <Badge tone={tailscaleTone(tailscale)} className={`${compactBadgeClass} capitalize`}>{tailscale.state.replace("-", " ")}</Badge>
            ) : <Loader2 className="size-3.5 animate-spin text-[var(--ec-muted)]" />}
          </span>
        )}
        description={(
          <>
            <p>{tailscale?.message ?? "Checking the local Tailscale installation…"}</p>
            <p className="text-[var(--ec-faint)]">Optional. BuildWarden removes only the exact root handler it created.</p>
          </>
        )}
      >
        <div className="flex w-full flex-col items-start gap-2 md:items-end">
          <label className="flex items-center gap-2 text-xs text-[var(--ec-muted)]">
            Expose to tailnet
            <Switch
              checked={tailscale?.desired ?? false}
              disabled={!enabled || working || !tailscale}
              aria-label="Expose to tailnet"
              onCheckedChange={(next) => void run(async () => {
                await buildwarden.setAppSetting(APP_SETTING_KEYS.remoteAccessTailscaleEnabled, String(next));
                await refreshRemoteStatus();
                setPairing(null);
              })}
            />
          </label>
          {tailscaleEndpoint ? (
            <div className="flex w-full max-w-md items-center gap-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] py-0.5 pr-0.5 pl-2.5">
              <code className="min-w-0 flex-1 truncate text-xs text-[var(--ec-accent)]" title={tailscaleEndpoint}>{tailscaleEndpoint}</code>
              <Button type="button" variant="ghost" size="xs" aria-label="Copy tailnet URL" title="Copy URL" onClick={() => void navigator.clipboard.writeText(tailscaleEndpoint)}>
                <Copy className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="xs" aria-label="Open tailnet URL" title="Open" onClick={() => void buildwarden.openExternalUrl(tailscaleEndpoint)}>
                <ExternalLink className="size-3.5" />
              </Button>
            </div>
          ) : tailscale?.enableCommand ? (
            <code className="block w-full max-w-md overflow-x-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ec-text)]" title="Manual command">
              {tailscale.enableCommand}
            </code>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        align="start"
        title="Pair a device"
        description={(
          <>
            <p>
              Hosted website pairs a BuildWarden web app at the origin you enter through Tailscale Serve and trusts that exact origin.
              Host-served uses the page this computer serves.
            </p>
            <p className="text-[var(--ec-faint)]">
              Codes work once and expire after five minutes. Full control adds runs, chats, approvals, Git, projects, terminal, and
              browser. Existing sessions keep their access; revoke and re-pair to change it.
            </p>
          </>
        )}
      >
        <div className="flex w-full flex-col items-start gap-2 md:items-end">
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <SegmentedControl
              label="Pairing target"
              options={PAIRING_TARGET_OPTIONS}
              value={pairingTarget}
              onChange={setPairingTarget}
              disabled={!enabled || working}
            />
            <SegmentedControl
              label="Pairing access"
              options={PAIRING_ACCESS_OPTIONS}
              value={pairingAccess}
              onChange={setPairingAccess}
              disabled={!enabled || working}
            />
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:flex-nowrap md:justify-end">
            {pairingTarget === "hosted" ? (
              <Input
                className="h-7 min-w-56 flex-1 font-mono text-xs"
                value={webOriginDraft}
                onChange={(event) => setWebOriginDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && enabled && !working && !hostedPairingBlocked) createPairing();
                }}
                placeholder="https://buildwarden-app.vercel.app"
                spellCheck={false}
                disabled={!enabled || working}
                aria-label="Hosted website origin"
              />
            ) : null}
            <Button
              type="button"
              size="xs"
              className="shrink-0"
              disabled={!enabled || working || hostedPairingBlocked}
              onClick={createPairing}
            >
              {working ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <KeyRound className="mr-1.5 size-3.5" />}
              Create pairing code
            </Button>
          </div>
          {pairingTarget === "hosted" && tailscale && !tailscaleEndpoint ? (
            <p className="text-[11px] text-[var(--ec-warning)]">Hosted website pairing needs Tailscale Serve exposed to the tailnet.</p>
          ) : null}
          {pairingTarget === "hosted" && webOrigins.length ? (
            <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
              <span className="text-[11px] text-[var(--ec-muted)]">Trusted</span>
              {webOrigins.map((origin) => (
                <span
                  key={origin}
                  className={`inline-flex items-center rounded-md border text-[11px] ${
                    normalizeRemoteAccessWebOrigin(webOriginDraft) === origin
                      ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                      : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]"
                  }`}
                >
                  <button type="button" className="px-1.5 py-0.5 font-mono hover:text-[var(--ec-text)]" disabled={working} onClick={() => setWebOriginDraft(origin)}>
                    {origin.replace(/^https:\/\//, "")}
                  </button>
                  <button
                    type="button"
                    className="border-l border-[var(--ec-border)] px-1 py-0.5 hover:text-[var(--ec-danger)] disabled:opacity-50"
                    disabled={working}
                    aria-label={`Stop trusting ${origin}`}
                    title="Stop trusting this origin. Devices paired through it lose access."
                    onClick={() => removeWebOrigin(origin)}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsRow>

      {pairing ? (
        <div className={settingsBlockClass}>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] px-3 py-2">
            {pairingQrCode ? <img className="size-20 rounded bg-white p-1" src={pairingQrCode} alt="Pair this device with BuildWarden" /> : null}
            <div className="min-w-0 flex-1">
              <p className="font-mono text-base font-semibold tracking-wider text-[var(--ec-success)]">{pairing.code}</p>
              <p className="text-[11px] text-[var(--ec-success)]">Expires {formatTimestamp(pairing.expiresAt)}</p>
              {pairing.pairingUrl ? <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--ec-success)]">{pairing.pairingUrl}</p> : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" variant="secondary" size="xs" onClick={() => void navigator.clipboard.writeText(pairing.code)}>
                <Copy className="mr-1.5 size-3.5" />
                Copy code
              </Button>
              {pairing.pairingUrl ? (
                <Button type="button" variant="secondary" size="xs" onClick={() => void navigator.clipboard.writeText(pairing.pairingUrl ?? "")}>
                  <Copy className="mr-1.5 size-3.5" />
                  Copy link
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={settingsBlockClass}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-medium text-[var(--ec-text)]">Paired devices</p>
          <span className="text-xs text-[var(--ec-muted)]">{activeSessions.length} active</span>
          <div className="ml-auto flex items-center gap-1">
            {inactiveSessions.length ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => setShowInactiveSessions((current) => !current)}>
                {showInactiveSessions ? "Hide" : "Show"} {inactiveSessions.length} revoked or expired
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="xs" disabled={working} aria-label="Refresh paired devices" title="Refresh" onClick={() => void run(refreshSessions)}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>
        {visibleSessions.length ? (
          <div className="mt-1 divide-y divide-[var(--ec-border)]">
            {visibleSessions.map((session) => (
              <PairedDeviceRow
                key={session.id}
                session={session}
                working={working}
                onRevoke={() => void run(async () => {
                  await onRevokeSession(session.id);
                  await refreshSessions();
                })}
              />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-[var(--ec-muted)]">{sessions.length ? "No active devices." : "No devices have been paired."}</p>
        )}
      </div>

      {error ? <p role="alert" className={`${settingsBlockClass} text-xs text-[var(--ec-danger)]`}>{error}</p> : null}
    </SettingsSection>
  );
};

const OutboundProxySettings = ({
  draft,
  dirty,
  saving,
  onDraftChange,
  onSave,
  onReset,
}: Pick<NetworkSettingsTabProps, "draft" | "dirty" | "saving" | "onDraftChange" | "onSave" | "onReset">) => {
  const passwordSaved = draft.hasPassword && !draft.clearSavedPassword;
  return (
    <SettingsSection
      title="Outbound proxy"
      actions={(
        <>
          {dirty && !saving ? <span className="text-xs text-[var(--ec-warning)]">Unsaved changes</span> : null}
          <Button type="button" variant="ghost" size="xs" disabled={!dirty || saving} onClick={onReset}>
            Reset
          </Button>
          <Button type="button" size="xs" disabled={!dirty || saving} onClick={() => void onSave()}>
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : "Save proxy"}
          </Button>
        </>
      )}
    >
      <SettingsRow
        title="Use a proxy"
        description={(
          <>
            Route provider, agent, and download traffic for the whole app through an HTTP(S) proxy. When off, BuildWarden connects
            directly even if details are filled in. <code className="text-[11px]">localhost</code>, <code className="text-[11px]">127.0.0.1</code>,
            and <code className="text-[11px]">::1</code> always bypass the proxy.
          </>
        )}
      >
        <div className={rowControlClass}>
          <Switch
            checked={draft.enabled}
            aria-label="Enable network proxy"
            onCheckedChange={(enabled) => onDraftChange({ ...draft, enabled })}
          />
        </div>
      </SettingsRow>

      <SettingsRow title="Proxy server" description="Protocol, host name or IP address, and port.">
        <div className="flex w-full flex-wrap items-center gap-2 md:flex-nowrap">
          <Select
            className="w-36 shrink-0"
            value={draft.protocol}
            onValueChange={(value) => onDraftChange({ ...draft, protocol: value as NetworkProxyProtocol })}
            options={PROXY_PROTOCOL_OPTIONS}
            ariaLabel="Proxy protocol"
          />
          <Input
            className="min-w-40 flex-1"
            value={draft.host}
            onChange={(event) => onDraftChange({ ...draft, host: event.target.value })}
            placeholder="proxy.company.net"
            spellCheck={false}
            aria-label="Proxy host"
          />
          <Input
            className="w-24 shrink-0"
            value={draft.port}
            onChange={(event) => onDraftChange({ ...draft, port: event.target.value })}
            placeholder="8080"
            inputMode="numeric"
            spellCheck={false}
            aria-label="Proxy port"
          />
        </div>
      </SettingsRow>

      <SettingsRow
        align="start"
        title="Authentication"
        description="Optional. The password is kept in BuildWarden's encrypted secret store, never in the settings database."
      >
        <div className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap gap-2 md:flex-nowrap">
            <Input
              className="min-w-40 flex-1"
              value={draft.username}
              onChange={(event) => onDraftChange({ ...draft, username: event.target.value })}
              placeholder="Username"
              autoComplete="username"
              spellCheck={false}
              aria-label="Proxy username"
            />
            <Input
              className="min-w-40 flex-1"
              type="password"
              value={draft.password}
              onChange={(event) => onDraftChange({ ...draft, password: event.target.value, clearSavedPassword: false })}
              placeholder={passwordSaved ? "Saved. Type to replace." : "Password"}
              autoComplete="current-password"
              spellCheck={false}
              aria-label="Proxy password"
            />
          </div>
          {draft.hasPassword ? (
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
              {passwordSaved ? (
                <span className="inline-flex items-center gap-1 text-[var(--ec-success)]">
                  <ShieldCheck className="size-3.5" />
                  Password saved securely
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={saving}
                onClick={() => onDraftChange({ ...draft, password: "", hasPassword: false, clearSavedPassword: true })}
              >
                Clear saved password
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
};

const UsageCostTrackingRow = ({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) => {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      title="Model pricing & usage costs"
      description="Downloads LiteLLM's public model price list from GitHub (through the outbound proxy, cached for 24 hours) and adds a Usage dashboard with estimated API-equivalent costs. Nothing is downloaded while this is off."
    >
      <div className="flex w-full flex-col items-start gap-1 md:items-end">
        <div className={rowControlClass}>
          {working ? <Loader2 className="size-3.5 animate-spin text-[var(--ec-muted)]" /> : null}
          <Switch
            checked={enabled}
            disabled={working}
            aria-label="Enable model pricing and usage cost dashboard"
            onCheckedChange={(next) => {
              setWorking(true);
              setError(null);
              void onEnabledChange(next)
                .catch((caught: unknown) => setError(errorMessage(caught, "The setting could not be saved.")))
                .finally(() => setWorking(false));
            }}
          />
        </div>
        {error ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
      </div>
    </SettingsRow>
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
  showRemoteAccess,
  usageCostTrackingEnabled,
  onUsageCostTrackingEnabledChange,
}: NetworkSettingsTabProps) => (
  <div className="space-y-5">
    {showRemoteAccess ? (
      <RemoteAccessSettings
        enabled={remoteAccessEnabled}
        onEnabledChange={onRemoteAccessEnabledChange}
        onCreatePairing={onCreateRemoteAccessPairing}
        onListSessions={onListRemoteAccessSessions}
        onRevokeSession={onRevokeRemoteAccessSession}
      />
    ) : null}

    <OutboundProxySettings
      draft={draft}
      dirty={dirty}
      saving={saving}
      onDraftChange={onDraftChange}
      onSave={onSave}
      onReset={onReset}
    />

    <SettingsSection title="Downloads & updates">
      <UsageCostTrackingRow enabled={usageCostTrackingEnabled} onEnabledChange={onUsageCostTrackingEnabledChange} />
      <ProviderCliUpdatesSettings />
    </SettingsSection>
  </div>
);
