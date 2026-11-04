import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Clock3, Gauge, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import type { SubscriptionLimitsAccount } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { Button } from "../ui/button";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { subscriptionResetCountdown, subscriptionUsageColor } from "./subscription-limit-format";
import { useSubscriptionLimits } from "../../lib/use-subscription-limits";

function CompactAccount({ account, now }: { account: SubscriptionLimitsAccount; now: number }) {
  const stale = account.status === "cached" || (account.status === "fresh" && now - Date.parse(account.checkedAt) >= 300_000);
  return <section className="space-y-2.5 px-3.5 py-3" aria-label={`${account.label} limits`}>
    <div className="flex min-w-0 items-center gap-2">
      <ProviderBrandIcon harnessType={account.providerType === "codex-cli" ? "codex-app-server" : account.providerType === "cursor-agent" ? "cursor-acp" : "claude-code"} className="size-3.5 shrink-0" />
      <h3 className="min-w-0 truncate text-xs font-semibold">{account.label}</h3>
      {account.plan ? <span className="min-w-0 truncate text-[10px] capitalize text-[var(--ec-muted)]">{account.plan}</span> : null}
      {stale ? <span className="ml-auto shrink-0 text-[10px] text-[var(--ec-warning)]">Cached</span> : null}
    </div>
    {account.windows.map((window) => <div key={window.id} className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-[var(--ec-muted)]">{window.label}</span>
        <span className="shrink-0 font-medium tabular-nums">{Math.round(100 - window.usedPercent)}% left</span>
      </div>
      <div role="progressbar" aria-label={`${account.label} ${window.label} usage`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100}
        className="h-1 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
        <div className="h-full rounded-full" style={{ width: `${window.usedPercent}%`, background: subscriptionUsageColor(window.usedPercent) }} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-[var(--ec-muted)]">
        <span>{Math.round(window.usedPercent)}% used</span>
        {window.resetsAt ? <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()} className="inline-flex items-center gap-1">
          <Clock3 className="size-2.5" />{Date.parse(window.resetsAt) > now ? `Resets ${subscriptionResetCountdown(window.resetsAt, now)}` : "Reset due · refresh to check"}
        </time> : <span>Reset time not reported</span>}
      </div>
    </div>)}
    {account.message ? <p className="text-[11px] leading-4 text-[var(--ec-muted)]">{account.message}</p> : !account.windows.length ? <p className="text-[11px] text-[var(--ec-muted)]">Limits unavailable. Check the provider connection.</p> : null}
    {account.resetCredits && account.resetCredits.availableCount > 0 ? <p className="flex items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
      <RotateCcw className="size-3" />{account.resetCredits.availableCount} reset {account.resetCredits.availableCount === 1 ? "credit" : "credits"}{stale ? " · last reading" : ""}
    </p> : null}
  </section>;
}

function LimitsPopover({ client, onClose, onOpenLimits, trigger, id }: {
  client: BuildWardenClient; onClose: () => void; onOpenLimits: () => void; trigger: HTMLButtonElement | null; id: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const titleId = useId();
  const { report, refreshing: loading, error, refresh } = useSubscriptionLimits(client);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    dialog.current?.showModal();
    void refresh();
    const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll); clearInterval(tick);
    };
  }, [refresh]);

  const close = () => { dialog.current?.close(); onClose(); trigger?.focus({ preventScroll: true }); };
  return createPortal(<dialog ref={dialog} id={id} aria-labelledby={titleId} onCancel={close} onClose={onClose}
    onMouseDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (backdropPress.current && event.target === event.currentTarget) close(); backdropPress.current = false; }}
    className="fixed bottom-auto left-auto right-2 top-11 m-0 max-h-[calc(100dvh-3.5rem)] w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-[var(--ec-border)] bg-[var(--ec-dialog-bg)] p-0 text-[var(--ec-text)] shadow-[var(--ec-popover-shadow)] backdrop:bg-transparent open:flex">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--ec-border)] pl-3.5 pr-2">
      <Gauge className="size-3.5 text-[var(--ec-accent)]" />
      <h2 id={titleId} className="text-xs font-semibold">Subscription limits</h2>
      <div className="ml-auto flex gap-0.5">
        <Button size="icon" variant="ghost" className="size-7" disabled={loading} onClick={() => void refresh(true)} title="Refresh limits" aria-label="Refresh limits">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={close} title="Close limits" aria-label="Close limits"><X className="size-3.5" /></Button>
      </div>
    </div>
    <div className="app-scrollbar min-h-0 overflow-y-auto" aria-busy={loading}>
      {error ? <p role="alert" className="m-2 rounded-md bg-[var(--ec-danger-soft)] px-2.5 py-2 text-xs text-[var(--ec-danger)]">{error}{report ? " Showing the previous reading." : ""}</p> : null}
      {!report && loading ? <p role="status" className="px-3 py-8 text-center text-xs text-[var(--ec-muted)]">Reading provider limits…</p> : null}
      {report?.accounts.map((account) => <div key={account.id} className="border-b border-[var(--ec-border)] last:border-b-0"><CompactAccount account={account} now={now} /></div>)}
      {report && !report.accounts.length ? <p className="px-3 py-6 text-center text-xs text-[var(--ec-muted)]">No provider limits reported.</p> : null}
    </div>
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--ec-border)] px-3 py-2">
      <span className="text-[10px] text-[var(--ec-muted)]">Auto-refresh · 5 min</span>
      <Button size="xs" variant="ghost" className="text-[11px]" onClick={() => { close(); onOpenLimits(); }}>Open Limits<ArrowUpRight className="size-3" /></Button>
    </div>
  </dialog>, document.body);
}

/** Mounted only when an installed provider and the custom title bar are available. */
export function TitleBarLimits({ client, onOpenLimits }: { client: BuildWardenClient; onOpenLimits: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <Button ref={trigger} type="button" size="icon" variant="ghost" title="Subscription limits" aria-label="Subscription limits"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}
      className={`size-7 rounded-md ${open ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"}`}>
      <Gauge className="size-4" />
    </Button>
    {open ? <LimitsPopover client={client} onClose={() => setOpen(false)} onOpenLimits={onOpenLimits} trigger={trigger.current} id={id} /> : null}
  </>;
}
