import { useCallback, useEffect, useState } from "react";
import {
  APP_SETTING_KEYS,
  PROVIDER_CLI_INSTALL_METHOD_LABELS,
  serializeProviderCliUpdateSettings,
  type ProviderCliUpdateSettings,
  type ProviderCliUpdateSnapshot,
  type ProviderCliUpdateState,
  type ProviderCliUpdateStatus,
} from "@buildwarden/shared";
import { Check, Copy, Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

const STATE_LABELS: Record<ProviderCliUpdateState, string> = {
  checking: "Checking…",
  current: "Up to date",
  "update-available": "Update available",
  updating: "Updating…",
  "not-installed": "Not found",
  unknown: "Unknown",
  error: "Check failed",
};

const NEUTRAL_PILL = "border-[var(--ec-border)] bg-[var(--ec-panel)] text-[var(--ec-muted)]";

const statePillClass = (state: ProviderCliUpdateState): string => {
  if (state === "current") return "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]";
  if (state === "update-available" || state === "updating") return "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]";
  if (state === "error" || state === "not-installed") return "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]";
  return NEUTRAL_PILL;
};

const formatTimestamp = (value: string): string => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const versionSummary = (status: ProviderCliUpdateStatus): string => {
  const installed = status.installedVersion ? `v${status.installedVersion}` : "—";
  return status.latestVersion && status.latestVersion !== status.installedVersion ? `${installed} → v${status.latestVersion}` : installed;
};

const ProviderRow = ({
  status,
  busy,
  copied,
  onUpdate,
  onCopy,
}: {
  status: ProviderCliUpdateStatus;
  busy: boolean;
  copied: boolean;
  onUpdate: () => void;
  onCopy: () => void;
}) => {
  const canUpdate = status.state === "update-available" && status.canAutoUpdate;
  const note = status.state === "updating" || status.message
    ? status.message
    : canUpdate && status.inUse
      ? "In use by an active run or chat. Update once they finish."
      : status.state === "update-available" && !status.canAutoUpdate
        ? status.manualReason
        : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-[var(--ec-text)]">{status.label}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statePillClass(status.state)}`}>
            {STATE_LABELS[status.state]}
          </span>
          <span className="font-mono text-xs text-[var(--ec-text)]">{versionSummary(status)}</span>
          {status.installMethod !== "unknown" ? (
            <span className="text-[11px] text-[var(--ec-faint)]">{PROVIDER_CLI_INSTALL_METHOD_LABELS[status.installMethod]}</span>
          ) : null}
        </div>
        {note ? <p className="mt-0.5 text-[11px] leading-4 text-[var(--ec-muted)]">{note}</p> : null}
        {status.binaryPath ? <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--ec-faint)]" title={status.binaryPath}>{status.binaryPath}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canUpdate ? (
          <Button type="button" size="xs" disabled={busy || status.inUse} onClick={onUpdate}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Update
          </Button>
        ) : null}
        {status.updateCommand ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onCopy}
            title={`Copy: ${status.updateCommand}`}
            aria-label={`Copy the ${status.label} update command`}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

/** Opt-in provider CLI version checks; nothing is requested or installed while it is off. */
export const ProviderCliUpdatesSettings = () => {
  const buildwarden = useBuildWardenClient();
  const [snapshot, setSnapshot] = useState<ProviderCliUpdateSnapshot | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void buildwarden.getProviderCliUpdates().then((next) => {
      if (!disposed) setSnapshot(next);
    }).catch((caught: unknown) => {
      if (!disposed) setError(formatAppErrorMessage(caught, "Could not load provider update status."));
    });
    const unsubscribe = buildwarden.onProviderCliUpdatesChanged((next) => {
      if (!disposed) setSnapshot(next);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [buildwarden]);

  const run = useCallback(async (key: string, action: () => Promise<ProviderCliUpdateSnapshot>) => {
    setWorking(key);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (caught) {
      setError(formatAppErrorMessage(caught, "The provider update action failed."));
    } finally {
      setWorking(null);
    }
  }, []);

  const saveSettings = (next: ProviderCliUpdateSettings) => void run("settings", async () => {
    await buildwarden.setAppSetting(APP_SETTING_KEYS.providerCliUpdates, serializeProviderCliUpdateSettings(next));
    return buildwarden.getProviderCliUpdates();
  });

  const copyCommand = (status: ProviderCliUpdateStatus) => {
    if (!status.updateCommand) return;
    void navigator.clipboard.writeText(status.updateCommand).then(() => {
      setCopiedType(status.providerType);
      setTimeout(() => setCopiedType((current) => (current === status.providerType ? null : current)), 1_500);
    });
  };

  // Checks and updates run on the host, so they need the same access as other host settings.
  if (!buildwarden.capabilities.settings) return null;
  const remote = buildwarden.capabilities.platform === "web";

  const enabled = snapshot?.enabled ?? false;
  const notify = snapshot?.notify ?? true;
  const checking = snapshot?.checking || working === "check";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-[var(--ec-accent)]">
            <PackageCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Provider CLI updates</p>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${enabled
                ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
                : NEUTRAL_PILL}`}>
                {enabled ? "On" : "Off"}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--ec-muted)]">
              When on, BuildWarden asks the npm registry (and cursor.com for Cursor Agent) for the newest version of each configured
              Claude Code, Codex CLI, and Cursor Agent provider every 6 hours. While off, nothing is requested or installed.
            </p>
          </div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-[var(--ec-text)]">
          <input
            className="h-4 w-4 accent-[var(--ec-accent)]"
            type="checkbox"
            checked={enabled}
            disabled={!snapshot || working !== null}
            onChange={(event) => saveSettings({ enabled: event.target.checked, notify })}
          />
          Check for updates
        </label>
      </div>

      {enabled ? (
        <div className="mt-3 border-t border-[var(--ec-border)] pt-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-xs text-[var(--ec-text)]">
              <input
                className="size-3.5 accent-[var(--ec-accent)]"
                type="checkbox"
                checked={notify}
                disabled={working !== null}
                onChange={(event) => saveSettings({ enabled, notify: event.target.checked })}
              />
              Notify about new versions
            </label>
            <span className="text-[11px] text-[var(--ec-muted)]">
              {snapshot?.lastCheckedAt ? `Last checked ${formatTimestamp(snapshot.lastCheckedAt)}` : "Not checked yet"}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="ml-auto"
              disabled={checking || working !== null}
              onClick={() => void run("check", () => buildwarden.checkProviderCliUpdates())}
            >
              {checking ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              Check now
            </Button>
          </div>
          {snapshot?.providers.length ? (
            <div className="mt-1 divide-y divide-[var(--ec-border)]">
              {snapshot.providers.map((status) => (
                <ProviderRow
                  key={status.providerType}
                  status={status}
                  busy={working === status.providerType || status.state === "updating"}
                  copied={copiedType === status.providerType}
                  onUpdate={() => void run(status.providerType, () => buildwarden.runProviderCliUpdate(status.providerType))}
                  onCopy={() => copyCommand(status)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-[var(--ec-muted)]">
              {checking ? "Checking configured providers…" : "No Claude Code, Codex CLI, or Cursor Agent provider is configured, or no check has run yet."}
            </p>
          )}
          <p className="mt-2 text-[11px] leading-4 text-[var(--ec-faint)]">
            Updates use the tool that installed each CLI (npm, pnpm, Bun, Volta, Homebrew, or the CLI&apos;s own updater) and wait until no run or chat
            uses it. Installs in folders BuildWarden cannot write to show a command to run yourself.
            {remote ? " Checks and updates run on the BuildWarden host computer, not on this device." : ""}
          </p>
        </div>
      ) : null}

      {error ? <p role="alert" className="mt-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
    </Card>
  );
};
