/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, RunTerminalListResult, RunTerminalSummary } from "@buildwarden/shared";
import { RunTerminalWorkspace } from "./RunTerminalWorkspace";

const mocks = vi.hoisted(() => ({
  sessions: [] as RunTerminalSummary[],
  start: vi.fn(), kill: vi.fn(),
  list: vi.fn<DesktopApi["runTerminalList"]>(),
}));
vi.mock("../../lib/buildwarden-client", () => {
  const client = {
    runTerminalList: mocks.list,
    runTerminalStart: mocks.start,
    runTerminalKill: mocks.kill,
    onRunTerminalExit: () => () => {},
  };
  return { useBuildWardenClient: () => client };
});
vi.mock("./RunWorktreeTerminal", () => ({ RunWorktreeTerminal: ({ sessionId }: { sessionId: string }) => <div data-session={sessionId} /> }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  mocks.sessions = [];
  mocks.list.mockImplementation(async () => ({ sessions: [...mocks.sessions], shells: ["auto", "pwsh", "cmd"] }));
});
afterEach(() => vi.useRealTimers());

describe("terminal workspace controls", () => {
  it("ignores a stale poll after closing a terminal and refreshing the list", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    mocks.sessions = [{ sessionId: "buildwarden-run-terminal:a:one", runId: "a", shell: "auto", shellFile: "sh", status: "running" }];
    let finishPoll!: (result: RunTerminalListResult) => void;
    try {
      await act(async () => root.render(<RunTerminalWorkspace runId="a" cwd="/workspace" />));
      mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      const stale = { sessions: [...mocks.sessions], shells: ["bash"] as const };
      mocks.kill.mockImplementation(async () => { mocks.sessions = []; });
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Close")!.click());
      await act(async () => finishPoll({ ...stale, shells: [...stale.shells] }));
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(container.querySelectorAll("[data-session]")).toHaveLength(0);
      await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["Auto shell", "pwsh", "cmd"]);
    } finally { await act(async () => root.unmount()); }
  });

  it("invalidates in-flight listings when the panel becomes inactive", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let finish!: (result: RunTerminalListResult) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    try {
      await act(async () => root.render(<RunTerminalWorkspace runId="a" cwd="/workspace" />));
      await act(async () => root.render(<RunTerminalWorkspace runId="a" cwd="/workspace" uiActive={false} />));
      await act(async () => finish({ sessions: [{ sessionId: "old", runId: "a", shell: "auto", shellFile: "sh", status: "running" }], shells: ["bash"] }));
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
      await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["Auto shell"]);
    } finally { await act(async () => root.unmount()); }
  });

  it("creates independent tabs, splits, restarts and closes only the selected terminal", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    mocks.sessions = [];
    mocks.start.mockImplementation(async (input: { sessionId: string; runId: string; shell: "pwsh"; restart?: boolean }) => {
      if (!input.restart) mocks.sessions.push({ ...input, shellFile: "pwsh.exe", status: "running" });
      return { ok: true };
    });
    mocks.kill.mockImplementation(async (id: string) => { mocks.sessions = mocks.sessions.filter((session) => session.sessionId !== id); });
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
      await act(async () => button.click());
    };
    try {
      await act(async () => root.render(<RunTerminalWorkspace runId="run-a" cwd="/workspace" />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Shell for new or restarted terminal"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "pwsh")!.click());
      await click("New terminal");
      expect(mocks.start).toHaveBeenLastCalledWith(expect.objectContaining({ shell: "pwsh" }));
      await click("New terminal");
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
      const selected = mocks.sessions[1]!.sessionId;
      expect(mocks.sessions[0]!.sessionId).not.toBe(selected);
      await click("Split");
      expect(container.querySelectorAll("[data-session]")).toHaveLength(2);
      await click("Restart");
      expect(mocks.start).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: selected, shell: "pwsh", restart: true }));
      await click("Close");
      expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(selected);
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    } finally { await act(async () => root.unmount()); }
  });
});
