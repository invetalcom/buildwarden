import { Button } from "../ui/button";

export const RunDiffLoadError = ({ error, hasPatch, pending, onRetry }: {
  error?: string | null;
  hasPatch: boolean;
  pending: boolean;
  onRetry: () => void;
}) => error ? (
  <div role="alert" className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-[var(--ec-warning)]" title={error}>
    <span>{hasPatch ? "Showing outdated changes. Refresh failed." : "Could not load changes."}</span>
    <Button type="button" size="sm" variant="secondary" className="h-6 shrink-0 px-2 text-xs" disabled={pending} onClick={onRetry}>
      {pending ? "Retrying…" : "Retry"}
    </Button>
  </div>
) : null;
