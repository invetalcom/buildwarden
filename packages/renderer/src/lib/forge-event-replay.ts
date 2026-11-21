import type { PrWatchView, RunDetail, RunForgeRequestChangedPayload, RunForgeRequestSummary } from "@buildwarden/shared";

/** The newest forge state a run's events brought, counted so older detail loads can be patched. */
export interface RecordedForgeEvents {
  count: number;
  forgeRequest: RunForgeRequestSummary | null;
  /** `undefined` when no event carried a watch; `null` when one cleared it. */
  prWatch?: PrWatchView | null;
}

export const recordForgeEvent = (
  recorded: RecordedForgeEvents | undefined,
  payload: Pick<RunForgeRequestChangedPayload, "forgeRequest" | "prWatch">,
): RecordedForgeEvents => ({
  count: (recorded?.count ?? 0) + 1,
  forgeRequest: payload.forgeRequest,
  // An event without a watch keeps the newest watch an earlier event brought.
  prWatch: payload.prWatch !== undefined ? payload.prWatch : recorded?.prWatch,
});

/** A detail load that started before later events carries older state; apply what those events brought. */
export const replayForgeEventsSince = (detail: RunDetail, recorded: RecordedForgeEvents | undefined, countAtStart: number): RunDetail => {
  if (!recorded || recorded.count === countAtStart) return detail;
  return {
    ...detail,
    run: { ...detail.run, forgeRequest: recorded.forgeRequest, ...(recorded.prWatch !== undefined ? { prWatch: recorded.prWatch } : {}) },
  };
};
