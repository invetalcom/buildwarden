import { Button } from "../ui/button";

/**
 * Shown when the host could not search the parts a list does not load. The list still shows what
 * matches in its own fields, so without this note a failed search would look like a complete one.
 */
export const SearchIncompleteNote = ({ scope, onRetry }: { scope: string; onRetry: () => void }) => (
  <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--ec-warning)]">
    <span>Could not search {scope}, so some matches may be missing.</span>
    <Button type="button" variant="ghost" size="xs" className="h-6 px-1.5 text-[11px]" onClick={onRetry}>Retry</Button>
  </p>
);
