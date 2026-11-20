/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot, DesktopApi, RunDetail, RunEvent, RunRecord, RunStepRecord } from "@buildwarden/shared";
import { App } from "./App";
import { EMPTY_SNAPSHOT } from "./components/app/app-model";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./lib/buildwarden-client-core";

// The run header is not memoized, so it renders exactly when the app shell does.
const headerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/app/RunDetailHeader", async (original) => {
  const actual = await original<typeof import("./components/app/RunDetailHeader")>();
  return { ...actual, RunDetailHeader: (props: Parameters<typeof actual.RunDetailHeader>[0]) => {
    headerRenders.count += 1;
    return <actual.RunDetailHeader {...props} />;
  } };
});

const iso = (offset: number) => new Date(Date.UTC(2026, 10, 1) + offset * 60_000).toISOString();
const run = (index: number): RunRecord => ({
  id: `run-${String(index)}`, projectId: "project", status: index === 0 ? "running" : "completed", kind: "standard", listVisibility: "default",
  prompt: `Task ${String(index)}`, title: `Task ${String(index)}`, mode: "code", workspaceType: "worktree", branchName: `bw/task-${String(index)}`,
  worktreePath: `/repo/.wt/${String(index)}`, providerAccountId: "provider", modelId: "model", createdAt: iso(index), updatedAt: iso(index),
  inputTokens: 0, outputTokens: 0, parentRunId: null, rootRunId: null,
} as unknown as RunRecord);
const step = (index: number, content: string): RunStepRecord => ({
  id: `step-${String(index)}`, runId: "run-0", eventType: "output", title: "Agent output", content, metadataJson: "{}", createdAt: iso(index),
});

describe("streamed run updates", () => {
  it("render the app once per update", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const runs = Array.from({ length: 3 }, (_, index) => run(index));
    const snapshot = { ...EMPTY_SNAPSHOT, selectedProjectId: "project", selectedRunId: "run-0",
      settings: { welcomeCompletedCheckIds: JSON.stringify(["project", "provider-models"]) },
      projects: [{ project: { id: "project", name: "Project", repoPath: "/repo", baseBranch: "main" }, runs, recentRuns: runs, activeRuns: [runs[0]],
        forLaterRuns: [], orchestratedRuns: [], tasks: [], automations: [], insights: [], labThreads: [], loops: [] }],
    } as unknown as AppSnapshot;
    const detail = { run: runs[0], steps: [step(0, "Earlier answer")], notes: [], diff: "", queuedFollowUps: [] } as unknown as RunDetail;
    const listeners = new Set<(event: RunEvent) => void>();
    const base = createElectronBuildWardenClient({} as DesktopApi).capabilities;
    const client = new Proxy({
      capabilities: base, refreshSnapshot: async () => snapshot, getSnapshot: async () => snapshot, getRunDetail: async () => detail,
      getRunWorktreeDiffSummary: async () => ({ summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }, worktreeUnavailable: false }),
      onRunEvent: (listener: (event: RunEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as BuildWardenClient, {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
        if (typeof property === "string" && /^(list|getAttention)/.test(property)) return async () => [];
        if (typeof property === "string" && property.startsWith("getDetected")) return async () => ({ binaryPath: null });
        if (property === "getAppPaths") return async () => ({ logDirPath: "", logDirectorySize: { fileCount: 0, totalBytes: 0 } });
        return vi.fn(async () => undefined);
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <BuildWardenClientProvider client={client}><App /></BuildWardenClientProvider>,
    ));
    const settle = async () => { for (let pass = 0; pass < 5; pass++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
    await settle();
    const runEntry = [...container.querySelectorAll<HTMLElement>("button, [role=button], a")].find((element) => element.textContent?.includes("Task 0"));
    await act(async () => runEntry!.click());
    // The timeline virtualizes rows and happy-dom has no layout, so wait for the run header.
    for (let wait = 0; wait < 40 && !container.textContent?.includes("Rewind / edit"); wait++) await settle();
    expect(container.textContent).toContain("Rewind / edit");

    headerRenders.count = 0;
    let text = "";
    const updates = 10;
    for (let update = 0; update < updates; update++) {
      text += `Token batch ${String(update)}. `;
      const event = { runId: "run-0", type: "output", title: "Agent output", content: text, createdAt: iso(1),
        metadata: { streamId: "answer", replace: true }, step: step(1, text) } as unknown as RunEvent;
      await act(async () => { for (const listener of [...listeners]) listener(event); });
    }
    // Each update used to render the app twice: once for the event, and again when an effect
    // copied the separately merged detail into the selected-run state.
    expect(headerRenders.count).toBe(updates);
    await act(async () => root.unmount());
    container.remove();
  });
});
