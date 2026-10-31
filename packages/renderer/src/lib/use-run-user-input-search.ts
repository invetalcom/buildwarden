import type { RunListItem } from "@buildwarden/shared";
import { useEffect, useMemo, useState } from "react";
import { useOptionalBuildWardenClient } from "./buildwarden-client";

const RUN_USER_INPUT_SEARCH_DEBOUNCE_MS = 150;

/**
 * Asks the host which runs match the search terms anywhere in their user input
 * (follow-up prompts and submitted answers included). Returns null until the
 * current terms have a result, so callers fall back to local prompt matching.
 *
 * `runs` only decides when to search again: `lastUserInputAt` moves when a run
 * gets new user input, but not on token-usage or status snapshot updates.
 */
export const useRunUserInputSearch = (
  terms: string[],
  runs: readonly Pick<RunListItem, "id" | "lastUserInputAt">[],
): ReadonlySet<string> | null => {
  const client = useOptionalBuildWardenClient();
  const query = terms.join(" ");
  const userInputRevision = useMemo(
    () => runs.map((run) => `${run.id}:${run.lastUserInputAt ?? ""}`).join("|"),
    [runs],
  );
  const [result, setResult] = useState<{ query: string; runIds: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!client || !query) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      client.searchRunUserInput(query)
        .then((runIds) => {
          if (!cancelled) setResult({ query, runIds: new Set(runIds) });
        })
        .catch(() => undefined);
    }, RUN_USER_INPUT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, query, userInputRevision]);

  // Keeps the previous matches for the same query while a refresh is pending.
  return result?.query === query ? result.runIds : null;
};
