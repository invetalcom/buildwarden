/** @vitest-environment happy-dom */

import type { RunDetail, RunEvent, RunRecord, RunStepRecord, RunWorktreeDiffResult } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useRunDetail } from "./use-run-detail";

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve };
};

const run = {
  id: "run-1",
  projectId: "project-1",
  kind: "standard",
  status: "running",
  listVisibility: "default",
  createdAt: "2026-08-29T06:00:00.000Z",
} as RunRecord;

const step = (id: string, content: string): RunStepRecord => ({
  id,
  runId: run.id,
  eventType: "output",
  title: "Agent output",
  content,
  metadataJson: "{}",
  createdAt: `2026-08-29T06:00:0${id === "step-old" ? "1" : "2"}.000Z`,
});

const detail = (steps: RunStepRecord[]): RunDetail => ({
  run,
  steps,
  notes: [],
  diff: "",
});

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

const RunDetailHarness = ({ client }: { client: BuildWardenClient }) => {
  const { detail: current } = useRunDetail(client, run.id);
  return <output>{current?.steps.map(({ id }) => id).join(",") ?? "loading"}</output>;
};

describe("useRunDetail", () => {
  it.each(["resolve", "reject"])("ignores an old run's diff %s after navigation without loading the new diff", async (outcome) => {
    let reject!: (error: Error) => void;
    const pending = deferred<RunWorktreeDiffResult>();
    const response = Promise.race([pending.promise, new Promise<never>((_, fail) => { reject = fail; })]);
    const client = {
      getRunDetail: vi.fn(async (id: string) => ({ ...detail([]), run: { ...run, id } })),
      getRunWorktreeDiff: vi.fn(() => response),
      refreshRunForgeRequest: vi.fn(() => new Promise<void>(() => undefined)),
      onRunEvent: vi.fn(() => vi.fn()),
      onRunForgeRequestChanged: vi.fn(() => vi.fn()),
    } as unknown as BuildWardenClient;
    let loadDiff!: () => Promise<void>;
    const Harness = ({ id }: { id: string }) => {
      const state = useRunDetail(client, id);
      loadDiff = state.loadDiff;
      return <output>{JSON.stringify({ diff: state.diff, revision: state.diffRevision, loading: state.diffLoading, error: state.diffError, unavailable: state.diffUnavailable })}</output>;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness id="run-1" />));
    let request!: Promise<void>;
    await act(async () => { request = loadDiff(); });
    expect(container.textContent).toContain('"loading":true');
    await act(async () => root?.render(<Harness id="run-2" />));
    const emptyState = JSON.stringify({ diff: "", loading: false, error: null, unavailable: false });
    expect(container.textContent).toBe(emptyState);
    await act(async () => {
      if (outcome === "resolve") pending.resolve({ diff: "old patch", diffRevision: { fingerprint: "git:old", head: "old" }, worktreeUnavailable: true });
      else reject(new Error("old request failed"));
      await request;
    });
    expect(container.textContent).toBe(emptyState);
    expect(client.getRunWorktreeDiff).toHaveBeenCalledTimes(1);
  });

  it("replays a durable step that arrives while an older detail request is in flight", async () => {
    const pendingDetail = deferred<RunDetail>();
    let publishRunEvent: ((event: RunEvent) => void) | undefined;
    const client = {
      getRunDetail: vi.fn(() => pendingDetail.promise),
      refreshRunForgeRequest: vi.fn(() => new Promise<void>(() => undefined)),
      onRunEvent: vi.fn((listener: (event: RunEvent) => void) => {
        publishRunEvent = listener;
        return vi.fn();
      }),
      onRunForgeRequestChanged: vi.fn(() => vi.fn()),
    } as unknown as BuildWardenClient;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RunDetailHarness client={client} />));

    const liveStep = step("step-new", "new output");
    await act(async () => publishRunEvent?.({
      runId: run.id,
      type: "output",
      title: liveStep.title,
      content: liveStep.content,
      createdAt: liveStep.createdAt,
      step: liveStep,
    }));
    await act(async () => {
      pendingDetail.resolve(detail([step("step-old", "old output")]));
      await pendingDetail.promise;
    });

    expect(container.textContent).toBe("step-old,step-new");
  });
});
