import { describe, expect, it } from "vitest";
import {
  parseElapsedSeconds,
  parseLsofListeningPorts,
  parsePosixProcessTable,
  parseSsListeningPorts,
  parseWindowsProcessSnapshot,
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

describe("POSIX process snapshots", () => {
  it.each([
    ["05", null],
    ["00:05", 5],
    ["12:34", 754],
    ["01:02:03", 3_723],
    ["2-01:00:00", 176_400],
  ])("parses elapsed time %s", (value, expected) => {
    expect(parseElapsedSeconds(value)).toBe(expected);
  });

  it("parses ps output with spaces in arguments", () => {
    const text = [
      "  4100  4000  51200      01:05  12.5 /usr/local/bin/node /repo/node_modules/.bin/vite --port 5173",
      "  4200  4100   1024      00:02   0,0 sh -c pnpm dev",
      "garbage",
    ].join("\n");
    const processes = parsePosixProcessTable(text, 100_000);
    expect(processes).toHaveLength(2);
    expect(processes[0]).toMatchObject({
      pid: 4100,
      ppid: 4000,
      name: "node",
      commandLine: "/usr/local/bin/node /repo/node_modules/.bin/vite --port 5173",
      startedAtMs: 35_000,
      memoryBytes: 51_200 * 1_024,
      cpuPercent: 12.5,
    });
    expect(processes[1]).toMatchObject({ name: "sh", cpuPercent: 0 });
  });

  it("parses listening ports from lsof and ss", () => {
    expect(parseLsofListeningPorts("p4100\nf20\nn*:5173\nf21\nn[::1]:5173\np4200\nn127.0.0.1:8080\n")).toEqual(new Map([[4100, [5173]], [4200, [8080]]]));
    expect(parseSsListeningPorts('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=4100,fd=20),("node",pid=4101,fd=20))\n'))
      .toEqual(new Map([[4100, [3000]], [4101, [3000]]]));
  });
});
