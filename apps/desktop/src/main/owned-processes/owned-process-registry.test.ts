import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { OwnedProcessOwner, OwnedProcessRecord, OwnedProcessesSnapshot } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { commandLineHead, looksLikeAgentProcess, redactCommandLine } from "@buildwarden/shared";
import { commandLineMentionsPath, OwnedProcessRegistry, workspacePathForms } from "./owned-process-registry";
import type { ProcessTableEntry, ProcessTableSnapshot } from "./process-table";
import type { ProcessTerminator } from "./process-terminator";

const RUN: OwnedProcessOwner = { kind: "run", id: "run-1" };
const CHAT: OwnedProcessOwner = { kind: "chat", id: "chat-1" };

const entry = (pid: number, ppid: number, name: string, startedAtMs: number, extra: Partial<ProcessTableEntry> = {}): ProcessTableEntry => ({
  pid,
  ppid,
  name,
  commandLine: name,
  argv: null,
  startedAtMs,
  memoryBytes: 1_000,
  cpuTimeMs: 0,
  cpuPercent: null,
  ...extra,
});

const table = (takenAtMs: number, processes: ProcessTableEntry[], ports: Array<[number, number[]]> = []): ProcessTableSnapshot => ({
  takenAtMs,
  processes,
  ports: new Map(ports),
  startTimeToleranceMs: 1_500,
});

interface Harness {
  registry: OwnedProcessRegistry;
  current: { value: ProcessTableSnapshot };
  readerFails: { value: boolean };
  alive: Set<number>;
  terminator: ProcessTerminator & { requestExit: ReturnType<typeof vi.fn>; forceExit: ReturnType<typeof vi.fn> };
  changes: OwnedProcessesSnapshot[];
  spawnCommand: ReturnType<typeof vi.fn>;
  byPid: (owner: OwnedProcessOwner, pid: number) => OwnedProcessRecord | undefined;
}

const createHarness = (options: { gracefulExit?: boolean; platform?: NodeJS.Platform } = {}): Harness => {
  const current = { value: table(0, []) };
  const readerFails = { value: false };
  const alive = new Set<number>();
  const removeFromTable = (pids: number[]) => {
    for (const pid of pids) alive.delete(pid);
    current.value = { ...current.value, processes: current.value.processes.filter((process) => !pids.includes(process.pid)) };
  };
  const terminator = {
    requestExit: vi.fn(async (pids: number[]) => {
      if (options.gracefulExit) removeFromTable(pids);
      return true;
    }),
    forceExit: vi.fn(async (pids: number[]) => removeFromTable(pids)),
    isAlive: (pid: number) => alive.has(pid),
  };
  const changes: OwnedProcessesSnapshot[] = [];
  const spawnCommand = vi.fn();
  const registry = new OwnedProcessRegistry({
    createReader: () => ({ supported: true, snapshot: async () => { if (readerFails.value) throw new Error("no process table"); return current.value; }, dispose: () => undefined }),
    supported: true,
    terminator,
    spawnCommand,
    onChange: (snapshot) => changes.push(snapshot),
    platform: options.platform ?? "win32",
    cpuCount: 2,
    gracefulStopMs: 60,
    pathExists: () => true,
  });
  const byPid = (owner: OwnedProcessOwner, pid: number) => registry.getSnapshot(owner).processes.find((process) => process.pid === pid);
  return { registry, current, alive, terminator, changes, spawnCommand, byPid, readerFails };
};

/** Seeds an agent (100) that started a shell (200) running a dev server (300) on port 5173. */
const seedDevServer = (harness: Harness) => {
  harness.registry.registerSpawn(RUN, { pid: 100, role: "agent", spawnedAtMs: 1_000, commandLine: "claude" }, "C:\\repo");
  const processes = [
    entry(100, 1, "claude.exe", 1_000),
    entry(200, 100, "bash.exe", 1_500, { commandLine: "bash.exe -c \"pnpm dev\"" }),
    entry(300, 200, "node.exe", 1_600, { commandLine: "\"C:\\node.exe\" vite.js" }),
    entry(999, 1, "explorer.exe", 500),
  ];
  for (const process of processes) harness.alive.add(process.pid);
  harness.current.value = table(2_000, processes, [[300, [5173]]]);
  harness.registry.applySnapshot(harness.current.value);
};

describe("OwnedProcessRegistry attribution", () => {
  it("attributes a reported spawn and everything it starts to its owner", () => {
    const harness = createHarness();
    seedDevServer(harness);
    const processes = harness.registry.getSnapshot(RUN).processes;
    expect(processes.map((process) => [process.pid, process.role])).toEqual([[100, "agent"], [200, "command"], [300, "command"]]);
    expect(harness.byPid(RUN, 300)).toMatchObject({ parentProcessId: harness.byPid(RUN, 200)?.processId, ports: [5173], cwd: "C:\\repo", restartable: true });
    expect(harness.byPid(RUN, 100)?.restartable).toBe(false);
    expect(harness.registry.getSnapshot(CHAT).processes).toEqual([]);
  });

  it("keeps tracking descendants after their parents exit, and drops exited agents", () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.registry.applySnapshot(table(5_000, [
      entry(300, 200, "node.exe", 1_600),
      entry(400, 300, "esbuild.exe", 4_000),
    ]));
    expect(harness.byPid(RUN, 100)).toBeUndefined();
    expect(harness.byPid(RUN, 200)).toMatchObject({ status: "exited", endReason: "exited" });
    expect(harness.byPid(RUN, 300)?.status).toBe("running");
    expect(harness.byPid(RUN, 400)?.parentProcessId).toBe(harness.byPid(RUN, 300)?.processId);
  });

  it("does not adopt a reused PID or a process older than its supposed parent", () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.registry.applySnapshot(table(9_000, [
      entry(100, 1, "claude.exe", 1_000),
      entry(200, 100, "bash.exe", 1_500),
      // PID 300 now belongs to an unrelated program that started later.
      entry(300, 4, "notepad.exe", 8_000),
      // Claims tracked PID 200 as parent but is older than it: the PID was reused.
      entry(500, 200, "svchost.exe", -60_000),
    ]));
    expect(harness.byPid(RUN, 300)).toMatchObject({ name: "node.exe", status: "exited" });
    expect(harness.registry.getSnapshot(RUN).processes.some((process) => process.name === "notepad.exe" || process.pid === 500)).toBe(false);
  });

  it("treats the agent's launcher chain as the agent and ignores console hosts", () => {
    const harness = createHarness();
    harness.registry.registerSpawn(CHAT, { pid: 10, role: "agent", spawnedAtMs: 1_000, commandLine: "cmd.exe /c codex app-server" }, "C:\\chat");
    harness.registry.registerSpawn(CHAT, { pid: 20, role: "command", spawnedAtMs: 1_000, commandLine: "claude" }, "C:\\chat");
    harness.registry.applySnapshot(table(3_000, [
      entry(10, 1, "cmd.exe", 1_000),
      entry(11, 10, "node.exe", 1_100, { commandLine: "node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js app-server" }),
      entry(12, 11, "codex-x86_64-pc-windows-msvc.exe", 1_200),
      entry(13, 12, "powershell.exe", 2_000, { commandLine: "powershell.exe -NoProfile -Command \"pnpm dev\"" }),
      entry(14, 13, "conhost.exe", 2_001),
      entry(20, 1, "claude.exe", 1_000),
    ]));
    const roles = Object.fromEntries(harness.registry.getSnapshot(CHAT).processes.map((process) => [process.pid, process.role]));
    expect(roles).toEqual({ 10: "agent", 11: "agent", 12: "agent", 13: "command", 20: "agent" });
  });

  it("adopts a backgrounded server whose launcher shell exited unseen, from workspace evidence", () => {
    // Cursor runs `npm start` in a background shell that exits at once; the server's chain then
    // points at a PID no snapshot ever saw.
    const harness = createHarness();
    harness.registry.registerSpawn(RUN, { pid: 100, role: "agent", spawnedAtMs: 1_000, commandLine: "cursor-agent" }, "C:\\worktrees\\run-1");
    harness.registry.applySnapshot(table(2_000, [entry(100, 1, "cursor-agent.exe", 1_000)]));
    harness.registry.applySnapshot(table(9_000, [
      entry(100, 1, "cursor-agent.exe", 1_000),
      entry(1804, 42048, "bash.exe", 6_000, { commandLine: "\"C:\\Program Files\\Git\\usr\\bin\\bash.exe\" \"/c/Program Files/nodejs/npm\" start" }),
      entry(1344, 1804, "bash.exe", 6_100, { commandLine: "bash.exe npm start" }),
      entry(30400, 1344, "node.exe", 6_500, { commandLine: "\"node\" \"C:\\worktrees\\run-1\\node_modules\\.bin\\\\..\\@angular\\cli\\bin\\ng.js\" serve" }),
      // An unrelated orphan from the same moment stays out.
      entry(777, 4242, "updater.exe", 6_000, { commandLine: "C:\\Program Files\\Vendor\\updater.exe --background" }),
    ], [[30400, [4200]]]));

    expect(harness.byPid(RUN, 1804)).toMatchObject({ attribution: "workspace", role: "command", parentProcessId: null, cwd: "C:\\worktrees\\run-1" });
    expect(harness.byPid(RUN, 1344)).toMatchObject({ attribution: "tree", parentProcessId: harness.byPid(RUN, 1804)?.processId });
    expect(harness.byPid(RUN, 30400)).toMatchObject({ attribution: "tree", ports: [4200] });
    expect(harness.byPid(RUN, 777)).toBeUndefined();
  });

  it("leaves an orphan unassigned when its workspace matches more than one owner", () => {
    const harness = createHarness();
    // Two runs in the same local repository, both with an agent running.
    harness.registry.registerSpawn(RUN, { pid: 100, role: "agent", spawnedAtMs: 1_000, commandLine: "claude" }, "C:\\repo");
    harness.registry.registerSpawn(CHAT, { pid: 110, role: "agent", spawnedAtMs: 2_000, commandLine: "codex" }, "C:\\repo");
    harness.registry.applySnapshot(table(9_000, [
      entry(100, 1, "claude.exe", 1_000),
      entry(110, 1, "codex.exe", 2_000),
      entry(4000, 4242, "node.exe", 6_000, { commandLine: "node C:\\repo\\server.js" }),
    ]));
    expect(harness.byPid(RUN, 4000)).toBeUndefined();
    expect(harness.byPid(CHAT, 4000)).toBeUndefined();
  });

  it("checks workspace evidence for Linux servers re-parented to init", () => {
    const harness = createHarness({ platform: "linux" });
    harness.registry.registerSpawn(RUN, { pid: 100, role: "agent", spawnedAtMs: 1_000, commandLine: "codex" }, "/home/dev/worktrees/run-1");
    harness.registry.applySnapshot(table(9_000, [
      entry(1, 0, "systemd", -1_000_000, { commandLine: "/sbin/init" }),
      entry(100, 1, "codex", 1_000),
      // The launcher shell exited, so the server now has PID 1 as its parent.
      entry(4000, 1, "node", 6_000, { commandLine: "node /home/dev/worktrees/run-1/node_modules/.bin/vite" }),
      // A daemon init started during the turn, elsewhere.
      entry(4100, 1, "cron", 6_000, { commandLine: "/usr/sbin/cron -f" }),
    ]));
    expect(harness.byPid(RUN, 4000)).toMatchObject({ attribution: "workspace" });
    expect(harness.byPid(RUN, 4100)).toBeUndefined();
    expect(harness.byPid(RUN, 1)).toBeUndefined();
  });

  it("does not claim orphans that started outside the agent's turn or never mention the workspace", () => {
    const harness = createHarness();
    harness.registry.registerSpawn(RUN, { pid: 100, role: "agent", spawnedAtMs: 5_000, commandLine: "claude" }, "C:\\worktrees\\run-1");
    harness.registry.applySnapshot(table(9_000, [
      entry(100, 1, "claude.exe", 5_000),
      // Started before the agent: a server the user ran themselves.
      entry(200, 42, "node.exe", 1_000, { commandLine: "node C:\\worktrees\\run-1\\server.js" }),
      // During the turn, but elsewhere.
      entry(300, 43, "node.exe", 6_000, { commandLine: "node C:\\other-project\\server.js" }),
    ]));
    expect(harness.registry.getSnapshot(RUN).processes.map((process) => process.pid)).toEqual([100]);
  });

  it("keeps children of a parent that exited between two snapshots", () => {
    const harness = createHarness();
    seedDevServer(harness);
    // The shell (200) exits; a child it started just before shows up only now.
    harness.registry.applySnapshot(table(5_000, [entry(100, 1, "claude.exe", 1_000), entry(300, 200, "node.exe", 1_600)]));
    harness.registry.applySnapshot(table(8_000, [
      entry(100, 1, "claude.exe", 1_000),
      entry(300, 200, "node.exe", 1_600),
      entry(310, 200, "watcher.exe", 4_900),
    ]));
    expect(harness.byPid(RUN, 310)).toMatchObject({ attribution: "tree", parentProcessId: harness.byPid(RUN, 200)?.processId });
  });

  it("keeps children of a reported spawn that exited before any snapshot", () => {
    const harness = createHarness();
    harness.registry.registerSpawn(CHAT, { pid: 50, role: "command", spawnedAtMs: 1_000, commandLine: "sh -c 'npm run dev &'" }, "/chat");
    harness.registry.applySnapshot(table(3_000, [entry(51, 50, "node", 1_200, { commandLine: "node vite.js" })]));
    expect(harness.byPid(CHAT, 51)).toMatchObject({ attribution: "tree", parentProcessId: null });
  });

  it("computes CPU share from CPU time deltas across all cores", () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.registry.applySnapshot(table(3_000, [
      entry(100, 1, "claude.exe", 1_000),
      entry(200, 100, "bash.exe", 1_500),
      entry(300, 200, "node.exe", 1_600, { cpuTimeMs: 1_000 }),
    ]));
    expect(harness.byPid(RUN, 300)?.cpuPercent).toBe(50);
  });

  it("only reports owners whose processes changed", () => {
    const harness = createHarness();
    seedDevServer(harness);
    const count = harness.changes.length;
    harness.registry.applySnapshot(harness.current.value);
    expect(harness.changes.length).toBe(count);
  });
});

describe("OwnedProcessRegistry actions", () => {
  it("stops a process with its children gracefully when they exit in time", async () => {
    const harness = createHarness({ gracefulExit: true });
    seedDevServer(harness);
    const shell = harness.byPid(RUN, 200)!;
    await harness.registry.manage({ owner: RUN, action: "stop", processId: shell.processId });
    expect(harness.terminator.requestExit).toHaveBeenCalledWith([200, 300]);
    expect(harness.terminator.forceExit).not.toHaveBeenCalled();
    expect(harness.byPid(RUN, 200)).toMatchObject({ status: "exited", endReason: "stopped" });
    expect(harness.byPid(RUN, 300)).toMatchObject({ status: "exited", endReason: "stopped" });
    expect(harness.byPid(RUN, 100)?.status).toBe("running");
  });

  it.each(["stop", "restart"] as const)("includes children the last poll missed when it chooses what to %s", async (action) => {
    const harness = createHarness({ gracefulExit: true });
    seedDevServer(harness);
    harness.spawnCommand.mockReturnValue(Object.assign(new EventEmitter(), { pid: 701, stdout: new EventEmitter(), stderr: new EventEmitter() }) as unknown as ChildProcess);
    // A worker the dev server started after the last snapshot.
    harness.alive.add(400);
    harness.current.value = { ...harness.current.value, processes: [...harness.current.value.processes, entry(400, 300, "node.exe", 1_900)] };
    await harness.registry.manage({ owner: RUN, action, processId: harness.byPid(RUN, 200)!.processId });
    expect(harness.terminator.requestExit).toHaveBeenCalledWith([200, 300, 400]);
    expect(harness.alive.has(400)).toBe(false);
  });

  it("reaches a live server through a shell that already exited", async () => {
    const harness = createHarness({ gracefulExit: true });
    // `pnpm dev` (500) started a shell (200), which exited; the server (300) still runs.
    harness.registry.registerSpawn(RUN, { pid: 500, role: "command", spawnedAtMs: 1_400, commandLine: "pnpm dev" }, "C:\\repo");
    const processes = [
      entry(500, 1, "pnpm.exe", 1_400),
      entry(200, 500, "bash.exe", 1_500),
      entry(300, 200, "node.exe", 1_600),
    ];
    harness.current.value = table(2_000, processes);
    for (const process of processes) harness.alive.add(process.pid);
    harness.registry.applySnapshot(harness.current.value);
    harness.alive.delete(200);
    harness.current.value = table(3_000, processes.filter((process) => process.pid !== 200));
    harness.registry.applySnapshot(harness.current.value);
    expect(harness.byPid(RUN, 200)?.status).toBe("exited");

    await harness.registry.manage({ owner: RUN, action: "stop", processId: harness.byPid(RUN, 500)!.processId });
    expect(harness.terminator.requestExit).toHaveBeenCalledWith([500, 300]);
  });

  it("signals nothing when it cannot re-check the processes first", async () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.readerFails.value = true;
    await expect(harness.registry.manage({ owner: RUN, action: "kill", processId: harness.byPid(RUN, 300)!.processId })).rejects.toThrow(/did not stop/);
    expect(harness.terminator.requestExit).not.toHaveBeenCalled();
    expect(harness.terminator.forceExit).not.toHaveBeenCalled();
  });

  it("does not force-kill a PID that was reused during the graceful wait", async () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.terminator.requestExit.mockImplementation(async () => {
      // The server exits on its own and another program receives its PID.
      harness.current.value = table(4_000, [
        entry(100, 1, "claude.exe", 1_000),
        entry(200, 100, "bash.exe", 1_500),
        entry(300, 4, "notepad.exe", 3_500),
      ]);
      return true;
    });
    await harness.registry.manage({ owner: RUN, action: "stop", processId: harness.byPid(RUN, 300)!.processId });
    expect(harness.terminator.forceExit).not.toHaveBeenCalled();
    expect(harness.byPid(RUN, 300)).toMatchObject({ name: "node.exe", status: "exited" });
  });

  it("escalates to a forced kill when a graceful stop is ignored", async () => {
    const harness = createHarness({ gracefulExit: false });
    seedDevServer(harness);
    await harness.registry.manage({ owner: RUN, action: "stop", processId: harness.byPid(RUN, 300)!.processId });
    expect(harness.terminator.requestExit).toHaveBeenCalledWith([300]);
    expect(harness.terminator.forceExit).toHaveBeenCalledWith([300]);
    expect(harness.byPid(RUN, 300)).toMatchObject({ status: "exited", endReason: "killed" });
  });

  it("kills immediately and refuses to act on the agent itself", async () => {
    const harness = createHarness();
    seedDevServer(harness);
    await expect(harness.registry.manage({ owner: RUN, action: "kill", processId: harness.byPid(RUN, 100)!.processId })).rejects.toThrow(/Stop the run/);
    await harness.registry.manage({ owner: RUN, action: "kill", processId: harness.byPid(RUN, 300)!.processId });
    expect(harness.terminator.requestExit).not.toHaveBeenCalled();
    expect(harness.byPid(RUN, 300)).toMatchObject({ status: "exited", endReason: "killed" });
  });

  it("includes spawns reported since the last snapshot when killing everything", async () => {
    const harness = createHarness();
    harness.registry.registerSpawn(RUN, { pid: 700, role: "command", spawnedAtMs: 1_000, commandLine: "npm run dev" }, "C:\\repo");
    harness.alive.add(700);
    harness.current.value = table(1_500, [entry(700, 1, "node.exe", 1_000)]);
    // No poll ran yet: the spawn is only known as a report.
    await harness.registry.manage({ owner: RUN, action: "kill-all" });
    expect(harness.terminator.forceExit).toHaveBeenCalledWith([700]);
  });

  it("stops everything except the agent, then clears exited entries", async () => {
    const harness = createHarness({ gracefulExit: true });
    seedDevServer(harness);
    await harness.registry.manage({ owner: RUN, action: "stop-all" });
    expect(harness.terminator.requestExit).toHaveBeenCalledWith([200, 300]);
    await harness.registry.manage({ owner: RUN, action: "clear-exited" });
    expect(harness.registry.getSnapshot(RUN).processes.map((process) => process.pid)).toEqual([100]);
  });

  it("restarts a command in the owner's workspace and captures its output and exit code", async () => {
    const harness = createHarness({ gracefulExit: true });
    seedDevServer(harness);
    const child = Object.assign(new EventEmitter(), { pid: 777, stdout: new EventEmitter(), stderr: new EventEmitter() });
    harness.spawnCommand.mockReturnValue(child as unknown as ChildProcess);
    const original = harness.byPid(RUN, 200)!;

    await harness.registry.manage({ owner: RUN, action: "restart", processId: original.processId });

    expect(harness.terminator.requestExit).toHaveBeenCalledWith([200, 300]);
    expect(harness.spawnCommand).toHaveBeenCalledWith({ commandLine: "bash.exe -c \"pnpm dev\"", argv: null, cwd: "C:\\repo" });
    const restarted = harness.byPid(RUN, 777)!;
    expect(restarted).toMatchObject({ role: "restarted", restartOfProcessId: original.processId, parentProcessId: null, hasOutput: true, status: "running" });

    child.stdout.emit("data", Buffer.from("ready on :5173\n"));
    expect(harness.registry.getOutput(RUN, restarted.processId).text).toBe("ready on :5173\n");
    // Output leaves the host too; credentials a command prints are hidden like in command lines.
    child.stderr.emit("data", Buffer.from("retrying with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n"));
    expect(harness.registry.getOutput(RUN, restarted.processId).text).toBe("ready on :5173\nretrying with GITHUB_TOKEN=•••\n");
    child.emit("exit", 1);
    expect(harness.byPid(RUN, 777)).toMatchObject({ status: "exited", exitCode: 1, endReason: "exited" });
  });

  it("does not start a replacement while the old command is still running", async () => {
    const harness = createHarness();
    seedDevServer(harness);
    // Neither the graceful request nor the forced kill ends the server.
    harness.terminator.forceExit.mockImplementation(async () => undefined);
    await expect(harness.registry.manage({ owner: RUN, action: "restart", processId: harness.byPid(RUN, 300)!.processId }))
      .rejects.toThrow(/node\.exe \(PID 300\) did not stop/);
    expect(harness.spawnCommand).not.toHaveBeenCalled();
    expect(harness.byPid(RUN, 300)?.status).toBe("running");
  }, 10_000);

  it("starts only one replacement when the same process is restarted twice at once", async () => {
    const harness = createHarness({ gracefulExit: true });
    seedDevServer(harness);
    harness.spawnCommand.mockImplementation(() => Object.assign(new EventEmitter(), { pid: 800, stdout: new EventEmitter(), stderr: new EventEmitter() }));
    const processId = harness.byPid(RUN, 300)!.processId;
    const results = await Promise.allSettled([
      harness.registry.manage({ owner: RUN, action: "restart", processId }),
      harness.registry.manage({ owner: RUN, action: "restart", processId }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(harness.spawnCommand).toHaveBeenCalledOnce();
    // The guard is released afterwards, so the process can be restarted again later.
    await harness.registry.manage({ owner: RUN, action: "restart", processId });
    expect(harness.spawnCommand).toHaveBeenCalledTimes(2);
  });

  it("restarts from launch arguments on Linux and refuses argv a process rewrote", () => {
    const harness = createHarness({ platform: "linux" });
    harness.registry.registerSpawn(RUN, { pid: 100, role: "command", spawnedAtMs: 1_000, commandLine: "sh -c npm run dev", argv: ["/bin/sh", "-c", "npm run dev"] }, "/repo");
    harness.registry.applySnapshot(table(2_000, [
      // npm set process.title, so its live argv no longer reads as launch arguments.
      entry(100, 1, "npm run dev", 1_000, { argv: ["npm run dev"] }),
      entry(200, 100, "node", 1_200, { argv: ["npm run dev"] }),
      entry(300, 100, "node", 1_300, { argv: ["/usr/bin/node", "vite.js"] }),
      // A shorter title leaves NUL padding, read as trailing empty arguments, with or without spaces.
      entry(400, 100, "node", 1_400, { argv: ["npm run dev", "", "", ""] }),
      entry(500, 100, "node", 1_500, { argv: ["npm", "", ""] }),
    ]));
    expect(harness.byPid(RUN, 100)?.restartable).toBe(true);
    expect(harness.byPid(RUN, 200)?.restartable).toBe(false);
    expect(harness.byPid(RUN, 300)?.restartable).toBe(true);
    expect(harness.byPid(RUN, 400)?.restartable).toBe(false);
    expect(harness.byPid(RUN, 500)?.restartable).toBe(false);
  });

  it("refuses to restart a process with unverified launch arguments before stopping anything", async () => {
    const harness = createHarness({ platform: "linux" });
    harness.registry.registerSpawn(RUN, { pid: 100, role: "command", spawnedAtMs: 1_000, commandLine: "sh -c npm run dev", argv: ["/bin/sh", "-c", "npm run dev"] }, "/repo");
    harness.alive.add(100).add(200);
    harness.current.value = table(2_000, [
      entry(100, 1, "sh", 1_000, { argv: ["/bin/sh", "-c", "npm run dev"] }),
      entry(200, 100, "node", 1_200, { argv: ["npm", "", ""] }),
    ]);
    harness.registry.applySnapshot(harness.current.value);
    await expect(harness.registry.manage({ owner: RUN, action: "restart", processId: harness.byPid(RUN, 200)!.processId }))
      .rejects.toThrow("cannot start this command again");
    expect(harness.terminator.requestExit).not.toHaveBeenCalled();
    expect(harness.byPid(RUN, 200)?.status).toBe("running");
  });

  it("redacts credentials in snapshots but restarts with the full command line", async () => {
    const harness = createHarness({ gracefulExit: true });
    const secretCommand = "node deploy.js --api-key=sk-live-1234567890abcdefghij --verbose";
    harness.registry.registerSpawn(RUN, { pid: 600, role: "command", spawnedAtMs: 1_000, commandLine: secretCommand }, "C:\\repo");
    harness.alive.add(600);
    harness.current.value = table(2_000, [entry(600, 1, "node.exe", 1_000, { commandLine: secretCommand })]);
    harness.registry.applySnapshot(harness.current.value);
    expect(harness.byPid(RUN, 600)?.commandLine).toBe("node deploy.js --api-key=••• --verbose");
    expect(JSON.stringify(harness.changes.at(-1))).not.toContain("sk-live");

    harness.spawnCommand.mockReturnValue(Object.assign(new EventEmitter(), { pid: 601, stdout: new EventEmitter(), stderr: new EventEmitter() }));
    await harness.registry.manage({ owner: RUN, action: "restart", processId: harness.byPid(RUN, 600)!.processId });
    expect(harness.spawnCommand).toHaveBeenCalledWith(expect.objectContaining({ commandLine: secretCommand }));
  });

  it.each([
    ["git clone https://dev:hunter2pass@github.com/org/repo.git", "git clone https://dev:•••@github.com/org/repo.git"],
    ["curl -H \"Authorization: Bearer abcdefghijklmnop\" https://api", "curl -H \"Authorization: Bearer •••\" https://api"],
    ["npm publish --token npm_abc123 --access public", "npm publish --token ••• --access public"],
    ["env GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 node x.js", "env GITHUB_TOKEN=••• node x.js"],
    ["claude --mcp-config {\\\"headers\\\":{\\\"Authorization\\\":\\\"Bearer t0k3n-value-123\\\"}}", "claude --mcp-config {\\\"headers\\\":{\\\"Authorization\\\":\"•••\"}}"],
    ["curl -u alice:mycredential https://example.com", "curl -u alice:••• https://example.com"],
    ["curl --user=\"alice:my credential\" -uBob:pw2 https://x", "curl --user=\"alice:•••\" -uBob:••• https://x"],
    ["git push -u origin main", "git push -u origin main"],
    // Escaped quotes inside a quoted value do not end it.
    ["tool --password=\"alpha\\\"bravo charlie\" --next", "tool --password=••• --next"],
    ["env password=\"alpha\\\"bravo\" node x.js", "env password=••• node x.js"],
    ["node vite.js --port 5173", "node vite.js --port 5173"],
  ])("redacts %s", (commandLine, expected) => {
    expect(redactCommandLine(commandLine)).toBe(expected);
  });

  it("only offers restarts where the exact command can be reproduced", () => {
    const harness = createHarness({ platform: "darwin" });
    seedDevServer(harness);
    expect(harness.byPid(RUN, 300)?.restartable).toBe(false);
  });

  it("forgets an owner without touching its processes", () => {
    const harness = createHarness();
    seedDevServer(harness);
    harness.registry.forgetOwner(RUN);
    expect(harness.registry.getSnapshot(RUN).processes).toEqual([]);
    expect(harness.terminator.forceExit).not.toHaveBeenCalled();
  });
});

describe("agent process recognition", () => {
  it.each([
    [{ name: "claude.exe", commandLine: null }, true],
    [{ name: "node.exe", commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }, true],
    [{ name: "codex-aarch64-apple-darwin", commandLine: null }, true],
    [{ name: "git.exe", commandLine: "git commit -m \"fix codex bug\"" }, false],
    [{ name: "node.exe", commandLine: "node vite.js" }, false],
  ])("recognises %o as agent: %s", (entryLike, expected) => {
    expect(looksLikeAgentProcess(entryLike)).toBe(expected);
  });

  it("matches a workspace path however a command line spells it", () => {
    const forms = workspacePathForms("C:\\Users\\Dev\\Repo\\");
    expect(forms).toEqual(["c:/users/dev/repo", "/c/users/dev/repo", "/mnt/c/users/dev/repo"]);
    expect(commandLineMentionsPath("node C:\\Users\\dev\\repo\\\\node_modules\\vite.js", forms)).toBe(true);
    expect(commandLineMentionsPath("bash -c 'cd /c/Users/dev/repo && npm start'", forms)).toBe(true);
    expect(commandLineMentionsPath("node C:\\Users\\dev\\other\\vite.js", forms)).toBe(false);
    // Whole path components only.
    const run1 = workspacePathForms("C:\\worktrees\\run-1");
    expect(commandLineMentionsPath("node C:\\worktrees\\run-10\\server.js", run1)).toBe(false);
    expect(commandLineMentionsPath("node C:\\worktrees\\run-1\\server.js", run1)).toBe(true);
    expect(commandLineMentionsPath("node --root=\"C:\\worktrees\\run-1\"", run1)).toBe(true);
    expect(commandLineMentionsPath("cd C:\\worktrees\\run-1 && npm start", run1)).toBe(true);
    expect(commandLineMentionsPath("node D:\\backup\\C:\\worktrees\\run-1x", run1)).toBe(false);
    expect(workspacePathForms("/home/dev/repo")).toEqual(["/home/dev/repo"]);
    expect(workspacePathForms("C:\\")).toEqual([]);
  });

  it("splits the head of a command line with quoted paths", () => {
    expect(commandLineHead("\"C:\\Program Files\\x.exe\" run --flag", 2)).toEqual(["C:\\Program Files\\x.exe", "run"]);
  });
});
