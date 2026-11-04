import { useCallback, useEffect, useRef, useState } from "react";
import { isCouncilRoundActive, isCouncilRunKind, type CouncilRound, type RunDetail } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";

const OPEN_PANEL_EVENT = "buildwarden:open-council-panel";

/** Controls appear once reviewers exist. Saved results stay reachable after reviewers are removed. */
export const hasCouncilSurface = (detail: Pick<RunDetail, "run" | "councilRounds"> | null | undefined, available: boolean): boolean =>
  Boolean(detail && isCouncilRunKind(detail.run.kind) && (available || detail.councilRounds?.length));

/** The header and the activity log live outside the run page that owns the panel layout. */
export const requestCouncilPanel = (runId: string): void => {
  window.dispatchEvent(new CustomEvent<string>(OPEN_PANEL_EVENT, { detail: runId }));
};

export const useCouncilPanelRequest = (runId: string, onRequest: () => void): void => {
  const handler = useRef(onRequest);
  useEffect(() => { handler.current = onRequest; });
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === runId) handler.current();
    };
    window.addEventListener(OPEN_PANEL_EVENT, listener);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, listener);
  }, [runId]);
};

/** Keeps a run's validation rounds current. Rounds outlive reviewer settings, so this never depends on them. */
export const useCouncilRounds = (
  client: Pick<BuildWardenClient, "getCouncilRounds" | "onRunEvent">,
  runId: string,
  initial: readonly CouncilRound[] | undefined,
) => {
  const [rounds, setRounds] = useState<CouncilRound[]>(() => [...(initial ?? [])]);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    const next = await client.getCouncilRounds(runId);
    if (request === latestRequest.current) setRounds(next);
  }, [client, runId]);

  useEffect(() => {
    setRounds([...(initial ?? [])]);
    // Only a different run should discard what is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return client.onRunEvent((event) => {
      if (event.runId !== runId) return;
      const finishedTurn = event.title === "Run completed" || event.title === "Run failed" || event.title === "Run cancelled";
      if (event.metadata?.councilRoundId || finishedTurn) void refresh().catch(() => undefined);
    });
  }, [client, refresh, runId]);

  return { rounds, refresh, latest: rounds.at(-1) ?? null, active: rounds.find(isCouncilRoundActive) ?? null };
};
