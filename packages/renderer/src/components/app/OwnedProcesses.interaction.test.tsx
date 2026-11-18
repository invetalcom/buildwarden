/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopApi, ManageOwnedProcessesInput, OwnedProcessRecord, OwnedProcessesSnapshot } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClientCapabilities } from "../../lib/buildwarden-client-core";
import { ChatProcessesBar } from "./ChatProcessesBar";
import { RunProcessesPanel } from "./RunProcessesPanel";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

const record = (overrides: Partial<OwnedProcessRecord> & Pick<OwnedProcessRecord, "processId" | "pid">): OwnedProcessRecord => ({
  parentProcessId: null,
  owner: { kind: "run", id: "run-1" },
  role: "command",
  attribution: "tree",
  name: "node.exe",
  commandLine: "node.exe",
  cwd: "C:\\repo",
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  endedAt: null,
  status: "running",
  endReason: null,
  exitCode: null,
  cpuPercent: 2,
  memoryBytes: 80 * 1024 * 1024,
  ports: [],
  restartOfProcessId: null,
  restartable: true,
  hasOutput: false,
  ...overrides,
});

const runProcesses = (owner: OwnedProcessRecord["owner"]): OwnedProcessRecord[] => [
  record({ processId: "agent", pid: 10, owner, role: "agent", name: "claude.exe", restartable: false }),
  record({ processId: "shell", pid: 20, owner, parentProcessId: "agent", name: "powershell.exe", commandLine: "powershell.exe -NoProfile -Command \"pnpm dev\"" }),
  record({ processId: "server", pid: 30, owner, parentProcessId: "shell", name: "node.exe", commandLine: "node.exe vite.js", ports: [5173] }),
  record({ processId: "build", pid: 40, owner, parentProcessId: "agent", name: "tsc.exe", status: "exited", endReason: "exited", exitCode: 2, endedAt: new Date().toISOString() }),
];

const mount = async (node: React.ReactNode, processes: OwnedProcessRecord[], capabilities: Partial<BuildWardenClientCapabilities> = {}) => {
  const owner = processes[0]?.owner ?? { kind: "run" as const, id: "run-1" };
  const snapshot: OwnedProcessesSnapshot = { owner, supported: true, processes, updatedAt: new Date().toISOString() };
  let listener: ((next: OwnedProcessesSnapshot) => void) | null = null;
  const api = {
    getOwnedProcesses: vi.fn(async () => snapshot),
    manageOwnedProcesses: vi.fn<(input: ManageOwnedProcessesInput) => Promise<OwnedProcessesSnapshot>>(async () => snapshot),
    getOwnedProcessOutput: vi.fn(async () => ({ processId: "x", text: "", truncated: false })),
    onOwnedProcessesChanged: vi.fn((next: (value: OwnedProcessesSnapshot) => void) => {
      listener = next;
      return () => { listener = null; };
    }),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
  };
  const electron = createElectronBuildWardenClient(api as unknown as DesktopApi);
  const client = Object.freeze({ ...electron, capabilities: Object.freeze({ ...electron.capabilities, ...capabilities }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<BuildWardenClientProvider client={client}>{node}</BuildWardenClientProvider>));
  const push = async (next: OwnedProcessRecord[]) => {
    await act(async () => listener?.({ owner, supported: true, processes: next, updatedAt: new Date().toISOString() }));
  };
  const byLabel = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const byText = (text: string) => [...container!.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
  return { api, push, byLabel, byText };
};

describe("RunProcessesPanel", () => {
  it("lists the agent's commands as a tree, hiding the agent and exited processes by default", async () => {
    await mount(<RunProcessesPanel runId="run-1" onOpenUrl={vi.fn()} />, runProcesses({ kind: "run", id: "run-1" }));
    const text = container!.textContent ?? "";
    expect(text).toContain("2 running · 1 exited");
    expect(text).toContain("pnpm dev");
    expect(text).toContain("vite.js");
    expect(text).not.toContain("claude.exe");
    expect(text).not.toContain("tsc.exe");
    expect(container!.querySelectorAll("ul[aria-label='Processes'] > li")).toHaveLength(2);
  });

  it("stops, kills, and restarts processes, and asks twice before killing all", async () => {
    const { api, byLabel, byText } = await mount(<RunProcessesPanel runId="run-1" onOpenUrl={vi.fn()} />, runProcesses({ kind: "run", id: "run-1" }));
    await act(async () => byLabel("Stop node.exe")!.click());
    await act(async () => byLabel("Kill powershell.exe")!.click());
    await act(async () => byLabel("Restart node.exe")!.click());
    await act(async () => byText("Kill all")!.click());
    expect(byText("Confirm kill")).toBeDefined();
    await act(async () => byText("Confirm kill")!.click());
    await act(async () => byText("Stop all")!.click());
    const owner = { kind: "run", id: "run-1" };
    expect(api.manageOwnedProcesses.mock.calls.map(([input]) => input)).toEqual([
      { owner, action: "stop", processId: "server" },
      { owner, action: "kill", processId: "shell" },
      { owner, action: "restart", processId: "server" },
      { owner, action: "kill-all" },
      { owner, action: "stop-all" },
    ]);
  });

  it("opens listening ports in the run's browser panel", async () => {
    const onOpenUrl = vi.fn();
    const { byLabel } = await mount(<RunProcessesPanel runId="run-1" onOpenUrl={onOpenUrl} />, runProcesses({ kind: "run", id: "run-1" }));
    await act(async () => byLabel("Open in browser port 5173")!.click());
    expect(onOpenUrl).toHaveBeenCalledWith("http://localhost:5173");
  });

  it("reveals exited processes and agents on request and shows details with copy actions", async () => {
    const { byText } = await mount(<RunProcessesPanel runId="run-1" onOpenUrl={vi.fn()} />, runProcesses({ kind: "run", id: "run-1" }));
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].forEach((toggle) => toggle.click()));
    const text = container!.textContent ?? "";
    expect(text).toContain("claude.exe");
    expect(text).toContain("Exited 2");
    // The agent offers no stop, kill, or restart.
    expect(container!.querySelector("button[aria-label='Stop claude.exe']")).toBeNull();
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes("vite.js"))!.click());
    expect(container!.textContent).toContain("Copy command");
    expect(byText("Copy PID")).toBeDefined();
  });

  it("follows pushed updates and explains when nothing runs", async () => {
    const { push } = await mount(<RunProcessesPanel runId="run-1" onOpenUrl={vi.fn()} />, runProcesses({ kind: "run", id: "run-1" }));
    await push([]);
    expect(container!.textContent).toContain("No processes running");
  });

  it("explains when the session cannot view host processes", async () => {
    await mount(<RunProcessesPanel runId="run-1" onOpenUrl={vi.fn()} />, [], { platform: "web", processInspection: false });
    expect(container!.textContent).toContain("cannot view the host's processes");
  });

  it("lets read-only remote sessions watch processes without acting on them", async () => {
    await mount(<RunProcessesPanel runId="run-1" />, runProcesses({ kind: "run", id: "run-1" }), { platform: "web", processInspection: true, runMutations: false });
    expect(container!.textContent).toContain("pnpm dev");
    expect(container!.querySelector("button[aria-label='Stop node.exe']")).toBeNull();
    expect(container!.textContent).not.toContain("Stop all");
    // Without an in-app browser the port is a label, not a link.
    expect(container!.querySelector("button[aria-label='Open in browser port 5173']")).toBeNull();
    expect(container!.textContent).toContain(":5173");
  });
});

describe("ChatProcessesBar", () => {
  const owner = { kind: "chat" as const, id: "chat-1" };

  it("stays hidden until the chat started a process", async () => {
    await mount(<ChatProcessesBar chatId="chat-1" />, [record({ processId: "agent", pid: 10, owner, role: "agent", name: "codex.exe" })]);
    expect(container!.textContent).toBe("");
  });

  it("summarizes running processes, opens ports externally, and expands into the process list", async () => {
    const { api, byLabel } = await mount(<ChatProcessesBar chatId="chat-1" />, runProcesses(owner));
    expect(container!.textContent).toContain("2 processes running");
    await act(async () => byLabel("Open port 5173")!.click());
    expect(api.openExternalUrl).toHaveBeenCalledWith("http://localhost:5173");
    await act(async () => byLabel("Expand processes")!.click());
    expect(container!.textContent).toContain("pnpm dev");
    expect(container!.textContent).toContain("Exited 2");
    await act(async () => byLabel("Stop all processes")!.click());
    await act(async () => byLabel("Clear exited processes")!.click());
    expect(api.manageOwnedProcesses.mock.calls.map(([input]) => input.action)).toEqual(["stop-all", "clear-exited"]);
  });

  it("shows ports as labels on remote clients, where localhost is not the host", async () => {
    const { api, byLabel } = await mount(<ChatProcessesBar chatId="chat-1" />, runProcesses(owner), { platform: "web", processInspection: true });
    expect(byLabel("Open port 5173")).toBeNull();
    expect(container!.textContent).toContain(":5173");
    expect(api.openExternalUrl).not.toHaveBeenCalled();
  });
});
