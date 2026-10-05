import { useCallback, useEffect, useRef, useState } from "react";
import type { RunRecord, RunVerificationState, WorkspaceRevision } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { Button } from "../ui/button";

export const RunVerificationPanel = ({ client, run, reviewedRevision, displayedRevision }: {
  client: BuildWardenClient; run: RunRecord; reviewedRevision?: WorkspaceRevision; displayedRevision?: WorkspaceRevision | null;
}) => {
  const [state, setState] = useState<RunVerificationState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = ["queued", "preparing", "running"].includes(run.status);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try { const next = await client.getRunVerification(run.id); if (id === sequence.current) { setState(next); setError(""); } }
    catch (e) { if (id === sequence.current) { setState(null); setError(String(e)); } }
  }, [client, run.id]);
  useEffect(() => {
    setState(null);
    if (active) { ++sequence.current; return; }
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focus);
    const unsubscribe = client.onRunEvent((event) => { if (event.runId === run.id && event.type === "status") void refresh(); });
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); unsubscribe(); };
  }, [client, run.id, run.status, active, refresh]);
  const verify = async () => {
    setBusy(true); setError("");
    try { await client.verifyRunRevision(run.id); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const running = busy || state?.status === "running";
  const diffChanged = displayedRevision && state?.currentRevision && (displayedRevision.fingerprint !== state.currentRevision.fingerprint || displayedRevision.head !== state.currentRevision.head);
  const reviewChanged = reviewedRevision && state?.currentRevision && (reviewedRevision.fingerprint !== state.currentRevision.fingerprint || reviewedRevision.head !== state.currentRevision.head);
  // Wait for configuration before showing the panel, so disabled gates never flash a status.
  if (active || (!state && !error) || (state && state.commands.length === 0)) return null;
  return <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-semibold">Verification</span>
      <span className={state?.status === "passed" && !running ? "text-[var(--ec-success)]" : "text-[var(--ec-warning)]"}>{running ? "running" : state?.status ?? "checking"}</span>
      {state?.requiredBeforePublish && <span className="text-[var(--ec-muted)]">Required before commit or publish</span>}
      <div className="ml-auto flex gap-2">
        <Button size="xs" variant="secondary" onClick={() => void refresh()}>Refresh</Button>
        {client.capabilities.runMutations && (running
          ? <Button size="xs" variant="secondary" onClick={() => void client.cancelRunVerification(run.id).then(refresh).catch((e) => setError(String(e)))}>Cancel check</Button>
          : <Button size="xs" variant="secondary" disabled={active || !state?.commands.length} onClick={() => void verify()}>Run verification</Button>)}
      </div>
    </div>
    {error && <p role="alert" className="mt-1 text-[var(--ec-danger)]">{error}</p>}
    {state?.reason && <p className="mt-1 text-[var(--ec-muted)]">{state.reason}</p>}
    {displayedRevision === null && <p className="mt-1 text-[var(--ec-warning)]">The displayed diff has no stable revision. Refresh it before reviewing.</p>}
    {diffChanged && <p className="mt-1 text-[var(--ec-warning)]">The displayed diff is stale. Refresh the diff to review the current verification revision.</p>}
    {reviewedRevision && <p className={reviewChanged ? "mt-1 text-[var(--ec-warning)]" : "mt-1 text-[var(--ec-muted)]"}>{reviewChanged ? "Review is stale: workspace contents changed." : "Reviewed contents"} · {reviewedRevision.fingerprint.slice(0, 20)}</p>}
    {state?.record && <details className="mt-1 text-[var(--ec-muted)]">
      <summary className="cursor-pointer">Evidence · {state.record.finishedAt ? new Date(state.record.finishedAt).toLocaleString() : "in progress"} · {state.record.revision?.fingerprint.slice(0, 20) ?? "revision unavailable"}</summary>
      <p className="mt-1 break-all">Verified revision: {state.record.revision?.fingerprint ?? "unavailable"}{state.record.revision?.head ? ` · HEAD ${state.record.revision.head}` : ""}</p>
      {state.record.results.map((result, index) => <details key={index} className="mt-1">
        <summary className="cursor-pointer font-mono">{result.ok ? "Passed" : "Failed"} · {result.command} · {result.durationMs} ms · exit {result.exitCode ?? "—"}{result.timedOut ? " · timed out" : ""}</summary>
        <pre className="app-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words p-2">{result.output}</pre>
      </details>)}
    </details>}
  </div>;
};
