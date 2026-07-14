import type { NetworkProxyProtocol } from "@buildwarden/shared";
import { Globe, Info, Loader2, ShieldCheck } from "lucide-react";
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
  <div className="grid gap-3">
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
