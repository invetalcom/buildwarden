import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_SESSION_PATH,
  type RemoteAccessPairingExchangeResponse,
  type RemoteAccessSession,
} from "@buildwarden/shared";
import {
  App,
  BuildWardenClientProvider,
  Button,
  Input,
  RemoteHostProjectDialog,
  createRemoteBuildWardenClient,
  setActiveBuildWardenClient,
} from "@buildwarden/renderer";
import { FolderPlus, KeyRound, Loader2, LockKeyhole, LogOut, MonitorDot, RefreshCw } from "lucide-react";
import {
  clearHostedConnection,
  readHostedConnection,
  saveHostedConnection,
  type HostedConnection,
} from "./hosted-connection-store";
import { normalizeRemoteHostOrigin, pairingDetailsFromFragment } from "./remote-pairing-code";

const HOSTED_MODE = import.meta.env.VITE_WEB_MODE === "hosted";

type RemoteWebState =
  | { status: "checking" }
  | { status: "pairing"; error?: string }
  | { status: "authenticated"; session: RemoteAccessSession; connection?: HostedConnection };

const browserLabel = (): string => `Web · ${navigator.platform || "browser"}`.slice(0, 80);

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

const sessionHeaders = (token: string | undefined): HeadersInit => token
  ? { Authorization: `Bearer ${token}` }
  : {};

interface PairingGateProps {
  initialError?: string;
  initialCode: string;
  initialHostOrigin: string;
  onPaired: (session: RemoteAccessSession, connection?: HostedConnection) => void;
}

const PairingGate = ({ initialError, initialCode, initialHostOrigin, onPaired }: PairingGateProps) => {
  const [code, setCode] = useState(initialCode);
  const [hostOrigin, setHostOrigin] = useState(initialHostOrigin);
  const [error, setError] = useState(initialError ?? "");
  const [pairing, setPairing] = useState(false);

  const pair = async () => {
    const normalizedCode = code.replace(/\s+/g, "").toUpperCase();
    const normalizedHost = HOSTED_MODE ? normalizeRemoteHostOrigin(hostOrigin) : "";
    if (!normalizedCode || pairing) return;
    if (HOSTED_MODE && !normalizedHost) {
      setError("Enter the Tailscale HTTPS URL shown by the BuildWarden desktop app.");
      return;
    }
    setPairing(true);
    setError("");
    try {
      const response = await fetch(`${normalizedHost}${REMOTE_ACCESS_PAIRING_PATH}`, {
        method: "POST",
        credentials: HOSTED_MODE ? "omit" : "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalizedCode, label: browserLabel() }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "Pairing failed. Request a fresh code from the desktop app."));
        return;
      }
      const payload = await response.json() as RemoteAccessPairingExchangeResponse;
      if (HOSTED_MODE) {
        if (!payload.token || !normalizedHost) {
          setError("The host did not issue an origin-bound browser session.");
          return;
        }
        const connection = { hostOrigin: normalizedHost, token: payload.token, session: payload.session };
        await saveHostedConnection(connection);
        onPaired(payload.session, connection);
      } else {
        onPaired(payload.session);
      }
    } catch {
      setError("The BuildWarden host is unavailable. Keep the desktop app and Tailscale running, then try again.");
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
  const [pairingHint, setPairingHint] = useState(pairingDetailsFromFragment);
  const [state, setState] = useState<RemoteWebState>({ status: "checking" });
  const [showHostProjectDialog, setShowHostProjectDialog] = useState(false);

  useEffect(() => {
    let disposed = false;
    const check = async () => {
      if (HOSTED_MODE && pairingHint.code && pairingHint.hostOrigin) {
        let replacementWarning: string | undefined;
        const existing = await readHostedConnection().catch(() => null);
        if (existing) {
          try {
            await fetch(`${existing.hostOrigin}${REMOTE_ACCESS_SESSION_PATH}`, {
              method: "DELETE",
              credentials: "omit",
              headers: sessionHeaders(existing.token),
            });
          } catch {
            replacementWarning = "The previous host was unreachable. Revoke that browser session from its desktop settings when possible.";
          }
          await clearHostedConnection().catch(() => undefined);
        }
        setState({ status: "pairing", ...(replacementWarning ? { error: replacementWarning } : {}) });
        return;
      }
      let connection: HostedConnection | undefined;
      try {
        connection = HOSTED_MODE ? await readHostedConnection() ?? undefined : undefined;
        if (HOSTED_MODE && !connection) {
          setState({ status: "pairing" });
          return;
        }
        const response = await fetch(`${connection?.hostOrigin ?? ""}${REMOTE_ACCESS_SESSION_PATH}`, {
          credentials: connection ? "omit" : "same-origin",
          headers: sessionHeaders(connection?.token),
        });
        if (disposed) return;
        if (!response.ok) {
          if (connection) await clearHostedConnection();
          setState({
            status: "pairing",
            error: response.status === 401
              ? "Your remote session expired or was revoked."
              : await readErrorMessage(response, "Could not verify the remote session."),
          });
          return;
        }
        const payload = await response.json() as RemoteAccessPairingExchangeResponse;
        if (connection) {
          connection = { ...connection, session: payload.session };
          await saveHostedConnection(connection);
        }
        setState({ status: "authenticated", session: payload.session, ...(connection ? { connection } : {}) });
      } catch {
        if (!disposed) setState({ status: "pairing", error: "The BuildWarden host is unavailable." });
      }
    };
    void check();
    return () => { disposed = true; };
  }, [pairingHint]);

  const client = useMemo(() => {
    if (state.status !== "authenticated") return null;
    return createRemoteBuildWardenClient({
      baseUrl: state.connection?.hostOrigin,
      sessionToken: state.connection?.token,
      scopes: state.session.scopes,
      onSessionExpired: () => {
        void clearHostedConnection();
        setState({ status: "pairing", error: "Your remote session expired or was revoked." });
      },
    });
  }, [state]);

  useEffect(() => {
    setActiveBuildWardenClient(client);
    return () => setActiveBuildWardenClient(null);
  }, [client]);

  if (state.status === "checking") {
    return <main className="theme-dark flex min-h-screen items-center justify-center bg-[var(--ec-bg)] text-[var(--ec-muted)]"><Loader2 className="size-5 animate-spin" aria-label="Checking remote session" /></main>;
  }
  if (state.status === "pairing" || !client) {
    return <PairingGate initialError={state.status === "pairing" ? state.error : undefined} initialCode={pairingHint.code} initialHostOrigin={pairingHint.hostOrigin} onPaired={(session, connection) => {
      setPairingHint({ code: "", hostOrigin: "" });
      setState({ status: "authenticated", session, ...(connection ? { connection } : {}) });
    }} />;
  }

  const disconnect = async (changeHost = false) => {
    const connection = state.status === "authenticated" ? state.connection : undefined;
    let revokeFailed = false;
    try {
      const response = await fetch(`${connection?.hostOrigin ?? ""}${REMOTE_ACCESS_SESSION_PATH}`, {
        method: "DELETE",
        credentials: connection ? "omit" : "same-origin",
        headers: sessionHeaders(connection?.token),
      });
      if (!response.ok && response.status !== 401) revokeFailed = Boolean(connection);
    } catch {
      revokeFailed = Boolean(connection);
    } finally {
      await clearHostedConnection().catch(() => undefined);
      setPairingHint({ code: "", hostOrigin: "" });
      setActiveBuildWardenClient(null);
      setState({
        status: "pairing",
        error: revokeFailed && changeHost
          ? "The previous host was unreachable. Revoke that browser session from its desktop settings when possible."
          : undefined,
      });
    }
  };

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
