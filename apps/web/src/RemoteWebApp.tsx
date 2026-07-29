import { useEffect, useState, type FormEvent } from "react";
import {
  App,
  BuildWardenClientProvider,
  Button,
  Input,
  RemoteHostProjectDialog,
} from "@buildwarden/renderer";
import { FolderPlus, KeyRound, Loader2, LockKeyhole, LogOut, MonitorDot, RefreshCw } from "lucide-react";
import { HOSTED_MODE, useRemoteSession } from "./session/use-remote-session";

interface PairingGateProps {
  initialError?: string;
  initialCode: string;
  initialHostOrigin: string;
  onPair: (code: string, hostOrigin: string) => Promise<string | null>;
}

const PairingGate = ({ initialError, initialCode, initialHostOrigin, onPair }: PairingGateProps) => {
  const [code, setCode] = useState(initialCode);
  const [hostOrigin, setHostOrigin] = useState(initialHostOrigin);
  const [error, setError] = useState(initialError ?? "");
  const [pairing, setPairing] = useState(false);

  const pair = async () => {
    if (!code.replace(/\s+/g, "") || pairing) return;
    setPairing(true);
    setError("");
    try {
      const message = await onPair(code, hostOrigin);
      if (message) setError(message);
    } finally {
      setPairing(false);
    }
  };

  useEffect(() => {
    if (HOSTED_MODE && initialCode && initialHostOrigin) void pair();
    // The fragment is a one-time initial instruction. Input edits must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void pair();
  };

  return (
    <main className="remote-pairing-shell theme-dark flex min-h-[100svh] items-center justify-center bg-[var(--ec-bg)] px-3 py-6 text-[var(--ec-text)] sm:px-4 sm:py-8">
      <section className="remote-pairing-panel w-full max-w-md overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/30">
        <div className="border-b border-[var(--ec-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-[var(--ec-accent)]/40 bg-[var(--ec-accent)]/10 text-[var(--ec-accent)]"><MonitorDot className="size-4.5" /></div>
            <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--ec-accent)]">BuildWarden</p><h1 className="mt-0.5 text-base font-semibold">Remote access</h1></div>
          </div>
        </div>
        <form className="space-y-4 p-5" onSubmit={submit}>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium"><LockKeyhole className="size-4 text-[var(--ec-muted)]" />Pair this browser</div>
            <p className="mt-1.5 text-xs leading-5 text-[var(--ec-muted)]">In the desktop app, open Settings → Network → Remote access and create a one-time {HOSTED_MODE ? "hosted website" : "host-served"} code.</p>
          </div>
          {HOSTED_MODE ? (
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ec-faint)]">BuildWarden host</span>
              <Input autoFocus={!initialHostOrigin} value={hostOrigin} onChange={(event) => setHostOrigin(event.target.value)} placeholder="https://device.tailnet.ts.net" spellCheck={false} />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ec-faint)]">Pairing code</span>
            <Input autoFocus={!HOSTED_MODE} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="BW-XXXX-XXXX-XXXX" className="h-10 font-mono text-base uppercase tracking-[0.16em]" aria-describedby={error ? "remote-pairing-error" : undefined} />
          </label>
          {error ? <p id="remote-pairing-error" role="alert" className="rounded-md border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-300">{error}</p> : null}
          <Button type="submit" className="w-full justify-center" disabled={!code.trim() || (HOSTED_MODE && !hostOrigin.trim()) || pairing}>
            {pairing ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}{pairing ? "Pairing…" : "Pair browser"}
          </Button>
          <p className="text-center text-[11px] leading-4 text-[var(--ec-faint)]">The desktop host stays authoritative and must remain running. The Vercel server never receives application data.</p>
        </form>
      </section>
    </main>
  );
};

export const RemoteWebApp = () => {
  const { state, client, pairingHint, pair, disconnect } = useRemoteSession();
  const [showHostProjectDialog, setShowHostProjectDialog] = useState(false);

  if (state.status === "checking") {
    return <main className="theme-dark flex min-h-screen items-center justify-center bg-[var(--ec-bg)] text-[var(--ec-muted)]"><Loader2 className="size-5 animate-spin" aria-label="Checking remote session" /></main>;
  }
  if (state.status === "pairing" || !client) {
    return <PairingGate initialError={state.status === "pairing" ? state.error : undefined} initialCode={pairingHint.code} initialHostOrigin={pairingHint.hostOrigin} onPair={pair} />;
  }

  const controlEnabled = client.capabilities.mutations;
  return (
    <BuildWardenClientProvider client={client}>
      <div className="remote-app-entry h-[100svh]">
        <App />
        <RemoteHostProjectDialog client={client} open={showHostProjectDialog} onClose={() => setShowHostProjectDialog(false)} onProjectAdded={() => window.location.reload()} />
        <div className="remote-session-chip fixed right-2 bottom-2 z-30 flex items-center gap-1.5 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)]/95 px-2 py-1.5 text-[10px] shadow-lg backdrop-blur sm:right-3 sm:bottom-3 sm:gap-2 sm:px-2.5">
          <MonitorDot className="size-3.5 text-[var(--ec-accent)]" />
          <span className="hidden font-semibold uppercase tracking-[0.16em] text-[var(--ec-muted)] sm:inline">{controlEnabled ? "Remote control" : "Read-only remote"}</span>
          {client.capabilities.hostDirectoryBrowser ? <button type="button" className="ml-1 inline-flex items-center gap-1 text-[var(--ec-faint)] transition hover:text-[var(--ec-text)]" onClick={() => setShowHostProjectDialog(true)}><FolderPlus className="size-3" /><span className="hidden sm:inline">Add host project</span></button> : null}
          {HOSTED_MODE ? <button type="button" className="ml-1 inline-flex items-center gap-1 text-[var(--ec-faint)] transition hover:text-[var(--ec-text)]" onClick={() => void disconnect(true)}><RefreshCw className="size-3" /><span className="hidden sm:inline">Change host</span></button> : null}
          <button type="button" className="ml-1 inline-flex items-center gap-1 text-[var(--ec-faint)] transition hover:text-[var(--ec-text)]" onClick={() => void disconnect()}><LogOut className="size-3" /><span className="hidden sm:inline">Disconnect</span></button>
        </div>
      </div>
    </BuildWardenClientProvider>
  );
};
