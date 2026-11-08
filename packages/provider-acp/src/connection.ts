import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcId = number | string;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpLaunch {
  command: string;
  args: string[];
  /** Windows resolves `.cmd` shims only through the shell, so the whole line runs there. */
  shellCommandLine?: string;
  env: Record<string, string>;
}

/** An error the agent returned for a request, keeping its JSON-RPC code. */
export class AcpRequestError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly method: string) {
    super(message);
    this.name = "AcpRequestError";
  }
}

/** Splits a command line into words, honoring single and double quotes. */
export const parseAcpCommandLine = (line: string): string[] => {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  for (const character of line.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
    } else if (/\s/.test(character)) {
      if (hasWord) words.push(current);
      current = "";
      hasWord = false;
    } else {
      current += character;
      hasWord = true;
    }
  }
  if (quote) throw new Error("The ACP agent command has an unclosed quote.");
  if (hasWord) words.push(current);
  return words;
};

const ENV_ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/s;

/** Splits on separators outside double quotes; a quote that never closes is an error. */
const splitOutsideQuotes = (line: string, separator: string): string[] => {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    if (character === separator && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("An ACP environment value has an unclosed quote.");
  pieces.push(current);
  return pieces;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
};

/**
 * Parses `KEY=VALUE` pairs separated by newlines or semicolons. A piece after a semicolon that
 * does not start a new assignment belongs to the previous value, so path lists such as
 * `PATH=C:\a;C:\b` keep their semicolons. A double-quoted value is taken literally, so
 * `TOKEN="abc;part=def"` keeps a semicolon followed by something that looks like a key.
 */
export const parseAcpEnvironment = (value: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    let lastKey: string | null = null;
    for (const piece of splitOutsideQuotes(line, ";")) {
      const assignment = ENV_ASSIGNMENT.exec(piece);
      if (assignment) {
        lastKey = assignment[1]!;
        env[lastKey] = unquote(assignment[2]!);
      } else if (!piece.trim()) {
        continue;
      } else if (lastKey) {
        env[lastKey] = `${env[lastKey]};${piece.trim()}`;
      } else {
        throw new Error(`ACP environment entry "${piece.trim()}" must look like KEY=VALUE.`);
      }
    }
  }
  return env;
};

export const resolveAcpLaunch = (commandLine: string, env: Record<string, string>, platform = process.platform): AcpLaunch => {
  const words = parseAcpCommandLine(commandLine);
  if (words.length === 0) throw new Error("Configure the command that starts the ACP agent.");
  return {
    command: words[0]!,
    args: words.slice(1),
    ...(platform === "win32" ? { shellCommandLine: commandLine.trim() } : {}),
    env,
  };
};

const ACP_EXIT_WAIT_MS = 5_000;

const terminateProcessTree = (child: ChildProcessWithoutNullStreams): void => {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    // A shell-launched agent runs below cmd.exe; only a tree kill reaches it.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
};

/** Newline-delimited JSON-RPC 2.0 over an agent process's stdio, as ACP specifies. */
export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout?: NodeJS.Timeout; method: string }>();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(
    private readonly launch: AcpLaunch,
    private readonly cwd: string,
    private readonly timeoutMs = 60_000,
  ) {}

  handleRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler);
  }

  handleNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  start(): void {
    if (this.child) return;
    const env = { ...process.env, ...this.launch.env };
    const child = this.launch.shellCommandLine
      ? spawn(this.launch.shellCommandLine, { cwd: this.cwd, env, stdio: "pipe", windowsHide: true, shell: true })
      : spawn(this.launch.command, this.launch.args, { cwd: this.cwd, env, stdio: "pipe", windowsHide: true });
    this.child = child;
    // Writing to an agent that already exited emits EPIPE here; unhandled, it would crash the worker.
    child.stdin.on("error", (error) => {
      this.rejectAll(new Error(`The ACP agent stopped reading input (${error.message}). ${this.stderr.trim()}`.trim()));
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.on("error", (error) => this.rejectAll(new Error(`Could not start the ACP agent (${error.message}).`)));
    child.on("exit", (code, signal) => {
      // Later requests, notifications, and replies must not write to the closed pipe.
      if (this.child === child) this.child = null;
      this.rejectAll(new Error(`The ACP agent exited (${String(code ?? signal ?? "unknown")}). ${this.stderr.trim()}`.trim()));
    });
  }

  get diagnostics(): string {
    return this.stderr.trim();
  }

  /** Stops the agent and resolves once it exited, so its workspace can be removed right after. */
  close(): Promise<void> {
    // Every caller waits for the same exit, including one that closes again while it is pending.
    this.closing ??= (async () => {
      const child = this.child;
      this.child = null;
      this.rejectAll(new Error("The ACP agent connection closed."));
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, ACP_EXIT_WAIT_MS).unref();
      });
      terminateProcessTree(child);
      await exited;
    })();
    return this.closing;
  }

  private closing: Promise<void> | null = null;

  async request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const child = this.child;
    if (!child) throw new Error("The ACP agent is not running.");
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`The ACP agent did not answer ${method} in time.`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timeout, method });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return await promise as T;
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new AcpRequestError(message.error.message || `ACP request failed: ${pending.method}`, message.error.code, pending.method));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message);
      return;
    }
    if (message.method) {
      try {
        this.notificationHandlers.get(message.method)?.(message.params);
      } catch {
        // A malformed notification must not stop the session.
      }
    }
  }

  private async answer(message: JsonRpcMessage): Promise<void> {
    const handler = this.requestHandlers.get(message.method ?? "");
    let reply: JsonRpcMessage;
    if (!handler) {
      reply = { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method ?? ""}` } };
    } else {
      try {
        reply = { jsonrpc: "2.0", id: message.id, result: (await handler(message.params)) ?? null };
      } catch (error) {
        reply = { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
      }
    }
    this.child?.stdin.write(`${JSON.stringify(reply)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
