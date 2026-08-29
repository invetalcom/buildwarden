/** @vitest-environment happy-dom */

import type { RunDetail, RunEvent, RunRecord, RunStepRecord } from "@buildwarden/shared";
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
