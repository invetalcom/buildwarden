import { useEffect, useRef, useState } from "react";
import type { SubscriptionLimitsAccount, SubscriptionResetOutcome } from "@buildwarden/shared";
import { Clock3, Loader2, RefreshCw } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { ModalDialog } from "../ui/modal-dialog";
import { SubscriptionLimitCard } from "./SubscriptionLimitCard";
import { useSubscriptionLimits } from "../../lib/use-subscription-limits";

const REFRESH_INTERVAL = 5 * 60_000;
const RESET_OUTCOMES: Record<SubscriptionResetOutcome, string> = {
  reset: "Reset applied. Your subscription limits have been refreshed.",
  nothingToReset: "No reset was needed. The provider reports that you are not limited.",
  noCredit: "No reset credit is currently available.",
  alreadyRedeemed: "This reset was already used. Your limits have been refreshed.",
};

function canReset(account: SubscriptionLimitsAccount, now: number): boolean {
  return account.providerType !== "cursor-agent" && account.status === "fresh"
    && now - Date.parse(account.checkedAt) < REFRESH_INTERVAL
    && Boolean(account.resetCredits?.actionToken) && (account.resetCredits?.availableCount ?? 0) > 0
    && (!account.resetCredits?.nextExpiresAt || Date.parse(account.resetCredits.nextExpiresAt) > now);
}

export function LimitsPage() {
  const client = useBuildWardenClient();
  const { report, refreshing, error: refreshError, refresh, replaceReport } = useSubscriptionLimits(client);
  const [resetting, setResetting] = useState(false);
  const busy = refreshing || resetting;
  const [resetError, setError] = useState<string | null>(null);
  const error = resetError ?? refreshError;
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SubscriptionLimitsAccount | null>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setResetting(false);
    setError(null);
    setConfirm(null);
    setNotice(null);
    void refresh(true);
    const poll = setInterval(() => { if (!inFlight.current && document.visibilityState !== "hidden") void refresh(); }, REFRESH_INTERVAL);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted.current = false; sequence.current += 1; inFlight.current = false; clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  const redeemReset = async () => {
    if (!confirm?.resetCredits?.actionToken || inFlight.current || refreshing) return;
    const account = confirm;
    const actionToken = confirm.resetCredits.actionToken;
    setConfirm(null);
    inFlight.current = true;
    setResetting(true);
    setError(null);
    setNotice(null);
    const request = ++sequence.current;
    try {
      const result = await client.useSubscriptionReset({ accountId: account.id, actionToken });
      if (mounted.current && request === sequence.current) {
        replaceReport(result.report); setNow(Date.now()); setNotice(result.warning ?? RESET_OUTCOMES[result.outcome]);
      }
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(cause instanceof Error ? cause.message : "The reset could not be confirmed. Try again.");
    } finally {
      if (mounted.current && request === sequence.current) { inFlight.current = false; setResetting(false); }
    }
  };

  return <div className="space-y-3" aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--ec-text)]">Subscription limits</h2>
        {report ? <span className="rounded-md bg-[var(--ec-muted-soft)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--ec-muted)]">{report.accounts.length} accounts</span> : null}
      </div>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--ec-muted)]"><Clock3 className="size-3" />Auto-refresh · 5 min</span>
        <Button size="xs" variant="secondary" disabled={busy} onClick={() => { setNotice(null); setError(null); void refresh(true); }}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh
        </Button>
      </div>
    </div>
    {error ? <p role="alert" className="text-xs text-[var(--ec-danger)]">{error}</p> : null}
    {notice ? <p role="status" className="text-xs text-[var(--ec-text)]">{notice}</p> : null}
    {!report && busy ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--ec-muted)]"><Loader2 className="size-4 animate-spin" />Reading provider limits…</div> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {report?.accounts.map((account) => <SubscriptionLimitCard key={account.id} account={account} now={now} busy={busy} canManage={client.capabilities.settings} resetAvailable={canReset(account, now)} onReset={setConfirm} />)}
    </div>
    {confirm ? <ModalDialog title={`Use a reset for ${confirm.label}?`} description="This spends one available reset credit to restore the limits covered by your provider. It cannot be undone." onClose={() => setConfirm(null)}>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirm(null)}>Cancel</Button>
        <Button size="sm" disabled={busy || !canReset(confirm, now)} onClick={() => void redeemReset()}>Use reset credit</Button>
      </div>
    </ModalDialog> : null}
  </div>;
}
