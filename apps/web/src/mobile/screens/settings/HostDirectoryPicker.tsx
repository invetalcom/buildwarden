import { useCallback, useEffect, useState } from "react";
import type { HostDirectoryListing } from "@buildwarden/shared";
import { ChevronLeft, Folder, HardDrive } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage } from "../../lib/format";
import { Sheet } from "../../components/Sheet";
import { Button, CenteredSpinner, EmptyState, InlineError, Input, ListRow } from "../../components/primitives";

/**
 * Browses the host filesystem to add a project.
 *
 * The desktop opens a native directory dialog, which a browser cannot do, so this walks
 * `listHostDirectories` instead — the same host endpoint the desktop web build uses. Only
 * directories are listed; the host decides what is reachable.
 */
export const HostDirectoryPicker = ({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (projectId: string) => void | Promise<void>;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [listing, setListing] = useState<HostDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        setListing(await client.listHostDirectories(path ? { path } : {}));
      } catch (caught) {
        setError(errorMessage(caught, "Could not read that folder on the host."));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!open) return;
    setName("");
    void browse();
  }, [browse, open]);

  const currentPath = listing?.path ?? "";

  const add = async () => {
    if (!currentPath) return;
    const project = await action.run(
      () => client.addProject({ repoPath: currentPath, ...(name.trim() ? { name: name.trim() } : {}) }),
      "The host rejected that folder.",
    );
    if (project) await onAdded(project.id);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a project"
      dismissable={!action.busy}
      full
      footer={
        <div className="flex flex-col gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name (optional)"
            className="text-[13px]"
          />
          <Button block busy={action.busy} disabled={!currentPath} onClick={() => void add()}>
            {currentPath ? "Add this folder" : "Choose a folder"}
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-1 border-b border-[var(--ec-border)] px-1 py-1">
        <button
          type="button"
          disabled={!listing?.parentPath && !currentPath}
          onClick={() => void browse(listing?.parentPath ?? undefined)}
          className="m-tap inline-flex items-center gap-1 px-2 text-xs font-medium text-[var(--ec-accent)] disabled:opacity-40"
        >
          <ChevronLeft className="size-4" />
          Up
        </button>
        <p className="m-mono min-w-0 flex-1 truncate text-[11px] text-[var(--ec-muted)]" dir="rtl">
          {currentPath || "Drives"}
        </p>
      </div>

      {error ? <InlineError message={error} onRetry={() => void browse(currentPath || undefined)} /> : null}
      {action.error ? <InlineError message={action.error} /> : null}

      {loading ? (
        <CenteredSpinner label="Reading folders" />
      ) : !listing || listing.entries.length === 0 ? (
        <EmptyState
          icon={<Folder className="size-7" />}
          title="No sub-folders"
          message={currentPath ? "You can still add this folder as a project." : "The host reported no drives."}
        />
      ) : (
        listing.entries.map((entry) => (
          <ListRow
            key={entry.path}
            leading={currentPath ? <Folder className="size-4" /> : <HardDrive className="size-4" />}
            title={entry.name}
            className="border-b border-[var(--ec-border)] last:border-b-0"
            onClick={() => void browse(entry.path)}
          />
        ))
      )}
    </Sheet>
  );
};
