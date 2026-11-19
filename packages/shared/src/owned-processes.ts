/**
 * Processes that agent runs and chats start on the host (dev servers, watchers, builds, and the
 * shells around them). BuildWarden attributes each process to the run or chat whose worker spawned
 * it, keeps tracking descendants even after their parent exits, and lets users stop, kill, or
 * restart them.
 */

export type OwnedProcessOwnerKind = "run" | "chat";

export interface OwnedProcessOwner {
  kind: OwnedProcessOwnerKind;
  id: string;
}

/**
 * - `agent`: the provider CLI (and its launcher chain) that runs the conversation itself.
 * - `command`: anything the agent or a tool started, at any depth.
 * - `restarted`: a command BuildWarden started again on request; its output is captured.
 */
export type OwnedProcessRole = "agent" | "command" | "restarted";

export type OwnedProcessStatus = "running" | "stopping" | "exited";

export type OwnedProcessAttribution = "tree" | "workspace";

/** Why a process is no longer running: on its own, stopped gracefully, or killed by the user. */
export type OwnedProcessEndReason = "exited" | "stopped" | "killed";

export interface OwnedProcessRecord {
  /**
   * Stable while the process lives; survives PID reuse because it includes the start time. Host-local:
   * deliberately not named `id`, so multi-instance clients do not rewrite it like an entity ID.
   */
  processId: string;
  pid: number;
  /** Tracked parent, when the parent belongs to the same owner. */
  parentProcessId: string | null;
  owner: OwnedProcessOwner;
  role: OwnedProcessRole;
  /**
   * How the process was linked to its owner: `tree` through its parent chain, `workspace` because
   * its parent exited unseen and its command line points into the owner's workspace.
   */
  attribution: OwnedProcessAttribution;
  /** Executable name, such as `node.exe` or `pnpm`. */
  name: string;
  /** Full command line; null when the operating system does not reveal it. */
  commandLine: string | null;
  /** Working directory, when BuildWarden knows it (restarted processes). */
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  status: OwnedProcessStatus;
  endReason: OwnedProcessEndReason | null;
  /** Known only for processes BuildWarden started itself. */
  exitCode: number | null;
  /** Share of total CPU capacity over the last sample interval. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  /** TCP ports the process listens on. */
  ports: number[];
  /** The process this one replaced through a restart. */
  restartOfProcessId: string | null;
  /** Whether BuildWarden can start the same command line again. */
  restartable: boolean;
  /** Whether captured output is available (restarted processes). */
  hasOutput: boolean;
}

export interface OwnedProcessesSnapshot {
  owner: OwnedProcessOwner;
  /** False on hosts where process inspection is unavailable. */
  supported: boolean;
  processes: OwnedProcessRecord[];
  updatedAt: string;
}

export type OwnedProcessAction = "stop" | "kill" | "restart";
export type OwnedProcessBulkAction = "stop-all" | "kill-all" | "clear-exited";

export type ManageOwnedProcessesInput =
  | { owner: OwnedProcessOwner; action: OwnedProcessAction; processId: string }
  | { owner: OwnedProcessOwner; action: OwnedProcessBulkAction };

export interface OwnedProcessOutput {
  processId: string;
  text: string;
  /** True when older output was dropped to keep the buffer bounded. */
  truncated: boolean;
}

export const isOwnedProcessOwner = (value: unknown): value is OwnedProcessOwner => {
  if (!value || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return (owner.kind === "run" || owner.kind === "chat") && typeof owner.id === "string" && owner.id.length > 0;
};

const OWNED_PROCESS_ACTIONS = new Set<string>(["stop", "kill", "restart", "stop-all", "kill-all", "clear-exited"]);

export const isManageOwnedProcessesInput = (value: unknown): value is ManageOwnedProcessesInput => {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (!isOwnedProcessOwner(input.owner) || typeof input.action !== "string" || !OWNED_PROCESS_ACTIONS.has(input.action)) return false;
  if (input.action === "stop" || input.action === "kill" || input.action === "restart") {
    return typeof input.processId === "string" && input.processId.length > 0;
  }
  return true;
};

export const ownedProcessOwnerKey = (owner: OwnedProcessOwner): string => `${owner.kind}:${owner.id}`;

const LAUNCHER_PROCESS_NAMES = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "pwsh", "sh", "bash", "bash.exe", "sh.exe", "zsh", "dash"]);
const AGENT_EXECUTABLE = /^(codex|claude|cursor-agent)([-._ ]|$)/i;
const AGENT_PACKAGE_PATH = /[\\/](@anthropic-ai[\\/]claude-(code|agent-sdk)|@openai[\\/]codex|cursor-agent)[\\/]/i;

const pathBasename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Shells that launch an agent CLI (`shell: true`, npm `.cmd` shims) rather than run agent commands. */
export const isLauncherProcessName = (name: string): boolean => LAUNCHER_PROCESS_NAMES.has(pathBasename(name).toLowerCase());

/** The first tokens of a command line, honouring double quotes. */
export const commandLineHead = (commandLine: string | null, count: number): string[] => {
  if (!commandLine) return [];
  const tokens: string[] = [];
  for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? "");
    if (tokens.length >= count) break;
  }
  return tokens;
};

/** Whether a process is (part of) a known agent CLI, judged by its executable and script only. */
export const looksLikeAgentProcess = (entry: { name: string; commandLine: string | null }): boolean => {
  const candidates = [entry.name, ...commandLineHead(entry.commandLine, 2)];
  return candidates.some((candidate) => AGENT_EXECUTABLE.test(pathBasename(candidate)) || AGENT_PACKAGE_PATH.test(candidate));
};

const REDACTED = "•••";
const SECRET_WORD = "(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credentials?|authorization|auth)";
/** A double- or single-quoted value (escaped characters included) or a bare word. */
const QUOTED_OR_BARE_VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"']+`;
/**
 * Patterns for one command-line string. With `joined`, the string is arguments joined by spaces
 * without quoting (`ps args` on Linux and macOS): where a secret value ends is unknown, so
 * everything after a secret option, assignment or `-u user:` is hidden, line breaks included (a
 * shell's `-c` script can span lines).
 */
const commandLineRedactions = (joined: boolean): Array<[RegExp, string]> => {
  const value = joined ? "[\\s\\S]*" : QUOTED_OR_BARE_VALUE;
  return [
    // https://user:password@host
    [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`],
    // curl -u user:password, --user=user:password, --proxy-user, -U (also attached: -uuser:password).
    // Joined, a quote is part of the value rather than its end, so everything after `user:` goes.
    ...(joined
      ? [[/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s+|(?=[^\s-]))["']?[^\s:"']*):[\s\S]*/g, `$1:${REDACTED}`] as [RegExp, string]]
      : [
        [/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s+)?(["'])[^\s:"']*):(?:(?!\2)[^\\]|\\.)*\2/g, `$1:${REDACTED}$2`] as [RegExp, string],
        [/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s+|(?=[^\s"'-]))[^\s:"']*):[^\s"']+/g, `$1:${REDACTED}`] as [RegExp, string],
      ]),
    // Authorization header values.
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
    // JSON keys, possibly with escaped quotes inside a quoted argument: "apiKey":"…"
    [new RegExp(`(\\\\?"[^"\\\\\\s]*${SECRET_WORD}[^"\\\\\\s]*\\\\?"\\s*:\\s*)\\\\?"[^"\\\\]*\\\\?"`, "gi"), `$1"${REDACTED}"`],
    // --api-key=… / --token … / -p …password options. Quoted values may contain escaped quotes.
    [new RegExp(`((?:^|\\s)--?[\\w-]*${SECRET_WORD}[\\w-]*)(=|\\s+)(${value})`, "gi"), `$1$2${REDACTED}`],
    // GITHUB_TOKEN=… / Authorization=… assignments.
    [new RegExp(`(\\b[\\w-]*${SECRET_WORD}[\\w-]*=)(${value})`, "gi"), `$1${REDACTED}`],
    // Well-known token shapes wherever they appear.
    [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, REDACTED],
  ];
};
const QUOTED_REDACTIONS = commandLineRedactions(false);
const JOINED_REDACTIONS = commandLineRedactions(true);

/**
 * Hides credentials a command line may carry (tokens in options, MCP auth headers in an agent's
 * arguments, passwords in URLs) before it leaves the host process registry. The host keeps the
 * full command line for restarts. Pass `joinedArguments` for a string that lost its argument
 * boundaries; {@link redactArgv} is exact when the argument list is known.
 */
export const redactCommandLine = (commandLine: string, options: { joinedArguments?: boolean } = {}): string =>
  (options.joinedArguments ? JOINED_REDACTIONS : QUOTED_REDACTIONS)
    .reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), commandLine);

const SECRET_OPTION_ARGUMENT = new RegExp(`^(--?[\\w-]*${SECRET_WORD}[\\w-]*)(=[\\s\\S]*)?$`, "i");
const SECRET_ASSIGNMENT_ARGUMENT = new RegExp(`^([\\w-]*${SECRET_WORD}[\\w-]*=)[\\s\\S]*$`, "i");
const USER_OPTION_ARGUMENT = /^(-u|-U|--user|--proxy-user)(=?)([\s\S]*)$/;

const redactUserValue = (value: string): string => {
  const colon = value.indexOf(":");
  return colon < 0 ? value : `${value.slice(0, colon + 1)}${REDACTED}`;
};

const quoteArgument = (argument: string): string =>
  argument && !/[\s"'\\]/.test(argument) ? argument : `"${argument.replace(/(["\\])/g, "\\$1")}"`;

/**
 * Redacts an exact argument list and renders it as one command line. Each secret value is hidden
 * whole, spaces included: the argument after a secret-named option, the value of `--token=…` or
 * `NAME_TOKEN=…`, the password of `-u user:password`. Every other argument gets the string
 * patterns as one that lost its boundaries, since a shell's `-c` script holds a whole command.
 */
export const redactArgv = (argv: readonly string[]): string => {
  const rendered: string[] = [];
  let next: "secret" | "user" | null = null;
  for (const argument of argv) {
    if (next === "secret") {
      rendered.push(REDACTED);
      next = null;
      continue;
    }
    if (next === "user") {
      rendered.push(quoteArgument(redactUserValue(argument)));
      next = null;
      continue;
    }
    const option = SECRET_OPTION_ARGUMENT.exec(argument);
    if (option) {
      if (option[2] === undefined) next = "secret";
      rendered.push(option[2] === undefined ? argument : `${option[1] ?? ""}=${REDACTED}`);
      continue;
    }
    const assignment = SECRET_ASSIGNMENT_ARGUMENT.exec(argument);
    if (assignment) {
      rendered.push(`${assignment[1] ?? ""}${REDACTED}`);
      continue;
    }
    const user = USER_OPTION_ARGUMENT.exec(argument);
    if (user) {
      if (!user[2] && !user[3]) next = "user";
      rendered.push(quoteArgument(`${user[1] ?? ""}${user[2] ?? ""}${redactUserValue(user[3] ?? "")}`));
      continue;
    }
    rendered.push(quoteArgument(redactCommandLine(argument, { joinedArguments: true })));
  }
  return rendered.join(" ");
};

const AGENT_PROCESS_REGISTRY = Symbol.for("buildwarden.agentProcesses");

const agentProcesses = (): WeakSet<object> => {
  const holder = globalThis as typeof globalThis & { [AGENT_PROCESS_REGISTRY]?: WeakSet<object> };
  holder[AGENT_PROCESS_REGISTRY] ??= new WeakSet<object>();
  return holder[AGENT_PROCESS_REGISTRY];
};

/**
 * Providers call this right after spawning the CLI that runs the conversation, so the process
 * panel can tell the agent apart from the commands it starts. Stored per thread on globalThis so
 * every bundled copy of this module shares it.
 */
export const markAgentProcess = <T extends object>(child: T): T => {
  agentProcesses().add(child);
  return child;
};

export const isMarkedAgentProcess = (child: object): boolean => agentProcesses().has(child);
