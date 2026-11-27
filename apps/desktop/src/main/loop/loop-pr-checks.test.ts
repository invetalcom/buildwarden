import type { CouncilRound, RunRecord, RunVerificationState } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { runLoopPrChecks, type LoopPrCheckHost } from "./loop-pr-checks";

const run = { id: "run-1", status: "completed" } as RunRecord;

const round = (overrides: Partial<CouncilRound>): CouncilRound => ({
  id: "round-1", runId: "run-1", status: "ready", groups: [], appliedGroupIds: [], error: null, ...overrides,
} as CouncilRound);

const verification = (status: RunVerificationState["status"], reason: string | null = null): RunVerificationState => ({
  record: null, commands: ["pnpm test"], currentRevision: null, requiredBeforePublish: false, status, reason,
});

const createHost = (overrides: Partial<LoopPrCheckHost> = {}) => {
  const events: Array<[string, string]> = [];
  const host: LoopPrCheckHost = {
    latestCouncilRound: async () => undefined,
    getCouncilRound: () => round({}),
    startCouncil: async () => round({ status: "reviewing" }),
    applyCouncilFindings: async () => round({ status: "applying" }),
    verifyRun: async () => verification("passed"),
    verificationIsCurrent: async () => false,
    followUpAndWait: async () => run,
    sleep: async () => undefined,
    assertNotCancelled: () => undefined,
    appendEvent: (label, content) => { events.push([label, content]); },
    ...overrides,
  };
  return { host, events };
};

describe("loop checks before a pull request", () => {
  it("does nothing when neither check is on", async () => {
    const { host, events } = createHost({ startCouncil: vi.fn(), verifyRun: vi.fn() });
    await runLoopPrChecks(host, { councilBeforePr: 0, verifyBeforePr: 0 }, run);
    expect(host.startCouncil).not.toHaveBeenCalled();
    expect(host.verifyRun).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("fixes the recommended council findings and waits for the fix", async () => {
    const groups = [
      { id: "g1", title: "Missing null check", severity: "high", decision: "recommended", reason: null, findingIds: [] },
      { id: "g2", title: "Style", severity: "low", decision: "rejected", reason: null, findingIds: [] },
    ] as CouncilRound["groups"];
    const states = [round({ status: "reviewing" }), round({ status: "ready", groups }), round({ status: "applying", groups }), round({ status: "applied", groups, appliedGroupIds: ["g1"] })];
    const applyCouncilFindings = vi.fn(async () => round({ status: "applying" }));
    const { host, events } = createHost({ getCouncilRound: () => states.shift() ?? round({ status: "applied", groups, appliedGroupIds: ["g1"] }), applyCouncilFindings });
    await runLoopPrChecks(host, { councilBeforePr: true, verifyBeforePr: false }, run);
    expect(applyCouncilFindings).toHaveBeenCalledWith("round-1", ["g1"]);
    expect(events.map(([label]) => label)).toEqual(["Council review", "Council findings fixed"]);
  });

  it("reports which checks changed the code, and keeps finished results when the loop resumes", async () => {
    const groups = [{ id: "g1", title: "Missing null check", severity: "high", decision: "recommended", reason: null, findingIds: [] }] as CouncilRound["groups"];
    const states = [round({ status: "ready", groups }), round({ status: "applied", groups, appliedGroupIds: ["g1"] })];
    const fresh = createHost({ getCouncilRound: () => states.shift() ?? round({ status: "applied", groups, appliedGroupIds: ["g1"] }) });
    await expect(runLoopPrChecks(fresh.host, { councilBeforePr: true, verifyBeforePr: false }, run)).resolves.toEqual({ changed: true });

    const startCouncil = vi.fn(async () => round({ status: "reviewing" }));
    const verifyRun = vi.fn(async () => verification("passed"));
    const resumed = createHost({
      latestCouncilRound: async () => round({ status: "applied", groups, appliedGroupIds: ["g1"], stale: true }),
      getCouncilRound: () => round({ status: "applied", groups, appliedGroupIds: ["g1"] }),
      verificationIsCurrent: async () => true,
      startCouncil,
      verifyRun,
    });
    await expect(runLoopPrChecks(resumed.host, { councilBeforePr: true, verifyBeforePr: true }, run)).resolves.toEqual({ changed: false });
    expect(startCouncil).not.toHaveBeenCalled();
    expect(verifyRun).not.toHaveBeenCalled();

    const outdated = createHost({ latestCouncilRound: async () => round({ status: "ready", stale: true }), startCouncil });
    await runLoopPrChecks(outdated.host, { councilBeforePr: true, verifyBeforePr: false }, run);
    expect(startCouncil).toHaveBeenCalledOnce();
  });

  it("fails when the council could not apply its own fixes", async () => {
    const { host } = createHost({ getCouncilRound: () => round({ status: "apply-failed", error: "The fix turn failed." }) });
    await expect(runLoopPrChecks(host, { councilBeforePr: true, verifyBeforePr: false }, run)).rejects.toThrow("The fix turn failed.");
  });

  it("goes on without a council review that cannot start", async () => {
    const { host, events } = createHost({ startCouncil: async () => { throw new Error("No reviewers are configured."); } });
    await runLoopPrChecks(host, { councilBeforePr: true, verifyBeforePr: false }, run);
    expect(events).toEqual([["Council review skipped", "The council review could not start: No reviewers are configured."]]);
  });

  it("lets the agent fix a failing verification, then gives up after two tries", async () => {
    const results = [verification("failed", "2 tests failed"), verification("passed")];
    const followUpAndWait = vi.fn(async () => run);
    const fixed = createHost({ verifyRun: async () => results.shift() ?? verification("passed"), followUpAndWait });
    await runLoopPrChecks(fixed.host, { councilBeforePr: false, verifyBeforePr: true }, run);
    expect(followUpAndWait).toHaveBeenCalledOnce();
    expect(fixed.events.map(([label]) => label)).toEqual(["Verification failed", "Verification passed"]);

    const broken = createHost({ verifyRun: async () => verification("failed", "Build broken") });
    await expect(runLoopPrChecks(broken.host, { councilBeforePr: false, verifyBeforePr: true }, run))
      .rejects.toThrow("Verification did not pass after 2 fix attempts: Build broken");
  });

  it("starts no fix turn when the loop was cancelled during verification", async () => {
    let cancelled = false;
    const followUpAndWait = vi.fn(async () => run);
    const { host } = createHost({
      verifyRun: async () => { cancelled = true; return verification("failed", "2 tests failed"); },
      assertNotCancelled: () => { if (cancelled) throw new Error("The loop was cancelled."); },
      followUpAndWait,
    });
    await expect(runLoopPrChecks(host, { councilBeforePr: false, verifyBeforePr: true }, run)).rejects.toThrow("The loop was cancelled.");
    expect(followUpAndWait).not.toHaveBeenCalled();
  });

  it("skips verification when the project has no commands", async () => {
    const { host, events } = createHost({ verifyRun: async () => verification("unconfigured") });
    await runLoopPrChecks(host, { councilBeforePr: false, verifyBeforePr: true }, run);
    expect(events[0]?.[0]).toBe("Verification skipped");
  });
});
