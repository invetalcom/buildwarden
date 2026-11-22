import { describe, expect, it } from "vitest";
import type { PrWatchView, RunDetail, RunForgeRequestSummary } from "@buildwarden/shared";
import { recordForgeEvent, replayForgeEventsSince } from "./forge-event-replay";

const request = { url: "https://github.com/acme/app/pull/12", state: "open" } as RunForgeRequestSummary;
const watching = { status: "watching", wakeCount: 0 } as PrWatchView;
const working = { status: "working", wakeCount: 1 } as PrWatchView;
const staleDetail = { run: { id: "run-1", forgeRequest: null, prWatch: null } } as unknown as RunDetail;

describe("forge event replay", () => {
  it("applies a watch from an event that arrived while an older detail load was in flight", () => {
    const recorded = recordForgeEvent(undefined, { forgeRequest: request, prWatch: watching });
    expect(replayForgeEventsSince(staleDetail, recorded, 0).run).toMatchObject({ forgeRequest: request, prWatch: watching });
    // A load that started after the event is already current.
    expect(replayForgeEventsSince(staleDetail, recorded, 1)).toBe(staleDetail);
  });

  it("keeps the newest watch when later events carry none, and honors an explicit clear", () => {
    let recorded = recordForgeEvent(undefined, { forgeRequest: request, prWatch: working });
    recorded = recordForgeEvent(recorded, { forgeRequest: request });
    expect(replayForgeEventsSince(staleDetail, recorded, 0).run.prWatch).toBe(working);
    recorded = recordForgeEvent(recorded, { forgeRequest: request, prWatch: null });
    const detail = { run: { id: "run-1", forgeRequest: null, prWatch: watching } } as unknown as RunDetail;
    expect(replayForgeEventsSince(detail, recorded, 0).run.prWatch).toBeNull();
  });

  it("leaves the loaded watch alone when no event ever carried one", () => {
    const recorded = recordForgeEvent(undefined, { forgeRequest: request });
    const detail = { run: { id: "run-1", forgeRequest: null, prWatch: watching } } as unknown as RunDetail;
    expect(replayForgeEventsSince(detail, recorded, 0).run.prWatch).toBe(watching);
  });
});
