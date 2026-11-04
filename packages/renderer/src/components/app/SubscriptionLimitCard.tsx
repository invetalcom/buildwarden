import type { SubscriptionLimitsAccount, SubscriptionLimitWindow } from "@buildwarden/shared";
import { Clock3, Gauge, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { subscriptionResetCountdown as relativeTime, subscriptionUsageColor as usageColor } from "./subscription-limit-format";

function CapacityRing({ window }: { window?: SubscriptionLimitWindow }) {
  const remaining = window ? 100 - window.usedPercent : 0;
  return <div className="relative size-28 shrink-0" aria-hidden>
    <svg viewBox="0 0 112 112" className="size-full -rotate-90">
      <circle cx="56" cy="56" r="47" fill="none" stroke="var(--ec-muted-soft)" strokeWidth="6" />
      {window ? <circle cx="56" cy="56" r="47" fill="none" stroke={usageColor(window.usedPercent)} strokeWidth="6" strokeLinecap={remaining > 0 ? "round" : "butt"}
        pathLength="100" strokeDasharray={`${remaining} 100`} /> : null}
    </svg>
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <span className="text-[30px] font-semibold leading-none tracking-tight tabular-nums text-[var(--ec-text)]">{window ? <>{Math.round(remaining)}<span className="ml-0.5 text-base text-[var(--ec-muted)]">%</span></> : "—"}</span>
      <span className="mt-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--ec-muted)]">{window ? "remaining" : "No reading"}</span>
    </div>
  </div>;
}

function LimitWindow({ window, now }: { window: SubscriptionLimitWindow; now: number }) {
  return <div className="space-y-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs">
      <span className="font-medium text-[var(--ec-text)]">{window.label}</span>
      <span className="tabular-nums text-[var(--ec-muted)]">{Math.round(window.usedPercent)}% used <span className="text-[var(--ec-faint)]">· {Math.round(100 - window.usedPercent)}% left</span></span>
    </div>
    <div role="progressbar" aria-label={`${window.label} usage`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100}
      className="h-1.5 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
      <div className="h-full rounded-full transition-[width] motion-reduce:transition-none" style={{ width: `${window.usedPercent}%`, background: usageColor(window.usedPercent) }} />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-[var(--ec-muted)]">
      {window.resetsAt ? <>
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{Date.parse(window.resetsAt) > now ? `Resets ${relativeTime(window.resetsAt, now)}` : "Reset due · refresh to check"}</span>
        <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{new Date(window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
      </> : <span>Reset time not reported</span>}
    </div>
  </div>;
}

export function SubscriptionLimitCard({ account, now, busy, canManage, resetAvailable, onReset }: {
  account: SubscriptionLimitsAccount; now: number; busy: boolean; canManage: boolean; resetAvailable: boolean;
  onReset: (account: SubscriptionLimitsAccount) => void;
}) {
  const stale = account.status === "cached" || (account.status === "fresh" && now - Date.parse(account.checkedAt) >= 5 * 60_000);
  const credits = account.resetCredits;
  // Highlight an actual window, never an average of unrelated provider allowances.
  const featured = account.windows.reduce<SubscriptionLimitWindow | undefined>((current, window) => !current || window.usedPercent > current.usedPercent ? window : current, undefined);
  const status = stale ? "Cached" : !featured ? "Unavailable" : featured.usedPercent >= 100 ? "Limit reached" : featured.usedPercent >= 80 ? "Running low" : "Available";
  const statusColor = stale || !featured ? "var(--ec-muted)" : featured.usedPercent >= 80 ? usageColor(featured.usedPercent) : "var(--ec-success)";
  return <Card className="flex min-w-0 flex-col overflow-hidden" aria-label={`${account.label} subscription limits`}>
    <div className="border-b border-[var(--ec-border)]" style={{ background: "linear-gradient(135deg, color-mix(in srgb, var(--ec-accent) 9%, transparent), transparent 70%)" }}>
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]">
            <ProviderBrandIcon harnessType={account.providerType === "codex-cli" ? "codex-app-server" : account.providerType === "cursor-agent" ? "cursor-acp" : "claude-code"} className="size-4" />
          </span>
          <h3 className="truncate text-sm font-semibold text-[var(--ec-text)]">{account.label}</h3>
        </div>
        {account.plan ? <span className="max-w-[45%] truncate rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-1 text-[10px] font-medium capitalize text-[var(--ec-muted)]" title={account.plan}>{account.plan}</span> : null}
      </div>
      <div className="flex items-center gap-4 px-4 pb-4 pt-1">
        <CapacityRing window={featured} />
        <div className="min-w-0 space-y-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-widest text-[var(--ec-muted)]">{featured ? "Most used window" : "Subscription limits"}</p>
            <p className="mt-1 text-base font-semibold text-[var(--ec-text)]">{featured?.label ?? "Awaiting data"}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium"
            style={{ color: statusColor, borderColor: `color-mix(in srgb, ${statusColor} 25%, transparent)`, background: `color-mix(in srgb, ${statusColor} 8%, transparent)` }}>
            <span className="size-1.5 rounded-full bg-current" aria-hidden />{status}
          </span>
        </div>
      </div>
    </div>
    <div className="flex-1 space-y-4 p-4">
      {account.message ? <p className={`text-xs leading-5 ${stale ? "text-[var(--ec-warning)]" : "text-[var(--ec-muted)]"}`}>{account.message}</p> : null}
      {account.windows.map((window) => <LimitWindow key={window.id} window={window} now={now} />)}
      {!featured ? <div className="flex items-start gap-2 text-xs leading-5 text-[var(--ec-muted)]"><Gauge className="mt-0.5 size-4 shrink-0" />Refresh after checking the provider connection to see its allowances.</div> : null}
    </div>
    <div className="mx-4 flex min-h-16 flex-wrap items-center justify-between gap-2 border-t border-[var(--ec-border)] py-3">
      {credits ? <>
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"><RotateCcw className="size-4" /></span>
          <div className="text-xs">
            <div className="font-medium text-[var(--ec-text)]"><span className="text-base font-semibold tabular-nums">{credits.availableCount}</span> reset {credits.availableCount === 1 ? "credit" : "credits"}</div>
            {credits.nextExpiresAt ? <div className="mt-0.5 text-[10px] text-[var(--ec-muted)]" title={new Date(credits.nextExpiresAt).toLocaleString()}>
              {Date.parse(credits.nextExpiresAt) > now ? `Next expires ${relativeTime(credits.nextExpiresAt, now)}` : "Credit expired · refresh to check"}
            </div> : null}
          </div>
        </div>
        {credits.availableCount > 0 ? <Button size="xs" variant="secondary" disabled={busy || !canManage || !resetAvailable} onClick={() => onReset(account)}
          title={!canManage ? "Requires settings access" : !resetAvailable ? "Refresh Limits to check reset availability" : "Use one subscription reset credit"}>
          <RotateCcw className="size-3" />Use reset
        </Button> : null}
      </> : <div className="flex items-center gap-2 text-[11px] text-[var(--ec-muted)]">
        <Clock3 className="size-4 shrink-0 text-[var(--ec-faint)]" />
        {account.providerType === "cursor-agent" ? "Cursor resets on its billing schedule." : "No reset credits reported."}
      </div>}
    </div>
    <div className="flex items-center justify-between border-t border-[var(--ec-border)] bg-[var(--ec-control)] px-4 py-2 text-[10px] text-[var(--ec-muted)]">
      <span>{stale ? "Last reading · cached" : account.status === "fresh" ? "Latest reading" : "Last checked"}</span>
      <time dateTime={account.checkedAt} title={new Date(account.checkedAt).toLocaleString()}>{new Date(account.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
    </div>
  </Card>;
}
