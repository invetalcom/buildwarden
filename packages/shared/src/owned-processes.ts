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
const COMMAND_LINE_REDACTIONS: Array<[RegExp, string]> = [
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // JSON keys, possibly with escaped quotes inside a quoted argument: "apiKey":"…"
  [new RegExp(`(\\\\?"[^"\\\\\\s]*${SECRET_WORD}[^"\\\\\\s]*\\\\?"\\s*:\\s*)\\\\?"[^"\\\\]*\\\\?"`, "gi"), `$1"${REDACTED}"`],
  // --api-key=… / --token … / -p …password options.
  [new RegExp(`(\\s--?[\\w-]*${SECRET_WORD}[\\w-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), `$1$2${REDACTED}`],
  // GITHUB_TOKEN=… / Authorization=… assignments.
  [new RegExp(`(\\b[\\w-]*${SECRET_WORD}[\\w-]*=)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), `$1${REDACTED}`],
  // Well-known token shapes wherever they appear.
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, REDACTED],
];

/**
 * Hides credentials a command line may carry (tokens in options, MCP auth headers in an agent's
 * arguments, passwords in URLs) before it leaves the host process registry. The host keeps the
 * full command line for restarts.
 */
export const redactCommandLine = (commandLine: string): string =>
  COMMAND_LINE_REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), commandLine);

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
