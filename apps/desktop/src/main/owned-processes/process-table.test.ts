import { describe, expect, it } from "vitest";
import {
  parseLsofListeningPorts,
  parsePosixProcessTable,
  parseProcessStartTime,
  parseSsListeningPorts,
  parseWindowsProcessSnapshot,
  runProcessTableCommand,
  WINDOWS_SNAPSHOT_SCRIPT,
} from "./process-table";

describe("Windows process snapshots", () => {
  it("parses processes, converts CPU time from 100 ns units, and groups listening ports", () => {
    const json = JSON.stringify({
      p: [
        { i: 4100, p: 4000, n: "node.exe", c: "\"C:\\Program Files\\nodejs\\node.exe\" vite.js", t: 1_700_000_000_000, m: 52_428_800, u: 15_000_000 },
        { i: 4200, p: 4100, n: "esbuild.exe", c: null, t: 1_700_000_001_000, m: 1_048_576, u: 0 },
        { i: 0, p: 0, n: "System Idle Process", c: null, t: 0, m: 8, u: 0 },
      ],
      l: [{ i: 4100, o: 5173 }, { i: 4100, o: 24678 }, { i: 4100, o: 5173 }],
    });
    const snapshot = parseWindowsProcessSnapshot(json, 1_700_000_005_000, true);
    expect(snapshot.processes).toHaveLength(2);
    expect(snapshot.processes[0]).toMatchObject({ pid: 4100, ppid: 4000, name: "node.exe", cpuTimeMs: 1_500, memoryBytes: 52_428_800 });
    expect(snapshot.processes[1]).toMatchObject({ pid: 4200, commandLine: null });
    expect(snapshot.ports?.get(4100)).toEqual([5173, 24678]);
  });

  it("accepts a single process serialized as an object and leaves ports unsampled when not requested", () => {
    const snapshot = parseWindowsProcessSnapshot(JSON.stringify({ p: { i: 7, p: 1, n: "a.exe", c: "a.exe", t: 1, m: 1, u: 1 }, l: [] }), 10, false);
    expect(snapshot.processes.map((entry) => entry.pid)).toEqual([7]);
    expect(snapshot.ports).toBeNull();
  });

  it("ends every answer with the marker the reader waits for", () => {
    expect(WINDOWS_SNAPSHOT_SCRIPT).toContain("$out.WriteLine('<<BW-END>>')");
    expect(WINDOWS_SNAPSHOT_SCRIPT).toContain("$ProgressPreference = 'SilentlyContinue'");
  });
});

describe("process table commands", () => {
  const fakeExec = (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) =>
    ((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(error, stdout);
    }) as unknown as typeof import("node:child_process").execFile;

  it("rejects a failed run even when it produced partial output", async () => {
    const truncated = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    await expect(runProcessTableCommand("ps", [], [], fakeExec(truncated, "  1 0 4 00:01 0.0 /sbin/init\n"))).rejects.toThrow(/maxBuffer/);
  });

  it("accepts listed exit codes, such as lsof finding no listeners", async () => {
    const noListeners = Object.assign(new Error("Command failed"), { code: 1 });
    await expect(runProcessTableCommand("lsof", [], [1], fakeExec(noListeners, ""))).resolves.toBe("");
    await expect(runProcessTableCommand("lsof", [], [], fakeExec(noListeners, ""))).rejects.toThrow();
    const timedOut = Object.assign(new Error("timed out"), { code: 1, killed: true });
    await expect(runProcessTableCommand("lsof", [], [1], fakeExec(timedOut, "p1\n"))).rejects.toThrow();
  });
});

describe("POSIX process snapshots", () => {
  it.each([
    ["Thu Nov 19 07:21:35 2026", new Date(2026, 10, 19, 7, 21, 35).getTime()],
    ["Mon Feb  2 23:05:09 2026", new Date(2026, 1, 2, 23, 5, 9).getTime()],
    ["01:05", null],
    ["Thu Foo 19 07:21:35 2026", null],
  ])("parses start time %s", (value, expected) => {
    expect(parseProcessStartTime(value)).toBe(expected);
  });

  it("parses ps output with spaces in arguments", () => {
    const text = [
      "  4100  4000  51200 Thu Nov 19 07:21:35 2026  12.5 /usr/local/bin/node /repo/node_modules/.bin/vite --port 5173",
      "  4200  4100   1024 Thu Nov  5 10:00:00 2026   0,0 sh -c pnpm dev",
      "garbage",
    ].join("\n");
    const processes = parsePosixProcessTable(text);
    expect(processes).toHaveLength(2);
    expect(processes[0]).toMatchObject({
      pid: 4100,
      ppid: 4000,
      name: "node",
      commandLine: "/usr/local/bin/node /repo/node_modules/.bin/vite --port 5173",
      startedAtMs: new Date(2026, 10, 19, 7, 21, 35).getTime(),
      memoryBytes: 51_200 * 1_024,
      cpuPercent: 12.5,
    });
    expect(processes[1]).toMatchObject({ name: "sh", cpuPercent: 0, startedAtMs: new Date(2026, 10, 5, 10, 0, 0).getTime() });
  });

  it("parses listening ports from lsof and ss", () => {
    expect(parseLsofListeningPorts("p4100\nf20\nn*:5173\nf21\nn[::1]:5173\np4200\nn127.0.0.1:8080\n")).toEqual(new Map([[4100, [5173]], [4200, [8080]]]));
    expect(parseSsListeningPorts('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=4100,fd=20),("node",pid=4101,fd=20))\n'))
      .toEqual(new Map([[4100, [3000]], [4101, [3000]]]));
  });
});
