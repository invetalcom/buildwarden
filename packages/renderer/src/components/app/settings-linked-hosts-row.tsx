import { useCallback, useEffect, useState } from "react";
import type { LinkedHostRecord } from "@buildwarden/shared";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/motion";
import { SettingsRow } from "./settings-layout";

/** Other BuildWarden hosts that orchestrations may run delegated tasks on. */
export function LinkedHostsRow() {
  const buildwarden = useBuildWardenClient();
  const [hosts, setHosts] = useState<LinkedHostRecord[]>([]);
  const [draft, setDraft] = useState({ label: "", mcpUrl: "", token: "" });
  const [status, setStatus] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setHosts(await buildwarden.listLinkedHosts());
  }, [buildwarden]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const run = async (key: string, action: () => Promise<void>) => {
    setWorking(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(null);
    }
  };
  const add = () => void run("add", async () => {
    const host = await buildwarden.saveLinkedHost(draft);
    setDraft({ label: "", mcpUrl: "", token: "" });
    await refresh();
    const { projects } = await buildwarden.checkLinkedHost(host.id);
    setStatus((current) => ({ ...current, [host.id]: `${String(projects.length)} project${projects.length === 1 ? "" : "s"}` }));
  });
  const check = (host: LinkedHostRecord) => void run(host.id, async () => {
    try {
      const { projects } = await buildwarden.checkLinkedHost(host.id);
      setStatus((current) => ({ ...current, [host.id]: `${String(projects.length)} project${projects.length === 1 ? "" : "s"}` }));
    } catch (caught) {
      setStatus((current) => ({ ...current, [host.id]: caught instanceof Error ? caught.message : "Unreachable" }));
    }
  });

  return (
    <SettingsRow
      align="start"
      title="Linked hosts"
      description={(
        <>
          <p>Orchestrations can run delegated tasks on these BuildWarden hosts. Create an agent token with Start runs on the other host, then add its MCP URL and token here.</p>
          <p className="text-[var(--ec-faint)]">A remote task&apos;s changes stay on that host, and its approvals are answered there.</p>
        </>
      )}
    >
      <div className="flex w-full flex-col gap-1.5 md:items-end">
        {hosts.map((host) => (
          <div key={host.id} className="flex w-full max-w-md items-center gap-1 rounded-md bg-[var(--ec-panel-soft)] py-0.5 pr-0.5 pl-2.5 text-xs">
            <span className="min-w-0 flex-1 truncate" title={host.mcpUrl}>
              <span className="text-[var(--ec-text)]">{host.label}</span>
              <span className="ml-1.5 text-[var(--ec-muted)]">{status[host.id] ?? host.mcpUrl}</span>
            </span>
            <Button type="button" variant="ghost" size="xs" disabled={working !== null} aria-label={`Check ${host.label}`} title="Check the connection" onClick={() => check(host)}>
              <Spinner icon={RefreshCw} spinning={working === host.id} className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={working !== null} aria-label={`Remove ${host.label}`} title="Remove"
              onClick={() => void run(host.id, async () => { await buildwarden.removeLinkedHost(host.id); await refresh(); })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex w-full max-w-md flex-wrap items-center gap-1.5">
          <Input className="h-7 w-28 text-xs" value={draft.label} placeholder="Name" aria-label="Linked host name"
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} disabled={working !== null} />
          <Input className="h-7 min-w-40 flex-1 font-mono text-xs" value={draft.mcpUrl} placeholder="https://host.ts.net/mcp" aria-label="Linked host MCP URL" spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, mcpUrl: event.target.value }))} disabled={working !== null} />
          <Input className="h-7 w-28 font-mono text-xs" type="password" value={draft.token} placeholder="Token" aria-label="Linked host agent token"
            onChange={(event) => setDraft((current) => ({ ...current, token: event.target.value }))} disabled={working !== null} />
          <Button type="button" size="xs" disabled={working !== null || !draft.label.trim() || !draft.mcpUrl.trim() || !draft.token.trim()} onClick={add}>
            {working === "add" ? <Spinner className="mr-1 size-3.5" /> : <Plus className="mr-1 size-3.5" />}Add
          </Button>
        </div>
        {error ? <p className="text-[11px] text-[var(--ec-danger)]" role="alert">{error}</p> : null}
      </div>
    </SettingsRow>
  );
}
