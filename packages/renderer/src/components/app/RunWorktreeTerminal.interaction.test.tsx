/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopApi, RunTerminalStartResult } from "@buildwarden/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWorktreeTerminal } from "./RunWorktreeTerminal";

const mocks = vi.hoisted(() => ({
  terminals: [] as {
    input: HTMLTextAreaElement;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    sendData?: (data: string) => void;
  }[],
  linkHandlers: [] as ((event: MouseEvent, uri: string) => void)[],
  client: {
    runTerminalStart: vi.fn<DesktopApi["runTerminalStart"]>(),
    runTerminalWrite: vi.fn<DesktopApi["runTerminalWrite"]>(),
    runTerminalResize: vi.fn<DesktopApi["runTerminalResize"]>(),
    onRunTerminalData: vi.fn<DesktopApi["onRunTerminalData"]>(),
    onRunTerminalExit: vi.fn<DesktopApi["onRunTerminalExit"]>(),
    openExternalUrl: vi.fn<DesktopApi["openExternalUrl"]>(),
  },
}));

vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => mocks.client }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    input = document.createElement("textarea");
    sendData?: (data: string) => void;
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn(() => this.input.remove());
    constructor() {
      mocks.terminals.push(this);
      this.input.addEventListener("input", () => this.sendData?.(this.input.value));
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open(element: HTMLElement) { element.append(this.input); }
    focus() { this.input.focus(); }
    onData(callback: (data: string) => void) {
      this.sendData = callback;
      return { dispose: () => { this.sendData = undefined; } };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) { mocks.linkHandlers.push(handler); }
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.terminals.length = 0;
  mocks.linkHandlers.length = 0;
  mocks.client.runTerminalStart.mockResolvedValue({ ok: true });
  mocks.client.onRunTerminalData.mockReturnValue(vi.fn());
  mocks.client.onRunTerminalExit.mockReturnValue(vi.fn());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const render = async (props: Partial<Parameters<typeof RunWorktreeTerminal>[0]> = {}) => {
  await act(async () => root.render(<RunWorktreeTerminal runId="run-1" cwd="C:/worktree" {...props} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
};

describe("RunWorktreeTerminal lifecycle", () => {
  it("ignores data and exit events from a previous shell before and after attachment", async () => {
    let finishStart!: (result: RunTerminalStartResult) => void;
    mocks.client.runTerminalStart.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    await render();
    const data = mocks.client.onRunTerminalData.mock.calls[0]![0];
    const exit = mocks.client.onRunTerminalExit.mock.calls[0]![0];
    const sessionId = "buildwarden-run-terminal:run-1";
    await act(async () => {
      data({ sessionId, generation: 1, data: "stale buffered", sequence: 100 });
      exit({ sessionId, generation: 1, exitCode: 1 });
      data({ sessionId, generation: 2, data: "new buffered", sequence: 2 });
      finishStart({ ok: true, generation: 2, status: "running", scrollback: "new snapshot", sequence: 1 });
    });
    await act(async () => {
      data({ sessionId, generation: 1, data: "stale live", sequence: 200 });
      exit({ sessionId, generation: 1, exitCode: 1 });
      data({ sessionId, generation: 2, data: "new live", sequence: 3 });
    });
    const terminal = mocks.terminals[0]!;
    expect(terminal.write.mock.calls).toEqual([["new snapshot"], ["new buffered"], ["new live"]]);
    terminal.sendData?.("pwd\r");
    expect(mocks.client.runTerminalWrite).toHaveBeenCalledWith({ sessionId, data: "pwd\r" });
    await act(async () => exit({ sessionId, generation: 2, exitCode: 0 }));
    terminal.sendData?.("blocked\r");
    expect(mocks.client.runTerminalWrite).toHaveBeenCalledTimes(1);
  });

  it("honors a current-generation exit buffered while the start response is in flight", async () => {
    let finishStart!: (result: RunTerminalStartResult) => void;
    mocks.client.runTerminalStart.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    await render();
    const sessionId = "buildwarden-run-terminal:run-1";
    await act(async () => {
      mocks.client.onRunTerminalExit.mock.calls[0]![0]({ sessionId, generation: 2, exitCode: 1 });
      finishStart({ ok: true, generation: 2, status: "running" });
    });
    mocks.terminals[0]!.sendData?.("blocked\r");
    expect(mocks.client.runTerminalWrite).not.toHaveBeenCalled();
    expect(mocks.terminals[0]!.write).toHaveBeenCalledWith(expect.stringContaining("Shell exited with code 1"));
  });

  it("replays output once when live events overlap the attachment snapshot", async () => {
    let finishStart!: (result: RunTerminalStartResult) => void;
    mocks.client.runTerminalStart.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    await render();
    const listener = mocks.client.onRunTerminalData.mock.calls[0]![0];
    const sessionId = "buildwarden-run-terminal:run-1";
    await act(async () => listener({ sessionId, data: "old", sequence: 1 }));
    await act(async () => listener({ sessionId, data: "new", sequence: 2 }));
    await act(async () => finishStart({ ok: true, scrollback: "old", sequence: 1 }));
    await act(async () => listener({ sessionId, data: "old", sequence: 1 }));
    expect(mocks.terminals[0]!.write.mock.calls).toEqual([["old"], ["new"]]);
  });

  it("preserves the terminal, focus, and input across run updates while using current link settings", async () => {
    const firstOpen = vi.fn();
    await render({ openLinksInApp: true, onOpenUrlInApp: firstOpen });
    const terminal = mocks.terminals[0]!;
    expect(document.activeElement).toBe(terminal.input);
    mocks.client.onRunTerminalData.mock.calls[0]![0]({ sessionId: "buildwarden-run-terminal:run-1", data: "shell output" });
    expect(terminal.write).toHaveBeenCalledWith("shell output");

    const latestOpen = vi.fn();
    for (let update = 0; update < 3; update++) {
      await render({ openLinksInApp: true, onOpenUrlInApp: (url) => latestOpen(url) });
    }
    expect(mocks.terminals).toHaveLength(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(mocks.client.runTerminalStart).toHaveBeenCalledTimes(1);
    expect(mocks.client.onRunTerminalData).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(terminal.input);
    terminal.input.value = "echo hello\r";
    terminal.input.dispatchEvent(new Event("input"));
    expect(mocks.client.runTerminalWrite).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", data: "echo hello\r" });

    mocks.linkHandlers[0]!(new MouseEvent("click"), "http://localhost:3000");
    expect(latestOpen).toHaveBeenCalledWith("http://localhost:3000");
    expect(firstOpen).not.toHaveBeenCalled();
    await render({ openLinksInApp: false, onOpenUrlInApp: latestOpen });
    mocks.linkHandlers[0]!(new MouseEvent("click"), "https://example.com");
    expect(mocks.client.openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(mocks.terminals).toHaveLength(1);
  });

  it("keeps an in-flight shell attachment through callback updates", async () => {
    let finishStart!: (result: RunTerminalStartResult) => void;
    mocks.client.runTerminalStart.mockReturnValue(new Promise((resolve) => { finishStart = resolve; }));
    await render({ onOpenUrlInApp: vi.fn() });
    await render({ onOpenUrlInApp: vi.fn() });
    await act(async () => finishStart({ ok: true }));
    expect(mocks.terminals).toHaveLength(1);
    mocks.terminals[0]!.sendData?.("ls\r");
    expect(mocks.client.runTerminalWrite).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", data: "ls\r" });
    expect(mocks.client.runTerminalStart).toHaveBeenCalledTimes(1);
  });

  it("reattaches when the workspace changes and routes input to the newly selected run", async () => {
    await render();
    const first = mocks.terminals[0]!;
    await render({ cwd: "C:/other-worktree" });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.client.runTerminalStart).toHaveBeenLastCalledWith({ sessionId: "buildwarden-run-terminal:run-1", cwd: "C:/other-worktree" });
    await render({ runId: "run-2", cwd: "C:/other-worktree" });
    mocks.terminals.at(-1)!.sendData?.("pwd\r");
    expect(mocks.client.runTerminalWrite).toHaveBeenLastCalledWith({ sessionId: "buildwarden-run-terminal:run-2", data: "pwd\r" });
  });
});
