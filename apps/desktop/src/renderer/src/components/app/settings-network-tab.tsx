import type { NetworkProxyProtocol } from "@buildwarden/shared";
import { Globe, Loader2, ShieldCheck } from "lucide-react";
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
};

const PROXY_PROTOCOL_OPTIONS: Array<{ value: NetworkProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP proxy" },
  { value: "https", label: "HTTPS proxy" },
];

export const NetworkSettingsTab = ({
  draft,
  dirty,
  saving,
  onDraftChange,
  onSave,
  onReset,
}: NetworkSettingsTabProps) => (
  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.95fr)]">
    <Card className="overflow-auto p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-full border border-zinc-800 bg-zinc-900/70 p-2 text-cyan-300">
          <Globe className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Outbound proxy</p>
              <p className="mt-2 text-sm font-medium text-zinc-100">App-wide network proxy</p>
              <p className="mt-1 text-sm text-zinc-400">
                Route provider and agent network calls through a proxy. Requests to <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">localhost</code>,{" "}
                <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">127.0.0.1</code>, and{" "}
                <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">::1</code> always bypass it.
              </p>
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

          <div className="mt-4 grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_8rem]">
            <label className="space-y-1.5">
              <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Protocol</span>
              <Select
                value={draft.protocol}
                onValueChange={(value) => onDraftChange({ ...draft, protocol: value as NetworkProxyProtocol })}
                options={PROXY_PROTOCOL_OPTIONS}
              />
            </label>

            <label className="space-y-1.5">
              <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Host</span>
              <Input
                value={draft.host}
                onChange={(event) => onDraftChange({ ...draft, host: event.target.value })}
                placeholder="proxy.company.net"
                spellCheck={false}
              />
            </label>

            <label className="space-y-1.5">
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

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Username</span>
              <Input
                value={draft.username}
                onChange={(event) => onDraftChange({ ...draft, username: event.target.value })}
                placeholder="Optional"
                autoComplete="username"
                spellCheck={false}
              />
            </label>

            <label className="space-y-1.5">
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
        </div>
      </div>
    </Card>

    <Card className="overflow-auto p-5">
      <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Notes</p>
      <div className="mt-4 space-y-3 text-sm text-zinc-400">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
          The proxy is applied in the Electron main process and worker-backed provider requests, so background runs and chats use the same setting.
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
          Proxy passwords are stored in BuildWarden&apos;s encrypted secret store, not in the SQLite settings database.
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
          Local calls stay direct automatically. That keeps embedded localhost tooling and local model endpoints reachable without proxy loops.
        </div>
      </div>
    </Card>
  </div>
);
