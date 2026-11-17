import { useEffect, useState } from "react";
import type { DatabaseCompactResult, DatabaseStorageInfo } from "@buildwarden/shared";
import { HardDrive, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { formatByteSize } from "../../lib/format-byte-size";
import { useLatestRef } from "../../lib/use-latest-ref";

export interface DatabaseCompactControlProps {
  disabled: boolean;
  onLoadInfo: () => Promise<DatabaseStorageInfo>;
  onCompact: () => Promise<DatabaseCompactResult>;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Free pages and the WAL are certain to be released; partly filled pages add to it, so this is a minimum. */
const describeStorage = (info: DatabaseStorageInfo): string => {
  const reclaimable = info.freeBytes + info.walBytes;
  const size = `${formatByteSize(info.totalBytes)} on disk`;
  return reclaimable > 0 ? `${size} · at least ${formatByteSize(reclaimable)} reclaimable` : size;
};

const describeResult = ({ beforeBytes, afterBytes, reclaimedBytes }: DatabaseCompactResult): string =>
  reclaimedBytes > 0
    ? `Reclaimed ${formatByteSize(reclaimedBytes)} (${formatByteSize(beforeBytes)} → ${formatByteSize(afterBytes)}).`
    : "The database was already compact.";

export const DatabaseCompactControl = ({ disabled, onLoadInfo, onCompact }: DatabaseCompactControlProps) => {
  const [info, setInfo] = useState<DatabaseStorageInfo | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadInfoRef = useLatestRef(onLoadInfo);

  useEffect(() => {
    let cancelled = false;
    loadInfoRef.current()
      .then((next) => { if (!cancelled) setInfo(next); })
      .catch((loadError: unknown) => { if (!cancelled) setError(errorMessage(loadError)); });
    return () => { cancelled = true; };
  }, [loadInfoRef]);

  const compact = async (): Promise<void> => {
    setCompacting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await onCompact();
      setNotice(describeResult(result));
      setInfo(await loadInfoRef.current());
    } catch (compactError) {
      setError(errorMessage(compactError));
    } finally {
      setCompacting(false);
    }
  };

  return (
    <div className="w-full md:max-w-[54rem]">
      <div className="flex flex-wrap items-center justify-start gap-x-3 gap-y-1.5 md:justify-end">
        <span className="text-xs tabular-nums text-[var(--ec-muted)]">{info ? describeStorage(info) : "Measuring…"}</span>
        <Button type="button" variant="secondary" size="sm" disabled={disabled || compacting} onClick={() => void compact()}>
          {compacting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <HardDrive className="mr-1.5 h-3.5 w-3.5" />}
          {compacting ? "Reclaiming…" : "Reclaim space"}
        </Button>
      </div>
      {notice ? <p className="mt-2 text-xs text-[var(--ec-success)] md:text-right">{notice}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--ec-danger)] md:text-right">{error}</p> : null}
    </div>
  );
};
