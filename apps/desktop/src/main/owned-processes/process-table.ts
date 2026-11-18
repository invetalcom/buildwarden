import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** One process as the operating system reports it. */
export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string | null;
  /** Exact argument vector, when the platform exposes it (Linux). */
  argv: string[] | null;
  /** Creation time; 0 when unknown. */
  startedAtMs: number;
  memoryBytes: number | null;
  /** Cumulative CPU time, for platforms that report it (Windows). */
  cpuTimeMs: number | null;
  /** Ready-made CPU share, for platforms that report it directly (ps). */
  cpuPercent: number | null;
}

export interface ProcessTableSnapshot {
  takenAtMs: number;
  processes: ProcessTableEntry[];
  /** Listening TCP ports by PID; null when ports were not sampled. */
  ports: Map<number, number[]> | null;
  /** How far two start times of the same process may differ between samples. */
  startTimeToleranceMs: number;
}

export interface ProcessTableReader {
  readonly supported: boolean;
  snapshot(options: { ports: boolean }): Promise<ProcessTableSnapshot>;
  /** Exact argv of a live process, when the platform exposes it. */
  readArgv?(pid: number): string[] | null;
  dispose(): void;
}

const addPort = (ports: Map<number, number[]>, pid: number, port: number) => {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0) return;
  const list = ports.get(pid) ?? [];
  if (!list.includes(port)) list.push(port);
  ports.set(pid, list.sort((left, right) => left - right));
};

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// ---------------------------------------------------------------------------------------------
// Windows: one long-lived PowerShell host answers snapshot requests over stdin/stdout. Starting
// PowerShell costs ~1 s; a warm CIM query takes ~60 ms (~160 ms with listening ports).
// ---------------------------------------------------------------------------------------------

const WINDOWS_SNAPSHOT_END = "<<BW-END>>";

export const WINDOWS_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
$out = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$in = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime | ForEach-Object {
    $created = 0
    if ($_.CreationDate) { $created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
    [pscustomobject]@{ i = [int]$_.ProcessId; p = [int]$_.ParentProcessId; n = [string]$_.Name; c = $_.CommandLine; t = $created; m = [double]$_.WorkingSetSize; u = [double]($_.KernelModeTime + $_.UserModeTime) }
  })
  $ports = @()
  if ($line -eq 'ports') {
    $ports = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ i = [int]$_.OwningProcess; o = [int]$_.LocalPort } })
  }
  $out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{ p = $procs; l = $ports }) -Compress -Depth 4))
  $out.WriteLine('${WINDOWS_SNAPSHOT_END}')
  $out.Flush()
}`;

/** Parses one answer of the PowerShell host. Kernel and user times arrive in 100 ns units. */
export const parseWindowsProcessSnapshot = (json: string, takenAtMs: number, withPorts: boolean): ProcessTableSnapshot => {
  const parsed = JSON.parse(json) as { p?: unknown; l?: unknown };
  const rows = Array.isArray(parsed.p) ? parsed.p : parsed.p ? [parsed.p] : [];
  const processes: ProcessTableEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const pid = finiteOrNull(value.i);
    const ppid = finiteOrNull(value.p);
    if (pid === null || pid <= 0 || ppid === null) continue;
    const cpu = finiteOrNull(value.u);
    processes.push({
      pid,
      ppid,
      name: typeof value.n === "string" ? value.n : "",
      commandLine: typeof value.c === "string" && value.c.trim() ? value.c : null,
      argv: null,
      startedAtMs: finiteOrNull(value.t) ?? 0,
      memoryBytes: finiteOrNull(value.m),
      cpuTimeMs: cpu === null ? null : cpu / 10_000,
      cpuPercent: null,
    });
  }
  let ports: Map<number, number[]> | null = null;
  if (withPorts) {
    ports = new Map();
    const listeners = Array.isArray(parsed.l) ? parsed.l : parsed.l ? [parsed.l] : [];
    for (const listener of listeners) {
      if (!listener || typeof listener !== "object") continue;
      const value = listener as Record<string, unknown>;
      addPort(ports, Number(value.i), Number(value.o));
    }
  }
  return { takenAtMs, processes, ports, startTimeToleranceMs: 1_500 };
};

const REQUEST_TIMEOUT_MS = 20_000;

export class WindowsProcessTableReader implements ProcessTableReader {
  readonly supported = true;
  private host: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { powershellPath?: string } = {}) {}

  snapshot(options: { ports: boolean }): Promise<ProcessTableSnapshot> {
    const next = this.queue.then(async () => {
      const text = await this.request(options.ports ? "ports" : "procs");
      return parseWindowsProcessSnapshot(text, Date.now(), options.ports);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.failPending(new Error("The process inspector stopped."));
    const host = this.host;
    this.host = null;
    if (host && host.exitCode === null) {
      host.stdin.end();
      host.kill();
    }
  }

  private ensureHost(): ChildProcessWithoutNullStreams {
    if (this.host && this.host.exitCode === null && !this.host.killed) return this.host;
    const encoded = Buffer.from(WINDOWS_SNAPSHOT_SCRIPT, "utf16le").toString("base64");
    const powershell = this.options.powershellPath
      ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const host = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    host.stdout.setEncoding("utf8");
    host.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const end = this.buffer.indexOf(WINDOWS_SNAPSHOT_END);
      if (end < 0) return;
      const text = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + WINDOWS_SNAPSHOT_END.length).replace(/^\s+/, "");
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(text);
      }
    });
    // PowerShell reports progress and warnings on stderr; they carry nothing the reader needs.
    host.stderr.on("data", () => undefined);
    host.on("error", (error) => this.handleHostEnd(host, error));
    host.on("exit", () => this.handleHostEnd(host, new Error("The process inspector exited.")));
    this.host = host;
    return host;
  }

  private handleHostEnd(host: ChildProcessWithoutNullStreams, error: Error) {
    if (this.host !== host) return;
    this.host = null;
    this.failPending(error);
  }

  private failPending(error: Error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private request(command: string): Promise<string> {
    const host = this.ensureHost();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending(new Error("The process inspector did not answer in time."));
        host.kill();
      }, REQUEST_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      host.stdin.write(`${command}\n`);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// macOS and Linux: `ps` for the table, `lsof` (or `ss` on Linux) for listening ports.
// ---------------------------------------------------------------------------------------------

/** `[[dd-]hh:]mm:ss` as printed by `ps -o etime`. */
export const parseElapsedSeconds = (value: string): number | null => {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
};

/** Parses `ps -A -o pid=,ppid=,rss=,etime=,pcpu=,args=`. */
export const parsePosixProcessTable = (text: string, takenAtMs: number): ProcessTableEntry[] => {
  const processes: ProcessTableEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, rssKb, elapsed, cpu, args] = match;
    const elapsedSeconds = parseElapsedSeconds(elapsed ?? "");
    const commandLine = (args ?? "").trim();
    const executable = commandLine.split(/\s+/)[0] ?? "";
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: basename(executable),
      commandLine: commandLine || null,
      argv: null,
      startedAtMs: elapsedSeconds === null ? 0 : takenAtMs - elapsedSeconds * 1_000,
      memoryBytes: Number(rssKb) * 1_024,
      cpuTimeMs: null,
      cpuPercent: Number((cpu ?? "0").replace(",", ".")),
    });
  }
  return processes;
};

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpn`. */
export const parseLsofListeningPorts = (text: string): Map<number, number[]> => {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      addPort(ports, pid, port);
    }
  }
  return ports;
};

/** Parses `ss -ltnpH`; the owning processes appear as `users:(("node",pid=123,fd=20))`. */
export const parseSsListeningPorts = (text: string): Map<number, number[]> => {
  const ports = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const local = columns[3];
    const port = Number(/:(\d+)$/.exec(local ?? "")?.[1]);
    for (const match of line.matchAll(/pid=(\d+)/g)) addPort(ports, Number(match[1]), port);
  }
  return ports;
};

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: REQUEST_TIMEOUT_MS }, (error, stdout) => {
      // lsof exits with 1 when nothing listens; its output is still valid.
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });

export class PosixProcessTableReader implements ProcessTableReader {
  readonly supported = true;

  constructor(private readonly platform: NodeJS.Platform) {}

  async snapshot(options: { ports: boolean }): Promise<ProcessTableSnapshot> {
    const takenAtMs = Date.now();
    const table = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,etime=,pcpu=,args="]);
    const processes = parsePosixProcessTable(table, takenAtMs);
    let ports: Map<number, number[]> | null = null;
    if (options.ports) ports = await this.readPorts();
    return { takenAtMs, processes, ports, startTimeToleranceMs: 2_500 };
  }

  readArgv(pid: number): string[] | null {
    if (this.platform !== "linux") return null;
    try {
      const raw = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8");
      const argv = raw.split("\0").filter((part, index, parts) => part.length > 0 || index < parts.length - 1);
      return argv.length > 0 && argv[0] ? argv : null;
    } catch {
      return null;
    }
  }

  dispose(): void {}

  private async readPorts(): Promise<Map<number, number[]>> {
    try {
      return parseLsofListeningPorts(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
    } catch {
      if (this.platform !== "linux") return new Map();
      try {
        return parseSsListeningPorts(await run("ss", ["-ltnpH"]));
      } catch {
        return new Map();
      }
    }
  }
}

export const createPlatformProcessTableReader = (platform: NodeJS.Platform = process.platform): ProcessTableReader => {
  if (platform === "win32") return new WindowsProcessTableReader();
  if (platform === "linux" || platform === "darwin") return new PosixProcessTableReader(platform);
  return {
    supported: false,
    snapshot: () => Promise.resolve({ takenAtMs: Date.now(), processes: [], ports: null, startTimeToleranceMs: 0 }),
    dispose: () => undefined,
  };
};
