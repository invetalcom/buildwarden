import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionLimitsAccount, SubscriptionLimitsReport, SubscriptionResetOutcome } from "@buildwarden/shared";
import { Clock3, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ModalDialog } from "../ui/modal-dialog";
import { ProviderBrandIcon } from "./provider-brand-icons";

const REFRESH_INTERVAL = 5 * 60_000;
const RESET_OUTCOMES: Record<SubscriptionResetOutcome, string> = {
  reset: "Reset applied. Your subscription limits have been refreshed.",
  nothingToReset: "No reset was needed. The provider reports that you are not limited.",
  noCredit: "No reset credit is currently available.",
  alreadyRedeemed: "This reset was already used. Your limits have been refreshed.",
};

function relativeTime(timestamp: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(timestamp) - now) / 60_000));
  if (!minutes) return "Refresh due";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return days ? `in ${days}d ${hours}h` : hours ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

function canReset(account: SubscriptionLimitsAccount, now: number): boolean {
  return account.providerType !== "cursor-agent" && account.status === "fresh"
    && now - Date.parse(account.checkedAt) < REFRESH_INTERVAL
    && Boolean(account.resetCredits?.actionToken) && (account.resetCredits?.availableCount ?? 0) > 0
    && (!account.resetCredits?.nextExpiresAt || Date.parse(account.resetCredits.nextExpiresAt) > now);
}

function AccountLimits({ account, now, busy, canManage, onReset }: {
  account: SubscriptionLimitsAccount; now: number; busy: boolean; canManage: boolean;
  onReset: (account: SubscriptionLimitsAccount) => void;
}) {
  const stale = account.status === "cached";
  const credits = account.resetCredits;
  return (
    <Card className="min-w-0 self-start" aria-label={`${account.label} subscription limits`}>
      <CardHeader className="flex-row items-center justify-between gap-2 px-4 py-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <ProviderBrandIcon harnessType={account.providerType === "codex-cli" ? "codex-app-server" : account.providerType === "cursor-agent" ? "cursor-acp" : "claude-code"} className="size-4 shrink-0" />
          <span className="truncate">{account.label}</span>
        </CardTitle>
        {account.plan ? <span className="text-xs capitalize text-[var(--ec-muted)]">{account.plan}</span> : null}
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 pt-0">
        {account.message ? <p className={`text-xs leading-5 ${stale ? "text-[var(--ec-warning)]" : "text-[var(--ec-muted)]"}`}>{account.message}</p> : null}
        {account.windows.map((window) => (
          <div key={window.id} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-[var(--ec-text)]">{window.label}</span>
              <span className="tabular-nums text-[var(--ec-muted)]">{Math.round(window.usedPercent)}% used <span className="text-[var(--ec-faint)]">· {Math.round(100 - window.usedPercent)}% left</span></span>
            </div>
            <div role="progressbar" aria-label={`${window.label} usage`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100}
              className="h-1.5 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
              <div className="h-full rounded-full transition-[width]" style={{ width: `${window.usedPercent}%`, background: window.usedPercent >= 95 ? "var(--ec-danger)" : window.usedPercent >= 80 ? "var(--ec-warning)" : "var(--ec-accent)" }} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-[var(--ec-muted)]">
              {window.resetsAt ? <>
                <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{Date.parse(window.resetsAt) > now ? `Resets ${relativeTime(window.resetsAt, now)}` : "Reset due · refresh to check"}</span>
                <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{new Date(window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
              </> : <span>Reset time not reported</span>}
            </div>
          </div>
        ))}
        {credits ? <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ec-border)] pt-3">
          <div className="text-xs">
            <div className="font-medium text-[var(--ec-text)]">{credits.availableCount} reset {credits.availableCount === 1 ? "credit" : "credits"}</div>
            {credits.nextExpiresAt ? <div className="mt-1 text-[11px] text-[var(--ec-muted)]" title={new Date(credits.nextExpiresAt).toLocaleString()}>
              {Date.parse(credits.nextExpiresAt) > now ? `Next expires ${relativeTime(credits.nextExpiresAt, now)}` : "Credit expired · refresh to check"}
            </div> : null}
          </div>
          {credits.availableCount > 0 ? <Button size="xs" variant="secondary" disabled={busy || !canManage || !canReset(account, now)} onClick={() => onReset(account)}
            title={!canManage ? "Requires settings access" : !canReset(account, now) ? "Refresh Limits to check reset availability" : "Use one subscription reset credit"}>
            <RotateCcw className="size-3" />Use reset
          </Button> : null}
        </div> : account.windows.length ? <p className="border-t border-[var(--ec-border)] pt-3 text-[11px] text-[var(--ec-muted)]">
          {account.providerType === "cursor-agent" ? "Cursor resets on its billing schedule." : "No reset credits reported."}
        </p> : null}
        {account.windows.length ? <p className="text-[10px] text-[var(--ec-faint)]">{stale ? "Last reading" : "Updated"} {new Date(account.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{stale ? " · cached" : ""}</p> : null}
      </CardContent>
    </Card>
  );
}

export function LimitsPage() {
  const client = useBuildWardenClient();
  const [report, setReport] = useState<SubscriptionLimitsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SubscriptionLimitsAccount | null>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return;
    const request = ++sequence.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await client.getSubscriptionLimits({ refresh: force });
      if (mounted.current && request === sequence.current) { setReport(next); setNow(Date.now()); }
    } catch {
      if (mounted.current && request === sequence.current) setError("Could not load subscription limits. Try refreshing.");
    } finally {
      if (mounted.current && request === sequence.current) { inFlight.current = false; setBusy(false); }
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    setReport(null);
    setConfirm(null);
    setNotice(null);
    void refresh();
    const poll = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, REFRESH_INTERVAL);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted.current = false; sequence.current += 1; inFlight.current = false; clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  const redeemReset = async () => {
    if (!confirm?.resetCredits?.actionToken || inFlight.current) return;
    const account = confirm;
    const actionToken = confirm.resetCredits.actionToken;
    setConfirm(null);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const request = ++sequence.current;
    try {
      const result = await client.useSubscriptionReset({ accountId: account.id, actionToken });
      if (mounted.current && request === sequence.current) {
        setReport(result.report); setNow(Date.now()); setNotice(result.warning ?? RESET_OUTCOMES[result.outcome]);
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(cause instanceof Error ? cause.message : "The reset could not be confirmed. Try again.");
    } finally {
      if (mounted.current && request === sequence.current) { inFlight.current = false; setBusy(false); }
    }
  };

  return <div className="space-y-3" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2">
      <div className="text-xs text-[var(--ec-muted)]">Subscription limits <span className="text-[var(--ec-faint)]">· Connected accounts · Refreshes every 5 minutes</span></div>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setNotice(null); void refresh(true); }}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh
      </Button>
    </div>
    {error ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
    {notice ? <p role="status" className="text-xs text-[var(--ec-text)]">{notice}</p> : null}
    {!report && busy ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--ec-muted)]"><Loader2 className="size-4 animate-spin" />Reading provider limits…</div> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {report?.accounts.map((account) => <AccountLimits key={account.id} account={account} now={now} busy={busy} canManage={client.capabilities.settings} onReset={setConfirm} />)}
    </div>
    {confirm ? <ModalDialog title={`Use a reset for ${confirm.label}?`} description="This spends one available reset credit to restore the limits covered by your provider. It cannot be undone." onClose={() => setConfirm(null)}>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirm(null)}>Cancel</Button>
        <Button size="sm" disabled={!canReset(confirm, now)} onClick={() => void redeemReset()}>Use reset credit</Button>
      </div>
    </ModalDialog> : null}
  </div>;
}
