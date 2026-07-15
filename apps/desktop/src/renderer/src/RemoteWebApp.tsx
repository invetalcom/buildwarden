import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_SESSION_PATH,
  type RemoteAccessPairingExchangeResponse,
  type RemoteAccessSession,
} from "@buildwarden/shared";
import { FolderPlus, KeyRound, Loader2, LockKeyhole, LogOut, MonitorDot } from "lucide-react";
import { App } from "./App";
import { RemoteHostProjectDialog } from "./components/app/RemoteHostProjectDialog";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { setActiveBuildWardenClient } from "./lib/buildwarden-client-core";
import { createRemoteBuildWardenClient } from "./lib/remote-buildwarden-client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

type RemoteWebState =
  | { status: "checking" }
  | { status: "pairing"; error?: string }
  | { status: "authenticated"; session: RemoteAccessSession };

const browserLabel = (): string => {
  const platform = navigator.platform || "browser";
  return `Web · ${platform}`.slice(0, 80);
};

const pairingCodeFromFragment = (): string => {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("pair") ?? "";
  return value.replace(/\s+/g, "").toUpperCase().slice(0, 64);
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

const PairingGate = ({ initialError, onPaired }: { initialError?: string; onPaired: (session: RemoteAccessSession) => void }) => {
  const [code, setCode] = useState(pairingCodeFromFragment);
  const [error, setError] = useState(initialError ?? "");
  const [pairing, setPairing] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedCode = code.replace(/\s+/g, "").toUpperCase();
    if (!normalizedCode || pairing) return;
    setPairing(true);
    setError("");
    try {
      const response = await fetch(REMOTE_ACCESS_PAIRING_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalizedCode, label: browserLabel() }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "Pairing failed. Request a fresh code from the desktop app."));
        return;
      }
      const payload = await response.json() as RemoteAccessPairingExchangeResponse;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      onPaired(payload.session);
    } catch {
      setError("The BuildWarden host is unavailable. Keep the desktop app running and try again.");
    } finally {
      setPairing(false);
    }
  };

  return (
    <main className="remote-pairing-shell theme-dark flex min-h-[100svh] items-center justify-center bg-[var(--ec-bg)] px-3 py-6 text-[var(--ec-text)] sm:px-4 sm:py-8">
      <section className="remote-pairing-panel w-full max-w-md overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/30">
        <div className="border-b border-[var(--ec-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-[var(--ec-accent)]/40 bg-[var(--ec-accent)]/10 text-[var(--ec-accent)]">
              <MonitorDot className="size-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--ec-accent)]">BuildWarden</p>
              <h1 className="mt-0.5 text-base font-semibold">Remote access</h1>
            </div>
          </div>
        </div>

        <form className="space-y-4 p-5" onSubmit={(event) => void submit(event)}>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole className="size-4 text-[var(--ec-muted)]" />
              Pair this browser
            </div>
            <p className="mt-1.5 text-xs leading-5 text-[var(--ec-muted)]">
              In the desktop app, open Settings → Network → Remote access and create a one-time code.
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ec-faint)]">Pairing code</span>
            <Input
              autoFocus
              autoComplete="one-time-code"
              inputMode="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="XXXX-XXXX"
              className="h-10 font-mono text-base uppercase tracking-[0.24em]"
              aria-describedby={error ? "remote-pairing-error" : undefined}
            />
          </label>

          {error ? (
            <p id="remote-pairing-error" role="alert" className="rounded-md border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-300">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full justify-center" disabled={!code.trim() || pairing}>
            {pairing ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {pairing ? "Pairing…" : "Pair browser"}
          </Button>

          <p className="text-center text-[11px] leading-4 text-[var(--ec-faint)]">
            The code expires quickly and can be used once. Remote access remains bound to this BuildWarden host.
          </p>
        </form>
      </section>
    </main>
  );
};

export const RemoteWebApp = () => {
  const [state, setState] = useState<RemoteWebState>({ status: "checking" });
  const [showHostProjectDialog, setShowHostProjectDialog] = useState(false);

  useEffect(() => {
    let disposed = false;
    void fetch(REMOTE_ACCESS_SESSION_PATH, { credentials: "same-origin" })
      .then(async (response) => {
        if (disposed) return;
        if (response.status === 401) {
          setState({ status: "pairing" });
          return;
        }
        if (!response.ok) {
          setState({ status: "pairing", error: await readErrorMessage(response, "Could not verify the remote session.") });
          return;
        }
        const payload = await response.json() as RemoteAccessPairingExchangeResponse;
        setState({ status: "authenticated", session: payload.session });
      })
      .catch(() => {
        if (!disposed) setState({ status: "pairing", error: "The BuildWarden host is unavailable." });
      });
    return () => {
      disposed = true;
    };
  }, []);

  const client = useMemo(() => {
    if (state.status !== "authenticated") return null;
    return createRemoteBuildWardenClient({
      scopes: state.session.scopes,
      onSessionExpired: () => setState({ status: "pairing", error: "Your remote session expired or was revoked." }),
    });
  }, [state]);

  useEffect(() => {
    if (client) setActiveBuildWardenClient(client);
  }, [client]);

  if (state.status === "checking") {
    return (
      <main className="theme-dark flex min-h-screen items-center justify-center bg-[var(--ec-bg)] text-[var(--ec-muted)]">
        <Loader2 className="size-5 animate-spin" aria-label="Checking remote session" />
      </main>
    );
  }

  if (state.status === "pairing" || !client) {
    return <PairingGate initialError={state.status === "pairing" ? state.error : undefined} onPaired={(session) => setState({ status: "authenticated", session })} />;
  }

  const disconnect = async () => {
    try {
      await fetch(REMOTE_ACCESS_SESSION_PATH, { method: "DELETE", credentials: "same-origin" });
    } finally {
      setActiveBuildWardenClient(null);
      setState({ status: "pairing" });
    }
  };

  const controlEnabled = client.capabilities.mutations;

  return (
    <BuildWardenClientProvider client={client}>
      <div className="remote-app-entry h-[100svh]">
        <App />
        <RemoteHostProjectDialog
          client={client}
          open={showHostProjectDialog}
          onClose={() => setShowHostProjectDialog(false)}
          onProjectAdded={() => window.location.reload()}
        />
        <div className="remote-session-chip fixed right-2 bottom-2 z-30 flex items-center gap-1.5 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)]/95 px-2 py-1.5 text-[10px] shadow-lg backdrop-blur sm:right-3 sm:bottom-3 sm:gap-2 sm:px-2.5">
          <MonitorDot className="size-3.5 text-[var(--ec-accent)]" />
          <span className="hidden font-semibold uppercase tracking-[0.16em] text-[var(--ec-muted)] sm:inline">{controlEnabled ? "Remote control" : "Read-only remote"}</span>
          {client.capabilities.hostDirectoryBrowser ? (
            <button type="button" className="ml-1 inline-flex items-center gap-1 text-[var(--ec-faint)] transition hover:text-[var(--ec-text)]" onClick={() => setShowHostProjectDialog(true)}>
              <FolderPlus className="size-3" />
              <span className="hidden sm:inline">Add host project</span>
            </button>
          ) : null}
          <button type="button" className="ml-1 inline-flex items-center gap-1 text-[var(--ec-faint)] transition hover:text-[var(--ec-text)]" onClick={() => void disconnect()}>
            <LogOut className="size-3" />
            <span className="hidden sm:inline">Disconnect</span>
          </button>
        </div>
      </div>
    </BuildWardenClientProvider>
  );
};
