/** @vitest-environment happy-dom */
import { act, useRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Activity } from "lucide-react";
import type { DesktopApi, RunRecord } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClientCapabilities } from "../../lib/buildwarden-client-core";
import { RunWorkspaceActions } from "./RunWorkspaceActions";
import { RunPanelsMenu } from "./RunPanelsMenu";
import { RunWorkspaceSummary } from "./RunWorkspaceSummary";

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  projectId: "project-1",
  providerAccountId: "provider-ai-sdk",
  modelId: "model-1",
  harnessType: "ai-sdk",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Improve renderer coverage",
  goalText: null,
  status: "completed",
  branchName: "feat/coverage",
  worktreePath: "C:/repo/worktree",
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 1200,
  outputTokens: 300,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  projectTaskId: null,
  delegationEnabled: false,
  lineageTitle: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  startedAt: "2026-01-01T00:00:10.000Z",
  finishedAt: "2026-01-01T00:04:00.000Z",
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); });

const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
  .find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label)!;

it.each(["git", "folder"] as const)("copies the complete %s workspace identifier and confirms success", async (workspaceVcs) => {
  const run = runRecord({ workspaceVcs, branchName: "kanban-46c84c3f-03da-40d4-8be0-8a1e4779e5ac" });
  const expected = workspaceVcs === "git" ? run.branchName : run.worktreePath;
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    await act(() => root.render(<RunWorkspaceSummary run={run} runDetail={{ run, notes: [], steps: [], diff: "" }}
      tokenUsage={null} stackedHeader={false} splitView={false} focused />));
    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Copy "]')!;
    await act(async () => { copyButton.click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(copyButton.querySelector('[role="status"]')?.textContent).toBe(workspaceVcs === "git" ? "Branch name copied" : "Workspace path copied");
  } finally {
    writeText.mockRestore();
  }
});

async function renderActions(overrides: Partial<ComponentProps<typeof RunWorkspaceActions>> = {}, capabilities: Partial<BuildWardenClientCapabilities> = {}) {
  const run = runRecord();
  const onOpenFileManager = vi.fn();
  const onDeleteRun = vi.fn();
  const onOpenContinueRunDialog = vi.fn();
  const onOpenInIde = vi.fn();
  const refreshRunForgeRequest = vi.fn(async () => null);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  await act(() => root.render(<BuildWardenClientProvider client={{ ...client, refreshRunForgeRequest, capabilities: { ...client.capabilities, ...capabilities } }}>
    <RunWorkspaceActions run={run} runDetail={{ run, steps: [], notes: [], diff: "" }} configuredIdeKinds={["vscode"]}
      canContinueRun busy={false} pendingDelete={false} onOpenInIde={onOpenInIde} onOpenFileManager={onOpenFileManager}
      onOpenContinueRunDialog={onOpenContinueRunDialog} onDeleteRun={onDeleteRun} {...overrides} />
  </BuildWardenClientProvider>));
  return { onOpenFileManager, onDeleteRun, onOpenContinueRunDialog, onOpenInIde, refreshRunForgeRequest };
}

it("groups utilities behind one trigger and preserves workspace, continue, delete and refresh actions", async () => {
  const callbacks = await renderActions();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(button("Delete run")).toBeUndefined();
  await act(() => button("More run actions").click());
  expect(document.activeElement).toBe(button("Copy link to this run"));
  await act(async () => { button("Check PR/MR status now").click(); });
  expect(callbacks.refreshRunForgeRequest).toHaveBeenCalledWith("run-1");
  expect(document.querySelector('[role="status"]')?.textContent).toBe("No matching PR/MR found.");
  for (const [label, callback] of [
    ["Open in file explorer", callbacks.onOpenFileManager],
    ["Open in Visual Studio Code", callbacks.onOpenInIde],
    ["Continue as new run", callbacks.onOpenContinueRunDialog],
    ["Delete run", callbacks.onDeleteRun],
  ] as const) {
    if (!document.querySelector('[role="menu"]')) await act(() => button("More run actions").click());
    await act(() => button(label).click());
    expect(callback).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }
});

it("preserves capability restrictions and disabled actions", async () => {
  await renderActions({ busy: true, pendingDelete: true }, { fileManager: false, ideIntegration: false, prReview: false });
  await act(() => button("More run actions").click());
  expect(button("Open in file explorer")).toBeUndefined();
  expect(button("Open in Visual Studio Code")).toBeUndefined();
  expect(button("Check PR/MR status now")).toBeUndefined();
  expect(button("Continue as new run").disabled).toBe(true);
  expect(button("Delete run").disabled).toBe(true);
});

it("hides missing workspaces and keeps the unfocused split-pane close action accessible", async () => {
  const run = runRecord();
  await renderActions({ runDetail: { run, steps: [], notes: [], diff: "", worktreeUnavailable: true } });
  await act(() => button("More run actions").click());
  expect(button("Open in file explorer")).toBeUndefined();
  expect(button("Open in Visual Studio Code")).toBeUndefined();
  const onClosePane = vi.fn();
  await renderActions({ focused: false, splitView: true, onClosePane });
  expect(button("More run actions")).toBeUndefined();
  await act(() => button("Close pane").click());
  expect(onClosePane).toHaveBeenCalledOnce();
});

it("combines density and panel settings, supports keyboard navigation, and restores focus", async () => {
  const onToggle = vi.fn();
  function ViewMenu() {
    const [open, setOpen] = useState(false);
    const [density, setDensity] = useState<"compact" | "comfortable" | "detailed">("comfortable");
    const ref = useRef<HTMLDivElement>(null);
    return <RunPanelsMenu runPanelsMenuOpen={open} setRunPanelsMenuOpen={setOpen} runPanelsMenuAnchorRef={ref}
      runTimelineDensity={density} onRunTimelineDensityChange={setDensity} runWorkspaceVisiblePanelCount={1}
      runPanelToggleItems={[{ key: "activity", label: "Activity", icon: Activity, active: true, disabled: false, subtitle: "Run timeline", onClick: onToggle }]} />;
  }
  await act(() => root.render(<ViewMenu />));
  await act(() => button("View").click());
  expect(document.activeElement).toBe(button("Compact"));
  await act(() => button("Compact").click());
  expect(button("Compact").getAttribute("aria-checked")).toBe("true");
  expect(button("Comfort").getAttribute("aria-checked")).toBe("false");
  await act(() => button("Compact").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  const panel = document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
  expect(document.activeElement).toBe(panel);
  await act(() => panel.click());
  expect(onToggle).toHaveBeenCalledOnce();
  expect(panel.getAttribute("aria-checked")).toBe("true");
  await act(() => panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button("View"));
});
