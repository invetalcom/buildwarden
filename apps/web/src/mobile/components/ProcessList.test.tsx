/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BuildWardenClientProvider, createElectronBuildWardenClient, type OwnedProcessesState } from "@buildwarden/renderer";
import type { DesktopApi, OwnedProcessRecord, OwnedProcessesSnapshot } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatProcessesBar } from "./ChatProcessesBar";
import { ProcessList } from "./ProcessList";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

const record = (overrides: Partial<OwnedProcessRecord> & Pick<OwnedProcessRecord, "processId" | "pid">): OwnedProcessRecord => ({
  parentProcessId: null,
  owner: { kind: "run", id: "run-1" },
  role: "command",
  attribution: "tree",
  name: "node.exe",
  commandLine: "node.exe",
  cwd: "/repo",
  startedAt: new Date(Date.now() - 30_000).toISOString(),
  endedAt: null,
  status: "running",
  endReason: null,
  exitCode: null,
  cpuPercent: 1,
  memoryBytes: 64 * 1024 * 1024,
  ports: [],
  restartOfProcessId: null,
  restartable: true,
  hasOutput: false,
  ...overrides,
});

const processes = (owner: OwnedProcessRecord["owner"]) => [
  record({ processId: "agent", pid: 10, owner, role: "agent", name: "claude", restartable: false }),
  record({ processId: "server", pid: 30, owner, parentProcessId: "agent", name: "node", commandLine: "node vite.js", ports: [5173] }),
  record({ processId: "restarted", pid: 40, owner, role: "restarted", name: "pnpm", commandLine: "pnpm test --watch", hasOutput: true }),
];

const snapshotOf = (owner: OwnedProcessRecord["owner"], list: OwnedProcessRecord[]): OwnedProcessesSnapshot =>
  ({ owner, supported: true, processes: list, updatedAt: new Date().toISOString() });

const fakeState = (overrides: Partial<OwnedProcessesState> = {}): OwnedProcessesState => ({
  available: true,
  canManage: true,
  snapshot: snapshotOf({ kind: "run", id: "run-1" }, processes({ kind: "run", id: "run-1" })),
  error: null,
  pending: new Set(),
  act: vi.fn(async () => undefined),
  loadOutput: vi.fn(async (processId: string) => ({ processId, text: "watching for changes\n", truncated: false })),
  clearError: vi.fn(),
  ...overrides,
});

const render = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
};

const buttonWithText = (text: string) =>
  [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes(text));

/** A button inside the open sheet whose label (first text line) matches exactly. */
const sheetButton = (label: string) =>
  [...document.body.querySelectorAll("[role='dialog'] button")].find((button) =>
    button.querySelector("span span")?.textContent === label || button.textContent === label);

const tap = async (element: Element | undefined | null) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};

describe("mobile ProcessList", () => {
  it("lists commands (not the agent) and acts on a process from its action sheet", async () => {
    const state = fakeState();
    const container = await render(<ProcessList state={state} ownerLabel="run" />);
    expect(container.textContent).toContain("2 running · 0 exited · ports :5173");
    expect(container.textContent).toContain("vite.js");
    expect(container.textContent).not.toContain("claude");

    await tap(buttonWithText("vite.js"));
    expect(document.body.textContent).toContain("node · PID 30");
    await tap(sheetButton("Stop"));
    expect(state.act).toHaveBeenCalledWith({ action: "stop", processId: "server" });

    await tap(buttonWithText("vite.js"));
    await tap(sheetButton("Restart"));
    await tap(buttonWithText("vite.js"));
    await tap(sheetButton("Kill now"));
    expect(vi.mocked(state.act).mock.calls.map(([input]) => input)).toEqual([
      { action: "stop", processId: "server" },
      { action: "restart", processId: "server" },
      { action: "kill", processId: "server" },
    ]);
  });

  it("confirms before killing everything and shows captured output", async () => {
    const state = fakeState();
    await render(<ProcessList state={state} ownerLabel="chat" />);
    await tap(buttonWithText("Kill all"));
    expect(document.body.textContent).toContain("Ends every process this chat started immediately.");
    const confirm = sheetButton("Kill all");
    await tap(confirm);
    expect(state.act).toHaveBeenCalledWith({ action: "kill-all" });

    await tap(buttonWithText("test --watch"));
    await tap(sheetButton("Show output"));
    expect(state.loadOutput).toHaveBeenCalledWith("restarted");
    expect(document.body.textContent).toContain("watching for changes");
  });

  it("offers only copying to sessions that cannot manage processes", async () => {
    const state = fakeState({ canManage: false });
    await render(<ProcessList state={state} ownerLabel="run" />);
    expect(buttonWithText("Stop all")).toBeUndefined();
    await tap(buttonWithText("vite.js"));
    expect(sheetButton("Kill now")).toBeUndefined();
    expect(sheetButton("Copy command")).toBeDefined();
  });
});

describe("mobile ChatProcessesBar", () => {
  const owner = { kind: "chat" as const, id: "chat-1" };

  const mountBar = async (list: OwnedProcessRecord[]) => {
    const api = {
      getOwnedProcesses: vi.fn(async () => snapshotOf(owner, list)),
      manageOwnedProcesses: vi.fn(async () => snapshotOf(owner, list)),
      getOwnedProcessOutput: vi.fn(async () => ({ processId: "x", text: "", truncated: false })),
      onOwnedProcessesChanged: vi.fn(() => () => undefined),
    };
    const electron = createElectronBuildWardenClient(api as unknown as DesktopApi);
    // Mobile runs as a remote web client with process inspection granted.
    const client = Object.freeze({ ...electron, capabilities: Object.freeze({ ...electron.capabilities, platform: "web" as const }) });
    return render(<BuildWardenClientProvider client={client}><ChatProcessesBar chatId="chat-1" /></BuildWardenClientProvider>);
  };

  it("stays hidden until the chat started a command", async () => {
    const container = await mountBar([record({ processId: "agent", pid: 10, owner, role: "agent", name: "codex" })]);
    expect(container.textContent).toBe("");
  });

  it("summarizes running processes and opens the full list", async () => {
    const container = await mountBar(processes(owner));
    expect(container.textContent).toContain("2 processes running");
    await tap(container.querySelector("button[aria-label^='2 processes running']"));
    expect(document.body.textContent).toContain("vite.js");
    expect(document.body.textContent).toContain("Stop all");
  });
});
