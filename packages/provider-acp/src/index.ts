import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startHarnessMcp } from "@buildwarden/agent-runtime";
import {
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
  type RunTokenUsage,
  type ShellApprovalDecision,
} from "@buildwarden/shared";
import { AcpConnection, AcpRequestError, parseAcpEnvironment, resolveAcpLaunch, type AcpLaunch } from "./connection";

export { AcpConnection, AcpRequestError, parseAcpCommandLine, parseAcpEnvironment, resolveAcpLaunch } from "./connection";

/** Model id meaning "whatever the agent uses by default"; nothing is sent to the agent for it. */
export const ACP_DEFAULT_MODEL_ID = "default";
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

const describeToolCall = (toolCall: Record<string, unknown>): string => {
  const title = asString(toolCall.title) ?? asString(toolCall.kind) ?? "tool";
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const command = asString(rawInput.command) ?? (Array.isArray(rawInput.command) ? rawInput.command.map(String).join(" ") : undefined);
  return command ? `${title}: ${command}` : title;
};

const toolContentText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).map((entry) => {
    if (entry.type === "content" && isRecord(entry.content) && typeof entry.content.text === "string") return entry.content.text;
    if (entry.type === "diff" && typeof entry.path === "string") return `Edited ${entry.path}`;
    return "";
  }).filter(Boolean).join("\n");
};

/** ACP execution arguments are agent-specific, so only clearly inspect-only kinds are permitted. */
const INSPECT_TOOL_KINDS = new Set(["read", "search", "think"]);

export class AcpHarnessAdapter implements HarnessAdapter {
  readonly harnessType = "acp" as const;

  constructor(private readonly requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>) {}

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
    let summary = "";
    const tools = new Map<string, Record<string, unknown>>();
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      // Before a session exists there is nothing to cancel, so stopping the agent ends the run.
      if (sessionId) {
        connection.notify("session/cancel", { sessionId });
        // ACP cancellation is cooperative; a stalled agent must not keep the worker occupied.
        cancelTimer = setTimeout(() => { void connection.close(); }, ACP_CANCEL_GRACE_MS);
      }
      else void connection.close();
    };
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
        bridge = await startHarnessMcp(toolContext);
        if (bridge) mcpServers.push({ type: "http", name: "buildwarden", url: bridge.url, headers: httpHeaders(bridge.headers) });
        for (const server of input.mcpServers ?? []) {
          mcpServers.push({ type: "http", name: server.name, url: server.url, headers: httpHeaders(server.headers) });
        }
      } else if (wantsMcp) {
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
        const known = typeof toolCall.toolCallId === "string" ? tools.get(toolCall.toolCallId) : undefined;
        const kind = asString(toolCall.kind) ?? asString(known?.kind);
        if (!writable && (!kind || !INSPECT_TOOL_KINDS.has(kind))) {
          return permissionOutcome(pickPermissionOption(params, ["reject_once", "reject_always"]));
        }
        if (input.yoloMode === true) return permissionOutcome(pickPermissionOption(params, ["allow_once", "allow_always"]));
        if (!this.requestShellApproval) return permissionOutcome(pickPermissionOption(params, ["reject_once"]));
        const decision = await this.requestShellApproval(describeToolCall({ ...known, ...toolCall }));
        if (signal.aborted) return permissionOutcome(undefined);
        if (decision === "deny") return permissionOutcome(pickPermissionOption(params, ["reject_once", "reject_always"]));
        if (decision === "allow-once") return permissionOutcome(pickPermissionOption(params, ["allow_once", "allow_always"]));
        return permissionOutcome(pickPermissionOption(params, ["allow_always", "allow_once"]));
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
          case "agent_thought_chunk":
            return;
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
            const status = asString(state.status) ?? "pending";
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
      if (previousSessionId && agent.loadSession) {
        // Loading replays the saved transcript as updates; the run already has those steps.
        replaying = true;
        try {
          sessionState = await connection.request("session/load", { sessionId: previousSessionId, cwd: input.worktreePath, mcpServers }, ACP_SESSION_LOAD_TIMEOUT_MS);
          sessionId = previousSessionId;
        } catch (error) {
          onChunk({ type: "status", title: "ACP session", value: `Started a new session; the agent could not reload the previous one (${error instanceof Error ? error.message : String(error)}).` });
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
      await this.applySessionSettings(connection, sessionId, sessionState, input);
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
      const result = await connection.request("session/prompt", { sessionId, prompt: promptBlocks(input, agent.promptImages) }, 0);
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

  /** Reconciles model and mode on both new and resumed sessions before sending the prompt. */
  private async applySessionSettings(connection: AcpConnection, sessionId: string, created: unknown, input: RunExecutionRequest): Promise<void> {
    if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID) {
      try {
        await connection.request("session/set_model", { sessionId, modelId: input.modelId });
      } catch (error) {
        throw new Error(`The ACP agent could not select model ${input.modelId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!isRecord(created) || !isRecord(created.modes)) return;
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
      return;
    }
    if (selected.id === modeState.currentModeId) return;
    try {
      await connection.request("session/set_mode", { sessionId, modeId: selected.id });
    } catch (error) {
      throw new Error(`The ACP agent could not select mode ${selected.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
