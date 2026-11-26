import { useEffect, useState } from "react";

const HOST_SEARCH_DEBOUNCE_MS = 150;

/**
 * Asks the host which items contain the search text in parts a list does not load, such as the
 * steps of a chat. Returns null until the current text has an answer, so callers show what they
 * can match themselves meanwhile.
 *
 * `search` must keep its identity between renders. `revision` asks again when the searched items changed.
 */
export const useHostSearch = (
  text: string,
  search: (text: string) => Promise<string[]>,
  revision: string | number = 0,
): ReadonlySet<string> | null => {
  const query = text.trim();
  const [result, setResult] = useState<{ query: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(query)
        .then((ids) => {
          if (!cancelled) setResult({ query, ids: new Set(ids) });
        })
        // The matches of the list's own fields stay visible.
        .catch(() => undefined);
    }, HOST_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, revision, search]);

  // Keeps the previous matches for the same text while a refresh is pending.
  return query && result?.query === query ? result.ids : null;
};
