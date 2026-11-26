/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot, DesktopApi, RunDetail, RunListItem } from "@buildwarden/shared";
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
  return <div>Run detail {props.runDetail.run.id}</div>;
} }));

const runRecord = (id: string) => ({ id, projectId: "project", status: "completed", prompt: "Prompt", createdAt: "2026-11-26T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z" });
const snapshotWith = (runs: ReturnType<typeof runRecord>[]) => ({ ...EMPTY_SNAPSHOT, selectedRunId: "run", selectedProjectId: "project",
  projects: [{ project: { id: "project", name: "Project", repoPath: "/repo" }, recentRuns: runs, runs, activeRuns: [], forLaterRuns: [], orchestratedRuns: [], tasks: [], insights: [], labThreads: [], loops: [] }],
} as unknown as AppSnapshot);

describe("fork refresh", () => {
  it("opens the created fork and says so when the refresh after it fails", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    view.current = null;
    const refreshSnapshot = vi.fn(async () => snapshotWith([runRecord("run")]));
    const getRunDetail = vi.fn(async (id: string) => ({ run: runRecord(id), steps: [], notes: [], diff: "" }) as unknown as RunDetail);
    const forkRun = vi.fn(async () => runRecord("fork"));
    const base = createElectronBuildWardenClient({} as DesktopApi).capabilities;
    const client = new Proxy({ capabilities: { ...base, platform: "web" }, refreshSnapshot, getRunDetail, forkRun,
      getRunWorktreeDiffSummary: async () => ({ summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 }, worktreeUnavailable: false }) } as unknown as BuildWardenClient, {
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
    try {
      await act(async () => root.render(<BuildWardenClientProvider client={client}><App /></BuildWardenClientProvider>));
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Open run")!.click());
      expect(view.current!.runDetail.run.id).toBe("run");

      refreshSnapshot.mockRejectedValueOnce(new Error("Host unavailable"));
      await act(async () => { await view.current!.onForkRun!(runRecord("run") as unknown as RunListItem, "answer"); });
      expect(forkRun).toHaveBeenCalledTimes(1);
      expect(getRunDetail).toHaveBeenLastCalledWith("fork");
      expect(container.textContent).toContain("The fork was created, but the run list could not be refreshed: Host unavailable");
      expect(view.current!.runDetail.run.id).toBe("fork");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
