/** @vitest-environment happy-dom */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CouncilFindingGroup, CouncilReview, CouncilRound } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { RunValidationBar, RunValidationPanel, type CouncilRoundsState } from "./RunValidationPanel";

const review = (id: string, overrides: Partial<CouncilReview> = {}): CouncilReview => ({
  id, modelId: id, modelLabel: id.toUpperCase(), providerLabel: "Provider", effort: null, status: "completed", childRunId: null,
  attempts: 1, repairRequested: false, failureKind: null, failureMessage: null, findingCount: 1, output: null, inputTokens: 0, outputTokens: 0, ...overrides,
});

const group = (id: string, decision: CouncilFindingGroup["decision"], findingIds: string[]): CouncilFindingGroup => ({
  id, title: `Group ${id}`, severity: "high", decision, reason: `Reason ${id}`, findingIds,
});

const baseRound = (overrides: Partial<CouncilRound> = {}): CouncilRound => ({
  id: "round", runId: "run", projectId: "project", status: "ready", kind: "code", trigger: "manual", createdAt: "", updatedAt: "", finishedAt: "", deadlineAt: "",
  minReviews: 1, autoApply: false, authorModelId: "author", authorModelLabel: "Author", subjectFingerprint: "code:a",
  reviews: [review("gpt"), review("claude")], assessment: null, assessmentError: null, summary: "One real issue.",
  findings: [
    { id: "F1", reviewId: "gpt", title: "A", severity: "high", file: "src/store.ts", line: 41, quote: null, problem: "Writes overlap", impact: "Data is lost", suggestion: "Add a lock" },
    { id: "F2", reviewId: "claude", title: "B", severity: "high", file: "src/store.ts", line: 42, quote: null, problem: "Saves race", impact: "", suggestion: null },
    { id: "F3", reviewId: "gpt", title: "C", severity: "low", file: null, line: null, quote: null, problem: "Naming", impact: "", suggestion: null },
  ],
  groups: [group("G1", "recommended", ["F1", "F2"]), group("G2", "rejected", ["F3"])],
  appliedGroupIds: [], error: null, stepId: null, ...overrides,
});

const councilFor = (rounds: CouncilRound[]): CouncilRoundsState => ({
  rounds, latest: rounds.at(-1) ?? null, active: rounds.find((round) => ["reviewing", "assessing", "applying"].includes(round.status)) ?? null, refresh: vi.fn(async () => undefined),
});

const run = { id: "run", status: "completed" as const, errorMessage: null };

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
  document.body.innerHTML = "";
});

const makeClient = (overrides: Record<string, unknown> = {}) => ({
  capabilities: { runMutations: true },
  startCouncil: vi.fn(async () => baseRound()),
  cancelCouncil: vi.fn(async () => baseRound()),
  applyCouncilFindings: vi.fn(async () => baseRound()),
  ...overrides,
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const mount = async (client: ReturnType<typeof makeClient>, ui: ReactElement) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<MobileAppProvider value={{ client } as unknown as MobileAppValue}>{ui}</MobileAppProvider>));
  await flush();
};

const text = () => document.body.textContent ?? "";
const labelOf = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
const queryButton = (name: string | RegExp) => [...document.querySelectorAll("button")].find((button) => (typeof name === "string" ? labelOf(button) === name : name.test(labelOf(button)))) ?? null;
const button = (name: string | RegExp) => {
  const found = queryButton(name);
  if (!found) throw new Error(`No button named ${String(name)} in: ${text()}`);
  return found;
};
const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
  await flush();
};

describe("RunValidationPanel", () => {
  it("shows duplicates as one row with who agreed, and hides rejected findings until asked", async () => {
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    expect(text()).toContain("Group G1");
    expect(text()).toContain("2 models");
    expect(text()).toContain("store.ts:41");
    expect(text()).not.toContain("Group G2");
    await click(button("Show"));
    expect(text()).toContain("Group G2");
  });

  it("applies the preselected recommended findings", async () => {
    const client = makeClient();
    await mount(client, <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    await click(button("Fix 1 finding"));
    expect(client.applyCouncilFindings).toHaveBeenCalledWith("round", ["G1"]);
  });

  it("lets the user include a rejected finding", async () => {
    const client = makeClient();
    await mount(client, <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    await click(button("Show"));
    await click(button("Include Group G2"));
    await click(button("Fix 2 findings"));
    expect(client.applyCouncilFindings).toHaveBeenCalledWith("round", ["G1", "G2"]);
  });

  it("opens the details in a sheet", async () => {
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    expect(text()).not.toContain("Writes overlap");
    await click(button(/^Group G1/));
    expect(text()).toContain("Writes overlap");
    expect(text()).toContain("Reason G1");
  });

  it("keeps a partial result honest", async () => {
    const partial = baseRound({ reviews: [review("gpt"), review("claude"), review("gemini", { status: "skipped", failureKind: "limit" })] });
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([partial])} available />);
    expect(text()).toContain("from 2 of 3 models");
    expect(text()).toContain("Usage limit");
  });

  it("uses revision wording for a text review", async () => {
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([baseRound({ kind: "text" })])} available />);
    expect(queryButton("Revise answer with 1 finding")).not.toBeNull();
  });

  it("offers cancel while reviewing, and no fix button", async () => {
    const reviewing = baseRound({ status: "reviewing", groups: [], findings: [], reviews: [review("gpt", { status: "running" })] });
    const client = makeClient();
    await mount(client, <RunValidationPanel run={run} council={councilFor([reviewing])} available />);
    await click(button("Cancel validation"));
    expect(client.cancelCouncil).toHaveBeenCalledWith("round");
  });

  it("switches between rounds, and only the latest can be applied", async () => {
    const older = baseRound({ id: "older", summary: "Older summary" });
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([older, baseRound()])} available />);
    expect(text()).toContain("One real issue.");
    await click(button("Round 1"));
    expect(text()).toContain("Older summary");
    expect(queryButton(/^Fix /)).toBeNull();
  });

  it("does not offer to repeat a complete review of unchanged work", async () => {
    const applied = baseRound({ status: "applied" });
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    expect(queryButton("Validate again")).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([applied])} available />);
    expect(queryButton("Validate again")).not.toBeNull();
  });

  it("keeps results readable after reviewers are removed", async () => {
    await mount(makeClient(), <RunValidationPanel run={run} council={councilFor([baseRound({ status: "applied" })])} available={false} />);
    expect(text()).toContain("Group G1");
    expect(queryButton("Validate again")).toBeNull();
  });

  it("is read-only without run permissions", async () => {
    await mount(makeClient({ capabilities: { runMutations: false } }), <RunValidationPanel run={run} council={councilFor([baseRound()])} available />);
    expect(text()).toContain("Group G1");
    expect(queryButton(/^Fix /)).toBeNull();
    expect(queryButton("Include Group G1")).toBeNull();
  });
});

describe("RunValidationBar", () => {
  it("starts a validation and opens the results", async () => {
    const client = makeClient();
    const onOpen = vi.fn();
    await mount(client, <RunValidationBar run={run} council={councilFor([])} available onOpen={onOpen} />);
    await click(button("Validate"));
    expect(client.startCouncil).toHaveBeenCalledWith("run");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("stays put and shows why when starting fails", async () => {
    const client = makeClient({ startCouncil: vi.fn(async () => { throw new Error("No changes to validate."); }) });
    const onOpen = vi.fn();
    await mount(client, <RunValidationBar run={run} council={councilFor([])} available onOpen={onOpen} />);
    await click(button("Validate"));
    expect(text()).toContain("No changes to validate.");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens existing results instead of paying for the same review twice", async () => {
    const client = makeClient();
    const onOpen = vi.fn();
    await mount(client, <RunValidationBar run={run} council={councilFor([baseRound()])} available onOpen={onOpen} />);
    await click(button("2 findings"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(client.startCouncil).not.toHaveBeenCalled();
  });

  it("offers a new validation once the work has changed", async () => {
    await mount(makeClient(), <RunValidationBar run={run} council={councilFor([baseRound({ stale: true })])} available onOpen={vi.fn()} />);
    expect(queryButton("Validate")).not.toBeNull();
  });

  it("shows progress", async () => {
    const reviewing = baseRound({ status: "reviewing", reviews: [review("gpt"), review("claude", { status: "running" })] });
    await mount(makeClient(), <RunValidationBar run={run} council={councilFor([reviewing])} available onOpen={vi.fn()} />);
    expect(text()).toContain("Validating 1/2");
  });

  it("renders nothing without reviewers or permissions", async () => {
    await mount(makeClient(), <RunValidationBar run={run} council={councilFor([])} available={false} onOpen={vi.fn()} />);
    expect(container?.textContent).toBe("");
    await act(async () => root?.unmount());
    container?.remove();
    await mount(makeClient({ capabilities: { runMutations: false } }), <RunValidationBar run={run} council={councilFor([])} available onOpen={vi.fn()} />);
    expect(container?.textContent).toBe("");
  });
});
