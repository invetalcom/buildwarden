import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Bell, Check, CheckCheck, CircleArrowUp, CircleCheck, CircleX, Inbox, MessageCircleQuestion, RefreshCw, Search, ShieldAlert, X, type LucideIcon } from "lucide-react";
import { ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT, ATTENTION_KIND_LABELS, filterAttentionItems, type AttentionItem, type AttentionKind } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { formatRunRelativeTime } from "./run-summary-format";
import { SidebarUtilityButton } from "./SidebarUtilityButton";

// Theme tokens only, so every design scheme and light/dark mode colors the rows consistently.
const KIND_STYLES: Record<AttentionKind, { icon: LucideIcon; tile: string; text: string }> = {
  approval: { icon: ShieldAlert, tile: "bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]", text: "text-[var(--ec-warning)]" },
  input: { icon: MessageCircleQuestion, tile: "bg-[var(--ec-user-input-soft)] text-[var(--ec-user-input)]", text: "text-[var(--ec-user-input)]" },
  failed: { icon: CircleX, tile: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]", text: "text-[var(--ec-danger)]" },
  blocked: { icon: Ban, tile: "bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]", text: "text-[var(--ec-danger)]" },
  review: { icon: CircleCheck, tile: "bg-[var(--ec-success-soft)] text-[var(--ec-success)]", text: "text-[var(--ec-success)]" },
  update: { icon: CircleArrowUp, tile: "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]", text: "text-[var(--ec-accent)]" },
};

export const AttentionInbox = ({ client, onOpenRun, compact = false, triggerVariant = "default" }: {
  client: BuildWardenClient;
  onOpenRun: (projectId: string, runId: string) => void;
  compact?: boolean;
  triggerVariant?: "default" | "sidebar" | "titlebar";
}) => {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const titleId = useId();
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await client.getAttentionInbox();
      if (alive.current && current === generation.current) { setItems(next); setError(""); }
    } catch (e) { if (alive.current && current === generation.current) setError(String(e)); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { timer ??= setTimeout(() => { timer = undefined; void refresh(); }, 1_000); };
    void refresh();
    const subscriptions = [client.onRunEvent((event) => { if (["status", "error", "approval-requested", "approval-resolved", "user-input-requested", "user-input-resolved"].includes(event.type)) schedule(); }), client.onOrchestrationChanged(schedule), client.onRunForgeRequestChanged(schedule), client.onProviderCliUpdatesChanged(schedule)];
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const focus = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", focus);
    return () => { alive.current = false; subscriptions.forEach((dispose) => dispose()); clearTimeout(timer); clearInterval(interval); document.removeEventListener("visibilitychange", focus); };
  }, [client, refresh]);
  useEffect(() => {
    if (open) { dialog.current?.showModal(); void refresh(); }
  }, [open, refresh]);
  const dismiss = async (item: AttentionItem) => {
    setPendingId(item.id);
    try { await client.acknowledgeAttentionItem(item.id); await refresh(); return true; }
    catch (e) { setError(`Could not mark this notice as read. ${String(e)}`); return false; }
    finally { setPendingId(null); }
  };
  const openItem = async (item: AttentionItem) => {
    if (pendingId !== null || !item.projectId || !item.runId) return;
    const { projectId: itemProjectId, runId } = item;
    if (item.dismissible && client.capabilities.runMutations && !await dismiss(item)) return;
    setOpen(false);
    onOpenRun(itemProjectId, runId);
  };
  const updateProvider = async (item: AttentionItem) => {
    if (!item.providerUpdate || pendingId !== null) return;
    setPendingId(item.id); setError("");
    let failure = "";
    try { await client.runProviderCliUpdate(item.providerUpdate.providerType); }
    catch (e) { failure = formatAppErrorMessage(e, "The update failed."); }
    // Refreshing clears errors, so report the failure afterwards.
    finally {
      await refresh();
      if (failure) setError(failure);
      setPendingId(null);
    }
  };
  // Updates run on the host; web clients need settings access, like other host configuration.
  const canRunProviderUpdates = client.capabilities.settings;
  const unreadNotices = items.filter((item) => item.dismissible);
  const markAllRead = async () => {
    if (!client.capabilities.runMutations || pendingId !== null) return;
    setPendingId("all"); setError("");
    let failure = "";
    try {
      // Only acknowledge the notices present at the click; new arrivals remain unread.
      const ids = unreadNotices.map((item) => item.id);
      for (let offset = 0; offset < ids.length; offset += ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT) {
        await client.acknowledgeAttentionItems(ids.slice(offset, offset + ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT));
      }
    } catch (e) { failure = `Could not mark every notice as read. ${String(e)}`; }
    finally {
      await refresh();
      if (failure) setError(failure);
      setPendingId(null);
    }
  };
  const filtered = filterAttentionItems(items, kind, projectId, query);
  const projects = [...new Map(items.flatMap((item) => item.projectId && item.projectName ? [[item.projectId, item.projectName] as const] : [])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const kinds = (Object.keys(ATTENTION_KIND_LABELS) as AttentionKind[])
    .map((value) => [value, items.filter((item) => item.kind === value).length] as const)
    .filter(([, count]) => count > 0);
  const countLabel =items.length > 99 ? "99+" : `${items.length}`;
  return <>
    {triggerVariant === "titlebar" ? <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(true)} title={`Attention inbox${items.length ? ` (${items.length})` : ""}`} aria-label={`Attention inbox${items.length ? `, ${items.length} items` : ""}`} className={cn("relative size-7 rounded-md text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]", open && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]")}>
      <Bell className="size-4" />
      {items.length > 0 && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-[0.9rem] rounded-full bg-[var(--ec-warning-soft)] px-1 text-center font-mono text-[9px] font-semibold leading-[0.9rem] text-[var(--ec-warning)]">{countLabel}</span>}
    </Button> : triggerVariant === "sidebar" ? <SidebarUtilityButton label="Attention inbox" icon={Inbox} count={items.length ? `${items.length}` : ""} collapsed={compact} selected={open} onClick={() => setOpen(true)} /> : <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} title="Attention inbox" aria-label={`Attention inbox${items.length ? `, ${items.length} items` : ""}`} className="min-h-9 justify-start px-2.5 text-xs text-[var(--ec-text)]">
      <Inbox className="size-4 shrink-0" />{!compact && <span>Attention inbox</span>}{items.length > 0 && <span className="rounded bg-[var(--ec-warning-soft)] px-1.5 text-[var(--ec-warning)]">{items.length}</span>}
    </Button>}
    {open && createPortal(<dialog ref={dialog} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby={titleId}
      // Close on backdrop clicks only when the press also started there, so drag-selecting text never dismisses the panel.
      onMouseDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (backdropPress.current && event.target === event.currentTarget) setOpen(false); backdropPress.current = false; }}
      className={cn(
        "fixed flex-col overflow-hidden rounded-xl border border-[var(--ec-border)] bg-[var(--ec-dialog-bg)] p-0 text-[var(--ec-text)] shadow-[var(--ec-popover-shadow)] open:flex",
        // The title bar bell drops the panel down beneath it; other triggers center it over a scrim.
        triggerVariant === "titlebar"
          ? "bottom-auto left-auto right-2 top-11 m-0 max-h-[min(40rem,calc(100dvh-3.5rem))] w-[min(30rem,calc(100vw-1rem))] backdrop:bg-transparent"
          : "inset-0 m-auto max-h-[min(40rem,85dvh)] w-[min(34rem,95vw)] backdrop:bg-[var(--ec-scrim)]",
      )}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--ec-border)] pl-3.5 pr-2">
        <h2 id={titleId} className="flex items-center gap-2 text-[13px] font-semibold">
          Attention inbox
          <span className={cn("rounded-full px-1.5 font-mono text-[10px] leading-4", items.length ? "bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]" : "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]")}>{items.length}</span>
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          {client.capabilities.runMutations && <Button size="xs" variant="ghost" disabled={loading || pendingId !== null || unreadNotices.length === 0} title="Clear all result notices across projects, including those hidden by filters. Approvals, questions, and blocked work stay until resolved." onClick={() => void markAllRead()} className="gap-1.5 text-[11px]"><CheckCheck className="size-3.5" />{pendingId === "all" ? "Marking as read…" : "Mark all as read"}</Button>}
          <Button size="icon" variant="ghost" className="size-7" onClick={() => void refresh()} aria-label="Refresh inbox" title="Refresh"><RefreshCw className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-7" onClick={() => setOpen(false)} aria-label="Close inbox" title="Close"><X className="size-4" /></Button>
        </div>
      </div>
      {(items.length > 0 || kind || projectId || query) && <div className="shrink-0 space-y-2 border-b border-[var(--ec-border)] px-3 py-2">
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ec-faint)]" />
            <Input aria-label="Search attention inbox" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-8 text-xs" />
          </label>
          {(projects.length > 0 || projectId) && <Select ariaLabel="Attention project" className="w-36 shrink-0" triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" maxMenuHeightPx={260} align="end" value={projectId} onValueChange={(value) => { setProjectId(value); setLimit(50); }} options={[{ value: "", label: "All projects" }, ...projects.map(([value, label]) => ({ value, label }))]} />}
        </div>
        {(kinds.length > 1 || kind) && <div role="group" aria-label="Attention type" className="app-scrollbar flex gap-1 overflow-x-auto pb-0.5">
          {[["", "All", items.length] as const, ...kinds.map(([value, count]) => [value, ATTENTION_KIND_LABELS[value], count] as const)].map(([value, label, count]) => (
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => { setKind(value); setLimit(50); }}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
                kind === value ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-text)]" : "border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
              )}>
              {label}<span className="font-mono text-[10px] text-[var(--ec-faint)]">{count}</span>
            </button>
          ))}
        </div>}
      </div>}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && <p role="alert" className="m-1 rounded-md bg-[var(--ec-danger-soft)] px-2.5 py-1.5 text-xs text-[var(--ec-danger)]">{error}</p>}
        {loading ? <p className="px-3 py-8 text-center text-xs text-[var(--ec-muted)]">Loading attention items…</p> : !filtered.length && <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
          <span aria-hidden className={cn("flex size-9 items-center justify-center rounded-full", items.length ? "bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]" : "bg-[var(--ec-success-soft)] text-[var(--ec-success)]")}>{items.length ? <Search className="size-4" /> : <CheckCheck className="size-4" />}</span>
          <p className="text-xs text-[var(--ec-muted)]">{items.length ? "No matching items." : "Nothing needs your attention."}</p>
        </div>}
        {filtered.slice(0, limit).map((item) => {
          const style = KIND_STYLES[item.kind];
          const KindIcon = style.icon;
          const body = <>
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ec-text)]">{item.title}</span>
              <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()} className="shrink-0 text-[10px] text-[var(--ec-faint)]">{formatRunRelativeTime(item.createdAt)}</time>
            </span>
            {item.detail && <span className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-[1.125rem] text-[var(--ec-muted)]">{item.detail}</span>}
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--ec-faint)]">
              <span className={cn("font-medium", style.text)}>{ATTENTION_KIND_LABELS[item.kind]}</span><span aria-hidden>·</span><span className="truncate">{item.projectName ?? "BuildWarden"}</span>
            </span>
          </>;
          const dismissLabel = item.providerUpdate ? "Dismiss" : "Mark as read";
          return <div key={item.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--ec-hover)]">
            <span aria-hidden className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", style.tile)}><KindIcon className="size-3.5" /></span>
            {item.runId ? <button type="button" disabled={pendingId !== null} title={item.dismissible && client.capabilities.runMutations ? "Open run and mark as read" : "Open run"} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] disabled:opacity-60" onClick={() => void openItem(item)}>
              {body}
            </button> : <div className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</div>}
            <div className="flex shrink-0 items-center gap-1 self-center">
              {item.providerUpdate?.canAutoUpdate && canRunProviderUpdates && <Button size="xs" disabled={pendingId !== null || item.providerUpdate.inUse} title={item.providerUpdate.inUse ? "In use by an active run or chat. Update once they finish." : undefined} onClick={() => void updateProvider(item)} className="h-7 px-2 text-[11px]">{pendingId === item.id ? "Updating…" : "Update"}</Button>}
              {item.dismissible && client.capabilities.runMutations && <Button size="icon" variant="secondary" disabled={pendingId !== null} onClick={() => void dismiss(item)} aria-label={dismissLabel} title={dismissLabel}
                className={cn("size-7 rounded-full text-[var(--ec-text)]", item.providerUpdate
                  ? "hover:border-[var(--ec-danger-ring)] hover:bg-[var(--ec-danger-soft)] hover:text-[var(--ec-danger)]"
                  : "hover:border-[var(--ec-success-ring)] hover:bg-[var(--ec-success-soft)] hover:text-[var(--ec-success)]")}>
                {item.providerUpdate ? <X className="size-4" /> : <Check className="size-4" strokeWidth={2.5} />}
              </Button>}
            </div>
          </div>;
        })}
        {filtered.length > limit && <Button className="mt-1 w-full text-xs" size="xs" variant="ghost" onClick={() => setLimit(limit + 50)}>Show {Math.min(50, filtered.length - limit)} more</Button>}
      </div>
    </dialog>, document.body)}
  </>;
};
