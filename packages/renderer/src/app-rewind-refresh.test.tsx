/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot, DesktopApi, RunDetail, RunRewindResult } from "@buildwarden/shared";
import { App } from "./App";
import { EMPTY_SNAPSHOT } from "./components/app/app-model";
import type { RunDetailPageProps } from "./components/app/RunDetailPage";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./lib/buildwarden-client-core";

const view = vi.hoisted(() => ({ current: null as RunDetailPageProps | null }));
vi.mock("./components/app/Sidebar", () => ({ Sidebar: ({ onSelectRun }: { onSelectRun: (projectId: string, runId: string) => void }) =>
  <button onClick={() => onSelectRun("project", "run")}>Open run</button> }));
vi.mock("./components/app/LandingPage", () => ({ LandingPage: () => null }));
vi.mock("./components/app/RunDetailPage", () => ({ RunDetailPage: (props: RunDetailPageProps) => {
  view.current = props;
  return <div>Run detail</div>;
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  view.current = null;
  const detail = { run: { id: "run", projectId: "project", status: "completed", prompt: "Original prompt", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z" }, steps: [], notes: [], diff: "" } as unknown as RunDetail;
  const snapshot = { ...EMPTY_SNAPSHOT, selectedRunId: "run", selectedProjectId: "project",
    projects: [{ project: { id: "project", name: "Project", repoPath: "/repo" }, recentRuns: [detail.run], runs: [detail.run], activeRuns: [], forLaterRuns: [], orchestratedRuns: [], tasks: [], insights: [], labThreads: [], loops: [] }],
  } as unknown as AppSnapshot;
  const result: RunRewindResult = { prompt: "Original prompt", attachments: [], providerStrategy: "fresh-session" };
  const refreshSnapshot = vi.fn(async () => snapshot);
  const getRunDetail = vi.fn(async () => detail);
  const getRunWorktreeDiffSummary = vi.fn<DesktopApi["getRunWorktreeDiffSummary"]>().mockResolvedValue({ summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }, worktreeUnavailable: false });
  const rewindRun = vi.fn(async () => result);
  const base = createElectronBuildWardenClient({} as DesktopApi).capabilities;
  const client = new Proxy({ capabilities: { ...base, platform: "web" }, refreshSnapshot, getRunDetail, getRunWorktreeDiffSummary, rewindRun } as unknown as BuildWardenClient, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
      if (property === "listIntegratedSkills" || property === "getAttentionInbox") return async () => [];
      if (property === "getDetectedCodexInstallation" || property === "getDetectedClaudeInstallation" || property === "getDetectedCursorInstallation") return async () => ({ binaryPath: null });
      if (property === "getAppPaths") return async () => ({ logDirPath: "", logDirectorySize: { fileCount: 0, totalBytes: 0 } });
      return vi.fn(async () => undefined);
    },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<BuildWardenClientProvider client={client}><App /></BuildWardenClientProvider>));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Open run")!.click());
  expect(view.current).not.toBeNull();
  return { container, result, detail, snapshot, refreshSnapshot, getRunDetail, getRunWorktreeDiffSummary, rewindRun,
    cleanup: async () => { await act(async () => root.unmount()); } };
}

describe("rewind refresh", () => {
  it.each(["resolve", "reject"] as const)("returns the restored prompt before the diff summary can %s", async (outcome) => {
    const h = await mount();
    try {
      const summary = deferred<Awaited<ReturnType<DesktopApi["getRunWorktreeDiffSummary"]>>>();
      const history = deferred<RunDetail>();
      const snapshot = deferred<AppSnapshot>();
      h.getRunWorktreeDiffSummary.mockReturnValue(summary.promise);
      h.getRunDetail.mockReturnValueOnce(history.promise);
      h.refreshSnapshot.mockReturnValueOnce(snapshot.promise);
      let restored: RunRewindResult | undefined;
      await act(async () => { void view.current!.onRewindRun!({ runId: "run", restorePointId: "point", mode: "conversation" }).then((result) => { restored = result; }); });
      expect(restored).toBeUndefined();
      await act(async () => history.resolve(h.detail));
      expect(restored).toBeUndefined();
      await act(async () => snapshot.resolve(h.snapshot));
      expect(restored).toEqual(h.result);
      expect(view.current!.runDetail.diffSummaryPending).toBe(true);
      await act(async () => {
        if (outcome === "resolve") summary.resolve({ summary: { files: [], totalFiles: 0, totalAdditions: 4, totalDeletions: 2 }, worktreeUnavailable: true });
        else summary.reject(new Error("Diff unavailable"));
      });
      expect(view.current!.runDetail.diffSummaryPending).toBe(false);
      expect(view.current!.runDetail.worktreeUnavailable).toBe(outcome === "resolve");
      expect(view.current!.runDetail.diffSummary?.totalAdditions).toBe(outcome === "resolve" ? 4 : undefined);
    } finally { await h.cleanup(); }
  });

  it.each(["refreshSnapshot", "getRunDetail"] as const)("preserves the restored draft and reports a %s failure", async (method) => {
    const h = await mount();
    try {
      h[method].mockRejectedValueOnce(new Error("Refresh unavailable"));
      let restored: RunRewindResult | undefined;
      await act(async () => { restored = await view.current!.onRewindRun!({ runId: "run", restorePointId: "point", mode: "conversation" }); });
      expect(restored).toEqual(h.result);
      expect(h.container.textContent).toContain("Refresh unavailable");
    } finally { await h.cleanup(); }
  });

  it("refreshes after a failed rewind and preserves its error without waiting for the summary", async () => {
    const h = await mount();
    const summary = deferred<Awaited<ReturnType<DesktopApi["getRunWorktreeDiffSummary"]>>>();
    try {
      const failure = new Error("Restore interrupted");
      h.rewindRun.mockRejectedValueOnce(failure);
      h.getRunWorktreeDiffSummary.mockReturnValue(summary.promise);
      h.getRunDetail.mockClear(); h.refreshSnapshot.mockClear();
      let caught: unknown;
      await act(async () => { void view.current!.onRewindRun!({ runId: "run", restorePointId: "point", mode: "conversation" }).catch((error: unknown) => { caught = error; }); });
      expect(caught).toBe(failure);
      expect(h.getRunDetail).toHaveBeenCalledWith("run");
      expect(h.refreshSnapshot).toHaveBeenCalled();
    } finally {
      await act(async () => summary.reject(new Error("Diff unavailable")));
      await h.cleanup();
    }
  });
});
