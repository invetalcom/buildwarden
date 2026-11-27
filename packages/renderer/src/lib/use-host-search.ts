import { useCallback, useEffect, useState } from "react";

const HOST_SEARCH_DEBOUNCE_MS = 150;

/**
 * Thrown by a search that only some hosts answered. `ids` holds what the others matched, so their
 * matches stay visible while the caller learns that the search is incomplete.
 */
export class IncompleteHostSearchError extends Error {
  constructor(readonly ids: readonly string[]) {
    super("Not every host could be searched.");
    this.name = "IncompleteHostSearchError";
  }
}

export interface HostSearch {
  /** The items the host matched. Null until the current text has an answer, so callers show what they can match themselves meanwhile. */
  ids: ReadonlySet<string> | null;
  /** The host could not be asked for the current text, so matches in parts the list does not load may be missing. */
  failed: boolean;
  /** Asks the host again for the current text. */
  retry: () => void;
}

/**
 * Asks the host which items contain the search text in parts a list does not load, such as the
 * steps of a chat.
 *
 * `search` must keep its identity between renders. `revision` asks again when the searched items changed.
 */
export const useHostSearch = (
  text: string,
  search: (text: string) => Promise<string[]>,
  revision: string | number = 0,
): HostSearch => {
  const query = text.trim();
  const [result, setResult] = useState<{ query: string; ids: ReadonlySet<string> } | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(query)
        .then((ids) => {
          if (cancelled) return;
          setResult({ query, ids: new Set(ids) });
          setFailedQuery(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // The matches of the list's own fields stay visible; the caller says that the rest is missing.
          if (error instanceof IncompleteHostSearchError) setResult({ query, ids: new Set(error.ids) });
          setFailedQuery(query);
        });
    }, HOST_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attempt, query, revision, search]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  return {
    // Keeps the previous matches for the same text while a refresh is pending.
    ids: query && result?.query === query ? result.ids : null,
    failed: Boolean(query) && failedQuery === query,
    retry,
  };
};
