import { useCallback, useEffect, useRef, useState } from "react";
import type { RunTerminalSummary, TerminalShell } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { RunWorktreeTerminal, type RunWorktreeTerminalProps } from "./RunWorktreeTerminal";
import { runWorktreeTerminalSessionId } from "./run-worktree-terminal-session";

export const RunTerminalWorkspace = (props: RunWorktreeTerminalProps) =>
  <TerminalWorkspace key={props.runId} {...props} />;

const TerminalWorkspace = (props: RunWorktreeTerminalProps) => {
  const client = useBuildWardenClient();
  const [sessions, setSessions] = useState<RunTerminalSummary[]>([]);
  const [shells, setShells] = useState<TerminalShell[]>(["auto"]);
  const [shell, setShell] = useState<TerminalShell>("auto");
  const [selected, setSelected] = useState<string>();
  const [split, setSplit] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshVersion = useRef(0);
  const invalidateRefresh = useCallback(() => { refreshVersion.current++; }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    let result;
    try { result = await client.runTerminalList(props.runId); }
    catch (error) { if (version === refreshVersion.current) throw error; else return; }
    if (version !== refreshVersion.current) return;
    setSessions(result.sessions);
    setShells(result.shells);
    setSelected((id) => result.sessions.some((session) => session.sessionId === id) ? id : result.sessions[0]?.sessionId);
  }, [client, props.runId]);
  useEffect(() => {
    if (props.disabled || props.uiActive === false) return;
    let disposed = false;
    const update = () => { if (!disposed) void refresh().catch((e: unknown) => { if (!disposed) setError(String(e)); }); };
    update();
    // Other viewers and preview startup can create/close terminals on the same host.
    const timer = window.setInterval(update, 3_000);
    const unsubscribe = client.onRunTerminalExit(update);
    return () => { disposed = true; invalidateRefresh(); window.clearInterval(timer); unsubscribe(); };
  }, [client, props.disabled, props.uiActive, refresh, invalidateRefresh]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); await refresh(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const create = () => act(async () => {
    const sessionId = runWorktreeTerminalSessionId(props.runId, crypto.randomUUID());
    const result = await client.runTerminalStart({ sessionId, runId: props.runId, cwd: props.cwd, shell });
    if (!result.ok) throw new Error(result.error);
    setSelected(sessionId);
  });
  const restart = () => act(async () => {
    if (!selected) return;
    const result = await client.runTerminalStart({ sessionId: selected, runId: props.runId, cwd: props.cwd, shell, restart: true });
    if (!result.ok) throw new Error(result.error);
    setRevision((value) => value + 1);
  });
  const visible = sessions.filter((session) => session.sessionId === selected);
  const other = sessions.find((session) => session.sessionId !== selected);
  if (split && other) visible.push(other);
  return <div className={cn("flex min-h-0 flex-col gap-1", props.className)}>
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <div role="tablist" aria-label="Run terminals" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {sessions.map((session, index) => <button key={session.sessionId} type="button" role="tab"
          aria-selected={selected === session.sessionId} title={session.shellFile}
          onClick={() => setSelected(session.sessionId)}
          className={cn("whitespace-nowrap rounded border px-2 py-1", selected === session.sessionId ? "border-[var(--ec-accent)] bg-[var(--ec-panel)]" : "border-[var(--ec-border)] text-[var(--ec-muted)]")}>
          {decodeURIComponent(session.sessionId).endsWith(":preview") ? "Preview" : `Terminal ${index + 1}`} · {session.status}
        </button>)}
      </div>
      <Select ariaLabel="Shell for new or restarted terminal" value={shell} onValueChange={(value) => setShell(value as TerminalShell)}
        options={shells.map((value) => ({ value, label: value === "auto" ? "Auto shell" : value }))}
        className="w-32 shrink-0" triggerClassName="h-7 px-2 text-xs" optionClassName="px-2 text-xs" />
      <Button size="xs" disabled={busy || props.disabled} onClick={() => void create()}>New terminal</Button>
      <Button size="xs" variant="secondary" disabled={sessions.length < 2} onClick={() => setSplit(!split)}>{split ? "Unsplit" : "Split"}</Button>
      <Button size="xs" variant="secondary" disabled={busy || !selected || props.disabled} onClick={() => void restart()}>Restart</Button>
      <Button size="xs" variant="secondary" disabled={busy || !selected} onClick={() => void act(async () => { if (selected) await client.runTerminalKill(selected); })}>Close</Button>
    </div>
    {error && <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p>}
    <div className="flex min-h-0 flex-1 gap-1">
      {visible.map((session) => <RunWorktreeTerminal {...props} key={`${session.sessionId}:${session.generation ?? 0}:${revision}`} sessionId={session.sessionId} className="min-w-0 flex-1" />)}
      {!visible.length && <p className="p-2 text-xs text-[var(--ec-muted)]">{props.disabled ? "Workspace is unavailable." : "Open a terminal to run commands in this workspace."}</p>}
    </div>
  </div>;
};
