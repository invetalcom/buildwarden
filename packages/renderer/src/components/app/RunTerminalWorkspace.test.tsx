/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { RunTerminalSummary } from "@buildwarden/shared";
import { RunTerminalWorkspace } from "./RunTerminalWorkspace";

const mocks = vi.hoisted(() => ({
  sessions: [] as RunTerminalSummary[],
  start: vi.fn(), kill: vi.fn(),
}));
vi.mock("../../lib/buildwarden-client", () => {
  const client = {
    runTerminalList: async () => ({ sessions: [...mocks.sessions], shells: ["auto", "pwsh", "cmd"] }),
    runTerminalStart: mocks.start,
    runTerminalKill: mocks.kill,
    onRunTerminalExit: () => () => {},
  };
  return { useBuildWardenClient: () => client };
});
vi.mock("./RunWorktreeTerminal", () => ({ RunWorktreeTerminal: ({ sessionId }: { sessionId: string }) => <div data-session={sessionId} /> }));

describe("terminal workspace controls", () => {
  it("creates independent tabs, splits, restarts and closes only the selected terminal", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    mocks.sessions = [];
    mocks.start.mockImplementation(async (input: { sessionId: string; runId: string; shell: "auto"; restart?: boolean }) => {
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
      await click("New terminal");
      await click("New terminal");
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
      const selected = mocks.sessions[1]!.sessionId;
      expect(mocks.sessions[0]!.sessionId).not.toBe(selected);
      await click("Split");
      expect(container.querySelectorAll("[data-session]")).toHaveLength(2);
      await click("Restart");
      expect(mocks.start).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: selected, restart: true }));
      await click("Close");
      expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(selected);
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    } finally { await act(async () => root.unmount()); }
  });
});
