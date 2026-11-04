/** @vitest-environment happy-dom */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COUNCIL_SETTINGS,
  councilRoundSummary,
  parseCouncilSettings,
  readCouncilApplyRecord,
  removeCouncilReviewerModel,
  resolveCouncilReviewers,
  type CouncilApplyRecord,
  type CouncilFinding,
  type CouncilFindingGroup,
  type CouncilReview,
  type CouncilRound,
  type RunDetail,
  type RunEvent,
} from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { CouncilDockButton } from "./CouncilDockButton";
import { CouncilAppliedFindings } from "./council-applied-findings";
import { CouncilPanel } from "./CouncilPanel";
import { CouncilSettingsSection } from "./settings-council-section";
import { hasCouncilSurface } from "./use-council";

const review = (id: string, overrides: Partial<CouncilReview> = {}): CouncilReview => ({
  id, modelId: id, modelLabel: id.toUpperCase(), providerLabel: "Provider", effort: null, status: "completed", childRunId: `child-${id}`,
  attempts: 1, repairRequested: false, failureKind: null, failureMessage: null, findingCount: 1, output: "{}", inputTokens: 100, outputTokens: 20,
  ...overrides,
});

const finding = (id: string, reviewId: string, overrides: Partial<CouncilFinding> = {}): CouncilFinding => ({
  id, reviewId, title: `Finding ${id}`, severity: "high", file: "src/store.ts", line: 41, quote: null, problem: "Two writes overlap", impact: "Data is lost", suggestion: "Add a lock",
  ...overrides,
});

const group = (id: string, decision: CouncilFindingGroup["decision"], findingIds: string[]): CouncilFindingGroup => ({
  id, title: `Group ${id}`, severity: "high", decision, reason: `Reason ${id}`, findingIds,
});

const round = (overrides: Partial<CouncilRound> = {}): CouncilRound => ({
  id: "round", runId: "run", projectId: "project", status: "ready", kind: "code", trigger: "manual",
  createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:05:00.000Z", deadlineAt: "2026-11-04T10:15:00.000Z",
  minReviews: 1, autoApply: false, authorModelId: "author", authorModelLabel: "Author", subjectFingerprint: "code:a",
  reviews: [review("gpt"), review("claude")], assessment: null, assessmentError: null, summary: "One real issue.",
  findings: [finding("F1", "gpt"), finding("F2", "claude"), finding("F3", "gpt", { severity: "low" })],
  groups: [group("G1", "recommended", ["F1", "F2"]), group("G2", "rejected", ["F3"])],
  appliedGroupIds: [], error: null, stepId: "step",
  ...overrides,
});

const run = { id: "run", status: "completed" as const, errorMessage: null };

const savedSetting = (client: { setAppSetting: { mock: { calls: unknown[][] } } }) => String(client.setAppSetting.mock.calls.at(-1)?.[1]);

const makeClient = (rounds: CouncilRound[]) => {
  let listener: ((event: RunEvent) => void) | null = null;
  const client = {
    capabilities: { runMutations: true },
    getCouncilRounds: vi.fn(async () => rounds),
    startCouncil: vi.fn(async () => rounds[0]),
    cancelCouncil: vi.fn(async () => rounds[0]),
    applyCouncilFindings: vi.fn(async () => rounds[0]),
    setAppSetting: vi.fn(async () => undefined),
    onRunEvent: vi.fn((next: (event: RunEvent) => void) => { listener = next; return () => undefined; }),
  };
  return { client, emit: (event: Partial<RunEvent>) => listener?.({ runId: "run", type: "status", title: "", content: "", createdAt: "", ...event }) };
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const renderWith = async (client: unknown, ui: ReactElement) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<BuildWardenClientProvider client={client as BuildWardenClient}>{ui}</BuildWardenClientProvider>));
  await flush();
};

const pageText = () => document.body.textContent ?? "";

const labelOf = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
const matches = (value: string, name: string | RegExp) => (typeof name === "string" ? value === name : name.test(value));

const queryButton = (name: string | RegExp) =>
  [...document.querySelectorAll("button")].find((button) => matches(labelOf(button), name)) ?? null;
const button = (name: string | RegExp) => {
  const found = queryButton(name);
  if (!found) throw new Error(`No button named ${String(name)} in: ${pageText()}`);
  return found;
};
const labelled = (name: string) => {
  const found = document.querySelector(`[aria-label="${name}"]`);
  if (!found) throw new Error(`Nothing labelled ${name}`);
  return found as HTMLElement;
};
const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
  await flush();
};

describe("availability", () => {
  const models = [{ id: "a", enabled: true }, { id: "b", enabled: false }];

  it("counts only reviewers whose model can run", () => {
    expect(resolveCouncilReviewers({ reviewers: [] }, models)).toEqual([]);
    expect(resolveCouncilReviewers({ reviewers: [{ modelId: "b" }, { modelId: "gone" }] }, models)).toEqual([]);
    expect(resolveCouncilReviewers({ reviewers: [{ modelId: "a" }] }, models)).toHaveLength(1);
  });

  it("hides the feature until reviewers exist, but keeps saved results reachable", () => {
    const detail = (councilRounds: CouncilRound[] = []) => ({ run: { kind: "standard" }, councilRounds }) as unknown as RunDetail;
    expect(hasCouncilSurface(detail(), false)).toBe(false);
    expect(hasCouncilSurface(detail(), true)).toBe(true);
    expect(hasCouncilSurface(detail([round()]), false)).toBe(true);
    expect(hasCouncilSurface({ ...detail(), run: { kind: "council-review" } } as unknown as RunDetail, true)).toBe(false);
  });

  it("leaves auto-fix off by default", () => {
    expect(DEFAULT_COUNCIL_SETTINGS.autoApply).toBe(false);
    expect(parseCouncilSettings("").autoApply).toBe(false);
    expect(parseCouncilSettings('{"reviewers":[{"modelId":"a"}]}').autoApply).toBe(false);
  });

  it("cannot auto-run without reviewers, and drops duplicates", () => {
    expect(parseCouncilSettings('{"autoRun":true,"reviewers":[]}').autoRun).toBe(false);
    const settings = parseCouncilSettings('{"minReviews":5,"reviewers":[{"modelId":"a"},{"modelId":"a"},{"modelId":"b"}]}');
    expect(settings.reviewers).toHaveLength(2);
    expect(settings.minReviews).toBe(2);
  });

  it("turns auto-run off when the last reviewer's model is deleted", () => {
    const settings = parseCouncilSettings('{"autoRun":true,"minReviews":2,"reviewers":[{"modelId":"a"},{"modelId":"b"}]}');
    expect(removeCouncilReviewerModel(settings, "a")).toMatchObject({ minReviews: 1, autoRun: true });
    expect(removeCouncilReviewerModel(removeCouncilReviewerModel(settings, "a"), "b")).toMatchObject({ reviewers: [], autoRun: false });
  });
});

describe("CouncilAppliedFindings", () => {
  const applied: CouncilApplyRecord = {
    label: "Fix 2 validation findings",
    findings: [
      { title: "Saves overlap", severity: "high", location: "src/app/store.ts:41", quote: null, problem: "Two writes overlap", impact: "Data is lost", suggestion: "Add a lock", assessment: "Confirmed", raisedBy: ["GPT", "Sonnet"] },
      { title: "Empty response", severity: "low", location: null, quote: "Cache forever", problem: "Never refreshed", impact: "", suggestion: null, assessment: null, raisedBy: [] },
    ],
  };

  it("shows what was sent to the model, with details on demand", async () => {
    await renderWith({}, <CouncilAppliedFindings record={applied} />);
    expect(pageText()).toContain("Fix 2 validation findings");
    expect(pageText()).toContain("Saves overlap");
    expect(pageText()).toContain("store.ts:41");
    expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("opens a single finding, which is the common case", async () => {
    await renderWith({}, <CouncilAppliedFindings record={{ ...applied, findings: applied.findings.slice(0, 1) }} />);
    expect(document.querySelectorAll("details[open]")).toHaveLength(1);
    expect(pageText()).toContain("GPT, Sonnet");
  });

  it("ignores step metadata that is not a usable record", () => {
    expect(readCouncilApplyRecord({})).toBeNull();
    expect(readCouncilApplyRecord({ councilApply: { label: "x", findings: [] } })).toBeNull();
    expect(readCouncilApplyRecord({ councilApply: applied })).toEqual(applied);
  });
});

describe("councilRoundSummary", () => {
  it("does not present a partial review as a clean pass", () => {
    const partial = round({ groups: [], findings: [], reviews: [review("gpt"), review("claude", { status: "failed" }), review("gemini", { status: "skipped" })] });
    expect(councilRoundSummary(partial)).toBe("No findings from 1 of 3 models");
  });

  it("describes findings and decisions", () => {
    expect(councilRoundSummary(round())).toBe("2 findings · 1 recommended · 1 rejected · from 2 models");
  });
});

describe("CouncilDockButton", () => {
  it("starts a validation when there are no results", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilDockButton run={run} initialRounds={[]} available />);
    await click(button("Validate"));
    expect(client.startCouncil).toHaveBeenCalledWith("run");
  });

  it("opens results instead of paying for the same review twice", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilDockButton run={run} initialRounds={[round()]} available />);
    await click(button("2 findings"));
    expect(client.startCouncil).not.toHaveBeenCalled();
  });

  it("offers a new validation once the work has changed", async () => {
    const { client } = makeClient([round({ stale: true })]);
    await renderWith(client, <CouncilDockButton run={run} initialRounds={[]} available />);
    expect(queryButton("Validate")).not.toBeNull();
  });

  it("shows progress and renders nothing when unavailable", async () => {
    const active = makeClient([round({ status: "reviewing", reviews: [review("gpt"), review("claude", { status: "running" })] })]);
    await renderWith(active.client, <CouncilDockButton run={run} initialRounds={[]} available />);
    expect(queryButton("Validating 1/2")).not.toBeNull();
    await act(async () => root?.unmount());
    container?.remove();

    const none = makeClient([]);
    await renderWith(none.client, <CouncilDockButton run={run} initialRounds={[]} available={false} />);
    expect(none.client.getCouncilRounds).toHaveBeenCalled();
    expect(container?.textContent).toBe("");
  });

  it("stays out of the way until there is a finished result to check", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilDockButton run={{ ...run, status: "cancelled" }} initialRounds={[]} available />);
    expect(queryButton("Validate")).toBeNull();
  });

  it("still offers Validate after a failed verification, where the changes are reviewable", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilDockButton run={{ ...run, status: "failed", errorMessage: "Verification failed: pnpm test" }} initialRounds={[]} available />);
    expect(queryButton("Validate")).not.toBeNull();
  });
});

describe("CouncilPanel", () => {
  it("collapses duplicates, shows who agreed, and hides rejected findings by default", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available />);
    expect(pageText()).toContain("Group G1");
    expect(pageText()).toContain("2 models");
    expect(pageText()).not.toContain("Group G2");
    await click(button(/Rejected \(1\)/));
    expect(pageText()).toContain("Group G2");
  });

  it("preselects recommended findings and applies only the checked ones", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available />);
    await click(button("Fix 1 finding"));
    expect(client.applyCouncilFindings).toHaveBeenCalledWith("round", ["G1"]);
  });

  it("lets the user include a rejected finding", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available />);
    await click(button(/Rejected \(1\)/));
    await click(labelled("Include Group G2"));
    await click(button("Fix 2 findings"));
    expect(client.applyCouncilFindings).toHaveBeenCalledWith("round", ["G1", "G2"]);
  });

  it("disables applying when nothing is selected", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available />);
    await click(labelled("Include Group G1"));
    expect(button("Fix 0 findings").disabled).toBe(true);
  });

  it("uses revision wording and passages for text reviews", async () => {
    const text = round({
      kind: "text",
      findings: [finding("F1", "gpt", { file: null, line: null, quote: "Cache forever" })],
      groups: [group("G1", "recommended", ["F1"])],
    });
    const { client } = makeClient([text]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[text]} available />);
    expect(queryButton("Revise answer with 1 finding")).not.toBeNull();
    await click(button(/Group G1/));
    expect(pageText()).toContain("Cache forever");
  });

  it("is honest about partial results and says why a reviewer is missing", async () => {
    const partial = round({ reviews: [review("gpt"), review("claude"), review("gemini", { status: "skipped", failureKind: "limit", failureMessage: "Weekly usage limit reached" })] });
    const { client } = makeClient([partial]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[partial]} available />);
    expect(pageText()).toContain("from 2 of 3 models");
    expect(pageText()).toContain("Usage limit");
    expect(queryButton("Validate again")).not.toBeNull();
  });

  it("shows unassessed findings when the assessment failed", async () => {
    const unassessed = round({ assessmentError: "limit", summary: null, groups: [group("G1", "unassessed", ["F1"])] });
    const { client } = makeClient([unassessed]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[unassessed]} available />);
    expect(pageText()).toMatch(/could not assess/);
    expect(queryButton(/Not assessed \(1\)/)).not.toBeNull();
  });

  it("does not offer to repeat a complete review of unchanged work", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available />);
    expect(queryButton("Validate again")).toBeNull();
  });

  it("warns when the work changed after the review", async () => {
    const stale = round({ stale: true });
    const { client } = makeClient([stale]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[stale]} available />);
    expect(pageText()).toMatch(/work changed after this review/);
  });

  it("keeps results readable but cannot start a new round after reviewers are removed", async () => {
    const { client } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[round()]} available={false} />);
    expect(pageText()).toContain("Group G1");
    expect(queryButton("Validate again")).toBeNull();
    expect(queryButton("Fix 1 finding")).not.toBeNull();
  });

  it("shows earlier rounds without letting them be applied", async () => {
    const older = round({ id: "older", createdAt: "2026-11-03T10:00:00.000Z" });
    const { client } = makeClient([older, round({ status: "applied", appliedGroupIds: ["G1"] })]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[]} available />);
    expect(pageText()).toContain("Fixed 1 finding");
    expect(queryButton(/^Fix /)).toBeNull();
  });

  it("refreshes when the round changes", async () => {
    const { client, emit } = makeClient([round()]);
    await renderWith(client, <CouncilPanel run={run} initialRounds={[]} available />);
    expect(pageText()).toContain("Group G1");
    const before = client.getCouncilRounds.mock.calls.length;
    await act(async () => { emit({ metadata: { councilRoundId: "round" } }); });
    await flush();
    expect(client.getCouncilRounds.mock.calls.length).toBeGreaterThan(before);
  });

  it("surfaces a failed start", async () => {
    const { client } = makeClient([]);
    client.startCouncil.mockRejectedValueOnce(new Error("This run has no changes or answer to validate."));
    await renderWith(client, <CouncilPanel run={run} initialRounds={[]} available />);
    await click(button("Validate"));
    expect(pageText()).toMatch(/no changes or answer/);
  });
});

describe("CouncilSettingsSection", () => {
  const models = [
    { id: "a", displayName: "Model A", providerAccountId: "p", enabled: true },
    { id: "b", displayName: "Model B", providerAccountId: "p", enabled: true },
  ] as never;
  const accounts = [{ id: "p", label: "Provider" }] as never;

  it("shows options only once a reviewer exists, and saves new reviewers with auto-fix off", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilSettingsSection models={models} providerAccounts={accounts} serializedValue="" canEdit />);
    expect(document.querySelector('[aria-label="Apply accepted findings automatically"]')).toBeNull();
    await click(button("Add reviewer"));
    const toggle = labelled("Apply accepted findings automatically");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(client.setAppSetting).toHaveBeenCalled();
    expect(JSON.parse(savedSetting(client))).toMatchObject({ reviewers: [{ modelId: "a" }], autoApply: false });
  });

  it("saves the auto-fix toggle", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilSettingsSection models={models} providerAccounts={accounts} serializedValue='{"reviewers":[{"modelId":"a"}]}' canEdit />);
    await click(labelled("Apply accepted findings automatically"));
    expect(client.setAppSetting).toHaveBeenCalled();
    expect(JSON.parse(savedSetting(client))).toMatchObject({ autoApply: true });
  });

  it("keeps a removed model visible so it can be replaced", async () => {
    const { client } = makeClient([]);
    await renderWith(client, <CouncilSettingsSection models={models} providerAccounts={accounts} serializedValue='{"reviewers":[{"modelId":"gone"}]}' canEdit />);
    expect(pageText()).toContain("Unavailable model");
  });
});
