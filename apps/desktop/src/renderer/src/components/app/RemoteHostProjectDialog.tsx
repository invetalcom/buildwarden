import type { HostDirectoryListing } from "@buildwarden/shared";
import { ChevronUp, Folder, FolderPlus, HardDrive, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface RemoteHostProjectDialogProps {
  client: BuildWardenClient;
  open: boolean;
  onClose: () => void;
  onProjectAdded: () => void;
}

const suggestedName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1)?.trim() ?? path.replace(/[\\/:]+/g, "").trim();

export const RemoteHostProjectDialog = ({ client, open, onClose, onProjectAdded }: RemoteHostProjectDialogProps) => {
  const [listing, setListing] = useState<HostDirectoryListing | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (path?: string, updateName = true) => {
    setLoading(true);
    setError("");
    try {
      const next = await client.listHostDirectories(path ? { path } : undefined);
      setListing(next);
      if (updateName) setName(next.path ? suggestedName(next.path) : "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not browse folders on the BuildWarden host.");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setName("");
    setError("");
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !adding) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adding, onClose, open]);

  if (!open) return null;

  const addProject = async () => {
    if (!listing?.path || adding) return;
    setAdding(true);
    setError("");
    try {
      await client.addProject({ repoPath: listing.path, name: name.trim() || undefined });
      onProjectAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add this host folder.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !adding) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-project-title"
        className="flex max-h-[min(42rem,calc(100svh-1.5rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/40"
      >
        <header className="flex items-center gap-3 border-b border-[var(--ec-border)] px-3 py-2.5 sm:px-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--ec-accent)]/30 bg-[var(--ec-accent)]/10 text-[var(--ec-accent)]">
            <FolderPlus className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="remote-host-project-title" className="text-sm font-semibold text-[var(--ec-text)]">Add host project</h2>
            <p className="text-[11px] text-[var(--ec-muted)]">Browse folders on the computer running BuildWarden.</p>
          </div>
          <Button type="button" size="sm" variant="ghost" className="size-8 p-0" onClick={onClose} disabled={adding} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 px-2"
              disabled={loading || !listing?.parentPath}
              onClick={() => void load(listing?.parentPath ?? undefined)}
              aria-label="Parent host folder"
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <div className="min-w-0 flex-1 truncate rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ec-muted)]">
              {listing?.path ?? "Host filesystem roots"}
            </div>
            <Button type="button" size="sm" variant="ghost" className="size-8 p-0" disabled={loading} onClick={() => void load(listing?.path ?? undefined, false)} aria-label="Refresh host folders">
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="mt-2 min-h-40 flex-1 overflow-y-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-bg)]/45">
            {loading && !listing ? (
              <div className="flex h-40 items-center justify-center text-[var(--ec-muted)]"><Loader2 className="size-4 animate-spin" /></div>
            ) : listing?.entries.length ? (
              <div className="divide-y divide-[var(--ec-border)]">
                {listing.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-panel-soft)] disabled:opacity-50"
                    disabled={loading}
                    onClick={() => void load(entry.path)}
                  >
                    {listing.path ? <Folder className="size-3.5 shrink-0 text-[var(--ec-accent)]" /> : <HardDrive className="size-3.5 shrink-0 text-[var(--ec-accent)]" />}
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-[var(--ec-muted)]">
                {listing?.path ? "This host folder has no subfolders." : "No readable host roots were found."}
              </div>
            )}
          </div>

          {error ? <p role="alert" className="mt-2 rounded-md border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p> : null}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-faint)]">Project name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional display name" className="h-9" />
            </label>
            <Button type="button" className="h-9 justify-center sm:min-w-32" disabled={!listing?.path || loading || adding} onClick={() => void addProject()}>
              {adding ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
              {adding ? "Adding…" : "Add folder"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};
