import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { preflightRequiredMcpServers, startHarnessMcp } from "@buildwarden/agent-runtime";
import {
  ACP_DEFAULT_MODEL_ID,
  acpToolApprovalKey,
  buildExecutedModelChunk,
  formatRunPlanProgressContent,
  normalizeRunPlanProgressPayload,
  PROVIDER_CONFIG_ACP_COMMAND_KEY,
  PROVIDER_CONFIG_ACP_ENV_KEY,
  type HarnessAdapter,
  type HarnessRunChunk,
  type HarnessToolContext,
  type ProviderAccountInput,
  type ProviderAdapter,
  type ProviderAvailableModel,
  type ProviderAvailableModelsContext,
  type RunExecutionRequest,
  type ApprovalRequester,
  type RunTokenUsage,
} from "@buildwarden/shared";
import { AcpConnection, AcpRequestError, parseAcpEnvironment, resolveAcpLaunch, type AcpLaunch } from "./connection";

export { AcpConnection, AcpRequestError, parseAcpCommandLine, parseAcpEnvironment, resolveAcpLaunch } from "./connection";

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
  loadSession: boolean;
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
  const info = isRecord(result.agentInfo) ? result.agentInfo : {};
  return {
    loadSession: capabilities.loadSession === true,
    mcpHttp: mcp.http === true,
    promptImages: prompt.image === true,
    ...(asString(info.title) ?? asString(info.name) ? { agentName: asString(info.title) ?? asString(info.name) } : {}),
    ...(asString(info.version) ? { agentVersion: asString(info.version) } : {}),
  };
};

/** Advertises only the file access this connection serves; the agent relies on what it is told. */
const initializeAgent = (connection: AcpConnection, access: { read: boolean; write: boolean }) => connection.request("initialize", {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: access.read, writeTextFile: access.write }, terminal: false },
  clientInfo: { name: "buildwarden", title: "BuildWarden", version: "1.0.0" },
}, ACP_INITIALIZE_TIMEOUT_MS);

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

const toolContentText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).map((entry) => {
    if (entry.type === "content" && isRecord(entry.content) && typeof entry.content.text === "string") return entry.content.text;
    if (entry.type === "diff" && typeof entry.path === "string") return `Edited ${entry.path}`;
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

/**
 * The BuildWarden tool a call's title names, if any. BuildWarden's own tools reach the agent
 * through the run's MCP bridge, and BuildWarden runs them itself under its own rules, so calling
 * one is not a bypass of the inspect-only answer. Agents label MCP calls `other` (or leave the
 * kind out), and title them differently (`name`, `mcp__server__name`, `name (server MCP Server)`),
 * so the name may appear anywhere in the title, as a whole token. A call of any other kind is never
 * one, whatever its title says: an `execute` or `edit` title holds the command or path.
 *
 * The title is the agent's own text, so a match is only a claim: a call counts as BuildWarden's
 * only once the bridge itself has received a call to that tool.
 */
const bridgeToolNameOf = (toolCall: Record<string, unknown>, bridgeToolNames: readonly string[]): string | null => {
  const kind = asString(toolCall.kind) ?? "other";
  const title = asString(toolCall.title);
  if (kind !== "other" || !title) return null;
  for (const name of bridgeToolNames) {
    for (let index = title.indexOf(name); index >= 0; index = title.indexOf(name, index + 1)) {
      const before = title.slice(0, index);
      const startsToken = before === "" || /[^A-Za-z0-9_]$/.test(before) || before.endsWith("__");
      if (startsToken && !/[A-Za-z0-9_]/.test(title.charAt(index + name.length))) return name;
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

const fallbackContextBlock = (context: string) =>
  `<earlier_conversation>\nThe agent could not reload its saved session, so this is the conversation so far.\n${context}\n</earlier_conversation>`;

export class AcpHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "acp" as const;

  constructor(private readonly requestShellApproval?: ApprovalRequester) {}

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
    let replaying = false;
    let messageIndex = 0;
    let messageText = "";
    let thoughtIndex = 0;
    let thoughtText = "";
    let summary = "";
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
    const bridgeCalls = new BridgeCallLedger();
    /** Calls titled as BuildWarden tools that ran, but that the bridge has not vouched for yet. */
    const unverifiedBridgeCalls = new Map<string, { toolName: string; state: Record<string, unknown> }>();
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
      const agent = readAgentCapabilities(await initializeAgent(connection, { read: true, write: writable }));
      onChunk({
        type: "status",
        title: "ACP session capabilities",
        value: `${agent.agentName ?? "ACP agent"}${agent.agentVersion ? ` ${agent.agentVersion}` : ""} connected.`,
        metadata: {
          silent: true,
          sessionCapabilities: {
            reportedAt: new Date().toISOString(),
            ...(agent.agentName ? { agentName: agent.agentName } : {}),
            ...(agent.agentVersion ? { agentVersion: agent.agentVersion } : {}),
            mcpHttp: agent.mcpHttp,
            sessionResume: agent.loadSession,
          },
        },
      });

      const mcpServers: Array<Record<string, unknown>> = [];
      const wantsMcp = toolContext.tools.some((tool) => tool.name.startsWith("buildwarden_")) || Boolean(input.mcpServers?.length);
      if (agent.mcpHttp) {
        // The agent connects to project servers itself and reports nothing back, so a required
        // server is checked from here before the session starts.
        await preflightRequiredMcpServers(input.mcpServers ?? [], { signal });
        bridge = await startHarnessMcp(toolContext, (toolName) => bridgeCalls.received(toolName));
        if (bridge) bridgeToolNames = toolContext.tools.map((tool) => tool.name).filter((name) => name.startsWith("buildwarden_"));
        if (bridge) mcpServers.push({ type: "http", name: "buildwarden", url: bridge.url, headers: httpHeaders(bridge.headers) });
        for (const server of input.mcpServers ?? []) {
          mcpServers.push({ type: "http", name: server.name, url: server.url, headers: httpHeaders(server.headers) });
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
          // BuildWarden's own tools run under BuildWarden's rules, so an agent that asks before
          // calling one gets the same answer as one that doesn't ask. The approval is not recorded
          // as a grant: the call still has to reach the bridge, or the turn is stopped.
          if (bridgeToolNameOf(merged, bridgeToolNames)) {
            const allowOnce = pickPermissionOption(params, ["allow_once"]);
            if (allowOnce) return permissionOutcome(allowOnce);
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
      connection.handleNotification("session/update", (raw) => {
        if (replaying || !isRecord(raw) || !isRecord(raw.update)) return;
        const update = raw.update;
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
            if (!writable && !readOnlyViolation && !INSPECT_TOOL_KINDS.has(toolKind) && !grantedToolCalls.has(id)) {
              // The agent ran a tool this turn rejects without BuildWarden's approval: it skipped
              // the permission prompt, or went ahead after a rejection. Stop the turn, and close
              // the connection if the agent ignores the cancel as well.
              const claimedBridgeTool = bridgeToolNameOf(state, bridgeToolNames);
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
            const finished = status === "completed" || status === "failed";
            onChunk({
              type: finished ? "tool-result" : "tool-progress",
              title: `Tool: ${asString(state.title) ?? asString(state.kind) ?? "tool"}`,
              value: toolContentText(state.content) || describeToolCall(state),
              metadata: { provider: "acp", toolName: asString(state.kind) ?? "tool", callId: id, ok: status !== "failed", streamId: `acp-tool-${id}`, replace: true },
            });
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

      const previousSessionId = asString(input.providerSessionRuntime?.resumeCursor?.sessionId);
      let sessionState: unknown;
      let resumeFailed = Boolean(previousSessionId) && !agent.loadSession;
      if (previousSessionId && agent.loadSession) {
        // Loading replays the saved transcript as updates; the run already has those steps.
        replaying = true;
        try {
          sessionState = await connection.request("session/load", { sessionId: previousSessionId, cwd: input.worktreePath, mcpServers }, ACP_SESSION_LOAD_TIMEOUT_MS);
          sessionId = previousSessionId;
        } catch (error) {
          resumeFailed = true;
          onChunk({
            type: "status", title: "ACP session",
            value: `Started a new session; the agent could not reload the previous one (${error instanceof Error ? error.message : String(error)}).${input.resumeFallbackContext ? " The earlier conversation is sent with this turn." : ""}`,
          });
        } finally {
          replaying = false;
        }
      }
      if (!sessionId) {
        const created = await connection.request("session/new", { cwd: input.worktreePath, mcpServers }, ACP_INITIALIZE_TIMEOUT_MS);
        sessionState = created;
        sessionId = isRecord(created) ? asString(created.sessionId) ?? null : null;
        if (!sessionId) throw new Error("The ACP agent did not return a session id.");
      }
      const readOnlyMode = await this.applySessionSettings(connection, sessionId, sessionState, input);
      // With the agent's default model, only the agent knows which model that is.
      if (!input.modelId || input.modelId === ACP_DEFAULT_MODEL_ID) {
        const models = isRecord(sessionState) && isRecord(sessionState.models) ? sessionState.models : {};
        const current = asString(models.currentModelId);
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
        type: "status", title: "ACP session", value: previousSessionId === sessionId ? "ACP session resumed." : "ACP session ready.",
        metadata: {
          silent: true,
          providerSessionRuntime: {
            cwd: input.worktreePath, modelId: input.modelId, runtimeMode: input.mode, status: "running",
            resumeCursor: { sessionId }, runtimePayload: { sessionType: input.isChat ? "chat" : "run" },
          },
        },
      });
      signal.throwIfAborted();
      const blocks = promptBlocks(input, agent.promptImages);
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
          resumeCursor: { sessionId }, runtimePayload: { sessionType: input.isChat ? "chat" : "run" },
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
      await bridge?.close().catch(() => undefined);
      await connection.close();
    }
  }

  /**
   * Reconciles model and mode on both new and resumed sessions before sending the prompt.
   * Returns whether a read-only mode is now selected.
   */
  private async applySessionSettings(connection: AcpConnection, sessionId: string, created: unknown, input: RunExecutionRequest): Promise<boolean> {
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID) {
      try {
        await connection.request("session/set_model", { sessionId, modelId: input.modelId });
      } catch (error) {
        throw new Error(`The ACP agent could not select model ${input.modelId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!isRecord(created) || !isRecord(created.modes)) return false;
    const modeState = created.modes;
    const modes = Array.isArray(modeState.availableModes) ? modeState.availableModes.filter(isRecord) : [];
    const isInspectMode = (mode: Record<string, unknown>) => /\b(?:plan|ask|read(?:[- ]?only)?)\b/i.test(`${String(mode.id)} ${String(mode.name ?? "")}`);
    const current = modes.find((mode) => mode.id === modeState.currentModeId);
    // A code follow-up must leave the read-only mode selected on the previous turn. Prefer
    // ordinary code modes; never select a permission-bypass mode merely because it is writable.
    const selected = input.mode === "code"
      ? (current && !isInspectMode(current) ? current : modes.find((mode) => /^(default|normal|code|build)$/i.test(String(mode.id))))
      : modes.find(isInspectMode);
    if (typeof selected?.id !== "string") {
      if (input.mode === "code" && current && isInspectMode(current)) {
        throw new Error("The ACP session is read-only and offers no recognized code mode. Start a new session or configure the agent's mode.");
      }
      return false;
    }
    if (selected.id !== modeState.currentModeId) {
      try {
        await connection.request("session/set_mode", { sessionId, modeId: selected.id });
      } catch (error) {
        throw new Error(`The ACP agent could not select mode ${selected.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return input.mode !== "code";
  }
}

export class AcpProviderAdapter implements ProviderAdapter {
  readonly providerType = "acp" as const;

  listRecommendedModels(): string[] {
    return [ACP_DEFAULT_MODEL_ID];
  }

  /** Starts the agent briefly and lists the models its new sessions offer, if it reports any. */
  async listAvailableModels(context: ProviderAvailableModelsContext): Promise<ProviderAvailableModel[]> {
    const fallback: ProviderAvailableModel = { modelId: ACP_DEFAULT_MODEL_ID, displayName: "Agent default", source: "curated" };
    const connection = new AcpConnection(resolveAcpConfig(context.config), tmpdir());
    try {
      connection.start();
      await initializeAgent(connection, { read: false, write: false });
      const created = await connection.request("session/new", { cwd: tmpdir(), mcpServers: [] }, ACP_INITIALIZE_TIMEOUT_MS);
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
    await initializeAgent(connection, { read: false, write: false });
    const created = await connection.request("session/new", { cwd: input.cwd, mcpServers: [] }, ACP_INITIALIZE_TIMEOUT_MS);
    sessionId = isRecord(created) ? asString(created.sessionId) : undefined;
    if (!sessionId) throw new Error("The ACP agent did not return a session id.");
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID) {
      await connection.request("session/set_model", { sessionId, modelId: input.modelId }).catch(() => undefined);
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
