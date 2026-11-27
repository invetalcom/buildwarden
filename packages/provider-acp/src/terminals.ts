import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { terminatePosixProcessTree } from "@buildwarden/agent-runtime";

/** Output a terminal keeps when the agent sets no limit. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1_048_576;
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1_048_576;
const MAX_TERMINALS = 32;

export interface AcpTerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface AcpTerminalSnapshot {
  id: string;
  commandLine: string;
  /** The command and arguments as the agent asked to run them. */
  request: { command: string; args: string[] };
  output: string;
  truncated: boolean;
  exitStatus: AcpTerminalExitStatus | null;
}

interface Terminal {
  id: string;
  commandLine: string;
  request: { command: string; args: string[] };
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exitStatus: AcpTerminalExitStatus | null;
  exited: Promise<AcpTerminalExitStatus>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Quotes one argument for cmd.exe's `/s /c "..."` command line. */
const quoteWindowsArgument = (value: string): string =>
  /^[A-Za-z0-9_\-+=.,:/\\@]+$/.test(value) ? value : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

const quotePosixArgument = (value: string): string =>
  /^[A-Za-z0-9_\-+=.,:/@%]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The command as the user approves it and as it runs. ACP names an executable and its arguments,
 * but some agents send shell source as the command with no arguments, so that form runs in a
 * shell. On Windows every command goes through cmd.exe, which resolves `.cmd` shims such as npm.
 */
export const terminalCommandLine = (command: string, args: readonly string[], platform = process.platform): string => {
  if (args.length === 0) return command.trim();
  const quote = platform === "win32" ? quoteWindowsArgument : quotePosixArgument;
  return [quote(command), ...args.map(quote)].join(" ");
};

/** Keeps the newest bytes, cut at a UTF-8 character boundary, as ACP requires. */
const trimFromStart = (buffer: Buffer, limit: number): Buffer => {
  if (buffer.byteLength <= limit) return buffer;
  let start = buffer.byteLength - limit;
  // Continuation bytes are 10xxxxxx; a character starts at the first byte that is not one.
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
};

/**
 * The terminals an ACP agent runs through BuildWarden (`terminal/*`). Each command passes
 * BuildWarden's shell policy before it starts, runs in the run workspace, and ends with the turn.
 */
export class AcpTerminals {
  private readonly terminals = new Map<string, Terminal>();

  constructor(private readonly options: {
    workspace: string;
    /** Throws when the command may not run. Gets the line that runs and the request it came from. */
    authorize: (commandLine: string, request: { command: string; args: string[] }) => Promise<void>;
    resolveCwd: (requested: unknown) => Promise<string>;
    env?: NodeJS.ProcessEnv;
    onOutput?: (terminalId: string) => void;
    platform?: NodeJS.Platform;
  }) {}

  async create(raw: unknown): Promise<{ terminalId: string }> {
    const params = isRecord(raw) ? raw : {};
    const command = typeof params.command === "string" ? params.command : "";
    if (!command.trim()) throw new Error("terminal/create needs a command.");
    const args = Array.isArray(params.args) ? params.args.filter((arg): arg is string => typeof arg === "string") : [];
    if (this.terminals.size >= MAX_TERMINALS) throw new Error("Too many open terminals; release finished ones first.");
    const platform = this.options.platform ?? process.platform;
    const commandLine = terminalCommandLine(command, args, platform);
    const cwd = params.cwd === undefined || params.cwd === null ? this.options.workspace : await this.options.resolveCwd(params.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("The terminal's working directory is not a folder.");
    await this.options.authorize(commandLine, { command, args });
    const extraEnv = Array.isArray(params.env)
      ? Object.fromEntries(params.env.filter(isRecord).flatMap((entry) =>
        typeof entry.name === "string" && typeof entry.value === "string" ? [[entry.name, entry.value]] : []))
      : {};
    const requestedLimit = typeof params.outputByteLimit === "number" && params.outputByteLimit > 0 ? Math.floor(params.outputByteLimit) : DEFAULT_OUTPUT_BYTE_LIMIT;
    const child = platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
        cwd, env: { ...(this.options.env ?? process.env), ...extraEnv }, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"],
      })
      : spawn("sh", ["-c", commandLine], {
        cwd, env: { ...(this.options.env ?? process.env), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
      });
    const id = `bw-term-${randomUUID()}`;
    let resolveExit!: (status: AcpTerminalExitStatus) => void;
    const terminal: Terminal = {
      id, commandLine, request: { command, args }, child, chunks: [], bytes: 0, limit: Math.min(requestedLimit, MAX_OUTPUT_BYTE_LIMIT), truncated: false, exitStatus: null,
      exited: new Promise((resolve) => { resolveExit = resolve; }),
    };
    const append = (chunk: Buffer) => {
      terminal.chunks.push(chunk);
      terminal.bytes += chunk.byteLength;
      if (terminal.bytes > terminal.limit * 2) this.compact(terminal);
      this.options.onOutput?.(id);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const settle = (status: AcpTerminalExitStatus) => {
      if (terminal.exitStatus) return;
      terminal.exitStatus = status;
      resolveExit(status);
      this.options.onOutput?.(id);
    };
    child.once("error", (error) => {
      append(Buffer.from(`${error.message}\n`));
      settle({ exitCode: null, signal: null });
    });
    child.once("close", (code, signal) => settle({ exitCode: code, signal }));
    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  private compact(terminal: Terminal): void {
    const joined = Buffer.concat(terminal.chunks);
    const kept = trimFromStart(joined, terminal.limit);
    if (kept.byteLength < joined.byteLength) terminal.truncated = true;
    terminal.chunks = [kept];
    terminal.bytes = kept.byteLength;
  }

  private get(raw: unknown): Terminal {
    const params = isRecord(raw) ? raw : {};
    const terminal = typeof params.terminalId === "string" ? this.terminals.get(params.terminalId) : undefined;
    if (!terminal) throw new Error("Unknown terminal.");
    return terminal;
  }

  snapshot(terminalId: string): AcpTerminalSnapshot | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return null;
    this.compact(terminal);
    return {
      id: terminal.id, commandLine: terminal.commandLine, request: terminal.request,
      output: Buffer.concat(terminal.chunks).toString("utf8"), truncated: terminal.truncated, exitStatus: terminal.exitStatus,
    };
  }

  output(raw: unknown): { output: string; truncated: boolean; exitStatus?: AcpTerminalExitStatus } {
    const snapshot = this.snapshot(this.get(raw).id)!;
    return { output: snapshot.output, truncated: snapshot.truncated, ...(snapshot.exitStatus ? { exitStatus: snapshot.exitStatus } : {}) };
  }

  async waitForExit(raw: unknown): Promise<AcpTerminalExitStatus> {
    return this.get(raw).exited;
  }

  async kill(raw: unknown): Promise<null> {
    await this.stop(this.get(raw));
    return null;
  }

  async release(raw: unknown): Promise<null> {
    const terminal = this.get(raw);
    await this.stop(terminal);
    this.terminals.delete(terminal.id);
    return null;
  }

  /** Ends every terminal the turn left running. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.values()].map((terminal) => this.stop(terminal)));
  }

  private async stop(terminal: Terminal): Promise<void> {
    if (terminal.exitStatus || !terminal.child.pid) return;
    const pid = terminal.child.pid;
    if ((this.options.platform ?? process.platform) === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", () => resolve());
        killer.once("error", () => {
          terminal.child.kill();
          resolve();
        });
      });
    } else if (!(await terminatePosixProcessTree(pid))) {
      terminal.child.kill("SIGTERM");
    }
    await Promise.race([terminal.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}
