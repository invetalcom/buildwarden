import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, LockKeyhole, MonitorSmartphone, Monitor } from "lucide-react";
import { HOSTED_MODE } from "../../session/use-remote-session";
import { switchShell } from "../../shell/select-shell";
import { Button, Input } from "../components/primitives";

/**
 * Mobile pairing gate. Same state machine as the desktop gate (`useRemoteSession`), entirely its
 * own layout: full-bleed, one field per row, a 48px submit button inside thumb reach, and no
 * two-column form.
 */
export const PairingScreen = ({
  initialError,
  initialCode,
  initialHostOrigin,
  onPair,
}: {
  initialError?: string;
  initialCode: string;
  initialHostOrigin: string;
  onPair: (code: string, hostOrigin: string) => Promise<string | null>;
}) => {
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
    // The fragment is a one-time initial instruction; edits to the fields must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void pair();
  };

  return (
    <main className="m-shell m-safe-top m-safe-bottom justify-between px-5 pb-5">
      <div className="flex flex-1 flex-col justify-center gap-6 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]">
            <MonitorSmartphone className="size-7" />
          </span>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-[var(--ec-accent)]">BuildWarden</p>
            <h1 className="mt-1 text-xl font-semibold">Remote access</h1>
          </div>
        </div>

        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2.5">
            <LockKeyhole className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" />
            <p className="text-xs leading-5 text-[var(--ec-muted)]">
              On the desktop app open <span className="text-[var(--ec-text)]">Settings → Network → Remote access</span> and
              create a one-time {HOSTED_MODE ? "hosted website" : "host-served"} code.
            </p>
          </div>

          {HOSTED_MODE ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">
                BuildWarden host
              </span>
              <Input
                value={hostOrigin}
                onChange={(event) => setHostOrigin(event.target.value)}
                placeholder="https://device.tailnet.ts.net"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                inputMode="url"
                enterKeyHint="next"
              />
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">
              Pairing code
            </span>
            <Input
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="BW-XXXX-XXXX-XXXX"
              className="m-mono h-12 text-base uppercase tracking-[0.16em]"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-describedby={error ? "mobile-pairing-error" : undefined}
            />
          </label>

          {error ? (
            <p
              id="mobile-pairing-error"
              role="alert"
              className="m-wrap-anywhere rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-xs leading-5 text-[var(--ec-danger)]"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            block
            busy={pairing}
            className="h-12"
            disabled={!code.trim() || (HOSTED_MODE && !hostOrigin.trim())}
          >
            {pairing ? null : <KeyRound className="size-4" />}
            {pairing ? "Pairing…" : "Pair this phone"}
          </Button>
        </form>
      </div>

      <div className="flex flex-col items-center gap-3">
        <p className="text-center text-[11px] leading-4 text-[var(--ec-faint)]">
          The desktop host stays authoritative and must remain running. The Vercel server never receives application data.
        </p>
        <button
          type="button"
          onClick={() => switchShell(window, "desktop")}
          className="m-tap inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ec-muted)]"
        >
          <Monitor className="size-3.5" />
          Use the desktop layout
        </button>
      </div>
    </main>
  );
};
