import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Inbox, RefreshCw, X } from "lucide-react";
import { ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT, ATTENTION_KIND_LABELS, filterAttentionItems, type AttentionItem, type AttentionKind } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SidebarUtilityButton } from "./SidebarUtilityButton";

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
  const countLabel = items.length > 99 ? "99+" : `${items.length}`;
  return <>
    {triggerVariant === "titlebar" ? <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(true)} title={`Attention inbox${items.length ? ` (${items.length})` : ""}`} aria-label={`Attention inbox${items.length ? `, ${items.length} items` : ""}`} className={cn("relative size-7 rounded-md text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]", open && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]")}>
      <Bell className="size-4" />
      {items.length > 0 && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-[0.9rem] rounded-full bg-[var(--ec-warning-soft)] px-1 text-center font-mono text-[9px] font-semibold leading-[0.9rem] text-[var(--ec-warning)]">{countLabel}</span>}
    </Button> : triggerVariant === "sidebar" ? <SidebarUtilityButton label="Attention inbox" icon={Inbox} count={items.length ? `${items.length}` : ""} collapsed={compact} selected={open} onClick={() => setOpen(true)} /> : <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} title="Attention inbox" aria-label={`Attention inbox${items.length ? `, ${items.length} items` : ""}`} className="min-h-9 justify-start px-2.5 text-xs text-[var(--ec-text)]">
      <Inbox className="size-4 shrink-0" />{!compact && <span>Attention inbox</span>}{items.length > 0 && <span className="rounded bg-[var(--ec-warning-soft)] px-1.5 text-[var(--ec-warning)]">{items.length}</span>}
    </Button>}
    {open && createPortal(<dialog ref={dialog} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby={titleId} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(48rem,95vw)] overflow-hidden rounded-xl border border-[var(--ec-border)] bg-[var(--ec-dialog-bg)] p-0 text-[var(--ec-text)] shadow-xl backdrop:bg-black/50">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ec-border)] px-3 py-2">
        <h2 id={titleId} className="mr-auto text-sm font-semibold">Attention inbox · {items.length}</h2>
        {client.capabilities.runMutations && <Button size="xs" variant="secondary" disabled={loading || pendingId !== null || unreadNotices.length === 0} title="Clear all result notices across projects, including those hidden by filters. Unresolved requests remain." onClick={() => void markAllRead()}>{pendingId === "all" ? "Marking as read…" : "Mark all as read"}</Button>}
        <Button size="xs" variant="secondary" onClick={() => void refresh()} aria-label="Refresh inbox"><RefreshCw className="size-4" /></Button><Button size="xs" variant="secondary" onClick={() => setOpen(false)} aria-label="Close inbox"><X className="size-4" /></Button>
      </div>
      <div className="grid grid-cols-2 gap-2 border-b border-[var(--ec-border)] p-3 sm:grid-cols-3">
        <Input aria-label="Search attention inbox" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 text-xs" />
        <Select ariaLabel="Attention type" triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" maxMenuHeightPx={260} value={kind} onValueChange={(value) => { setKind(value); setLimit(50); }} options={[{ value: "", label: "All types" }, ...Object.entries(ATTENTION_KIND_LABELS).map(([value, label]) => ({ value, label }))]} />
        <Select ariaLabel="Attention project" triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" maxMenuHeightPx={260} value={projectId} onValueChange={(value) => { setProjectId(value); setLimit(50); }} options={[{ value: "", label: "All projects" }, ...projects.map(([value, label]) => ({ value, label }))]} />
      </div>
      <div className="app-scrollbar max-h-[60dvh] overflow-y-auto p-2">
        {error && <p role="alert" className="p-2 text-xs text-[var(--ec-danger)]">{error}</p>}
        {loading ? <p className="p-3 text-sm">Loading attention items…</p> : !filtered.length && <p className="p-3 text-sm text-[var(--ec-muted)]">{items.length ? "No matching items." : "Nothing needs your attention."}</p>}
        {filtered.slice(0, limit).map((item) => {
          const meta = <span className="flex flex-wrap gap-x-2 text-[11px] text-[var(--ec-muted)]"><span className={item.kind === "review" ? "text-[var(--ec-success)]" : item.kind === "update" ? "text-[var(--ec-accent)]" : "text-[var(--ec-warning)]"}>{ATTENTION_KIND_LABELS[item.kind as AttentionKind]}</span><span>{item.projectName ?? "BuildWarden"}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span>;
          const body = <><span className="truncate text-sm font-medium">{item.title}</span><span className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-[var(--ec-muted)]">{item.detail}</span></>;
          return <div key={item.id} className="flex items-start gap-2 border-b border-[var(--ec-border)] p-2">
            {item.runId ? <Button type="button" variant="ghost" disabled={pendingId !== null} className="h-auto min-w-0 flex-1 flex-col items-stretch justify-start gap-0 px-1 py-0 text-left font-normal text-[var(--ec-text)]" onClick={() => void openItem(item)}>
              {meta}{body}
            </Button> : <div className="flex min-w-0 flex-1 flex-col px-1 text-[var(--ec-text)]">{meta}{body}</div>}
            {item.providerUpdate?.canAutoUpdate && canRunProviderUpdates && <Button size="xs" disabled={pendingId !== null || item.providerUpdate.inUse} title={item.providerUpdate.inUse ? "In use by an active run or chat. Update once they finish." : undefined} onClick={() => void updateProvider(item)}>{pendingId === item.id ? "Updating…" : "Update"}</Button>}
            {item.dismissible && client.capabilities.runMutations && <Button size="xs" variant="secondary" disabled={pendingId !== null} onClick={() => void dismiss(item)}>{item.providerUpdate ? "Dismiss" : "Mark reviewed"}</Button>}
          </div>;
        })}
        {filtered.length > limit && <Button className="m-2" size="sm" variant="secondary" onClick={() => setLimit(limit + 50)}>Show more</Button>}
      </div>
      <p className="border-t border-[var(--ec-border)] px-3 py-2 text-[11px] text-[var(--ec-muted)]">Opening a result marks it as read when you have write access. Mark all as read clears result notices across all projects and filters for every connected client. Approvals, questions, and blocked work stay until resolved.</p>
    </dialog>, document.body)}
  </>;
};
