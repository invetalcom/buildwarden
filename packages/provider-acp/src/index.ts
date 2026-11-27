import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  acpStdioRelayServer,
  preflightRequiredMcpServers,
  resolveMcpStdioRelayLaunch,
  sessionInstructionPrompt,
  startHarnessMcp,
  type McpStdioRelayLaunch,
} from "@buildwarden/agent-runtime";
import {
  ACP_DEFAULT_MODEL_ID,
  acpToolApprovalKey,
  buildExecutedModelChunk,
  formatRunPlanProgressContent,
  normalizeRunPlanProgressPayload,
  PROVIDER_CONFIG_ACP_COMMAND_KEY,
  PROVIDER_CONFIG_ACP_ENV_KEY,
  PROVIDER_CONFIG_ACP_SESSION_OPTIONS_KEY,
  PROVIDER_CONFIG_ACP_AUTH_METHOD_KEY,
  RESPONSE_PRESENTATION_INSTRUCTIONS,
  type HarnessAdapter,
  type HarnessRunChunk,
  type HarnessSessionCapabilities,
  type HarnessToolContext,
  type ProviderAccountInput,
  type ProviderAdapter,
  type ProviderAvailableModel,
  type ProviderAvailableModelsContext,
  type RunExecutionRequest,
  type ApprovalRequester,
  type RunTokenUsage,
  type RunUserInputAnswers,
  type RunUserInputRequest,
} from "@buildwarden/shared";
import { AcpConnection, AcpRequestError, parseAcpEnvironment, resolveAcpLaunch, type AcpLaunch } from "./connection";

export { AcpConnection, AcpRequestError, parseAcpCommandLine, parseAcpEnvironment, resolveAcpLaunch } from "./connection";

import { AcpSessionSettings } from "./session-settings";
import { AcpTerminals, type AcpTerminalSnapshot } from "./terminals";
import { readElicitationForm } from "./elicitation";
import { applyAcpSessionSettings } from "./session-apply";

export { readElicitationForm } from "./elicitation";

export { AcpTerminals, terminalCommandLine } from "./terminals";

export { ACP_DEFAULT_MODEL_ID };
const ACP_PROTOCOL_VERSION = 1;
const ACP_INITIALIZE_TIMEOUT_MS = 60_000;
/** Reloading replays the whole transcript, so it may take a while, but never forever. */
const ACP_SESSION_LOAD_TIMEOUT_MS = 5 * 60_000;
const ACP_MAX_READ_CHARS = 2_000_000;
const ACP_CANCEL_GRACE_MS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export const resolveAcpConfig = (config: Record<string, unknown> | undefined): AcpLaunch => {
  const command = asString(config?.[PROVIDER_CONFIG_ACP_COMMAND_KEY])?.trim() ?? "";
  if (!command) throw new Error("Configure the command that starts the ACP agent, for example `gemini --experimental-acp`.");
  return resolveAcpLaunch(command, parseAcpEnvironment(asString(config?.[PROVIDER_CONFIG_ACP_ENV_KEY]) ?? ""));
};

interface AcpAgentCapabilities {
  authMethods: Array<{ id: string; name: string }>;
  loadSession: boolean;
  /** `session/resume`: reopens a session without replaying it. */
  resumeSession: boolean;
  /** `session/fork` (unstable in ACP): a new session that starts with a copy of another's history. */
  forkSession: boolean;
  /** `session/list`: the sessions the agent saved, so they can be imported. */
  listSessions: boolean;
  mcpHttp: boolean;
  promptImages: boolean;
  agentName?: string;
  agentVersion?: string;
}

const readAgentCapabilities = (initialization: unknown): AcpAgentCapabilities => {
  const result = isRecord(initialization) ? initialization : {};
  const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
  const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
  const prompt = isRecord(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
  // ACP advertises these as objects; omitted or null means unsupported.
  const session = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
  const info = isRecord(result.agentInfo) ? result.agentInfo : {};
  return {
    authMethods: Array.isArray(result.authMethods) ? result.authMethods.filter(isRecord).flatMap((method) =>
      typeof method.id === "string" && typeof method.name === "string" && (method.type === undefined || method.type === "agent")
        ? [{ id: method.id, name: method.name }] : []) : [],
    loadSession: capabilities.loadSession === true,
    resumeSession: isRecord(session.resume),
    forkSession: isRecord(session.fork),
    listSessions: isRecord(session.list),
    mcpHttp: mcp.http === true,
    promptImages: prompt.image === true,
    ...(asString(info.title) ?? asString(info.name) ? { agentName: asString(info.title) ?? asString(info.name) } : {}),
    ...(asString(info.version) ? { agentVersion: asString(info.version) } : {}),
  };
};

/**
 * The session capability report BuildWarden keeps for the agent's provider. `mcpHttp` says whether
 * the agent reaches BuildWarden's HTTP MCP servers, natively or through the stdio relay.
 */
const acpSessionCapabilities = (agent: AcpAgentCapabilities, stdioRelay = false): HarnessSessionCapabilities => ({
  reportedAt: new Date().toISOString(),
  ...(agent.agentName ? { agentName: agent.agentName } : {}),
  ...(agent.agentVersion ? { agentVersion: agent.agentVersion } : {}),
  mcpHttp: agent.mcpHttp || stdioRelay,
  sessionResume: agent.loadSession || agent.resumeSession,
  sessionFork: agent.forkSession,
  sessionList: agent.listSessions,
  authMethods: agent.authMethods,
});

/** Advertises only the file access this connection serves; the agent relies on what it is told. */
const initializeAgent = async (
  connection: AcpConnection,
  access: { read: boolean; write: boolean; terminal?: boolean; elicitation?: boolean },
  config?: Record<string, unknown>,
) => {
  const initialized = await connection.request("initialize", {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: access.read, writeTextFile: access.write },
    terminal: access.terminal === true,
    // Form elicitation only: BuildWarden opens no links on an agent's behalf.
    ...(access.elicitation ? { elicitation: { form: {} } } : {}),
  },
  clientInfo: { name: "buildwarden", title: "BuildWarden", version: "1.0.0" },
}, ACP_INITIALIZE_TIMEOUT_MS);
  const methodId = config?.[PROVIDER_CONFIG_ACP_AUTH_METHOD_KEY];
  if (methodId !== undefined && methodId !== "") {
    const methods = readAgentCapabilities(initialized).authMethods;
    if (typeof methodId !== "string" || !methods.some((method) => method.id === methodId)) {
      throw new Error(`The ACP agent does not advertise login method ${String(methodId)}. Available agent login methods: ${methods.map((method) => method.id).join(", ") || "none"}.`);
    }
    await connection.request("authenticate", { methodId }, ACP_SESSION_LOAD_TIMEOUT_MS);
  }
  return initialized;
};

/** Resolves an agent-supplied path and refuses anything outside the run's workspace. */
export const resolveWorkspacePath = async (workspace: string, requested: unknown, allowMissing = false): Promise<string> => {
  if (typeof requested !== "string" || !requested) throw new Error("A file path is required.");
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const assertContained = (base: string, path: string) => {
    const offset = relative(base, path);
    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
      throw new Error("The ACP agent may only access files inside the run workspace.");
    }
  };
  assertContained(root, target);
  const canonicalRoot = await realpath(root);
  let existing = target;
  const missing: string[] = [];
  // lstat distinguishes missing components from dangling links, which must not be followed.
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const canonicalParent = await realpath(existing);
  assertContained(canonicalRoot, canonicalParent);
  return resolve(canonicalParent, ...missing);
};

const httpHeaders = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));

const promptBlocks = (input: RunExecutionRequest, images: boolean): Array<Record<string, unknown>> => {
  const textAttachments: string[] = [];
  const imageBlocks: Array<Record<string, unknown>> = [];
  for (const attachment of input.attachments ?? []) {
    if (images && attachment.mimeType.startsWith("image/")) {
      imageBlocks.push({ type: "image", mimeType: attachment.mimeType, data: attachment.dataBase64 });
    } else if (attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/json") {
      textAttachments.push(`--- ${attachment.fileName} ---\n${Buffer.from(attachment.dataBase64, "base64").toString("utf8").slice(0, 80_000)}`);
    } else {
      textAttachments.push(`[Attached file: ${attachment.fileName} (${attachment.mimeType}) is not expanded for this agent.]`);
    }
  }
  const modeNote = input.mode === "code"
    ? ""
    : "This is an inspect-only turn: do not modify files or run commands that change state.";
  // ACP has no instruction channel: the run worker already put BuildWarden's policy in the prompt.
  const text = [
    input.repoContext?.trim() ? `<context>\n${input.repoContext.trim()}\n</context>` : "",
    modeNote,
    textAttachments.length ? `<attachments>\n${textAttachments.join("\n\n")}\n</attachments>` : "",
    input.prompt,
  ].filter(Boolean).join("\n\n");
  return [{ type: "text", text }, ...imageBlocks];
};

const permissionOutcome = (optionId: string | undefined) =>
  optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };

const pickPermissionOption = (params: Record<string, unknown>, kinds: readonly string[]): string | undefined => {
  const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind && typeof option.optionId === "string");
    if (match) return match.optionId as string;
  }
  return undefined;
};

const toolCallCommand = (toolCall: Record<string, unknown>): string | undefined => {
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  return asString(rawInput.command) ?? (Array.isArray(rawInput.command) ? rawInput.command.map(String).join(" ") : undefined);
};

const toolCallPaths = (toolCall: Record<string, unknown>): string[] =>
  (Array.isArray(toolCall.locations) ? toolCall.locations.filter(isRecord) : []).flatMap((location) => {
    const path = asString(location.path);
    return path ? [path] : [];
  });

/** The tool call as the user sees it: its title, plus the command it runs or the files it touches. */
const describeToolCall = (toolCall: Record<string, unknown>): string => {
  const title = asString(toolCall.title) ?? asString(toolCall.kind) ?? "tool";
  const command = toolCallCommand(toolCall);
  if (command) return `${title}: ${command}`;
  const paths = toolCallPaths(toolCall);
  return paths.length > 0 ? `${title} (${paths.join(", ")})` : title;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/**
 * What a run-wide or permanent approval of a tool call covers. ACP gives tools no stable identity
 * and agents reuse titles such as "Edit file" for unrelated actions, so it is the specific action:
 * the command, else the files touched, else a hash of the exact input. A call with none of these
 * has nothing specific to remember and returns null, so it can only be allowed once.
 */
const toolCallApprovalIdentity = (toolCall: Record<string, unknown>): string | null => {
  if (toolCallCommand(toolCall) || toolCallPaths(toolCall).length > 0) return describeToolCall(toolCall);
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  if (Object.keys(rawInput).length === 0) return null;
  return `${describeToolCall(toolCall)} #${createHash("sha256").update(stableJson(rawInput)).digest("hex").slice(0, 16)}`;
};

/** Terminal output shown in a tool step; the agent receives the whole buffer through terminal/output. */
const MAX_TERMINAL_STEP_CHARS = 16_000;

const terminalStepText = (terminal: AcpTerminalSnapshot): string => {
  const output = terminal.output.length > MAX_TERMINAL_STEP_CHARS
    ? `…${terminal.output.slice(-MAX_TERMINAL_STEP_CHARS)}`
    : terminal.output;
  const status = terminal.exitStatus
    ? `\n[exit ${terminal.exitStatus.exitCode ?? terminal.exitStatus.signal ?? "?"}]`
    : "";
  return `$ ${terminal.commandLine}\n${output.trimEnd() || "(waiting for output…)"}${status}`;
};

/** The terminals a tool call's content embeds. */
const toolTerminalIds = (content: unknown): string[] =>
  Array.isArray(content)
    ? content.filter(isRecord).flatMap((entry) => (entry.type === "terminal" && typeof entry.terminalId === "string" ? [entry.terminalId] : []))
    : [];

const toolContentText = (content: unknown, terminal?: (terminalId: string) => AcpTerminalSnapshot | null): string => {
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).map((entry) => {
    if (entry.type === "content" && isRecord(entry.content) && typeof entry.content.text === "string") return entry.content.text;
    if (entry.type === "diff" && typeof entry.path === "string") return `Edited ${entry.path}`;
    if (entry.type === "terminal" && typeof entry.terminalId === "string") {
      const snapshot = terminal?.(entry.terminalId);
      return snapshot ? terminalStepText(snapshot) : "";
    }
    return "";
  }).filter(Boolean).join("\n");
};

/**
 * ACP execution arguments are agent-specific, so only clearly inspect-only kinds are permitted.
 * BuildWarden rejects every other kind in an inspect turn, so an agent that runs one without
 * BuildWarden's approval bypassed that answer. That includes `other` (and a missing kind, which
 * ACP treats as `other`): agents label MCP calls and custom tools that way.
 */
const INSPECT_TOOL_KINDS = new Set(["read", "search", "think"]);

const BRIDGE_SERVER_PREFIX = "buildwarden-";

/** Whether a title qualifies the tool name before or after it with a server other than the bridge. */
const namesOtherServer = (before: string, after: string, serverName: string): boolean => {
  const prefixed = /mcp__([A-Za-z0-9_-]+?)__$/.exec(before)?.[1] ?? /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]+)[/.]$/.exec(before)?.[1];
  if (prefixed !== undefined && prefixed.toLowerCase() !== serverName) return true;
  const suffixed = /^\s*\(([^()]+?)\s+MCP Server\)/i.exec(after)?.[1];
  return suffixed !== undefined && suffixed.trim().toLowerCase() !== serverName;
};

/**
 * The BuildWarden tool a call's title names, if any. BuildWarden's own tools reach the agent
 * through the run's MCP bridge, and BuildWarden runs them itself under its own rules, so calling
 * one is not a bypass of the inspect-only answer. Agents label MCP calls `other` (or leave the
 * kind out), and title them differently (`name`, `mcp__server__name`, `name (server MCP Server)`),
 * so the name may appear anywhere in the title, as a whole token. A name the title places on another
 * server (`mcp__other__name`, `other/name`, `other.name`, `name (other MCP Server)`) is that server's
 * tool. A title that names no server cannot be told apart from the bridge's by its text, so it
 * matches, and the bridge ledger decides. A call of any other kind is never one, whatever its
 * title says: an `execute` or `edit` title holds the command or path.
 *
 * The title is the agent's own text, so a match is only a claim: a call counts as BuildWarden's
 * only once the bridge itself has received a call to that tool.
 */
const bridgeToolNameOf = (toolCall: Record<string, unknown>, bridgeToolNames: readonly string[], serverName: string, requireQualified = false): string | null => {
  const kind = asString(toolCall.kind) ?? "other";
  const title = asString(toolCall.title);
  if (kind !== "other" || !title) return null;
  for (const name of bridgeToolNames) {
    for (let index = title.indexOf(name); index >= 0; index = title.indexOf(name, index + 1)) {
      const before = title.slice(0, index);
      const startsToken = before === "" || /[^A-Za-z0-9_]$/.test(before) || before.endsWith("__");
      const after = title.slice(index + name.length);
      const qualified = before.endsWith('mcp__' + serverName + '__') || before.endsWith(serverName + '/') || before.endsWith(serverName + '.')
        || after.toLowerCase().startsWith(' (' + serverName + ' mcp server)');
      if (startsToken && !/^[A-Za-z0-9_]/.test(after) && !namesOtherServer(before, after, serverName) && (!requireQualified || qualified)) return name;
    }
  }
  return null;
};

/**
 * Matches the agent's tool calls that claim to be BuildWarden tools against the calls the run's
 * bridge actually received. Each received call vouches for one agent call to the same tool, so a
 * look-alike tool on another MCP server cannot ride on a real bridge call.
 */
class BridgeCallLedger {
  private readonly unclaimed = new Map<string, number>();
  private readonly claimed = new Set<string>();

  /** Called by the bridge when it receives a call. */
  received(toolName: string): void {
    this.unclaimed.set(toolName, (this.unclaimed.get(toolName) ?? 0) + 1);
  }

  /** Whether the agent's call `toolCallId` to `toolName` is backed by a call the bridge received. */
  claim(toolCallId: string, toolName: string): boolean {
    if (this.claimed.has(toolCallId)) return true;
    const count = this.unclaimed.get(toolName) ?? 0;
    if (count === 0) return false;
    this.unclaimed.set(toolName, count - 1);
    this.claimed.add(toolCallId);
    return true;
  }
}

export interface AcpHarnessOptions {
  /** How to start the stdio MCP relay; read from the environment by default. */
  resolveStdioRelay?: () => McpStdioRelayLaunch | null;
  /**
   * BuildWarden's shell policy (operators, allowlist, approval) for commands the agent runs in
   * BuildWarden's terminals. Throws when a command may not run. Without it, every command needs
   * the user's approval.
   */
  authorizeShellCommand?: (commandLine: string, options: { yoloMode: boolean }) => Promise<void>;
  /** The environment terminals start with. */
  shellEnv?: NodeJS.ProcessEnv;
  /** Asks the user the questions of an agent's form elicitation. Without it, BuildWarden advertises none. */
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
}

/** The command of an execute call BuildWarden approved: as the user saw it, and as separate words when the agent sent them so. */
interface ApprovedCommand { text: string; argv: string[] | null }

const approvedCommandOf = (toolCall: Record<string, unknown>): ApprovedCommand | null => {
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  if (Array.isArray(rawInput.command) && rawInput.command.length > 0 && rawInput.command.every((word) => typeof word === "string")) {
    const argv = rawInput.command as string[];
    return { text: argv.join(" "), argv };
  }
  const text = asString(rawInput.command)?.trim();
  return text ? { text, argv: null } : null;
};

/** Words joined with spaces read back the same only when no word holds whitespace. */
const joinsUnambiguously = (words: readonly string[]): boolean => words.every((word) => word.length > 0 && !/\s/.test(word));

/**
 * Whether a terminal request runs exactly the command the user approved. Shell source compares as
 * text, exactly: spacing inside quotes changes what runs. An executable with arguments compares
 * word by word, or with the line BuildWarden shows for it, or with its words joined as the agent
 * showed them when that joining cannot hide an argument boundary.
 */
const runsApprovedCommand = (approved: ApprovedCommand, commandLine: string, request: { command: string; args: string[] }): boolean => {
  if (request.args.length === 0) {
    const source = request.command.trim();
    return approved.argv ? joinsUnambiguously(approved.argv) && approved.text === source : approved.text === source;
  }
  const argv = [request.command, ...request.args];
  if (approved.argv) return approved.argv.length === argv.length && approved.argv.every((word, index) => word === argv[index]);
  return approved.text === commandLine.trim() || (joinsUnambiguously(argv) && approved.text === argv.join(" "));
};

const fallbackContextBlock = (context: string) =>
  `<earlier_conversation>\nThe agent could not reload its saved session, so this is the conversation so far.\n${context}\n</earlier_conversation>`;

export class AcpHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "acp" as const;

  private readonly resolveStdioRelay: () => McpStdioRelayLaunch | null;

  constructor(
    private readonly requestShellApproval?: ApprovalRequester,
    private readonly options: AcpHarnessOptions = {},
  ) {
    this.resolveStdioRelay = options.resolveStdioRelay ?? resolveMcpStdioRelayLaunch;
  }

  /** BuildWarden's shell policy for a command the agent runs in one of BuildWarden's terminals. */
  private async authorizeCommand(commandLine: string, yoloMode: boolean): Promise<void> {
    if (this.options.authorizeShellCommand) {
      await this.options.authorizeShellCommand(commandLine, { yoloMode });
      return;
    }
    if (yoloMode) return;
    if (!this.requestShellApproval || await this.requestShellApproval(commandLine) === "deny") {
      throw new Error(`Command was denied by the user: ${commandLine}`);
    }
  }

  async run(
    input: RunExecutionRequest,
    toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): ReturnType<HarnessAdapter["run"]> {
    const launch = resolveAcpConfig(input.config);
    const connection = new AcpConnection(launch, input.worktreePath);
    const writable = input.mode === "code";
    let bridge: Awaited<ReturnType<typeof startHarnessMcp>> = null;
    let sessionId: string | null = null;
    let settingsSessionId: string | null = null;
    let replaying = false;
    let messageIndex = 0;
    let messageText = "";
    let thoughtIndex = 0;
    let thoughtText = "";
    let summary = "";
    const settings = new AcpSessionSettings();
    /** Tool calls BuildWarden approved in this turn. Asking is not approval: an agent may run a tool after a rejection. */
    const grantedToolCalls = new Set<string>();
    let readOnlyViolation: string | null = null;
    const tools = new Map<string, Record<string, unknown>>();
    /**
     * The tools the run's bridge serves, and so the only names a BuildWarden call can have. The
     * run's other tools (`read_file`, `write_file`, `run_shell`…) are never served to an ACP agent,
     * so an agent tool with one of those names belongs to someone else.
     */
    let bridgeToolNames: string[] = [];
    const bridgeServerName = BRIDGE_SERVER_PREFIX + randomUUID();
    const bridgeCalls = new BridgeCallLedger();
    /** Calls titled as BuildWarden tools that ran, but that the bridge has not vouched for yet. */
    const unverifiedBridgeCalls = new Map<string, { toolName: string; state: Record<string, unknown> }>();
    // Full Access never reaches past an inspect-only turn: its commands keep the allowlist and approvals.
    const shellYolo = input.yoloMode === true && writable;
    /** Commands of execute calls BuildWarden approved this turn; the terminal that runs one is not asked about again. */
    const approvedCommands: ApprovedCommand[] = [];
    /** Each BuildWarden terminal and the tool call that shows it. */
    const terminalToolCalls = new Map<string, string>();
    const toolEmitTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let emitToolChunk: (id: string) => void = () => undefined;
    const scheduleToolEmit = (id: string) => {
      if (toolEmitTimers.has(id)) return;
      toolEmitTimers.set(id, setTimeout(() => {
        toolEmitTimers.delete(id);
        emitToolChunk(id);
      }, 150));
    };
    const terminals = new AcpTerminals({
      workspace: input.worktreePath,
      resolveCwd: (requested) => resolveWorkspacePath(input.worktreePath, requested),
      ...(this.options.shellEnv ? { env: this.options.shellEnv } : {}),
      authorize: async (commandLine, request) => {
        const approved = approvedCommands.findIndex((command) => runsApprovedCommand(command, commandLine, request));
        if (approved >= 0) {
          approvedCommands.splice(approved, 1);
          return;
        }
        await this.authorizeCommand(commandLine, shellYolo);
      },
      onOutput: (terminalId) => {
        const toolCallId = terminalToolCalls.get(terminalId);
        if (toolCallId) scheduleToolEmit(toolCallId);
      },
    });
    const readOnlyViolationMessage = (toolCall: Record<string, unknown>) =>
      `The ACP agent ran "${describeToolCall(toolCall)}" without BuildWarden's permission in an inspect-only turn. BuildWarden stopped the turn; configure the agent to ask before edits, commands and MCP tools.`;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    /** Cancels the turn, and closes the connection if the agent does not stop in time. */
    const cancelTurn = () => {
      // Before a session exists there is nothing to cancel, so stopping the agent ends the run.
      if (!sessionId) {
        void connection.close();
        return;
      }
      connection.notify("session/cancel", { sessionId });
      // ACP cancellation is cooperative. A stalled agent must not keep the worker occupied, and an
      // agent that already ignored a rejection must not keep changing things.
      cancelTimer ??= setTimeout(() => { void connection.close(); }, ACP_CANCEL_GRACE_MS);
    };
    const onAbort = () => cancelTurn();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      connection.start();
      const requestUserInput = this.options.requestUserInput;
      const agent = readAgentCapabilities(await initializeAgent(connection, {
        read: true, write: writable, terminal: true, elicitation: Boolean(requestUserInput),
      }, input.config));
      // Read once, so the reported support and the transport chosen below agree.
      const stdioRelay = this.resolveStdioRelay();
      onChunk({
        type: "status",
        title: "ACP session capabilities",
        value: `${agent.agentName ?? "ACP agent"}${agent.agentVersion ? ` ${agent.agentVersion}` : ""} connected.`,
        metadata: { silent: true, sessionCapabilities: acpSessionCapabilities(agent, Boolean(stdioRelay)) },
      });

      const mcpServers: Array<Record<string, unknown>> = [];
      const wantsMcp = toolContext.tools.some((tool) => tool.name.startsWith("buildwarden_")) || Boolean(input.mcpServers?.length);
      // ACP requires stdio MCP support and leaves HTTP optional, so an agent without HTTP gets
      // the same servers through BuildWarden's stdio relay.
      const relay = agent.mcpHttp ? null : stdioRelay;
      if (wantsMcp && (agent.mcpHttp || relay)) {
        // The agent connects to project servers itself and reports nothing back, so a required
        // server is checked from here before the session starts.
        await preflightRequiredMcpServers(input.mcpServers ?? [], { signal });
        bridge = await startHarnessMcp(toolContext, (toolName) => bridgeCalls.received(toolName));
        if (bridge) bridgeToolNames = toolContext.tools.map((tool) => tool.name).filter((name) => name.startsWith("buildwarden_"));
        const servers = [
          ...(bridge ? [{ name: bridgeServerName, url: bridge.url, headers: bridge.headers }] : []),
          ...(input.mcpServers ?? []).map((server) => ({ name: server.name, url: server.url, headers: server.headers })),
        ];
        for (const server of servers) {
          mcpServers.push(relay
            ? { ...acpStdioRelayServer(relay, server.name, server) }
            : { type: "http", name: server.name, url: server.url, headers: httpHeaders(server.headers) });
        }
      } else if (wantsMcp) {
        const required = (input.mcpServers ?? []).filter((server) => server.required === true).map((server) => server.name);
        if (required.length > 0) {
          throw new Error(`This agent does not accept HTTP MCP servers, so the required project MCP server${required.length === 1 ? "" : "s"} ${required.join(", ")} cannot be used.`);
        }
        onChunk({
          type: "error",
          title: "ACP agent",
          value: "This agent does not accept HTTP MCP servers, so BuildWarden orchestration tools and project MCP servers are unavailable in this run.",
        });
      }

      connection.handleRequest("session/request_permission", async (raw) => {
        if (signal.aborted) return permissionOutcome(undefined);
        const params = isRecord(raw) ? raw : {};
        const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
        const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
        const known = toolCallId ? tools.get(toolCallId) : undefined;
        const kind = asString(toolCall.kind) ?? asString(known?.kind);
        const merged = { ...known, ...toolCall };
        if (!writable && (!kind || !INSPECT_TOOL_KINDS.has(kind))) {
          // Only a title qualified with this session's unique bridge name is eligible. Bare names
          // are ambiguous and denied before execution. The name disambiguates servers; the
          // authenticated bridge ledger still verifies execution. The approval is not recorded
          // as a grant: the call still has to reach the bridge, or the turn is stopped.
          if (bridgeToolNameOf(merged, bridgeToolNames, bridgeServerName, true)) {
            const allowOnce = pickPermissionOption(params, ["allow_once"]);
            if (allowOnce) return permissionOutcome(allowOnce);
          }
          // A command gets the same shell policy as run_shell in an inspect turn: allowlisted
          // commands run, others need the user's approval.
          const command = kind === "execute" ? toolCallCommand(merged) : undefined;
          const allowOnce = pickPermissionOption(params, ["allow_once"]);
          if (command && allowOnce && toolCallId) {
            try {
              await this.authorizeCommand(command, false);
            } catch {
              return permissionOutcome(pickPermissionOption(params, ["reject_once", "reject_always"]));
            }
            if (signal.aborted) return permissionOutcome(undefined);
            grantedToolCalls.add(toolCallId);
            const approvedCommand = approvedCommandOf(merged);
            if (approvedCommand) approvedCommands.push(approvedCommand);
            return permissionOutcome(allowOnce);
          }
          return permissionOutcome(pickPermissionOption(params, ["reject_once", "reject_always"]));
        }
        const description = describeToolCall(merged);
        // BuildWarden remembers run-wide and permanent approvals itself. The agent's own
        // `allow_always` would let it save the choice in its settings, past this run and past
        // BuildWarden's control, so it is never selected. An agent that offers no one-time
        // approval for an action does not get it.
        const allowOnce = pickPermissionOption(params, ["allow_once"]);
        if (!allowOnce) {
          onChunk({
            type: "error", title: "ACP agent",
            value: `BuildWarden declined "${description}": the agent offered only a permanent approval, which it would store in its own settings.`,
          });
          return permissionOutcome(pickPermissionOption(params, ["reject_once"]));
        }
        const allow = () => {
          if (toolCallId) grantedToolCalls.add(toolCallId);
          const approvedCommand = kind === "execute" ? approvedCommandOf(merged) : null;
          if (approvedCommand) approvedCommands.push(approvedCommand);
          return permissionOutcome(allowOnce);
        };
        if (input.yoloMode === true) return allow();
        const identity = toolCallApprovalIdentity(merged);
        const approvalKey = acpToolApprovalKey(input.providerAccountId ?? "unknown-agent", kind ?? "tool", identity ?? description);
        if (identity && input.toolApprovalAllowlist?.includes(approvalKey)) return allow();
        if (!this.requestShellApproval) return permissionOutcome(pickPermissionOption(params, ["reject_once"]));
        const decision = await this.requestShellApproval(description, { approvalKey, ...(identity ? {} : { onceOnly: true }) });
        if (signal.aborted) return permissionOutcome(undefined);
        if (decision === "deny") return permissionOutcome(pickPermissionOption(params, ["reject_once", "reject_always"]));
        return allow();
      });
      connection.handleRequest("fs/read_text_file", async (raw) => {
        const params = isRecord(raw) ? raw : {};
        const text = (await readFile(await resolveWorkspacePath(input.worktreePath, params.path), "utf8")).slice(0, ACP_MAX_READ_CHARS);
        const line = typeof params.line === "number" && params.line > 0 ? params.line : null;
        const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : null;
        if (line === null && limit === null) return { content: text };
        const lines = text.split("\n");
        const start = (line ?? 1) - 1;
        return { content: lines.slice(start, limit === null ? undefined : start + limit).join("\n") };
      });
      connection.handleRequest("fs/write_text_file", async (raw) => {
        if (!writable) throw new Error("Writing files is not allowed in ask or plan mode.");
        const params = isRecord(raw) ? raw : {};
        if (typeof params.content !== "string") throw new Error("File content is required.");
        const target = await resolveWorkspacePath(input.worktreePath, params.path, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, params.content, "utf8");
        return null;
      });
      if (requestUserInput) {
        const elicit = async (raw: unknown) => {
          const form = readElicitationForm(raw);
          if (!form) throw new Error("BuildWarden cannot show this form; ask in the conversation instead.");
          if (signal.aborted) return { action: "cancel" };
          try {
            return form.respond(await requestUserInput(form.request));
          } catch {
            // The user dismissed the question, or the turn stopped.
            return { action: "cancel" };
          }
        };
        // ACP v1 named the request session/elicitation; later drafts call it elicitation/create.
        connection.handleRequest("session/elicitation", elicit);
        connection.handleRequest("elicitation/create", elicit);
      }
      connection.handleRequest("terminal/create", (raw) => terminals.create(raw));
      connection.handleRequest("terminal/output", (raw) => terminals.output(raw));
      connection.handleRequest("terminal/wait_for_exit", (raw) => terminals.waitForExit(raw));
      connection.handleRequest("terminal/kill", (raw) => terminals.kill(raw));
      connection.handleRequest("terminal/release", (raw) => terminals.release(raw));
      emitToolChunk = (id) => {
        const state = tools.get(id);
        if (!state || replaying) return;
        const status = asString(state.status) ?? "pending";
        const finished = status === "completed" || status === "failed";
        onChunk({
          type: finished ? "tool-result" : "tool-progress",
          title: `Tool: ${asString(state.title) ?? asString(state.kind) ?? "tool"}`,
          value: toolContentText(state.content, (terminalId) => terminals.snapshot(terminalId)) || describeToolCall(state),
          metadata: { provider: "acp", toolName: asString(state.kind) ?? "tool", callId: id, ok: status !== "failed", streamId: `acp-tool-${id}`, replace: true },
        });
      };
      connection.handleNotification("session/update", (raw) => {
        if (!isRecord(raw) || !isRecord(raw.update)) return;
        const update = raw.update;
        if (update.sessionUpdate === "config_option_update") {
          if (!settingsSessionId || raw.sessionId !== settingsSessionId) return;
          settings.update(update);
          if (!replaying && settings.currentModel) onChunk(buildExecutedModelChunk(settings.currentModel));
          return;
        }
        if (replaying) return;
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const content = isRecord(update.content) ? update.content : {};
            if (content.type !== "text" || typeof content.text !== "string") return;
            messageText += content.text;
            summary = messageText;
            onChunk({
              type: "message", title: "Agent output", value: messageText,
              metadata: { provider: "acp", streamId: `acp-message-${String(messageIndex)}`, replace: true },
            });
            return;
          }
          case "agent_thought_chunk": {
            const content = isRecord(update.content) ? update.content : {};
            if (content.type !== "text" || typeof content.text !== "string") return;
            thoughtText += content.text;
            onChunk({
              type: "message", title: "Reasoning", value: thoughtText,
              metadata: { provider: "acp", assistantKind: "reasoning", streamId: `acp-thought-${String(thoughtIndex)}`, replace: true },
            });
            return;
          }
          case "tool_call":
          case "tool_call_update": {
            const id = asString(update.toolCallId);
            if (!id) return;
            const state = { ...tools.get(id), ...update };
            tools.set(id, state);
            // Text after a tool call is a new message, so earlier output stays in place.
            if (messageText) {
              messageIndex += 1;
              messageText = "";
            }
            if (thoughtText) {
              thoughtIndex += 1;
              thoughtText = "";
            }
            const status = asString(state.status) ?? "pending";
            const toolKind = asString(state.kind) ?? "other";
            for (const terminalId of toolTerminalIds(state.content)) {
              const terminal = terminals.snapshot(terminalId);
              if (!terminal) continue;
              // A terminal belongs to the first call that shows it; another call can show its
              // output but cannot borrow its approval.
              const owner = terminalToolCalls.get(terminalId);
              if (owner === undefined) terminalToolCalls.set(terminalId, id);
              else if (owner !== id) continue;
              // BuildWarden's shell policy let this terminal's command start. The call is approved
              // with it, unless it names another command than the one that runs.
              const shown = approvedCommandOf(state);
              if (toolKind === "execute" && (!shown || runsApprovedCommand(shown, terminal.commandLine, terminal.request))) grantedToolCalls.add(id);
            }
            if (!writable && !readOnlyViolation && !INSPECT_TOOL_KINDS.has(toolKind) && !grantedToolCalls.has(id)) {
              // The agent ran a tool this turn rejects without BuildWarden's approval: it skipped
              // the permission prompt, or went ahead after a rejection. Stop the turn, and close
              // the connection if the agent ignores the cancel as well.
              const claimedBridgeTool = bridgeToolNameOf(state, bridgeToolNames, bridgeServerName);
              if (!claimedBridgeTool) {
                if (status === "in_progress" || status === "completed") {
                  readOnlyViolation = readOnlyViolationMessage(state);
                  cancelTurn();
                }
              } else if (status === "completed") {
                // The bridge answers a call before the agent can report it done, so by now a
                // genuine BuildWarden call has reached it.
                unverifiedBridgeCalls.delete(id);
                if (!bridgeCalls.claim(id, claimedBridgeTool)) {
                  readOnlyViolation = readOnlyViolationMessage(state);
                  cancelTurn();
                }
              } else if (status === "in_progress") {
                // The agent may report a call running before it reaches the bridge; it is checked
                // when it completes, or at the end of the turn.
                unverifiedBridgeCalls.set(id, { toolName: claimedBridgeTool, state });
              } else if (status === "failed") {
                unverifiedBridgeCalls.delete(id);
              }
            }
            emitToolChunk(id);
            return;
          }
          case "plan": {
            const entries = Array.isArray(update.entries) ? update.entries.filter(isRecord) : [];
            const progress = normalizeRunPlanProgressPayload({
              steps: entries.map((entry) => ({ title: String(entry.content ?? ""), status: entry.status === "in_progress" ? "in_progress" : entry.status })),
              source: "acp",
            }, "acp");
            if (progress) {
              onChunk({
                type: "plan-progress", title: "Plan progress", value: formatRunPlanProgressContent(progress),
                metadata: { provider: "acp", planProgress: progress, streamId: "acp-plan-progress", replace: true },
              });
            }
            return;
          }
          default:
        }
      });

      const resumeCursor = input.providerSessionRuntime?.resumeCursor;
      const previousSessionId = asString(resumeCursor?.sessionId);
      // A forked run starts from a copy of its source run's session (see the run fork service).
      const forkFromSessionId = previousSessionId ? undefined : asString(resumeCursor?.forkFromSessionId);
      const fallbackNote = input.resumeFallbackContext ? " The earlier conversation is sent with this turn." : "";
      let sessionState: unknown;
      /** The session holds the conversation so far: it was reopened or forked. */
      let continued = false;
      let resumeFailed = false;
      if (forkFromSessionId) {
        if (agent.forkSession) {
          try {
            const forked = await connection.request("session/fork", { sessionId: forkFromSessionId, cwd: input.worktreePath, mcpServers }, ACP_SESSION_LOAD_TIMEOUT_MS);
            const forkedId = isRecord(forked) ? asString(forked.sessionId) : undefined;
            if (!forkedId) throw new Error("the agent returned no session id");
            sessionState = forked;
            sessionId = forkedId;
            settingsSessionId = forkedId;
            continued = true;
            onChunk({ type: "status", title: "ACP session", value: "Forked the agent's session from the source run." });
          } catch (error) {
            resumeFailed = true;
            onChunk({
              type: "status", title: "ACP session",
              value: `Started a new session; the agent could not fork the source run's session (${error instanceof Error ? error.message : String(error)}).${fallbackNote}`,
            });
          }
        } else {
          resumeFailed = true;
          onChunk({ type: "status", title: "ACP session", value: `Started a new session; this agent cannot fork sessions.${fallbackNote}` });
        }
      } else if (previousSessionId && agent.resumeSession) {
        // Resuming reopens the session without replaying it.
        settingsSessionId = previousSessionId;
        try {
          sessionState = await connection.request("session/resume", { sessionId: previousSessionId, cwd: input.worktreePath, mcpServers }, ACP_SESSION_LOAD_TIMEOUT_MS);
          sessionId = previousSessionId;
          continued = true;
        } catch (error) {
          settingsSessionId = null;
          resumeFailed = true;
          onChunk({
            type: "status", title: "ACP session",
            value: `Started a new session; the agent could not resume the previous one (${error instanceof Error ? error.message : String(error)}).${fallbackNote}`,
          });
        }
      } else if (previousSessionId && agent.loadSession) {
        // Loading replays the saved transcript as updates; the run already has those steps.
        replaying = true;
        settingsSessionId = previousSessionId;
        try {
          sessionState = await connection.request("session/load", { sessionId: previousSessionId, cwd: input.worktreePath, mcpServers }, ACP_SESSION_LOAD_TIMEOUT_MS);
          sessionId = previousSessionId;
          continued = true;
        } catch (error) {
          settingsSessionId = null;
          resumeFailed = true;
          onChunk({
            type: "status", title: "ACP session",
            value: `Started a new session; the agent could not reload the previous one (${error instanceof Error ? error.message : String(error)}).${fallbackNote}`,
          });
        } finally {
          replaying = false;
        }
      } else if (previousSessionId) {
        resumeFailed = true;
      }
      if (!sessionId) {
        // A failed load may have replayed settings belonging to the old session.
        settingsSessionId = null;
        settings.reset();
        const created = await connection.request("session/new", { cwd: input.worktreePath, mcpServers }, ACP_INITIALIZE_TIMEOUT_MS);
        // The creation response defines the fresh session's initial settings, including legacy-only responses.
        settings.reset();
        sessionState = created;
        sessionId = isRecord(created) ? asString(created.sessionId) ?? null : null;
        if (!sessionId) throw new Error("The ACP agent did not return a session id.");
        settingsSessionId = sessionId;
      }
      const readOnlyMode = await applyAcpSessionSettings(connection, sessionId, sessionState, input, settings);
      const selectedModel = settings.currentModel;
      const selectedMode = settings.selector("mode")?.currentValue;
      await settings.configure(input.config?.[PROVIDER_CONFIG_ACP_SESSION_OPTIONS_KEY],
      (configId, value) => connection.request("session/set_config_option", { sessionId, configId, value }));

      if (settings.currentModel !== selectedModel || settings.selector("mode")?.currentValue !== selectedMode) {
        throw new Error("ACP session options changed the selected model or mode.");
      }
      // With the agent's default model, only the agent knows which model that is.
      if (!input.modelId || input.modelId === ACP_DEFAULT_MODEL_ID) {
        const models = isRecord(sessionState) && isRecord(sessionState.models) ? sessionState.models : {};
        const current = settings.currentModel ?? asString(models.currentModelId);
        if (current) onChunk(buildExecutedModelChunk(current));
      }
      if (!writable && !readOnlyMode) {
        if (input.requireReadOnly) {
          throw new Error("This ACP agent offers no read-only mode, so BuildWarden cannot guarantee an inspect-only task stays read-only. Delegate it to another model or as an implement task.");
        }
        onChunk({
          type: "error", title: "ACP agent",
          value: "This agent offers no read-only mode. BuildWarden rejects edit and command permissions in this turn and stops it if the agent runs one anyway.",
        });
      }
      onChunk({
        type: "status", title: "ACP session", value: continued && previousSessionId === sessionId ? "ACP session resumed." : "ACP session ready.",
        metadata: {
          silent: true,
          providerSessionRuntime: {
            cwd: input.worktreePath, modelId: input.modelId, runtimeMode: input.mode, status: "running",
            resumeCursor: { sessionId }, runtimePayload: { sessionType: input.isChat ? "chat" : "run" },
          },
        },
      });
      signal.throwIfAborted();
      const policy = sessionInstructionPrompt({ prompt: input.prompt,
        instructions: [RESPONSE_PRESENTATION_INSTRUCTIONS, input.instructions?.trim()].filter(Boolean).join("\n\n"),
        resumed: continued,
        previousHash: input.providerSessionRuntime?.runtimePayload?.coordinatorPolicyHash,
        // A fresh session after a failed resume gets the conversation in front of the prompt.
        nativeCommand: input.nativeCommand === true && !resumeFailed });
      const blocks = promptBlocks({ ...input, prompt: policy.prompt }, agent.promptImages);
      if (resumeFailed && input.resumeFallbackContext && blocks[0]?.type === "text") {
        blocks[0] = { type: "text", text: `${fallbackContextBlock(input.resumeFallbackContext)}\n\n${String(blocks[0].text)}` };
      }
      const result = await connection.request("session/prompt", { sessionId, prompt: blocks }, 0);
      for (const [id, call] of unverifiedBridgeCalls) {
        if (readOnlyViolation) break;
        if (!bridgeCalls.claim(id, call.toolName)) readOnlyViolation = readOnlyViolationMessage(call.state);
      }
      if (readOnlyViolation) throw new Error(readOnlyViolation);
      const stopReason = isRecord(result) ? asString(result.stopReason) : undefined;
      if (stopReason === "refusal") throw new Error("The ACP agent refused to continue this request.");
      if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        onChunk({ type: "status", title: "ACP agent", value: `The agent stopped early (${stopReason}).` });
      }
      const usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };
      return {
        summary: summary.trim() || (signal.aborted ? "ACP agent run cancelled." : "ACP agent run completed."),
        responseId: sessionId,
        usage,
        providerSessionRuntime: {
          cwd: input.worktreePath, modelId: input.modelId, runtimeMode: input.mode, status: "ready",
          resumeCursor: { sessionId }, runtimePayload: { sessionType: input.isChat ? "chat" : "run", ...(!signal.aborted && policy.hash ? { coordinatorPolicyHash: policy.hash } : {}) },
        },
      };
    } catch (error) {
      // Closing the connection after a violation rejects the prompt with a generic error.
      if (readOnlyViolation && !signal.aborted) throw new Error(readOnlyViolation);
      if (signal.aborted) {
        return {
          summary: summary.trim() || "ACP agent run cancelled.",
          responseId: sessionId,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      const diagnostics = connection.diagnostics;
      throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics && !(error instanceof AcpRequestError) ? `\n${diagnostics.slice(-1_000)}` : ""}`);
    } finally {
      clearTimeout(cancelTimer);
      signal.removeEventListener("abort", onAbort);
      for (const [id, state] of tools) {
        if (state.status === "completed" || state.status === "failed") continue;
        onChunk({
          type: "tool-result", title: `Tool: ${asString(state.title) ?? "tool"}`,
          value: signal.aborted ? "Tool cancelled when the ACP turn stopped." : "Tool did not finish before the ACP turn ended.",
          metadata: { provider: "acp", toolName: asString(state.kind) ?? "tool", callId: id,
            ok: false, streamId: `acp-tool-${id}`, replace: true, endedReason: signal.aborted ? "cancelled" : "turn-ended" },
        });
      }
      for (const timer of toolEmitTimers.values()) clearTimeout(timer);
      toolEmitTimers.clear();
      emitToolChunk = () => undefined;
      await terminals.closeAll().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      // A cancelled turn stops everything it started, and so does one stopped for running a
      // command without permission; only a turn that finished normally leaves its servers running.
      await connection.close({ scope: signal.aborted || readOnlyViolation ? "tree" : "agent" });
    }
  }
}

export class AcpProviderAdapter implements ProviderAdapter {
  readonly providerType = "acp" as const;

  listRecommendedModels(): string[] {
    return [ACP_DEFAULT_MODEL_ID];
  }

  /** Starts the agent, reads what it announces during initialization, and stops it again. */
  async probeSessionCapabilities(context: ProviderAvailableModelsContext): Promise<HarnessSessionCapabilities> {
    const connection = new AcpConnection(resolveAcpConfig(context.config), tmpdir());
    try {
      connection.start();
      return acpSessionCapabilities(readAgentCapabilities(await initializeAgent(connection, { read: true, write: true })), Boolean(resolveMcpStdioRelayLaunch()));
    } catch (error) {
      throw new Error(`Could not start the ACP agent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await connection.close();
    }
  }

  /** Starts the agent briefly and lists the models its new sessions offer, if it reports any. */
  async listAvailableModels(context: ProviderAvailableModelsContext): Promise<ProviderAvailableModel[]> {
    const fallback: ProviderAvailableModel = { modelId: ACP_DEFAULT_MODEL_ID, displayName: "Agent default", source: "curated" };
    const connection = new AcpConnection(resolveAcpConfig(context.config), tmpdir());
    try {
      connection.start();
      await initializeAgent(connection, { read: false, write: false }, context.config);
      const created = await connection.request("session/new", { cwd: tmpdir(), mcpServers: [] }, ACP_INITIALIZE_TIMEOUT_MS);
      const settings = new AcpSessionSettings();
      if (settings.update(created) && settings.selector("model")) return [fallback, ...settings.models()];
      const models = isRecord(created) && isRecord(created.models) && Array.isArray(created.models.availableModels)
        ? created.models.availableModels.filter(isRecord)
        : [];
      return [
        fallback,
        ...models.flatMap((model): ProviderAvailableModel[] => {
          const modelId = asString(model.modelId);
          return modelId ? [{
            modelId, displayName: asString(model.name) ?? modelId, source: "provider",
            ...(asString(model.description) ? { description: asString(model.description) } : {}),
          }] : [];
        }),
      ];
    } catch (error) {
      throw new Error(`Could not list the ACP agent's models: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await connection.close();
    }
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const command = asString(input.config?.[PROVIDER_CONFIG_ACP_COMMAND_KEY]) ?? "";
    if (!command.trim()) throw new Error("Enter the command that starts the ACP agent.");
    if (command.includes("\n")) throw new Error("The ACP agent command must be a single line.");
    resolveAcpConfig(input.config);
  }
}


/**
 * One prompt in a throwaway ACP session that may not touch the workspace: every permission
 * request is refused and file writes fail. Returns the agent's reply text.
 */
export async function generateUtilityTextWithAcp(input: {
  cwd: string;
  prompt: string;
  modelId: string;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ text: string; usage: RunTokenUsage }> {
  const connection = new AcpConnection(resolveAcpConfig(input.config), input.cwd);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), input.timeoutMs ?? 180_000);
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let text = "";
  let sessionId: string | undefined;
  const onAbort = () => {
    if (sessionId) connection.notify("session/cancel", { sessionId });
    void connection.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // AbortSignal.any() returns an already-aborted signal without firing the abort listener.
    signal.throwIfAborted();
    connection.start();
    connection.handleRequest("session/request_permission", (raw) =>
      permissionOutcome(pickPermissionOption(isRecord(raw) ? raw : {}, ["reject_once", "reject_always"])));
    connection.handleNotification("session/update", (raw) => {
      const update = isRecord(raw) && isRecord(raw.update) ? raw.update : {};
      const content = isRecord(update.content) ? update.content : {};
      if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") text += content.text;
    });
    await initializeAgent(connection, { read: false, write: false }, input.config);
    const created = await connection.request("session/new", { cwd: input.cwd, mcpServers: [] }, ACP_INITIALIZE_TIMEOUT_MS);
    sessionId = isRecord(created) ? asString(created.sessionId) : undefined;
    if (!sessionId) throw new Error("The ACP agent did not return a session id.");
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID) {
      const settings = new AcpSessionSettings();
      if (settings.update(created) && settings.selector("model")) {
        await settings.select("model", input.modelId, (configId, value) => connection.request("session/set_config_option", { sessionId, configId, value }));
      } else {
        await connection.request("session/set_model", { sessionId, modelId: input.modelId });
      }
    }
    await connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] }, 0);
    signal.throwIfAborted();
    if (!text.trim()) throw new Error("The ACP agent returned an empty answer.");
    return { text: text.trim(), usage: { inputTokens: 0, outputTokens: 0 } };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    await connection.close();
  }
}

/** A session an ACP agent saved, as `session/list` reports it. */
export interface AcpListedSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

const ACP_LIST_MAX_PAGES = 10;
const ACP_LIST_MAX_SESSIONS = 200;

/**
 * The sessions the agent saved for `cwd`, in the agent's order. Returns `supported: false` when
 * the agent does not advertise `session/list`.
 */
export async function listAcpSessions(input: { cwd: string; config?: Record<string, unknown> }): Promise<{ supported: boolean; sessions: AcpListedSession[] }> {
  const connection = new AcpConnection(resolveAcpConfig(input.config), input.cwd);
  try {
    connection.start();
    const agent = readAgentCapabilities(await initializeAgent(connection, { read: false, write: false }, input.config));
    if (!agent.listSessions) return { supported: false, sessions: [] };
    const sessions: AcpListedSession[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ACP_LIST_MAX_PAGES && sessions.length < ACP_LIST_MAX_SESSIONS; page += 1) {
      const listed = await connection.request("session/list", { cwd: input.cwd, ...(cursor ? { cursor } : {}) }, ACP_INITIALIZE_TIMEOUT_MS);
      for (const entry of isRecord(listed) && Array.isArray(listed.sessions) ? listed.sessions.filter(isRecord) : []) {
        const sessionId = asString(entry.sessionId);
        if (!sessionId) continue;
        sessions.push({
          sessionId: sessionId.slice(0, 500),
          cwd: asString(entry.cwd) ?? input.cwd,
          title: asString(entry.title)?.slice(0, 300) ?? null,
          updatedAt: asString(entry.updatedAt) ?? null,
        });
      }
      cursor = isRecord(listed) ? asString(listed.nextCursor) : undefined;
      if (!cursor) break;
    }
    return { supported: true, sessions: sessions.slice(0, ACP_LIST_MAX_SESSIONS) };
  } finally {
    await connection.close();
  }
}

/** One message of a saved ACP session, as its replay reports it. */
export interface AcpTranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

const ACP_TRANSCRIPT_MAX_CHARS = 2_000_000;

/**
 * Reloads a saved session to read its conversation: `session/load` replays the transcript as
 * updates, of which the user's and the agent's messages are kept. Permission requests are refused
 * and no file access is advertised, so the replay cannot act. Returns `loaded: false` when the
 * agent cannot reload sessions.
 */
export async function readAcpSessionTranscript(input: { cwd: string; sessionId: string; config?: Record<string, unknown> }): Promise<{ loaded: boolean; messages: AcpTranscriptMessage[] }> {
  const connection = new AcpConnection(resolveAcpConfig(input.config), input.cwd);
  const messages: AcpTranscriptMessage[] = [];
  let total = 0;
  try {
    connection.start();
    connection.handleRequest("session/request_permission", (raw) =>
      permissionOutcome(pickPermissionOption(isRecord(raw) ? raw : {}, ["reject_once", "reject_always"])));
    connection.handleNotification("session/update", (raw) => {
      if (!isRecord(raw) || raw.sessionId !== input.sessionId || !isRecord(raw.update)) return;
      const update = raw.update;
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "assistant" : null;
      const content = isRecord(update.content) ? update.content : {};
      if (!role || content.type !== "text" || typeof content.text !== "string" || total >= ACP_TRANSCRIPT_MAX_CHARS) return;
      total += content.text.length;
      const last = messages.at(-1);
      if (last?.role === role) last.text += content.text;
      else messages.push({ role, text: content.text });
    });
    const agent = readAgentCapabilities(await initializeAgent(connection, { read: false, write: false }, input.config));
    if (!agent.loadSession) return { loaded: false, messages: [] };
    await connection.request("session/load", { sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] }, ACP_SESSION_LOAD_TIMEOUT_MS);
    return { loaded: true, messages: messages.map((message) => ({ ...message, text: message.text.trim() })).filter((message) => message.text) };
  } finally {
    await connection.close();
  }
}
