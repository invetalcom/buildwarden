import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COUNCIL_SETTINGS, type CouncilRound, type CouncilSettings, type RunRecord } from "@buildwarden/shared";
import { CouncilService, type CouncilChildResult, type CouncilHost, type CouncilStore } from "./council-service";
import { councilApplyStepContent, type CouncilSubject } from "./council-prompts";
import { councilCommittedBaseRef, latestRunExecutionSettings, runUserRequests } from "./app-controller";
import { classifyCouncilFailure, parseCouncilAssessment, parseCouncilReport } from "./council-output";

const REPORT = JSON.stringify({ findings: [{ title: "Race in save", severity: "high", file: "a.ts", line: 3, problem: "Two writes overlap", impact: "Data is lost" }] });
const EMPTY_REPORT = JSON.stringify({ findings: [] });
const MALFORMED_REPORT = JSON.stringify({ findings: [{ title: "Race in save", description: "Uses the wrong field" }] });
const READABLE_FINDING = { title: "Race in save", severity: "high", file: "a.ts", line: 3, problem: "Two writes overlap" };
const PARTLY_READABLE_REPORT = JSON.stringify({ findings: [READABLE_FINDING, { title: "Second", description: "Wrong field" }] });
const TWO_FINDINGS_REPORT = JSON.stringify({ findings: [READABLE_FINDING, { ...READABLE_FINDING, title: "Second" }] });
const assessmentFor = (ids: string[]) => JSON.stringify({ summary: "One real issue.", groups: [{ title: "Race in save", severity: "high", decision: "recommended", reason: "Confirmed", findingIds: ids }] });

const memoryStore = (): CouncilStore => {
  const rounds = new Map<string, CouncilRound>();
  const copy = (round: CouncilRound) => JSON.parse(JSON.stringify(round)) as CouncilRound;
  return {
    saveCouncilRound: (round) => { rounds.set(round.id, copy(round)); },
    getCouncilRound: (id) => copy(rounds.get(id)!),
    listCouncilRounds: (runId) => [...rounds.values()].filter((round) => round.runId === runId).map(copy),
    listCouncilRoundsWithStatuses: (statuses) => [...rounds.values()].filter((round) => statuses.includes(round.status)).map(copy),
  };
};

const setup = (overrides: Partial<CouncilSettings> = {}, subject: Partial<CouncilSubject> = {}) => {
  const settings: CouncilSettings = {
    ...DEFAULT_COUNCIL_SETTINGS,
    reviewers: [{ modelId: "gpt" }, { modelId: "claude" }, { modelId: "gemini" }],
    ...overrides,
  };
  const run = { id: "run", projectId: "project", kind: "standard", status: "completed", mode: "code", modelId: "author", errorMessage: null } as RunRecord;
  const children: Array<{ id: string; modelId: string; prompt: string }> = [];
  const results = new Map<string, CouncilChildResult>();
  let fingerprint = "code:one";
  const host: CouncilHost = {
    getRun: () => run,
    getSettings: () => settings,
    getReviewers: () => settings.reviewers,
    describeModel: (modelId) => ({ label: modelId.toUpperCase(), providerLabel: "Provider" }),
    isRunBusy: vi.fn(() => false),
    captureSubject: vi.fn(async () => ({ kind: "code" as const, requests: ["Do it"], diff: "diff", answer: null, fingerprint: "code:one", ...subject })),
    currentFingerprint: vi.fn(async () => fingerprint),
    readConversation: () => "<conversation/>",
    getLimitReason: vi.fn(async () => null),
    startChild: vi.fn(async (_round, input) => {
      const id = `child-${String(children.length + 1)}`;
      children.push({ id, modelId: input.modelId, prompt: input.prompt });
      return id;
    }),
    messageChild: vi.fn(async () => undefined),
    stopChild: vi.fn(async () => undefined),
    releaseChild: vi.fn(async () => undefined),
    readChild: (id) => results.get(id)!,
    startApply: vi.fn(async () => undefined),
    setRunMode: vi.fn((_runId, mode) => { run.mode = mode; }),
    appendStep: () => "step",
    publish: vi.fn(),
    logError: vi.fn(),
  };
  const store = memoryStore();
  const service = new CouncilService(store, host);
  const finishChild = async (id: string, text: string, status: RunRecord["status"] = "completed", errorMessage: string | null = null) => {
    results.set(id, { status, text, errorMessage, inputTokens: 10, outputTokens: 5 });
    await service.onChildTerminal(id);
  };
  const childFor = (modelId: string) => children.filter((child) => child.modelId === modelId).at(-1)!;
  const latest = () => store.listCouncilRounds("run").at(-1)!;
  return { service, host, run, settings, children, finishChild, childFor, latest, setFingerprint: (value: string) => { fingerprint = value; } };
};

describe("CouncilService", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("aggregates reports and stops at results when auto-fix is off", async () => {
    const { service, host, finishChild, childFor, latest } = setup();
    await service.start("run");
    expect(latest().status).toBe("reviewing");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("claude").id, REPORT);
    await finishChild(childFor("gemini").id, EMPTY_REPORT);

    expect(latest().status).toBe("assessing");
    expect(childFor("author").prompt).toContain('"id":"F2"');
    await finishChild(childFor("author").id, assessmentFor(["F1", "F2"]));

    const round = latest();
    expect(round.status).toBe("ready");
    expect(round.groups).toHaveLength(1);
    expect(round.groups[0]!.findingIds).toEqual(["F1", "F2"]);
    expect(host.startApply).not.toHaveBeenCalled();
    expect(host.releaseChild).toHaveBeenCalledTimes(4);
  });

  it("keeps going when one provider hits a usage limit", async () => {
    const { service, finishChild, childFor, latest } = setup();
    await service.start("run");
    await finishChild(childFor("gpt").id, "", "failed", "You have hit your usage limit.");
    await finishChild(childFor("claude").id, REPORT);
    await finishChild(childFor("gemini").id, EMPTY_REPORT);
    await finishChild(childFor("author").id, assessmentFor(["F1"]));

    const round = latest();
    expect(round.status).toBe("ready");
    expect(round.reviews.find((review) => review.modelId === "gpt")).toMatchObject({ status: "failed", failureKind: "limit" });
  });

  it("skips a reviewer whose account is already at its limit", async () => {
    const { service, host, children, latest } = setup();
    vi.mocked(host.getLimitReason).mockImplementation(async (modelId) => (modelId === "gpt" ? "Weekly usage limit reached" : null));
    await service.start("run");
    expect(children.map((child) => child.modelId)).toEqual(["claude", "gemini"]);
    expect(latest().reviews[0]).toMatchObject({ status: "skipped", failureKind: "limit" });
  });

  it("continues when a reviewer cannot start", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }, { modelId: "claude" }] });
    const startChild = vi.mocked(host.startChild).getMockImplementation()!;
    vi.mocked(host.startChild).mockImplementation(async (round, input) => {
      if (input.modelId === "gpt") throw new Error("Credentials are unavailable");
      return startChild(round, input);
    });
    await service.start("run");
    await finishChild(childFor("claude").id, EMPTY_REPORT);
    expect(latest()).toMatchObject({ status: "ready" });
    expect(latest().reviews[0]).toMatchObject({ status: "failed", failureKind: "auth" });
  });

  it("fails without an author turn when too few reviews finish", async () => {
    const { service, children, finishChild, childFor, latest } = setup({ minReviews: 2 });
    await service.start("run");
    await finishChild(childFor("gpt").id, "", "failed", "boom");
    await finishChild(childFor("claude").id, "", "failed", "boom");
    await finishChild(childFor("gemini").id, REPORT);
    expect(latest().status).toBe("failed");
    expect(latest().error).toContain("Only 1 of the 2");
    expect(children.some((child) => child.modelId === "author")).toBe(false);
  });

  it("skips the author turn when nobody found anything", async () => {
    const { service, children, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, EMPTY_REPORT);
    expect(latest()).toMatchObject({ status: "ready", groups: [] });
    expect(children).toHaveLength(1);
  });

  it("retries a temporary failure once with a new child", async () => {
    const { service, children, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, "", "failed", "503 overloaded");
    expect(children).toHaveLength(2);
    await finishChild(childFor("gpt").id, "", "failed", "503 overloaded");
    expect(children).toHaveLength(2);
    expect(latest().status).toBe("failed");
  });

  it("asks once for a readable report before giving up on a reviewer", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, "I looked at the code and it seems fine.");
    expect(host.messageChild).toHaveBeenCalledOnce();
    expect(latest().status).toBe("reviewing");
    await finishChild(id, "Still not JSON.");
    expect(host.messageChild).toHaveBeenCalledOnce();
    expect(latest().reviews[0]).toMatchObject({ status: "failed", failureKind: "output" });
  });

  it("never reports unreadable findings as a clean review", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, MALFORMED_REPORT);
    expect(host.messageChild).toHaveBeenCalledOnce();
    expect(latest().status).toBe("reviewing");

    await finishChild(id, MALFORMED_REPORT);
    expect(latest().reviews[0]).toMatchObject({ status: "failed", failureKind: "output" });
    expect(latest().status).toBe("failed");
  });

  it("asks again when only some entries are readable, and accepts the corrected report", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, PARTLY_READABLE_REPORT);
    expect(host.messageChild).toHaveBeenCalledOnce();
    await finishChild(id, TWO_FINDINGS_REPORT);
    expect(latest().findings).toHaveLength(2);
    expect(latest().findings.map((finding) => finding.id)).toEqual(["F1", "F2"]);
  });

  it("keeps the readable findings when the correction still drops some", async () => {
    const { service, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, PARTLY_READABLE_REPORT);
    await finishChild(id, PARTLY_READABLE_REPORT);
    expect(latest().findings).toHaveLength(1);
    expect(latest().reviews[0]).toMatchObject({ status: "completed", findingCount: 1 });
  });

  it("keeps readable findings when the correction turn itself fails", async () => {
    const { service, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, PARTLY_READABLE_REPORT);
    await finishChild(id, "", "failed", "You have hit your usage limit.");
    expect(latest().findings).toHaveLength(1);
    expect(latest().reviews[0]).toMatchObject({ status: "completed" });
  });

  it.each([
    ["answers in prose", "I checked again and it looks fine.", "completed", null],
    ["has only unreadable entries", MALFORMED_REPORT, "completed", null],
    ["fails with partial text", "Partial answer before the limit", "failed", "You have hit your usage limit."],
  ] as const)("keeps the first reply's findings when the correction %s", async (_name, text, status, error) => {
    const { service, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    const { id } = childFor("gpt");
    await finishChild(id, PARTLY_READABLE_REPORT);
    await finishChild(id, text, status, error);
    expect(latest().findings).toHaveLength(1);
    expect(latest().reviews[0]).toMatchObject({ status: "completed", findingCount: 1 });
  });

  it("stops a hanging reviewer at the deadline and uses the others", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ timeoutMinutes: 5 });
    await service.start("run");
    await finishChild(childFor("gpt").id, EMPTY_REPORT);
    await finishChild(childFor("claude").id, EMPTY_REPORT);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.reconcileAfterRestart();

    expect(host.stopChild).toHaveBeenCalledWith(childFor("gemini").id);
    expect(latest().status).toBe("ready");
    expect(latest().reviews[2]).toMatchObject({ failureKind: "timeout" });
  });

  it("shows findings unassessed when the author fails, and never auto-applies them", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }], autoApply: true });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("author").id, "", "failed", "You have hit your usage limit.");

    const round = latest();
    expect(round.status).toBe("ready");
    expect(round.assessmentError).toContain("usage limit");
    expect(round.groups).toMatchObject([{ decision: "unassessed", findingIds: ["F1"] }]);
    expect(host.startApply).not.toHaveBeenCalled();
  });

  it("applies recommended findings automatically only when enabled", async () => {
    const { service, host, run, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }], autoApply: true });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("author").id, assessmentFor(["F1"]));

    expect(host.startApply).toHaveBeenCalledOnce();
    expect(latest().status).toBe("applying");
    expect(await service.onRunTerminal("run")).toBe(true);
    expect(latest().status).toBe("applied");
    expect(run.status).toBe("completed");
  });

  it("does not auto-apply on top of work the reviewers never saw", async () => {
    const { service, host, finishChild, childFor, latest, setFingerprint } = setup({ reviewers: [{ modelId: "gpt" }], autoApply: true });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    setFingerprint("code:two");
    await finishChild(childFor("author").id, assessmentFor(["F1"]));
    expect(host.startApply).not.toHaveBeenCalled();
    expect(latest().status).toBe("ready");

    await service.applyFindings(latest().id, ["G1"]);
    expect(vi.mocked(host.startApply).mock.calls[0]![1]).toContain("first check that each issue still applies");
  });

  it.each([
    ["is unknown", () => Promise.resolve(null)],
    ["cannot be read", () => Promise.reject(new Error("git failed"))],
  ])("waits for the user when the current fingerprint %s", async (_name, lookup) => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }], autoApply: true });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    vi.mocked(host.currentFingerprint).mockImplementation(lookup);
    await finishChild(childFor("author").id, assessmentFor(["F1"]));
    expect(host.startApply).not.toHaveBeenCalled();
    expect(latest().status).toBe("ready");

    await service.applyFindings(latest().id, ["G1"]);
    expect(host.startApply).toHaveBeenCalledOnce();
    expect(vi.mocked(host.startApply).mock.calls[0]![1]).toContain("first check that each issue still applies");
  });

  it("applies only the selected groups in one turn", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("author").id, assessmentFor(["F1"]));
    await service.applyFindings(latest().id, ["G1"]);

    expect(host.startApply).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.stringContaining("Race in save"), expect.objectContaining({ label: "Fix 1 validation finding" }));
    expect(latest()).toMatchObject({ status: "applying", appliedGroupIds: ["G1"] });
    expect(vi.mocked(host.startApply).mock.calls[0]![1]).not.toContain("first check");
  });

  it("records the applied findings for the run's history", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }, { modelId: "claude" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("claude").id, REPORT);
    await finishChild(childFor("author").id, assessmentFor(["F1", "F2"]));
    await service.applyFindings(latest().id, ["G1"]);

    const record = vi.mocked(host.startApply).mock.calls[0]![2];
    expect(record.findings).toEqual([expect.objectContaining({
      title: "Race in save",
      location: "a.ts:3",
      problem: "Two writes overlap",
      assessment: "Confirmed",
      raisedBy: ["GPT", "CLAUDE"],
    })]);
    const content = councilApplyStepContent(record);
    expect(content).toContain("Fix 1 validation finding");
    expect(content).toContain("Problem: Two writes overlap");
    expect(content).toContain("Raised by: GPT, CLAUDE");
  });

  describe("text revision on a code run", () => {
    const TEXT = { kind: "text" as const, diff: null, answer: "The plan", fingerprint: "code:one" };
    const TEXT_REPORT = JSON.stringify({ findings: [{ title: "Race in save", severity: "high", quote: "q", problem: "Two writes overlap" }] });
    const prepare = async (service: CouncilService, finishChild: (id: string, text: string) => Promise<void>, childFor: (modelId: string) => { id: string }, latest: () => CouncilRound) => {
      await service.start("run");
      await finishChild(childFor("gpt").id, TEXT_REPORT);
      await finishChild(childFor("author").id, assessmentFor(["F1"]));
      return latest();
    };

    it("restores the mode when the turn ends", async () => {
      const { service, host, run, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] }, TEXT);
      const round = await prepare(service, finishChild, childFor, latest);
      vi.mocked(host.startApply).mockImplementation(async () => { run.mode = "ask"; });
      await service.applyFindings(round.id, ["G1"]);
      expect(latest().restoreMode).toBe("code");

      service.restoreRunMode("run");
      expect(run.mode).toBe("code");
      await service.onRunTerminal("run");
      expect(latest().restoreMode).toBeNull();
    });

    it("restores the mode after an app restart", async () => {
      const { service, host, run, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] }, TEXT);
      const round = await prepare(service, finishChild, childFor, latest);
      vi.mocked(host.startApply).mockImplementation(async () => { run.mode = "ask"; });
      await service.applyFindings(round.id, ["G1"]);

      await service.reconcileAfterRestart();
      expect(run.mode).toBe("code");
      expect(latest()).toMatchObject({ status: "apply-failed", restoreMode: null });
    });

    it("restores the mode when the turn cannot start", async () => {
      const { service, host, run, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] }, TEXT);
      const round = await prepare(service, finishChild, childFor, latest);
      vi.mocked(host.startApply).mockImplementation(async () => { run.mode = "ask"; throw new Error("Could not start"); });
      await expect(service.applyFindings(round.id, ["G1"])).rejects.toThrow("Could not start");
      expect(run.mode).toBe("code");
      expect(latest()).toMatchObject({ status: "ready", restoreMode: null });
    });

    it("leaves the mode alone on a plan run and on code reviews", async () => {
      const plan = setup({ reviewers: [{ modelId: "gpt" }] }, TEXT);
      plan.run.mode = "plan";
      const round = await prepare(plan.service, plan.finishChild, plan.childFor, plan.latest);
      await plan.service.applyFindings(round.id, ["G1"]);
      expect(plan.latest().restoreMode).toBeNull();
      await plan.service.reconcileAfterRestart();
      expect(plan.host.setRunMode).not.toHaveBeenCalled();
    });
  });

  it("keeps results when applying fails to start, so the user can retry", async () => {
    const { service, host, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, REPORT);
    await finishChild(childFor("author").id, assessmentFor(["F1"]));
    vi.mocked(host.startApply).mockRejectedValueOnce(new Error("Usage limit reached"));

    await expect(service.applyFindings(latest().id, ["G1"])).rejects.toThrow("Usage limit");
    expect(latest()).toMatchObject({ status: "ready", appliedGroupIds: [], error: "Usage limit reached" });
  });

  it("refuses to run without reviewers and when there is nothing to review", async () => {
    await expect(setup({ reviewers: [] }).service.start("run")).rejects.toThrow("Choose at least one reviewer");
    const { service, host } = setup();
    vi.mocked(host.captureSubject).mockRejectedValueOnce(new Error("This run has no changes or answer to validate."));
    await expect(service.start("run")).rejects.toThrow("no changes or answer");
  });

  it("allows only one active round per run", async () => {
    const { service } = setup();
    await service.start("run");
    await expect(service.start("run")).rejects.toThrow("already being validated");
  });

  it("closes open work after a restart and keeps what was collected", async () => {
    const { service, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }, { modelId: "claude" }] });
    await service.start("run");
    await finishChild(childFor("gpt").id, EMPTY_REPORT);
    await service.reconcileAfterRestart();
    expect(latest().status).toBe("ready");
    expect(latest().reviews[1]).toMatchObject({ status: "failed", failureKind: "interrupted" });
  });

  it("stops reviewers when cancelled and ignores their late results", async () => {
    const { service, host, children, finishChild, latest } = setup();
    const round = await service.start("run");
    await service.cancel(round.id);
    expect(host.stopChild).toHaveBeenCalledTimes(3);
    await finishChild(children[0]!.id, REPORT);
    expect(latest()).toMatchObject({ status: "cancelled", findings: [] });
  });

  describe("automatic validation", () => {
    it("runs for code runs with changes and never for ask runs", async () => {
      const code = setup({ autoRun: true });
      await code.service.autoStart("run");
      expect(code.latest()).toMatchObject({ trigger: "auto", status: "reviewing" });

      const ask = setup({ autoRun: true });
      ask.run.mode = "ask";
      await ask.service.autoStart("run");
      expect(ask.latest()).toBeUndefined();
    });

    it("does not start when turned off or without reviewers", async () => {
      const off = setup({ autoRun: false });
      await off.service.autoStart("run");
      expect(off.latest()).toBeUndefined();
      const empty = setup({ autoRun: true, reviewers: [] });
      await empty.service.autoStart("run");
      expect(empty.latest()).toBeUndefined();
    });

    it("skips a code run that only produced text", async () => {
      const { service, latest } = setup({ autoRun: true }, { kind: "text", diff: null, answer: "Hello", fingerprint: "text:a" });
      await service.autoStart("run");
      expect(latest()).toBeUndefined();
    });

    it("reviews a plan run's text", async () => {
      const { service, run, latest } = setup({ autoRun: true }, { kind: "text", diff: null, answer: "The plan", fingerprint: "text:a" });
      run.mode = "plan";
      await service.autoStart("run");
      expect(latest()).toMatchObject({ kind: "text" });
    });

    it("does not review unchanged work twice", async () => {
      const { service, finishChild, childFor, latest } = setup({ autoRun: true, reviewers: [{ modelId: "gpt" }] });
      await service.autoStart("run");
      await finishChild(childFor("gpt").id, EMPTY_REPORT);
      const first = latest().id;
      await service.autoStart("run");
      expect(latest().id).toBe(first);
    });

    it("does not start another round after a fix turn", async () => {
      const { service, finishChild, childFor, latest } = setup({ reviewers: [{ modelId: "gpt" }] });
      await service.start("run");
      await finishChild(childFor("gpt").id, REPORT);
      await finishChild(childFor("author").id, assessmentFor(["F1"]));
      await service.applyFindings(latest().id, ["G1"]);
      expect(await service.onRunTerminal("run")).toBe(true);
      expect(await service.onRunTerminal("run")).toBe(false);
    });
  });
});

describe("run history for later rounds", () => {
  it("keeps applied findings in what later reviewers are told", () => {
    const steps = [
      { content: "Build the board", metadataJson: JSON.stringify({ source: "user", commandType: "initial" }) },
      { content: "Fix 1 validation finding\n\n1. Race in save (high)", metadataJson: JSON.stringify({ source: "user", commandType: "follow-up", councilRoundId: "round" }) },
      { content: "Validated", metadataJson: JSON.stringify({ councilRoundId: "round" }) },
    ];
    expect(runUserRequests({ prompt: "Build the board" }, steps)).toEqual(["Build the board", steps[1]!.content]);
  });

  it("includes messages the user steered into a running turn, in order", () => {
    const steps = [
      { content: "Build the board", metadataJson: JSON.stringify({ source: "user", commandType: "initial" }) },
      { content: "Use tabs instead", metadataJson: JSON.stringify({ source: "user", commandType: "steer", steered: true }) },
      { content: "Now add tests", metadataJson: JSON.stringify({ source: "user", commandType: "follow-up" }) },
    ];
    expect(runUserRequests({ prompt: "Build the board" }, steps)).toEqual(["Build the board", "Use tabs instead", "Now add tests"]);
  });

  it("finds a reviewer's effort for its correction turn", () => {
    const steps = [{ metadataJson: JSON.stringify({ source: "council", commandType: "initial", executionOptions: { reasoningEffort: "high" } }) }];
    expect(latestRunExecutionSettings(steps)?.executionOptions).toEqual({ reasoningEffort: "high" });
  });

  it("reviews a run from where it started, not from its latest prompt", () => {
    expect(councilCommittedBaseRef({ workspaceType: "local" }, "main", "start")).toBe("start");
    expect(councilCommittedBaseRef({ workspaceType: "local" }, "main", null)).toBeNull();
    expect(councilCommittedBaseRef({ workspaceType: "worktree" }, "main", "start")).toBe("start");
    expect(councilCommittedBaseRef({ workspaceType: "worktree" }, "main", null)).toBe("main");
  });
});

describe("council output", () => {
  const finding = (id: string) => ({ id, reviewId: "r", title: id, severity: "low" as const, file: null, line: null, quote: null, problem: "p", impact: "", suggestion: null });

  it("reads a report wrapped in prose or a fence", () => {
    expect(parseCouncilReport(`Here you go:\n\`\`\`json\n${REPORT}\n\`\`\``, "code").findings).toHaveLength(1);
    expect(parseCouncilReport(EMPTY_REPORT, "code")).toEqual({ findings: [], droppedCount: 0 });
    expect(() => parseCouncilReport("no json here", "code")).toThrow();
  });

  it("uses quotes instead of file locations for text reviews", () => {
    const [parsed] = parseCouncilReport(JSON.stringify({ findings: [{ title: "T", problem: "P", quote: "Q", file: "a.ts", line: 2 }] }), "text").findings;
    expect(parsed).toMatchObject({ file: null, line: null, quote: "Q", severity: "medium" });
  });

  it("counts entries without a title or problem and clips long text", () => {
    const { findings, droppedCount } = parseCouncilReport(JSON.stringify({ findings: [{ title: "", problem: "P" }, "text", { title: "T".repeat(500), problem: "P".repeat(5000) }] }), "code");
    expect(droppedCount).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title.length).toBeLessThanOrEqual(120);
    expect(findings[0]!.problem.length).toBeLessThanOrEqual(600);
  });

  it("never loses or duplicates a finding in an assessment", () => {
    const findings = [finding("F1"), finding("F2"), finding("F3")];
    const { groups } = parseCouncilAssessment(JSON.stringify({ groups: [
      { title: "A", decision: "recommended", findingIds: ["F1", "F1", "F9"] },
      { title: "B", decision: "rejected", findingIds: ["F1", "F2"] },
      { title: "Empty", decision: "rejected", findingIds: ["F9"] },
    ] }), findings);

    expect(groups.flatMap((group) => group.findingIds).sort()).toEqual(["F1", "F2", "F3"]);
    expect(groups.find((group) => group.findingIds.includes("F3"))).toMatchObject({ decision: "unassessed" });
    expect(groups.map((group) => group.title)).not.toContain("Empty");
  });

  it("treats an unknown decision as unassessed", () => {
    const { groups } = parseCouncilAssessment(JSON.stringify({ groups: [{ decision: "maybe", findingIds: ["F1"] }] }), [finding("F1")]);
    expect(groups[0]).toMatchObject({ decision: "unassessed", title: "F1" });
  });

  it("classifies failures so only temporary ones are retried", () => {
    expect(classifyCouncilFailure("You've hit your usage limit")).toBe("limit");
    expect(classifyCouncilFailure("insufficient_quota")).toBe("limit");
    expect(classifyCouncilFailure("401 Unauthorized")).toBe("auth");
    expect(classifyCouncilFailure("503 Service Unavailable")).toBe("transient");
    expect(classifyCouncilFailure("Rate limit exceeded, retry shortly")).toBe("transient");
    expect(classifyCouncilFailure("Something else")).toBe("unknown");
  });
});
