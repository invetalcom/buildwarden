import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runTextGenerationProcess } from "@buildwarden/agent-runtime";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  buildRunSubagentChunk,
  formatRunPlanProgressContent,
  getModelPresetsForProvider,
  isTerminalRunSubagentStatus,
  mergeRunSubagentInfo,
  MODEL_CONFIG_EXECUTION_PROFILE_KEY,
  normalizeRunPlanProgressPayload,
  normalizeRunPlanStepStatus,
  PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY,
  PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY,
  type RunSubagentInfo,
  type RunSubagentStatus,
  type ChatAttachmentPayload,
  type HarnessAdapter,
  type HarnessRunChunk,
  type HarnessToolContext,
  type ProviderAdapter,
  type ProviderAvailableModel,
  type ProviderAvailableModelsContext,
  type ProviderExecutionOptions,
  type ProviderAccountInput,
  type RunExecutionRequest,
  type RunMode,
  type RunPlanProgressPayload,
  type RunTokenUsage,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
  type RunUserInputRequest,
  type ShellApprovalDecision,
  type UtilityTextGenerationOptions,
} from "@buildwarden/shared";

const PROVIDER = "cursor-agent" as const;
const HARNESS = "cursor-acp" as const;
const CURSOR_RESUME_SCHEMA_VERSION = 1;
const CURSOR_DEFAULT_MODEL = "default";
const CURSOR_MODEL_CONFIG_OPTIONS_KEY = "cursorAcpConfigOptions";
const CURSOR_MODEL_MAX_TOKENS_KEY = "cursorMaxTokens";
const ABOUT_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CURSOR_TOOL_STORE_RETRY_DELAYS_MS = [25, 75, 200, 500, 1_000] as const;

type JsonRpcId = number | string;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type CursorProcessLaunch = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

type CursorAcpConfigOption = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
};

export type CursorToolState = {
  id: string;
  kind?: string;
  title?: string;
  status?: "pending" | "inProgress" | "completed" | "failed";
  arguments?: Record<string, unknown>;
  command?: string;
  path?: string;
  query?: string;
  diff?: string;
  detail?: string;
  toolName?: string;
  rawOutput?: Record<string, unknown>;
  raw?: unknown;
};

export type CursorStoredToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  richResult?: Record<string, unknown>;
};

type CursorAcpStartedSession = {
  sessionId: string;
  configOptions: CursorAcpConfigOption[];
  modelConfigId?: string;
};

type CursorRuntimeOptions = {
  cwd: string;
  binaryPath: string;
  apiEndpoint?: string;
  devLogger?: CursorDevLogger;
  resumeSessionId?: string;
  modelId: string;
  mode: RunMode;
  yoloMode?: boolean;
  modelConfig?: Record<string, unknown>;
  providerOptions?: ProviderExecutionOptions;
  attachments?: ChatAttachmentPayload[];
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
  onChunk?: (chunk: HarnessRunChunk) => void;
  onUsage?: (usage: RunTokenUsage) => void;
  onAssistantText?: (text: string) => void;
  signal: AbortSignal;
  mcpServers?: Array<Record<string, unknown>>;
};

export class CursorMcpToolNameMatcher {
  private readonly pendingCursorToolIds: string[] = [];
  private readonly pendingCursorToolIdSet = new Set<string>();
  private readonly pendingToolNames: string[] = [];
  private readonly matchedCursorToolIds = new Set<string>();

  registerCursorTool(toolId: string): string | undefined {
    if (this.matchedCursorToolIds.has(toolId) || this.pendingCursorToolIdSet.has(toolId)) {
      return undefined;
    }
    const pendingToolName = this.pendingToolNames.shift();
    if (pendingToolName) {
      this.matchedCursorToolIds.add(toolId);
      return pendingToolName;
    }
    this.pendingCursorToolIds.push(toolId);
    this.pendingCursorToolIdSet.add(toolId);
    return undefined;
  }

  registerToolName(toolName: string): { toolId: string; toolName: string } | null {
    const toolId = this.pendingCursorToolIds.shift();
    if (!toolId) {
      this.pendingToolNames.push(toolName);
      return null;
    }
    this.pendingCursorToolIdSet.delete(toolId);
    this.matchedCursorToolIds.add(toolId);
    return { toolId, toolName };
  }

  discardCursorTool(toolId: string): void {
    if (!this.pendingCursorToolIdSet.delete(toolId)) return;
    const index = this.pendingCursorToolIds.indexOf(toolId);
    if (index >= 0) this.pendingCursorToolIds.splice(index, 1);
  }
}

const readHttpJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 1_048_576) throw new Error("MCP request body is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const writeMcpJson = (response: ServerResponse, status: number, value?: unknown): void => {
  if (value === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

export const startCursorOrchestrationMcp = async (
  toolContext: HarnessToolContext,
  onToolCall?: (toolName: string) => void,
): Promise<{ config: Record<string, unknown>; close: () => Promise<void> } | null> => {
  const tools = toolContext.tools.filter((tool) => tool.name.startsWith("buildwarden_"));
  if (tools.length === 0) return null;
  const bearerToken = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== "/mcp" || request.method !== "POST") {
        writeMcpJson(response, 404, { error: "Not found" });
        return;
      }
      if (request.headers.authorization !== `Bearer ${bearerToken}`) {
        writeMcpJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const payload = await readHttpJsonBody(request);
      if (!isRecord(payload) || (typeof payload.id !== "string" && typeof payload.id !== "number" && payload.id !== undefined)) {
        writeMcpJson(response, 400, { error: "Invalid JSON-RPC request" });
        return;
      }
      const id = payload.id;
      const method = asString(payload.method);
      const params = isRecord(payload.params) ? payload.params : {};
      if (id === undefined) {
        writeMcpJson(response, 202);
        return;
      }
      if (method === "initialize") {
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: asString(params.protocolVersion) ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "buildwarden-orchestration", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "ping") {
        writeMcpJson(response, 200, { jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        });
        return;
      }
      if (method === "tools/call") {
        const name = asString(params.name);
        const definition = tools.find((tool) => tool.name === name);
        if (!definition || !name) {
          writeMcpJson(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Unknown BuildWarden tool: ${name ?? "(missing)"}` }], isError: true },
          });
          return;
        }
        onToolCall?.(definition.name);
        const result = await toolContext.executeTool({
          id: randomUUID(),
          name: definition.name,
          arguments: isRecord(params.arguments) ? params.arguments : {},
        });
        writeMcpJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result.content }],
            isError: !result.ok,
          },
        });
        return;
      }
      writeMcpJson(response, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported MCP method: ${method ?? "(missing)"}` },
      });
    })().catch((error) => {
      writeMcpJson(response, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    config: {
      type: "http",
      name: "buildwarden-orchestration",
      url: `http://127.0.0.1:${String(address.port)}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${bearerToken}` }],
    },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections?.();
    }),
  };
};

type CursorDevLogger = {
  enabled: boolean;
  log: (event: string, data: unknown) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const REDACTED_LOG_VALUE = "[REDACTED]";
const isSensitiveLogKey = (key: string): boolean =>
  /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|bearer[-_]?token|password|secret)$/i
    .test(key);

const redactSensitiveLogValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveLogValues);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sensitiveNamedValue = typeof value.name === "string" && isSensitiveLogKey(value.name);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveLogKey(key) || (key === "value" && sensitiveNamedValue)
        ? REDACTED_LOG_VALUE
        : redactSensitiveLogValues(entry),
    ]),
  );
};

const sanitizeMetadataValue = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    return redactSensitiveLogValues(JSON.parse(JSON.stringify(value)) as unknown);
  } catch {
    return String(value);
  }
};

type CursorStoredToolCallParts = Partial<CursorStoredToolCall>;

const indexCursorStoredToolCallPayload = (
  data: unknown,
  toolCalls: Map<string, CursorStoredToolCallParts>,
): void => {
  if (!(data instanceof Uint8Array) && typeof data !== "string") {
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(payload)) {
    return;
  }
  const providerOptions = isRecord(payload.providerOptions) ? payload.providerOptions : undefined;
  const cursorOptions = isRecord(providerOptions?.cursor) ? providerOptions.cursor : undefined;
  const richResult = isRecord(cursorOptions?.highLevelToolCallResult)
    ? cursorOptions.highLevelToolCallResult
    : undefined;

  for (const entry of asArray(payload.content) ?? []) {
    if (!isRecord(entry)) {
      continue;
    }
    const toolCallId = asString(entry.toolCallId)?.trim();
    if (!toolCallId) {
      continue;
    }
    const current = toolCalls.get(toolCallId) ?? {};
    const hasToolCall =
      entry.type === "tool-call" &&
      typeof entry.toolName === "string" &&
      isRecord(entry.args);
    if (!hasToolCall && !richResult) {
      continue;
    }
    toolCalls.set(toolCallId, {
      ...current,
      ...(hasToolCall ? { toolName: entry.toolName as string, arguments: entry.args as Record<string, unknown> } : {}),
      ...(richResult ? { richResult } : {}),
    });
  }
};

const completeCursorStoredToolCall = (
  stored: CursorStoredToolCallParts | undefined,
): CursorStoredToolCall | null =>
  typeof stored?.toolName === "string" && isRecord(stored.arguments)
    ? {
        toolName: stored.toolName,
        arguments: stored.arguments,
        ...(stored.richResult ? { richResult: stored.richResult } : {}),
      }
    : null;

const readCursorStoredToolCallFromDatabase = (
  database: DatabaseSync,
  toolCallId: string,
): CursorStoredToolCall | null => {
  // Cursor currently publishes empty rawInput objects over ACP for many built-in tools,
  // while its session store retains the arguments under the same toolCallId.
  const rows = database
    .prepare("SELECT data FROM blobs WHERE instr(CAST(data AS TEXT), ?) > 0 ORDER BY rowid ASC")
    .all(toolCallId) as Array<{ data?: unknown }>;
  const toolCalls = new Map<string, CursorStoredToolCallParts>();
  for (const row of rows) {
    indexCursorStoredToolCallPayload(row.data, toolCalls);
  }
  return completeCursorStoredToolCall(toolCalls.get(toolCallId));
};

const openCursorSessionDatabase = (databasePath: string): DatabaseSync => {
  const { DatabaseSync: SqliteDatabaseSync } = process.getBuiltinModule("node:sqlite");
  return new SqliteDatabaseSync(databasePath, { readOnly: true });
};

export const readCursorStoredToolCall = (
  databasePath: string,
  toolCallId: string,
): CursorStoredToolCall | null => {
  const database = openCursorSessionDatabase(databasePath);
  try {
    return readCursorStoredToolCallFromDatabase(database, toolCallId);
  } finally {
    database.close();
  }
};

export const readCursorStoredToolCallWithRetry = async (
  read: () => CursorStoredToolCall | null,
  retryDelaysMs: readonly number[] = CURSOR_TOOL_STORE_RETRY_DELAYS_MS,
): Promise<CursorStoredToolCall | null> => {
  const immediate = read();
  if (immediate) {
    return immediate;
  }
  for (const delayMs of retryDelaysMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    const stored = read();
    if (stored) {
      return stored;
    }
  }
  return null;
};

export const findCursorSessionStorePath = (
  sessionId: string,
  cursorDirectory = join(homedir(), ".cursor"),
): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return null;
  }
  const currentPath = join(cursorDirectory, "acp-sessions", sessionId, "store.db");
  if (existsSync(currentPath)) {
    return currentPath;
  }
  const chatsDirectory = join(cursorDirectory, "chats");
  let hashDirectories: string[];
  try {
    hashDirectories = readdirSync(chatsDirectory);
  } catch {
    return null;
  }
  for (const hash of hashDirectories) {
    const legacyPath = join(chatsDirectory, hash, sessionId, "store.db");
    if (existsSync(legacyPath)) {
      return legacyPath;
    }
  }
  return null;
};

class CursorToolStoreReader {
  private database: DatabaseSync | null = null;
  private lastIndexedRowId = 0;
  private readonly toolCalls = new Map<string, CursorStoredToolCallParts>();

  constructor(private readonly sessionId: string) {}

  hasStore(): boolean {
    return this.database !== null || findCursorSessionStorePath(this.sessionId) !== null;
  }

  read(toolCallId: string): CursorStoredToolCall | null {
    try {
      if (!this.database) {
        const databasePath = findCursorSessionStorePath(this.sessionId);
        if (!databasePath) {
          return null;
        }
        this.database = openCursorSessionDatabase(databasePath);
      }
      const rows = this.database
        .prepare("SELECT rowid, data FROM blobs WHERE rowid > ? ORDER BY rowid ASC")
        .all(this.lastIndexedRowId) as Array<{ rowid?: unknown; data?: unknown }>;
      for (const row of rows) {
        if (typeof row.rowid !== "number" || !Number.isSafeInteger(row.rowid)) {
          continue;
        }
        this.lastIndexedRowId = Math.max(this.lastIndexedRowId, row.rowid);
        indexCursorStoredToolCallPayload(row.data, this.toolCalls);
      }
      return completeCursorStoredToolCall(this.toolCalls.get(toolCallId));
    } catch {
      this.close();
      return null;
    }
  }

  close(): void {
    try {
      this.database?.close();
    } catch {
      /* The Cursor process may have already removed its temporary session store. */
    }
    this.database = null;
    this.lastIndexedRowId = 0;
    this.toolCalls.clear();
  }
}

const toJsonLine = (event: string, data: unknown) =>
  JSON.stringify({
    ts: new Date().toISOString(),
    event,
    data: sanitizeMetadataValue(data),
  }) + "\n";

export const createCursorDevLogger = (input: {
  logDirPath?: string;
  runId: string;
  modelId: string;
  sessionType: "run" | "chat";
}): CursorDevLogger => {
  const enabled = Boolean(input.logDirPath?.trim());
  const logDirPath = input.logDirPath?.trim() ?? "";
  const filePath = enabled ? join(logDirPath, `${input.sessionType}-${input.runId}-${PROVIDER}-${input.modelId}.jsonl`) : "";

  if (enabled) {
    mkdirSync(logDirPath, { recursive: true });
  }

  return {
    enabled,
    log: (event, data) => {
      if (!enabled) {
        return;
      }
      appendFileSync(filePath, toJsonLine(event, data), "utf8");
    },
  };
};

const WINDOWS_CMD_ARGUMENT_UNSAFE_PATTERN = /[\r\n"&|<>^%!]/;

const quoteWindowsCommandShimArgument = (value: string): string => {
  if (WINDOWS_CMD_ARGUMENT_UNSAFE_PATTERN.test(value)) {
    throw new Error("Cursor Agent command-shim arguments cannot contain Windows shell metacharacters.");
  }
  return `"${value}"`;
};

const resolveWindowsCommandShimLaunch = (command: string, args: string[], hasPathSeparator: boolean): CursorProcessLaunch => {
  const commandText = hasPathSeparator ? quoteWindowsCommandShimArgument(command) : command;
  if (!hasPathSeparator && WINDOWS_CMD_ARGUMENT_UNSAFE_PATTERN.test(commandText)) {
    throw new Error("Cursor Agent command-shim arguments cannot contain Windows shell metacharacters.");
  }
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/c", ["call", commandText, ...args.map(quoteWindowsCommandShimArgument)].join(" ")],
    windowsVerbatimArguments: true,
  };
};

export const resolveCursorAgentProcessLaunch = (binaryPath: string, args: string[]): CursorProcessLaunch => {
  if (process.platform !== "win32") {
    return { command: binaryPath, args };
  }

  const hasPathSeparator = /[\\/]/.test(binaryPath);
  const isCommandShim = /\.(?:cmd|bat)$/i.test(binaryPath);
  if (!hasPathSeparator || isCommandShim) {
    return resolveWindowsCommandShimLaunch(binaryPath, args, hasPathSeparator);
  }

  return { command: binaryPath, args };
};

type CursorKillableProcess = Pick<ChildProcessWithoutNullStreams, "pid" | "kill">;
type CursorWindowsProcessTreeKiller = (pid: number) => boolean;

const killCursorWindowsProcessTree: CursorWindowsProcessTreeKiller = (pid) => {
  const result = spawnSync(
    "C:\\Windows\\System32\\taskkill.exe",
    ["/pid", String(pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
  return !result.error && result.status === 0;
};

export const terminateCursorProcessTree = (
  child: CursorKillableProcess,
  platform: NodeJS.Platform = process.platform,
  killWindowsTree: CursorWindowsProcessTreeKiller = killCursorWindowsProcessTree,
): void => {
  if (platform === "win32" && child.pid !== undefined) {
    try {
      if (killWindowsTree(child.pid)) return;
    } catch {
      // Fall back to the ordinary child-process termination path.
    }
  }
  child.kill();
};

const readConfigString = (
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const getCursorAgentBinaryPath = (config?: Record<string, unknown>): string =>
  readConfigString(config, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY) ?? getDefaultCursorAgentBinaryPath();

const getCursorAgentApiEndpoint = (config?: Record<string, unknown>): string | undefined =>
  readConfigString(config, PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY);

export const getDefaultCursorAgentBinaryPath = (): string => {
  return getCursorAgentBinaryPathCandidates().find((candidate) => existsSync(candidate)) ?? "agent";
};

const candidateBaseDirs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const home = env.USERPROFILE || homedir();
  const dirs = [
    join(home, ".local", "bin"),
    env.APPDATA ? join(env.APPDATA, "npm") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : undefined,
    join(home, "scoop", "shims"),
    env.ProgramData ? join(env.ProgramData, "chocolatey", "bin") : undefined,
  ];
  return Array.from(new Set(dirs.filter((dir): dir is string => Boolean(dir))));
};

export const getCursorAgentBinaryPathCandidates = (env: NodeJS.ProcessEnv = process.env): string[] => {
  if (process.platform !== "win32") {
    return [join(homedir(), ".local", "bin", "agent"), join(homedir(), ".local", "bin", "cursor-agent")];
  }
  return candidateBaseDirs(env).flatMap((dir) => [
    join(dir, "agent.exe"),
    join(dir, "agent.cmd"),
    join(dir, "cursor-agent.exe"),
    join(dir, "cursor-agent.cmd"),
  ]);
};

const normalizeToken = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "-");

const configOptionId = (option: CursorAcpConfigOption): string => asString(option.id)?.trim() ?? "";

const configOptionName = (option: CursorAcpConfigOption): string => asString(option.name)?.trim() ?? "";

const flattenSelectOptions = (option: CursorAcpConfigOption | undefined): Array<{ value: string; name: string }> => {
  const options = asArray(option?.options) ?? [];
  const flattened: Array<{ value: string; name: string }> = [];
  for (const entry of options) {
    if (!isRecord(entry)) {
      continue;
    }
    const value = asString(entry.value)?.trim();
    const name = asString(entry.name)?.trim() ?? asString(entry.label)?.trim() ?? value;
    if (value) {
      flattened.push({ value, name: name || value });
      continue;
    }
    const nested = asArray(entry.options) ?? [];
    for (const nestedEntry of nested) {
      if (!isRecord(nestedEntry)) {
        continue;
      }
      const nestedValue = asString(nestedEntry.value)?.trim();
      const nestedName = asString(nestedEntry.name)?.trim() ?? asString(nestedEntry.label)?.trim() ?? nestedValue;
      if (nestedValue) {
        flattened.push({ value: nestedValue, name: nestedName || nestedValue });
      }
    }
  }
  return flattened;
};

const findConfigOption = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
  matcher: (option: CursorAcpConfigOption) => boolean,
): CursorAcpConfigOption | undefined => configOptions?.find(matcher);

const isModelConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  const category = normalizeToken(asString(option.category));
  if (id === "model" || id === "model-id" || name === "model" || name === "model-id") {
    return true;
  }
  if (category !== "model" && category !== "model-config") {
    return false;
  }
  const combined = `${id} ${name}`;
  return (
    combined.includes("model") &&
    !combined.includes("context") &&
    !combined.includes("reasoning") &&
    !combined.includes("effort") &&
    !combined.includes("fast") &&
    !combined.includes("thinking")
  );
};

const isReasoningConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  const category = normalizeToken(asString(option.category));
  return category === "thought-level" || id.includes("reasoning") || id.includes("effort") || name.includes("reasoning") || name.includes("effort");
};

const isContextConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  return id.includes("context") || name.includes("context");
};

const isSpeedConfigOption = (option: CursorAcpConfigOption): boolean => {
  const id = normalizeToken(configOptionId(option));
  const name = normalizeToken(configOptionName(option));
  return id.includes("speed") || id.includes("fast") || name.includes("speed") || name.includes("fast");
};

const isModeConfigOption = (option: CursorAcpConfigOption): boolean => normalizeToken(configOptionId(option)) === "mode";

const parseContextWindowTokenCount = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = /(\d+(?:\.\d+)?)\s*([km])?/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) {
    return undefined;
  }
  let multiplier = 1;
  if (match[2] === "k") multiplier = 1_000;
  if (match[2] === "m") multiplier = 1_000_000;
  return Math.round(base * multiplier);
};

export const deriveCursorMaxTokensFromConfigOptions = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
): number | undefined => {
  const contextOption = findConfigOption(configOptions, isContextConfigOption);
  if (!contextOption) {
    return undefined;
  }
  const current = parseContextWindowTokenCount(contextOption.currentValue);
  if (current) {
    return current;
  }
  const optionCounts = flattenSelectOptions(contextOption)
    .flatMap((option) => [parseContextWindowTokenCount(option.value), parseContextWindowTokenCount(option.name)])
    .filter((value): value is number => typeof value === "number" && value > 0);
  return optionCounts.length > 0 ? Math.max(...optionCounts) : undefined;
};

const buildCursorModelConfig = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
): Record<string, unknown> | undefined => {
  if (!configOptions?.length) {
    return undefined;
  }
  const maxTokens = deriveCursorMaxTokensFromConfigOptions(configOptions);
  const executionControls = configOptions.flatMap((entry) => {
    let id: "reasoningEffort" | "contextMode" | "speed" | null = null;
    if (isReasoningConfigOption(entry)) id = "reasoningEffort";
    else if (isContextConfigOption(entry)) id = "contextMode";
    else if (isSpeedConfigOption(entry)) id = "speed";
    if (!id || entry.type !== "select") return [];
    const options = flattenSelectOptions(entry).map((candidate) => ({ value: candidate.value, label: candidate.name }));
    if (options.length === 0) return [];
    let label = "Speed";
    if (id === "reasoningEffort") label = "Effort";
    else if (id === "contextMode") label = "Context";
    return [{
      id,
      label,
      defaultValue: "auto",
      options: [{ value: "auto", label: "Provider default" }, ...options],
    }];
  });
  return {
    [CURSOR_MODEL_CONFIG_OPTIONS_KEY]: configOptions,
    ...(maxTokens ? { [CURSOR_MODEL_MAX_TOKENS_KEY]: maxTokens } : {}),
    ...(executionControls.length > 0
      ? { [MODEL_CONFIG_EXECUTION_PROFILE_KEY]: { source: "provider", controls: executionControls } }
      : {}),
  };
};

const cursorConfigOptionsFromModelConfig = (modelConfig?: Record<string, unknown>): CursorAcpConfigOption[] => {
  const value = modelConfig?.[CURSOR_MODEL_CONFIG_OPTIONS_KEY];
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : CURSOR_DEFAULT_MODEL;
  return base.includes("[") ? base.slice(0, base.indexOf("[")).trim() : base;
}

const normalizeReasoningEffort = (value: string | undefined): string | undefined => {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  const map: Record<string, string> = {
    min: "low",
    minimum: "low",
    low: "low",
    medium: "medium",
    med: "medium",
    high: "high",
    xhigh: "xhigh",
    "x-high": "xhigh",
    max: "max",
    maximum: "max",
  };
  return map[normalized] ?? normalized;
};

export const resolveCursorAcpConfigUpdates = (
  configOptions: readonly CursorAcpConfigOption[] | undefined,
  providerOptions: ProviderExecutionOptions | undefined,
  onWarning?: (message: string) => void,
): Array<{ configId: string; value: string | boolean }> => {
  const requested = [
    {
      label: "reasoning effort",
      value: providerOptions?.reasoningEffort,
      matcher: isReasoningConfigOption,
      normalize: normalizeReasoningEffort,
    },
    {
      label: "context mode",
      value: providerOptions?.contextMode,
      matcher: isContextConfigOption,
      normalize: (value: string | undefined) => normalizeToken(value) || undefined,
    },
    {
      label: "speed",
      value: providerOptions?.speed,
      matcher: isSpeedConfigOption,
      normalize: (value: string | undefined) => normalizeToken(value) || undefined,
    },
  ];
  return requested.flatMap((request) => {
    const normalized = request.normalize(request.value);
    if (!normalized || normalized === "auto") return [];
    const configOption = findConfigOption(configOptions, request.matcher);
    const configId = configOption ? configOptionId(configOption) : "";
    if (!configId) {
      onWarning?.(`Cursor Agent does not advertise a ${request.label} control for this model.`);
      return [];
    }
    const selected = flattenSelectOptions(configOption).find((candidate) =>
      request.normalize(candidate.value) === normalized || request.normalize(candidate.name) === normalized,
    );
    if (!selected) {
      onWarning?.(`Cursor Agent does not support ${request.label} '${request.value ?? ""}' for this model.`);
      return [];
    }
    return [{ configId, value: selected.value }];
  });
};

const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => {
  const totalTokens = (left.totalTokens ?? left.inputTokens + left.outputTokens) + (right.totalTokens ?? right.inputTokens + right.outputTokens);
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const cacheCreationInputTokens = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const result: RunTokenUsage = {
    ...left,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens,
    totalProcessedTokens: totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(right.usedTokens !== undefined ? { usedTokens: right.usedTokens, lastUsedTokens: right.usedTokens } : {}),
    ...(right.maxTokens !== undefined ? { maxTokens: right.maxTokens } : {}),
    ...(right.lastInputTokens !== undefined ? { lastInputTokens: right.lastInputTokens } : {}),
    ...(right.lastOutputTokens !== undefined ? { lastOutputTokens: right.lastOutputTokens } : {}),
    ...(right.lastReasoningTokens !== undefined ? { lastReasoningTokens: right.lastReasoningTokens } : {}),
    ...(right.lastCachedInputTokens !== undefined ? { lastCachedInputTokens: right.lastCachedInputTokens } : {}),
  };
  return result;
};

const readUsageFromRecord = (record: Record<string, unknown>): RunTokenUsage | null => {
  const inputTokens = asFiniteNumber(
    record.inputTokens ?? record.input_tokens ?? record.promptTokens ?? record.prompt_tokens,
  ) ?? 0;
  const outputTokens = asFiniteNumber(
    record.outputTokens ?? record.output_tokens ?? record.completionTokens ?? record.completion_tokens,
  ) ?? 0;
  // ACP's stabilized end-turn usage names these thoughtTokens/cachedReadTokens/cachedWriteTokens.
  const reasoningTokens = asFiniteNumber(
    record.reasoningTokens ?? record.reasoning_tokens ?? record.thoughtTokens ?? record.thought_tokens,
  );
  const cachedInputTokens = asFiniteNumber(
    record.cachedInputTokens ?? record.cached_input_tokens ?? record.cachedReadTokens ?? record.cached_read_tokens,
  );
  const cacheCreationInputTokens = asFiniteNumber(
    record.cacheCreationInputTokens ??
      record.cache_creation_input_tokens ??
      record.cachedWriteTokens ??
      record.cached_write_tokens,
  );
  const totalTokens = asFiniteNumber(record.totalTokens ?? record.total_tokens ?? record.tokens);
  const usedTokens = asFiniteNumber(
    record.usedTokens ?? record.used_tokens ?? record.contextUsedTokens ?? record.context_used_tokens ?? record.used,
  );
  const maxTokens = asFiniteNumber(
    record.maxTokens ?? record.max_tokens ?? record.contextWindow ?? record.context_window ?? record.contextWindowTokens ?? record.size,
  );

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined &&
    usedTokens === undefined &&
    maxTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens, lastReasoningTokens: reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens, totalProcessedTokens: totalTokens } : {}),
    ...(usedTokens !== undefined ? { usedTokens, lastUsedTokens: usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
  };
};

const readUsageUpdateSnapshot = (record: Record<string, unknown>): RunTokenUsage | null => {
  const source = isRecord(record.usage) ? record.usage : record;
  const usedTokens = asFiniteNumber(
    source.usedTokens ?? source.used_tokens ?? source.contextUsedTokens ?? source.context_used_tokens ?? source.used,
  );
  const maxTokens = asFiniteNumber(
    source.maxTokens ?? source.max_tokens ?? source.contextWindow ?? source.context_window ?? source.contextWindowTokens ?? source.size,
  );
  if (usedTokens === undefined && maxTokens === undefined) {
    return null;
  }
  return {
    inputTokens: 0,
    outputTokens: 0,
    ...(usedTokens !== undefined ? { usedTokens, lastUsedTokens: usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
};

export const normalizeCursorTokenUsage = (payload: unknown): RunTokenUsage | null => {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.sessionUpdate === "usage_update") {
    return readUsageUpdateSnapshot(payload);
  }
  const direct = readUsageFromRecord(payload);
  if (direct) {
    return direct;
  }
  const candidates = [
    payload.usage,
    payload.tokenUsage,
    payload.token_usage,
    payload.modelUsage,
    payload.model_usage,
    payload.contextUsage,
    payload.context_usage,
    payload.context,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      const usage = readUsageFromRecord(candidate);
      if (usage) {
        return usage;
      }
    }
  }
  const update = isRecord(payload.update) ? payload.update : undefined;
  return update ? normalizeCursorTokenUsage(update) : null;
};

export const extractCursorTodosAsPlanProgress = (params: unknown): RunPlanProgressPayload | null => {
  if (!isRecord(params)) {
    return null;
  }
  const todos = asArray(params.todos) ?? [];
  const steps = todos.flatMap((todo, index) => {
    if (!isRecord(todo)) {
      return [];
    }
    const title =
      asString(todo.content)?.trim() ??
      asString(todo.title)?.trim() ??
      asString(todo.name)?.trim() ??
      `Step ${String(index + 1)}`;
    return [
      {
        title,
        status: normalizeRunPlanStepStatus(todo.status),
      },
    ];
  });
  if (steps.length === 0) {
    return null;
  }
  return normalizeRunPlanProgressPayload({ steps, source: "cursor-acp" }, "cursor-acp");
};

export const buildCursorPlanProgressChunk = (
  progress: RunPlanProgressPayload,
  rawPayload: unknown,
): HarnessRunChunk => {
  const normalized = normalizeRunPlanProgressPayload({ ...progress, source: "cursor-acp" }, "cursor-acp") ?? progress;
  return {
    type: "plan-progress",
    title: "Plan progress",
    value: formatRunPlanProgressContent(normalized),
    metadata: {
      provider: PROVIDER,
      planProgress: normalized,
      streamId: "cursor-plan-progress",
      replace: true,
      rawPlanUpdate: sanitizeMetadataValue(rawPayload),
    },
  };
};

const buildCursorPlanUpdatedChunk = (params: unknown): HarnessRunChunk | null => {
  if (!isRecord(params)) {
    return null;
  }
  const plan = asString(params.plan)?.trim();
  if (!plan) {
    return null;
  }
  return {
    type: "plan-updated",
    title: asString(params.name)?.trim() || "Cursor plan",
    value: plan,
    metadata: {
      provider: PROVIDER,
      source: "cursor-acp",
      planKind: "proposal",
      rawPlanUpdate: sanitizeMetadataValue(params),
    },
  };
};

const parseSessionPlanUpdate = (params: unknown): RunPlanProgressPayload | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  if (update.sessionUpdate !== "plan") {
    return null;
  }
  const entries = asArray(update.entries) ?? [];
  const steps = entries.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }
    const title = asString(entry.content)?.trim() || `Step ${String(index + 1)}`;
    return [{ title, status: normalizeRunPlanStepStatus(entry.status) }];
  });
  return steps.length > 0 ? normalizeRunPlanProgressPayload({ steps, source: "cursor-acp" }, "cursor-acp") : null;
};

const normalizeCursorToolName = (kind: string | undefined): string => {
  switch (normalizeToken(kind)) {
    case "execute":
      return "run_shell";
    case "edit":
      return "edit_file";
    case "delete":
      return "delete_file";
    case "move":
      return "edit_file";
    case "search":
      return "search_repo";
    case "read":
    case "fetch":
      return "read_file";
    default:
      return "tool";
  }
};

const normalizeCursorStoredToolName = (toolName: string): string => {
  switch (normalizeToken(toolName)) {
    case "shell":
    case "execute":
      return "run_shell";
    case "read":
      return "read_file";
    case "write":
      return "write_file";
    case "str-replace":
    case "edit":
      return "edit_file";
    case "delete":
      return "delete_file";
    case "glob":
    case "grep":
    case "search":
      return "search_repo";
    case "task":
      return "task";
    default:
      return toolName;
  }
};

const normalizeCursorToolStatus = (value: unknown): CursorToolState["status"] | undefined => {
  const normalized = normalizeToken(asString(value));
  if (normalized === "completed" || normalized === "complete" || normalized === "done" || normalized === "success") return "completed";
  if (normalized === "failed" || normalized === "failure" || normalized === "error") return "failed";
  if (normalized === "pending") return "pending";
  if (normalized === "in-progress" || normalized === "running" || normalized === "started") return "inProgress";
  return undefined;
};

const normalizeCommandValue = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

const extractCommandFromRawInput = (rawInput: unknown, title: string | undefined): string | undefined => {
  if (isRecord(rawInput)) {
    const direct = normalizeCommandValue(rawInput.command);
    if (direct) {
      return direct;
    }
    const executable = asString(rawInput.executable)?.trim();
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  const match = title?.match(/`([^`]+)`/);
  return match?.[1]?.trim();
};

const readCursorPath = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return [
    value.path,
    value.filePath,
    value.file_path,
    value.targetPath,
    value.target_path,
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
};

const readCursorQuery = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return [
    value.query,
    value.pattern,
    value.glob,
    value.globPattern,
    value.glob_pattern,
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
};

const compactCursorToolArguments = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !/^(?:content|contents|fileText|oldText|newText|replacement|replaceWith)$/i.test(key),
    ),
  );

const cursorDisplayPath = (cwd: string, value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  if (!isAbsolute(value)) {
    return value.replaceAll("\\", "/");
  }
  const workspaceRelativePath = relative(cwd, value);
  if (
    workspaceRelativePath &&
    workspaceRelativePath !== ".." &&
    !workspaceRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(workspaceRelativePath)
  ) {
    return workspaceRelativePath.replaceAll("\\", "/");
  }
  return value;
};

export const readCursorToolName = (rawInput: unknown, title: string | undefined): string | undefined => {
  const inputToolName = isRecord(rawInput) ? asString(rawInput._toolName)?.trim() : undefined;
  if (inputToolName && normalizeToken(inputToolName) !== "tool") {
    return inputToolName;
  }
  const titleToolName = title?.match(/:\s*([A-Za-z][A-Za-z0-9_.-]*)\s*$/)?.[1]?.trim();
  return titleToolName && normalizeToken(titleToolName) !== "tool" ? titleToolName : undefined;
};

const textContentFromToolContent = (content: unknown): string | undefined => {
  const entries = asArray(content) ?? [];
  const chunks: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const nested = isRecord(entry.content) ? entry.content : entry;
    if (nested.type === "text" && typeof nested.text === "string" && nested.text.trim()) {
      chunks.push(nested.text.trim());
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
};

const buildCursorFallbackDiff = (path: string, oldText: string, newText: string): string => {
  const normalizeLines = (value: string) => value.replaceAll("\r\n", "\n").split("\n");
  const oldLines = normalizeLines(oldText);
  const newLines = normalizeLines(newText);
  const normalizedPath = path.replaceAll("\\", "/");
  return [
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -1,${String(oldLines.length)} +1,${String(newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
};

const diffContentFromToolContent = (
  content: unknown,
): { path?: string; diff?: string } => {
  for (const entry of asArray(content) ?? []) {
    if (!isRecord(entry)) {
      continue;
    }
    const nested = isRecord(entry.content) ? entry.content : entry;
    if (nested.type !== "diff") {
      continue;
    }
    const path = asString(nested.path)?.trim();
    const oldText = asString(nested.oldText);
    const newText = asString(nested.newText);
    const diff = asString(nested.diff)?.trim();
    let resolvedDiff = diff;
    if (!resolvedDiff && path && oldText !== undefined && newText !== undefined) {
      resolvedDiff = buildCursorFallbackDiff(path, oldText, newText);
    }
    const result = {
      ...(path ? { path } : {}),
      ...(resolvedDiff ? { diff: resolvedDiff } : {}),
    };
    if (result.path || result.diff) {
      return result;
    }
  }
  return {};
};

export const parseCursorToolState = (params: unknown): CursorToolState | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  const updateKind = asString(update.sessionUpdate);
  if (updateKind !== "tool_call" && updateKind !== "tool_call_update") {
    return null;
  }
  const id = asString(update.toolCallId)?.trim();
  if (!id) {
    return null;
  }
  const title = asString(update.title)?.trim();
  const kind = asString(update.kind)?.trim();
  const status = normalizeCursorToolStatus(update.status) ?? (updateKind === "tool_call" ? "pending" : undefined);
  const command = extractCommandFromRawInput(update.rawInput, title);
  const path = readCursorPath(update.rawInput);
  const query = readCursorQuery(update.rawInput);
  const contentDiff = diffContentFromToolContent(update.content);
  const detail = command ?? path ?? query ?? contentDiff.path ?? textContentFromToolContent(update.content) ?? title;
  const toolName = readCursorToolName(update.rawInput, title);
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(isRecord(update.rawInput) ? { arguments: compactCursorToolArguments(update.rawInput) } : {}),
    ...(command ? { command } : {}),
    ...(path ?? contentDiff.path ? { path: path ?? contentDiff.path } : {}),
    ...(query ? { query } : {}),
    ...(contentDiff.diff ? { diff: contentDiff.diff } : {}),
    ...(detail ? { detail } : {}),
    ...(toolName ? { toolName } : {}),
    ...(rawOutput ? { rawOutput } : {}),
    raw: sanitizeMetadataValue(params),
  };
};

const cursorRichResultSuccess = (richResult: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const output = isRecord(richResult?.output) ? richResult.output : undefined;
  return isRecord(output?.success) ? output.success : undefined;
};

export const enrichCursorToolState = (
  tool: CursorToolState,
  stored: CursorStoredToolCall | null,
  cwd: string,
): CursorToolState => {
  if (!stored) {
    return {
      ...tool,
      ...(tool.path ? { path: cursorDisplayPath(cwd, tool.path) } : {}),
    };
  }
  const richSuccess = cursorRichResultSuccess(stored.richResult);
  const rawPath = readCursorPath(stored.arguments) ?? readCursorPath(richSuccess) ?? tool.path;
  const path = cursorDisplayPath(cwd, rawPath);
  const command = extractCommandFromRawInput(stored.arguments, tool.title) ?? tool.command;
  const query = readCursorQuery(stored.arguments) ?? tool.query;
  const richDiff = asString(richSuccess?.diffString)?.trim();
  const kindToolName = normalizeCursorToolName(tool.kind);
  const storedToolName = normalizeCursorStoredToolName(stored.toolName);
  const toolName =
    tool.toolName ??
    (kindToolName === "tool" && !normalizeToken(storedToolName).startsWith("mcp-")
      ? storedToolName
      : undefined);
  const detail = command ?? path ?? query ?? tool.detail;
  const storedArguments = compactCursorToolArguments(stored.arguments);
  return {
    ...tool,
    ...(Object.keys(storedArguments).length > 0 ? { arguments: storedArguments } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(richDiff ? { diff: richDiff } : {}),
    ...(detail ? { detail } : {}),
    ...(toolName ? { toolName } : {}),
  };
};

const mergeCursorToolState = (left: CursorToolState | undefined, right: CursorToolState): CursorToolState => ({
  id: right.id,
  kind: right.kind ?? left?.kind,
  title: right.title ?? left?.title,
  status: right.status ?? left?.status,
  arguments: right.arguments ?? left?.arguments,
  command: right.command ?? left?.command,
  path: right.path ?? left?.path,
  query: right.query ?? left?.query,
  diff: right.diff ?? left?.diff,
  detail: right.detail ?? left?.detail,
  toolName: right.toolName ?? left?.toolName,
  rawOutput: right.rawOutput ?? left?.rawOutput,
  raw: right.raw ?? left?.raw,
});

const isGenericCursorMcpToolState = (tool: CursorToolState): boolean =>
  !tool.toolName &&
  normalizeToken(tool.kind) === "other" &&
  /^mcp:\s*tool$/i.test(tool.title ?? "");

// Subagents surface over Cursor ACP as a "task" tool call
// (`rawInput._toolName === "task"`, title "Task: ..."). The richer metadata
// (description, prompt, model, agentId) arrives via the custom `cursor/task`
// server request keyed by the same toolCallId.
export const isCursorSubagentToolState = (tool: Pick<CursorToolState, "toolName" | "title">): boolean =>
  tool.toolName === "task" || /^task\s*:/i.test(tool.title ?? "");

export const cursorSubagentStatusFromToolStatus = (status: CursorToolState["status"]): RunSubagentStatus => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "inProgress") return "running";
  return "pending";
};

export type CursorTaskRequestInfo = {
  toolCallId?: string;
  description?: string;
  prompt?: string;
  model?: string;
  agentName?: string;
  durationMs?: number;
};

const readCursorSubagentTypeName = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "unspecified") {
      continue;
    }
    const nestedName = readCursorSubagentTypeName(nested);
    if (nestedName) {
      return nestedName;
    }
    if (key !== "custom") {
      return key;
    }
  }
  return undefined;
};

export const readCursorTaskRequestInfo = (params: unknown): CursorTaskRequestInfo => {
  if (!isRecord(params)) {
    return {};
  }
  const model = asString(params.model)?.trim();
  const durationMs = asFiniteNumber(params.durationMs);
  return {
    ...(asString(params.toolCallId)?.trim() ? { toolCallId: asString(params.toolCallId)?.trim() } : {}),
    ...(asString(params.description)?.trim() ? { description: asString(params.description)?.trim() } : {}),
    ...(asString(params.prompt)?.trim() ? { prompt: asString(params.prompt)?.trim() } : {}),
    ...(model && model !== "default" ? { model } : {}),
    ...(readCursorSubagentTypeName(params.subagentType) ? { agentName: readCursorSubagentTypeName(params.subagentType) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

export const buildCursorToolChunkForState = (tool: CursorToolState): HarnessRunChunk => {
  const kindToolName = normalizeCursorToolName(tool.kind);
  const toolName = tool.toolName ?? (kindToolName !== "tool" ? kindToolName : undefined);
  const genericTitle = !tool.title || /^mcp:\s*tool$/i.test(tool.title);
  let fallbackTitle = "Cursor tool";
  if (kindToolName === "run_shell") fallbackTitle = "Shell command";
  const title = genericTitle ? toolName ?? fallbackTitle : tool.title!;
  const value = tool.diff ?? tool.command ?? tool.path ?? tool.query ?? tool.detail ?? title;
  const metadata = {
    provider: PROVIDER,
    ...(toolName ? { toolName } : {}),
    callId: tool.id,
    cursorToolKind: tool.kind,
    arguments: tool.arguments,
    command: tool.command,
    path: tool.path,
    query: tool.query,
    ...(tool.diff ? { writeFileUnifiedDiff: tool.diff } : {}),
    status: tool.status,
    rawToolCall: tool.raw,
    ...(tool.status === "completed" || tool.status === "failed"
      ? {
          streamId: `cursor-tool-result-${tool.id}`,
          replace: true,
        }
      : {}),
  };
  if (tool.status === "completed" || tool.status === "failed") {
    return {
      type: "tool-result",
      title,
      value,
      metadata: {
        ...metadata,
        ok: tool.status === "completed",
      },
    };
  }
  return {
    type: tool.status === "pending" ? "tool-call" : "tool-progress",
    title,
    value,
    metadata,
  };
};

const textFromSessionUpdate = (params: unknown): string | null => {
  if (!isRecord(params)) {
    return null;
  }
  const update = isRecord(params.update) ? params.update : params;
  if (update.sessionUpdate !== "agent_message_chunk") {
    return null;
  }
  const content = isRecord(update.content) ? update.content : {};
  return content.type === "text" && typeof content.text === "string" ? content.text : null;
};

class CursorAcpJsonRpcConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
      method: string;
    }
  >();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void | Promise<void>>>();
  private stderr = "";

  constructor(
    private readonly launch: CursorProcessLaunch,
    private readonly cwd: string,
    private readonly devLogger?: CursorDevLogger,
    private readonly timeoutMs = 30_000,
  ) {}

  handleRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler);
  }

  handleNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  start(): void {
    if (this.child) {
      return;
    }
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: this.launch.windowsVerbatimArguments,
    });
    this.child = child;
    this.devLogger?.log("cursor.process.start", {
      command: this.launch.command,
      args: this.launch.args,
      windowsVerbatimArguments: this.launch.windowsVerbatimArguments,
      cwd: this.cwd,
    });

    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8");
      this.stderr += message;
      this.devLogger?.log("cursor.stderr", { message });
    });
    child.on("error", (error) => {
      this.devLogger?.log("cursor.process.error", { message: error.message });
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      this.devLogger?.log("cursor.process.exit", {
        code,
        signal,
        stderr: this.stderr.trim(),
      });
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`Cursor Agent ACP exited (${code ?? signal ?? "unknown"}). ${this.stderr.trim()}`.trim()));
      }
    });
  }

  close(): void {
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Cursor Agent ACP connection closed."));
    }
    this.pending.clear();
    if (child && !child.killed) {
      terminateCursorProcessTree(child);
    }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error("Cursor Agent ACP connection has not started.");
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    this.devLogger?.log("cursor.rpc.outbound", message);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Cursor Agent ACP request timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timeout, method });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return (await promise) as T;
  }

  notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child) {
      return;
    }
    const message = { jsonrpc: "2.0", method, params };
    this.devLogger?.log("cursor.rpc.outbound", message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleResponse(message: JsonRpcMessage): boolean {
    if (message.id === undefined || message.method) return false;
    this.devLogger?.log("cursor.rpc.response", message);
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    this.pending.delete(message.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Cursor Agent ACP request failed: ${pending.method}`));
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.devLogger?.log("cursor.rpc.invalid", { line: trimmed });
      return;
    }

    if (this.handleResponse(message)) return;

    if (message.method && message.id !== undefined) {
      this.devLogger?.log("cursor.rpc.request", message);
      void this.handleIncomingRequest(message);
      return;
    }

    if (message.method) {
      this.devLogger?.log("cursor.rpc.notification", message);
      const handlers = this.notificationHandlers.get(message.method) ?? [];
      for (const handler of handlers) {
        void Promise.resolve(handler(message.params)).catch(() => {
          /* Ignore notification handler failures. */
        });
      }
    }
  }

  private async handleIncomingRequest(message: JsonRpcMessage): Promise<void> {
    const handler = message.method ? this.requestHandlers.get(message.method) : undefined;
    try {
      const result = handler ? await handler(message.params) : null;
      this.sendResponse({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.sendResponse({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Cursor Agent request handler failed.",
        },
      });
    }
  }

  private sendResponse(message: JsonRpcMessage): void {
    this.devLogger?.log("cursor.rpc.outbound", message);
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const extractSessionId = (value: unknown): string | undefined =>
  isRecord(value) ? asString(value.sessionId)?.trim() : undefined;

const extractConfigOptions = (value: unknown): CursorAcpConfigOption[] =>
  isRecord(value) && Array.isArray(value.configOptions) ? value.configOptions.filter(isRecord) : [];

const extractModelConfigId = (configOptions: readonly CursorAcpConfigOption[]): string | undefined =>
  configOptionId(configOptions.find(isModelConfigOption) ?? {}) || undefined;

const responseConfigOptions = (value: unknown): CursorAcpConfigOption[] => extractConfigOptions(value);

const selectConfigOptionValue = (
  option: CursorAcpConfigOption | undefined,
  candidates: readonly string[],
): string | undefined => {
  if (!option) {
    return undefined;
  }
  const normalizedCandidates = new Set(candidates.map(normalizeToken));
  return flattenSelectOptions(option).find((entry) => {
    const value = normalizeToken(entry.value);
    const name = normalizeToken(entry.name);
    return normalizedCandidates.has(value) || normalizedCandidates.has(name);
  })?.value;
};

const modeCandidatesForRunMode = (mode: RunMode): string[] => {
  if (mode === "plan") {
    return ["plan", "architect"];
  }
  if (mode === "ask") {
    return ["ask", "chat", "default"];
  }
  return ["code", "agent", "implement", "default", "chat"];
};

const modeFallbackInstruction = (mode: RunMode): string => {
  if (mode === "plan") {
    return "Operate in planning mode. Do not modify files or run destructive commands unless the user explicitly asks you to switch to implementation.";
  }
  if (mode === "ask") {
    return "Operate in ask mode. Answer directly and avoid modifying files.";
  }
  return "Operate in code mode. Make the requested code changes and keep the work reviewable.";
};

const selectPermissionOption = (params: unknown, kinds: readonly string[]): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const options = asArray(params.options) ?? [];
  const normalizedKinds = new Set(kinds.map(normalizeToken));
  for (const option of options) {
    if (!isRecord(option)) {
      continue;
    }
    const kind = normalizeToken(asString(option.kind));
    const optionId = asString(option.optionId)?.trim();
    if (optionId && (normalizedKinds.has(kind) || normalizedKinds.has(normalizeToken(optionId)))) {
      return optionId;
    }
  }
  return undefined;
};

const selectAllowOnceOption = (params: unknown): string | undefined => selectPermissionOption(params, ["allow-once", "allow_once"]);

const selectAllowAlwaysOption = (params: unknown): string | undefined => selectPermissionOption(params, ["allow-always", "allow_always"]);

const selectRejectOption = (params: unknown): string | undefined =>
  selectPermissionOption(params, ["reject-once", "reject_once", "deny", "decline"]);

const permissionResponse = (optionId: string | undefined): Record<string, unknown> => {
  if (!optionId) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
};

const getPermissionTool = (params: unknown): CursorToolState | null => {
  if (!isRecord(params) || !isRecord(params.toolCall)) {
    return null;
  }
  return parseCursorToolState({
    update: {
      sessionUpdate: "tool_call",
      ...params.toolCall,
    },
  });
};

export const mergeCursorPermissionToolState = (
  existing: CursorToolState | undefined,
  params: unknown,
): CursorToolState | null => {
  const permissionTool = getPermissionTool(params);
  return permissionTool ? mergeCursorToolState(existing, permissionTool) : null;
};

type ParsedCursorQuestion = {
  question: RunUserInputQuestion;
  answersByLabel: Record<string, string>;
};

const questionFromCursor = (value: unknown): ParsedCursorQuestion | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id)?.trim();
  const question = asString(value.prompt)?.trim();
  if (!id || !question) {
    return null;
  }
  const answersByLabel: Record<string, string> = {};
  const options = (asArray(value.options) ?? []).flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const label = asString(option.label)?.trim() ?? asString(option.id)?.trim();
    if (!label) {
      return [];
    }
    answersByLabel[label] = asString(option.id)?.trim() ?? asString(option.value)?.trim() ?? label;
    return [{ label, description: label }];
  });
  return {
    question: {
      id,
      header: "Question",
      question,
      options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
      multiSelect: value.allowMultiple === true,
      allowCustomAnswer: false,
    },
    answersByLabel,
  };
};

export const mapCursorUserInputAnswers = (
  answers: RunUserInputAnswers,
  answerMapsByQuestionId: Record<string, Record<string, string>>,
): RunUserInputAnswers => {
  const mapped: RunUserInputAnswers = {};
  for (const [questionId, value] of Object.entries(answers)) {
    const answersByLabel = answerMapsByQuestionId[questionId];
    if (!answersByLabel) {
      mapped[questionId] = value;
      continue;
    }
    mapped[questionId] = Array.isArray(value)
      ? value.map((entry) => answersByLabel[entry] ?? entry)
      : answersByLabel[value] ?? value;
  }
  return mapped;
};

const decodeTextAttachment = (attachment: ChatAttachmentPayload): string | null => {
  const mime = attachment.mimeType.toLowerCase();
  if (!mime.startsWith("text/") && mime !== "application/json" && mime !== "application/xml") {
    return null;
  }
  try {
    return Buffer.from(attachment.dataBase64, "base64").toString("utf8");
  } catch {
    return null;
  }
};

const buildPromptParts = (
  prompt: string,
  attachments: ChatAttachmentPayload[] | undefined,
  modeInstruction?: string,
): Array<Record<string, unknown>> => {
  const parts: Array<Record<string, unknown>> = [];
  const text = [modeInstruction, prompt.trim()].filter(Boolean).join("\n\n");
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const attachment of attachments ?? []) {
    if (attachment.mimeType.toLowerCase().startsWith("image/")) {
      parts.push({
        type: "image",
        data: attachment.dataBase64,
        mimeType: attachment.mimeType,
      });
      continue;
    }
    const textAttachment = decodeTextAttachment(attachment);
    if (textAttachment) {
      parts.push({
        type: "text",
        text: `Attached file: ${attachment.fileName}\n\n${textAttachment}`,
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `Attached file: ${attachment.fileName} (${attachment.mimeType || "application/octet-stream"})`,
    });
  }
  return parts;
};

class CursorAcpRuntime {
  private readonly connection: CursorAcpJsonRpcConnection;
  private session: CursorAcpStartedSession | null = null;
  private toolStoreReader: CursorToolStoreReader | null = null;
  private readonly toolStates = new Map<string, CursorToolState>();
  private readonly pendingToolStoreReads = new Map<string, Promise<void>>();
  private readonly mcpToolNameMatcher = new CursorMcpToolNameMatcher();
  private readonly subagents = new Map<string, RunSubagentInfo>();
  private assistantText = "";
  private assistantSegmentText = "";
  private assistantStreamIndex = 0;
  private isPromptActive = false;
  private isClosed = false;
  private usage: RunTokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: CursorRuntimeOptions) {
    const launch = resolveCursorAgentProcessLaunch(options.binaryPath, [
      ...(options.apiEndpoint ? ["-e", options.apiEndpoint] : []),
      "acp",
    ]);
    this.connection = new CursorAcpJsonRpcConnection(launch, options.cwd, options.devLogger);
    this.registerHandlers();
  }

  recordMcpToolCallName(toolName: string): void {
    const match = this.mcpToolNameMatcher.registerToolName(toolName);
    if (!match) return;
    const previous = this.toolStates.get(match.toolId);
    if (!previous || previous.toolName === match.toolName) return;
    const namedTool = {
      ...previous,
      title: match.toolName,
      detail: match.toolName,
      toolName: match.toolName,
    };
    this.toolStates.set(match.toolId, namedTool);
    this.options.onChunk?.(this.withUsage(buildCursorToolChunkForState(namedTool)));
  }

  async start(timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS): Promise<CursorAcpStartedSession> {
    this.connection.start();
    const abort = () => {
      void this.cancel().catch(() => undefined);
      this.connection.close();
    };
    this.options.signal.addEventListener("abort", abort, { once: true });

    const initialization = await this.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: {
        name: "buildwarden",
        version: "0.5.2",
      },
    }, timeoutMs);
    if (this.options.mcpServers?.length) {
      const initializationRecord = isRecord(initialization) ? initialization : {};
      const capabilities = isRecord(initializationRecord.agentCapabilities)
        ? initializationRecord.agentCapabilities
        : {};
      const mcpCapabilities = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
      if (mcpCapabilities.http !== true) {
        throw new Error("This Cursor Agent ACP version does not advertise HTTP MCP support.");
      }
    }
    await this.connection.request("authenticate", { methodId: "cursor_login" }, timeoutMs);

    let setup: unknown;
    let loadedExistingSession = false;
    if (this.options.resumeSessionId) {
      try {
        setup = await this.connection.request("session/load", {
          sessionId: this.options.resumeSessionId,
          cwd: this.options.cwd,
          mcpServers: this.options.mcpServers ?? [],
        }, timeoutMs);
        loadedExistingSession = true;
      } catch {
        setup = undefined;
      }
    }
    if (!setup) {
      setup = await this.connection.request("session/new", {
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers ?? [],
      }, timeoutMs);
    }
    const sessionId = loadedExistingSession ? this.options.resumeSessionId : extractSessionId(setup);
    if (!sessionId) {
      throw new Error("Cursor Agent ACP did not return a session id.");
    }
    const configOptions = extractConfigOptions(setup);
    this.session = {
      sessionId,
      configOptions,
      modelConfigId: extractModelConfigId(configOptions),
    };
    this.toolStoreReader?.close();
    this.toolStoreReader = new CursorToolStoreReader(sessionId);
    await this.applyModelSelection();
    const modeApplied = await this.applyMode();
    if (!modeApplied) {
      this.options.onChunk?.({
        type: "status",
        title: "Cursor mode",
        value: `Cursor did not expose a ${this.options.mode} mode selector; using prompt guidance instead.`,
        metadata: { provider: PROVIDER, cursorModeFallback: true },
      });
    }
    return this.session;
  }

  async discoverModels(): Promise<ProviderAvailableModel[]> {
    await this.start(MODEL_DISCOVERY_TIMEOUT_MS);
    const response = await this.connection.request("cursor/list_available_models", {}, MODEL_DISCOVERY_TIMEOUT_MS);
    return parseCursorAvailableModelsResponse(response);
  }

  async prompt(prompt: string): Promise<{
    summary: string;
    usage: RunTokenUsage;
    result: unknown;
  }> {
    const session = this.requireSession();
    const modeApplied = await this.applyMode();
    this.assistantText = "";
    this.assistantSegmentText = "";
    this.assistantStreamIndex = 0;
    this.toolStates.clear();
    this.isPromptActive = true;
    try {
      const result = await this.connection.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: buildPromptParts(prompt, this.options.attachments, modeApplied ? undefined : modeFallbackInstruction(this.options.mode)),
      }, 0);
      await this.waitForPendingToolStoreReads();
      this.mergeUsage(normalizeCursorTokenUsage(result));
      return {
        summary: this.assistantText.trim(),
        usage: this.usage,
        result,
      };
    } finally {
      this.isPromptActive = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.session) {
      return;
    }
    // Cancelling the session tears down any in-flight subagent tasks with it.
    for (const info of this.subagents.values()) {
      if (!isTerminalRunSubagentStatus(info.status)) {
        this.emitSubagentUpdate(info.id, { status: "cancelled", endedAtMs: Date.now() });
      }
    }
    await this.connection.request("session/cancel", { sessionId: this.session.sessionId }).catch(() => undefined);
  }

  close(): void {
    this.isClosed = true;
    this.toolStoreReader?.close();
    this.toolStoreReader = null;
    this.connection.close();
  }

  get providerSessionRuntime(): {
    cwd: string;
    modelId: string;
    runtimeMode: RunMode;
    resumeCursor: Record<string, unknown>;
    runtimePayload: Record<string, unknown>;
  } {
    const session = this.requireSession();
    return {
      cwd: this.options.cwd,
      modelId: this.options.modelId,
      runtimeMode: this.options.mode,
      resumeCursor: {
        schemaVersion: CURSOR_RESUME_SCHEMA_VERSION,
        sessionId: session.sessionId,
      },
      runtimePayload: {
        sessionId: session.sessionId,
      },
    };
  }

  private registerHandlers(): void {
    this.connection.handleNotification("session/update", (params) => this.handleSessionUpdate(params));
    this.connection.handleNotification("cursor/update_todos", (params) => this.handleCursorTodos(params));
    this.connection.handleRequest("cursor/create_plan", (params) => this.handleCursorCreatePlan(params));
    this.connection.handleRequest("cursor/ask_question", (params) => this.handleCursorAskQuestion(params));
    this.connection.handleRequest("cursor/task", (params) => this.handleCursorTask(params));
    this.connection.handleRequest("session/request_permission", (params) => this.handlePermissionRequest(params));
  }

  private emitSubagentUpdate(subagentId: string, update: Partial<RunSubagentInfo>): void {
    const previous = this.subagents.get(subagentId);
    const next = mergeRunSubagentInfo(previous, {
      id: subagentId,
      source: "cursor-acp",
      status: update.status ?? previous?.status ?? "pending",
      ...(update.name ? { name: update.name } : {}),
      ...(update.model ? { model: update.model } : {}),
      ...(update.description ? { description: update.description } : {}),
      ...(update.prompt ? { prompt: update.prompt } : {}),
      ...(update.summary ? { summary: update.summary } : {}),
      ...(update.isBackground !== undefined ? { isBackground: update.isBackground } : {}),
      ...(update.usage ? { usage: update.usage } : {}),
      ...(update.startedAtMs !== undefined ? { startedAtMs: update.startedAtMs } : {}),
      ...(update.endedAtMs !== undefined ? { endedAtMs: update.endedAtMs } : {}),
    });
    this.subagents.set(subagentId, next);
    this.options.onChunk?.(this.withUsage(buildRunSubagentChunk(next)));
  }

  // Cursor sends this custom request with the subagent's delegation metadata
  // (description, prompt, model, agentId) keyed by the task toolCallId.
  private handleCursorTask(params: unknown): Record<string, unknown> {
    const info = readCursorTaskRequestInfo(params);
    if (info.toolCallId) {
      this.emitSubagentUpdate(info.toolCallId, {
        ...(info.agentName ? { name: info.agentName } : {}),
        ...(info.model ? { model: info.model } : {}),
        ...(info.description ? { description: info.description } : {}),
        ...(info.prompt ? { prompt: info.prompt } : {}),
        ...(info.durationMs !== undefined ? { usage: { durationMs: info.durationMs } } : {}),
      });
    }
    return {};
  }

  private emitSubagentUpdateFromToolState(tool: CursorToolState): void {
    const status = cursorSubagentStatusFromToolStatus(tool.status);
    const titleDescription = tool.title?.replace(/^task\s*:\s*/i, "").trim();
    const durationMs = asFiniteNumber(tool.rawOutput?.durationMs);
    const isBackground = tool.rawOutput?.isBackground;
    this.emitSubagentUpdate(tool.id, {
      status,
      ...(titleDescription && titleDescription.toLowerCase() !== "subagent task" ? { description: titleDescription } : {}),
      ...(typeof isBackground === "boolean" ? { isBackground } : {}),
      ...(durationMs !== undefined ? { usage: { durationMs } } : {}),
      ...(status === "running" && !this.subagents.get(tool.id)?.startedAtMs ? { startedAtMs: Date.now() } : {}),
      ...(status === "completed" || status === "failed" ? { endedAtMs: Date.now() } : {}),
    });
  }

  private requireSession(): CursorAcpStartedSession {
    if (!this.session) {
      throw new Error("Cursor Agent ACP session is not started.");
    }
    return this.session;
  }

  private async applyModelSelection(): Promise<void> {
    const session = this.requireSession();
    const baseModelId = resolveCursorAcpBaseModelId(this.options.modelId);
    const configId = session.modelConfigId ?? "model";
    try {
      const response = await this.connection.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId,
        value: baseModelId,
      });
      const nextOptions = responseConfigOptions(response);
      if (nextOptions.length > 0) {
        session.configOptions = nextOptions;
        session.modelConfigId = extractModelConfigId(nextOptions) ?? session.modelConfigId;
      }
    } catch {
      await this.connection.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: baseModelId,
      }).catch(() => undefined);
    }

    const liveConfigOptions = session.configOptions.length > 0 ? session.configOptions : cursorConfigOptionsFromModelConfig(this.options.modelConfig);
    const reportOptionFallback = (message: string) => this.options.onChunk?.({
      type: "status",
      title: "Cursor option",
      value: `${message} Using the provider default.`,
      metadata: { provider: PROVIDER, cursorExecutionOptionFallback: true },
    });
    for (const update of resolveCursorAcpConfigUpdates(liveConfigOptions, this.options.providerOptions, reportOptionFallback)) {
      try {
        await this.connection.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: update.configId,
          ...(typeof update.value === "boolean" ? { type: "boolean" } : {}),
          value: update.value,
        });
      } catch {
        reportOptionFallback(`Cursor Agent rejected the selected '${update.configId}' value.`);
      }
    }

    const maxTokens =
      asFiniteNumber(this.options.modelConfig?.[CURSOR_MODEL_MAX_TOKENS_KEY]) ??
      deriveCursorMaxTokensFromConfigOptions(liveConfigOptions);
    if (maxTokens) {
      this.mergeUsage({ inputTokens: 0, outputTokens: 0, maxTokens });
    }
  }

  private async applyMode(): Promise<boolean> {
    const session = this.requireSession();
    const modeOption = findConfigOption(session.configOptions, isModeConfigOption);
    const selected = selectConfigOptionValue(modeOption, modeCandidatesForRunMode(this.options.mode));
    if (!selected) {
      return false;
    }
    try {
      const response = await this.connection.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: configOptionId(modeOption ?? {}),
        value: selected,
      });
      const nextOptions = responseConfigOptions(response);
      if (nextOptions.length > 0) {
        session.configOptions = nextOptions;
      }
      return true;
    } catch {
      return false;
    }
  }

  private handleSessionUpdate(params: unknown): void {
    // session/load replays the saved transcript as ordinary session/update
    // notifications. Only updates produced by the active prompt are new run output.
    if (!this.isPromptActive) {
      return;
    }
    this.mergeUsage(normalizeCursorTokenUsage(params));

    const text = textFromSessionUpdate(params);
    if (text) {
      this.assistantSegmentText += text;
      this.assistantText = this.assistantSegmentText;
      this.options.onAssistantText?.(text);
      this.options.onChunk?.({
        type: "message",
        title: "Cursor output",
        value: this.assistantSegmentText,
        metadata: {
          provider: PROVIDER,
          streamId: `cursor-assistant-${String(this.assistantStreamIndex)}`,
          replace: true,
          ...(this.usage.inputTokens > 0 || this.usage.outputTokens > 0 || this.usage.maxTokens ? { usageTotals: this.usage } : {}),
        },
      });
      return;
    }

    const planProgress = parseSessionPlanUpdate(params);
    if (planProgress) {
      this.options.onChunk?.(this.withUsage(buildCursorPlanProgressChunk(planProgress, params)));
      return;
    }

    const parsedTool = parseCursorToolState(params);
    const tool = parsedTool
      ? enrichCursorToolState(parsedTool, this.toolStoreReader?.read(parsedTool.id) ?? null, this.options.cwd)
      : null;
    if (tool) {
      if (this.assistantSegmentText) {
        this.assistantSegmentText = "";
        this.assistantStreamIndex += 1;
      }
      const previous = this.toolStates.get(tool.id);
      let merged = mergeCursorToolState(previous, tool);
      if (isGenericCursorMcpToolState(merged)) {
        const matchedToolName = this.mcpToolNameMatcher.registerCursorTool(merged.id);
        if (matchedToolName) {
          merged = {
            ...merged,
            title: matchedToolName,
            detail: matchedToolName,
            toolName: matchedToolName,
          };
        }
      }
      this.toolStates.set(tool.id, merged);
      if (isGenericCursorMcpToolState(merged)) {
        if (merged.status === "completed" || merged.status === "failed") {
          this.mcpToolNameMatcher.discardCursorTool(merged.id);
        } else {
          return;
        }
      }
      if (isCursorSubagentToolState(merged)) {
        this.emitSubagentUpdateFromToolState(merged);
        return;
      }
      this.options.onChunk?.(this.withUsage(buildCursorToolChunkForState(merged)));
      if (this.shouldRetryToolStoreRead(merged)) {
        this.scheduleToolStoreRead(merged.id);
      }
    }
  }

  private shouldRetryToolStoreRead(tool: CursorToolState): boolean {
    if (
      (tool.status !== "completed" && tool.status !== "failed") ||
      isCursorSubagentToolState(tool) ||
      isGenericCursorMcpToolState(tool) ||
      tool.toolName?.startsWith("buildwarden_")
    ) {
      return false;
    }
    const kind = normalizeToken(tool.kind);
    if (!["read", "edit", "delete", "move", "search", "execute", "fetch"].includes(kind)) {
      return false;
    }
    return (
      !tool.path &&
      !tool.command &&
      !tool.query &&
      !tool.diff &&
      Object.keys(tool.arguments ?? {}).length === 0
    );
  }

  private scheduleToolStoreRead(toolId: string): void {
    if (
      this.pendingToolStoreReads.has(toolId) ||
      this.isClosed ||
      !this.toolStoreReader?.hasStore()
    ) {
      return;
    }
    const pending = readCursorStoredToolCallWithRetry(() => {
      if (this.isClosed || this.options.signal.aborted) {
        return null;
      }
      return this.toolStoreReader?.read(toolId) ?? null;
    })
      .then((stored) => {
        if (!stored || this.isClosed || this.options.signal.aborted) {
          return;
        }
        const current = this.toolStates.get(toolId);
        if (!current || (current.status !== "completed" && current.status !== "failed")) {
          return;
        }
        const enriched = mergeCursorToolState(
          current,
          enrichCursorToolState(current, stored, this.options.cwd),
        );
        const metadataChanged =
          enriched.path !== current.path ||
          enriched.command !== current.command ||
          enriched.query !== current.query ||
          enriched.diff !== current.diff ||
          enriched.toolName !== current.toolName ||
          JSON.stringify(enriched.arguments ?? {}) !== JSON.stringify(current.arguments ?? {});
        if (!metadataChanged) {
          return;
        }
        this.toolStates.set(toolId, enriched);
        this.options.onChunk?.(this.withUsage(buildCursorToolChunkForState(enriched)));
      })
      .catch(() => {
        /* Cursor may remove its session store while a run is shutting down. */
      })
      .finally(() => {
        this.pendingToolStoreReads.delete(toolId);
      });
    this.pendingToolStoreReads.set(toolId, pending);
  }

  private async waitForPendingToolStoreReads(): Promise<void> {
    while (this.pendingToolStoreReads.size > 0) {
      await Promise.allSettled([...this.pendingToolStoreReads.values()]);
    }
  }

  private handleCursorTodos(params: unknown): void {
    this.mergeUsage(normalizeCursorTokenUsage(params));
    const progress = extractCursorTodosAsPlanProgress(params);
    if (progress) {
      this.options.onChunk?.(this.withUsage(buildCursorPlanProgressChunk(progress, params)));
    }
  }

  private handleCursorCreatePlan(params: unknown): Record<string, unknown> {
    this.mergeUsage(normalizeCursorTokenUsage(params));
    const chunk = buildCursorPlanUpdatedChunk(params);
    if (chunk) {
      this.options.onChunk?.(this.withUsage(chunk));
    }
    return { accepted: true };
  }

  private async handleCursorAskQuestion(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params)) {
      return { answers: {} };
    }
    const parsedQuestions = (asArray(params.questions) ?? []).flatMap((question) => {
      const parsed = questionFromCursor(question);
      return parsed ? [parsed] : [];
    });
    const questions = parsedQuestions.map((parsed) => parsed.question);
    if (questions.length === 0 || !this.options.requestUserInput) {
      return { answers: {} };
    }
    const answerMapsByQuestionId = Object.fromEntries(
      parsedQuestions.map((parsed) => [parsed.question.id, parsed.answersByLabel]),
    );
    const requestId = asString(params.toolCallId)?.trim() || randomUUID();
    const answers = await this.options.requestUserInput({
      requestId,
      title: asString(params.title)?.trim() || "Cursor question",
      content: questions.map((question) => question.question).join("\n"),
      questions,
      metadata: {
        provider: PROVIDER,
        source: "cursor-acp",
        rawRequest: sanitizeMetadataValue(params),
      },
    });
    return { answers: mapCursorUserInputAnswers(answers, answerMapsByQuestionId) };
  }

  private async handlePermissionRequest(params: unknown): Promise<Record<string, unknown>> {
    const allowOnce = selectAllowOnceOption(params) ?? "allow-once";
    const allowAlways = selectAllowAlwaysOption(params) ?? "allow-always";
    const reject = selectRejectOption(params) ?? "reject-once";
    const permissionTool = getPermissionTool(params);
    const previousTool = permissionTool ? this.toolStates.get(permissionTool.id) : undefined;
    const tool = mergeCursorPermissionToolState(previousTool, params);
    if (tool) {
      if (tool.toolName?.startsWith("buildwarden_")) {
        this.mcpToolNameMatcher.registerCursorTool(tool.id);
      }
      this.toolStates.set(tool.id, tool);
      if (previousTool && !isCursorSubagentToolState(tool)) {
        this.options.onChunk?.(this.withUsage(buildCursorToolChunkForState({
          ...tool,
          status: "inProgress",
        })));
      }
    }
    const kind = normalizeToken(tool?.kind);

    if (this.options.yoloMode) {
      return permissionResponse(allowAlways ?? allowOnce);
    }
    if (kind === "read" || kind === "fetch" || kind === "search") {
      return permissionResponse(allowOnce ?? allowAlways);
    }
    if (kind === "edit" || kind === "delete" || kind === "move") {
      return permissionResponse(this.options.mode === "code" ? allowOnce ?? allowAlways : reject);
    }
    if (kind === "execute") {
      const command = tool?.command;
      if (!command || !this.options.requestShellApproval) {
        return permissionResponse(reject);
      }
      const decision = await this.options.requestShellApproval(command);
      if (decision === "allow-always" || decision === "allow-for-run") {
        return permissionResponse(allowAlways ?? allowOnce);
      }
      if (decision === "allow-once") {
        return permissionResponse(allowOnce ?? allowAlways);
      }
      return permissionResponse(reject);
    }
    return permissionResponse(this.options.mode === "code" ? allowOnce ?? allowAlways : reject);
  }

  private mergeUsage(update: RunTokenUsage | null): void {
    if (!update) {
      return;
    }
    this.usage = addUsage(this.usage, update);
    this.options.onUsage?.(this.usage);
  }

  private withUsage(chunk: HarnessRunChunk): HarnessRunChunk {
    if (this.usage.inputTokens === 0 && this.usage.outputTokens === 0 && this.usage.maxTokens === undefined) {
      return chunk;
    }
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        usageTotals: this.usage,
      },
    };
  }
}

export const parseCursorAvailableModelsResponse = (response: unknown): ProviderAvailableModel[] => {
  if (!isRecord(response) || !Array.isArray(response.models)) {
    return [];
  }
  const seen = new Set<string>();
  const models: ProviderAvailableModel[] = [];
  for (const raw of response.models) {
    if (!isRecord(raw)) {
      continue;
    }
    const modelId = asString(raw.value)?.trim() ?? asString(raw.model)?.trim() ?? asString(raw.id)?.trim();
    if (!modelId || seen.has(modelId.toLowerCase())) {
      continue;
    }
    seen.add(modelId.toLowerCase());
    const displayName = asString(raw.name)?.trim() ?? asString(raw.displayName)?.trim() ?? modelId;
    const configOptions = Array.isArray(raw.configOptions) ? raw.configOptions.filter(isRecord) : [];
    models.push({
      modelId,
      displayName,
      source: "provider",
      config: buildCursorModelConfig(configOptions),
    });
  }
  return models;
};

export const listAvailableModelsWithCursorAgent = async (
  context: ProviderAvailableModelsContext,
): Promise<ProviderAvailableModel[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  const runtime = new CursorAcpRuntime({
    cwd: process.cwd(),
    binaryPath: getCursorAgentBinaryPath(context.config),
    apiEndpoint: getCursorAgentApiEndpoint(context.config),
    modelId: CURSOR_DEFAULT_MODEL,
    mode: "ask",
    signal: controller.signal,
  });
  try {
    return await runtime.discoverModels();
  } finally {
    clearTimeout(timeout);
    runtime.close();
  }
};

const getCursorFallbackModels = (): string[] =>
  getModelPresetsForProvider(PROVIDER, undefined).map((preset) => preset.modelId);

type CursorAboutResult = { status: number | null; stdout: string; stderr: string; error?: Error };

const runCursorAbout = async (binaryPath: string, args: string[]): Promise<CursorAboutResult> => {
  let launch: CursorProcessLaunch;
  try {
    launch = resolveCursorAgentProcessLaunch(binaryPath, args);
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  return await new Promise<CursorAboutResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcessWithoutNullStreams | undefined;

    const finish = (result: CursorAboutResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child?.kill();
      finish({
        status: null,
        stdout,
        stderr,
        error: new Error(`Cursor Agent about timed out after ${String(ABOUT_TIMEOUT_MS)}ms.`),
      });
    }, ABOUT_TIMEOUT_MS);

    try {
      child = spawn(launch.command, launch.args, {
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (error) {
      finish({
        status: null,
        stdout,
        stderr,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      finish({ status: code, stdout, stderr });
    });
  });
};

const combinedCommandOutput = (result: { stdout: string; stderr: string }): string =>
  [result.stdout, result.stderr].join("\n").trim();

const isCursorAboutJsonFormatUnsupported = (result: { stdout: string; stderr: string }): boolean => {
  const lower = combinedCommandOutput(result).toLowerCase();
  return (
    lower.includes("unknown option '--format'") ||
    lower.includes("unexpected argument '--format'") ||
    lower.includes("unrecognized option '--format'") ||
    lower.includes("unknown argument '--format'") ||
    lower.includes("not in the list of known options")
  );
};

const isCursorDesktopCliOutput = (output: string): boolean => {
  const lower = output.toLowerCase();
  return lower.includes("usage: cursor.exe") || lower.includes("run with 'cursor -'") || lower.includes("subcommands");
};

export const parseCursorAboutOutput = (output: string): { authenticated: boolean | null; detail?: string } => {
  const trimmed = output.trim();
  if (!trimmed) {
    return { authenticated: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      if (Object.prototype.hasOwnProperty.call(parsed, "userEmail") && parsed.userEmail == null) {
        return { authenticated: false };
      }
      const email = asString(parsed.userEmail)?.trim() ?? asString(parsed.email)?.trim();
      if (email) {
        const lowerEmail = email.toLowerCase();
        if (lowerEmail === "not logged in" || lowerEmail.includes("login required") || lowerEmail.includes("authentication required")) {
          return { authenticated: false };
        }
        return { authenticated: true, detail: email };
      }
      if (parsed.authenticated === false || parsed.loggedIn === false) {
        return { authenticated: false };
      }
    }
  } catch {
    /* Fall back to plain text heuristics. */
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("not logged") || lower.includes("not authenticated") || lower.includes("login required")) {
    return { authenticated: false };
  }
  return { authenticated: null, detail: trimmed.split(/\r?\n/)[0] };
};

export async function assertCursorAgentAvailable(config?: Record<string, unknown>): Promise<void> {
  const explicitBinaryPath = readConfigString(config, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY);
  const binaryCandidates = explicitBinaryPath
    ? [explicitBinaryPath]
    : Array.from(new Set([getDefaultCursorAgentBinaryPath(), "agent", "cursor-agent"]));
  let lastDetail = "";
  let lastBinaryPath = binaryCandidates[0] ?? "agent";

  for (const binaryPath of binaryCandidates) {
    lastBinaryPath = binaryPath;
    const first = await runCursorAbout(binaryPath, ["about", "--format", "json"]);
    const second = first.status === 0 && !isCursorAboutJsonFormatUnsupported(first) ? first : await runCursorAbout(binaryPath, ["about"]);
    lastDetail = combinedCommandOutput(second) || combinedCommandOutput(first);
    if (second.error) {
      lastDetail = second.error.message;
      continue;
    }
    if (second.status !== 0) {
      continue;
    }
    if (isCursorDesktopCliOutput(lastDetail)) {
      throw new Error(
        "Cursor desktop was found, but it is not the Cursor Agent CLI ACP server. Install or expose the Cursor Agent CLI as `agent` or `cursor-agent`, run `agent login`, then try again.",
      );
    }
    const auth = parseCursorAboutOutput(lastDetail);
    if (auth.authenticated === false) {
      throw new Error('Cursor Agent is not authenticated. Run "agent login" in your terminal and try again.');
    }
    return;
  }

  const detailSuffix = lastDetail ? `\n\n${lastDetail}` : "";
  throw new Error(
    `Cursor Agent CLI was not found or is not available at "${lastBinaryPath}". Install Cursor CLI, expose \`agent\` or \`cursor-agent\` on PATH, run "agent login", and ensure "agent about" works.${detailSuffix}`,
  );
}

export class CursorAgentProviderAdapter implements ProviderAdapter {
  readonly providerType = PROVIDER;

  listRecommendedModels(): string[] {
    return getCursorFallbackModels();
  }

  async listAvailableModels(context: ProviderAvailableModelsContext): Promise<ProviderAvailableModel[]> {
    return listAvailableModelsWithCursorAgent(context);
  }

  validateConfiguration(input: ProviderAccountInput): void {
    const binaryPath = input.config?.[PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY];
    if (typeof binaryPath === "string" && binaryPath.trim().length === 0) {
      throw new Error("Cursor binary path cannot be blank when provided.");
    }
    const apiEndpoint = input.config?.[PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY];
    if (typeof apiEndpoint === "string" && apiEndpoint.trim().length === 0) {
      throw new Error("Cursor API endpoint cannot be blank when provided.");
    }
  }
}

const sessionIdFromResumeCursor = (input: RunExecutionRequest): string | undefined => {
  const cursor = input.providerSessionRuntime?.resumeCursor;
  if (!isRecord(cursor)) {
    return undefined;
  }
  const schemaVersion = asFiniteNumber(cursor.schemaVersion);
  const sessionId = asString(cursor.sessionId)?.trim();
  return schemaVersion === CURSOR_RESUME_SCHEMA_VERSION && sessionId ? sessionId : undefined;
};

const cursorRuntimeFromRunInput = (
  input: RunExecutionRequest,
  onChunk: (chunk: HarnessRunChunk) => void,
  signal: AbortSignal,
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
  mcpServers?: Array<Record<string, unknown>>,
): CursorAcpRuntime => {
  const devLogger = createCursorDevLogger({
    logDirPath: input.devLogging?.logDirPath,
    runId: input.runId,
    modelId: input.modelId || CURSOR_DEFAULT_MODEL,
    sessionType: input.isChat ? "chat" : "run",
  });
  return new CursorAcpRuntime({
    cwd: input.worktreePath,
    binaryPath: getCursorAgentBinaryPath(input.config),
    apiEndpoint: getCursorAgentApiEndpoint(input.config),
    devLogger: devLogger.enabled ? devLogger : undefined,
    resumeSessionId: sessionIdFromResumeCursor(input),
    modelId: input.modelId,
    mode: input.mode,
    yoloMode: input.yoloMode,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    attachments: input.attachments,
    requestShellApproval: input.yoloMode ? undefined : requestShellApproval,
    requestUserInput,
    onChunk,
    signal,
    mcpServers,
  });
};

export class CursorAgentHarnessAdapter implements HarnessAdapter {
  readonly harnessType = HARNESS;

  constructor(
    private readonly requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>,
    private readonly requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>,
  ) {}

  async run(
    input: RunExecutionRequest,
    toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): Promise<{
    summary: string;
    responseId: string | null;
    usage: RunTokenUsage;
    providerSessionRuntime?: {
      cwd: string;
      modelId: string;
      runtimeMode: RunMode;
      resumeCursor: Record<string, unknown>;
      runtimePayload: Record<string, unknown>;
      status?: "starting" | "running" | "ready" | "stopped" | "error";
    };
  }> {
    let runtime: CursorAcpRuntime | undefined;
    const pendingMcpToolNames: string[] = [];
    const orchestrationMcp = await startCursorOrchestrationMcp(toolContext, (toolName) => {
      if (runtime) {
        runtime.recordMcpToolCallName(toolName);
      } else {
        pendingMcpToolNames.push(toolName);
      }
    });
    const externalMcpServers = (input.mcpServers ?? []).map((server) => ({
      type: "http",
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    }));
    runtime = cursorRuntimeFromRunInput(
      input,
      onChunk,
      signal,
      this.requestShellApproval,
      this.requestUserInput,
      [...externalMcpServers, ...(orchestrationMcp ? [orchestrationMcp.config] : [])],
    );
    for (const toolName of pendingMcpToolNames) {
      runtime.recordMcpToolCallName(toolName);
    }
    try {
      const started = await runtime.start();
      const providerSessionRuntime = runtime.providerSessionRuntime;
      onChunk({
        type: "status",
        title: "Cursor session started",
        value: `Cursor ACP session ${started.sessionId} is ready.`,
        metadata: {
          provider: PROVIDER,
          providerSessionRuntime: {
            ...providerSessionRuntime,
            status: "running",
          },
        },
      });
      const result = await runtime.prompt(input.prompt);
      return {
        summary: result.summary,
        responseId: started.sessionId,
        usage: result.usage,
        providerSessionRuntime: {
          ...providerSessionRuntime,
          status: "ready",
        },
      };
    } finally {
      runtime.close();
      await orchestrationMcp?.close().catch(() => undefined);
    }
  }
}

type GenerateAskTextWithCursorAgentInput = {
  cwd: string;
  prompt: string;
  modelId: string;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: ProviderExecutionOptions;
  signal?: AbortSignal;
  devLogging?: {
    logDirPath: string;
    runId?: string;
    sessionType?: "run" | "chat";
  };
};

export async function generateAskTextResultWithCursorAgent(input: GenerateAskTextWithCursorAgentInput): Promise<{
  text: string;
  usage: RunTokenUsage;
}> {
  const harness = new CursorAgentHarnessAdapter();
  const result = await harness.run(
    {
      runId: input.devLogging?.runId ?? "ask-text",
      worktreePath: input.cwd,
      mode: "ask",
      prompt: input.prompt,
      providerType: PROVIDER,
      modelId: input.modelId || CURSOR_DEFAULT_MODEL,
      apiKey: "",
      config: input.config,
      modelConfig: input.modelConfig,
      providerOptions: input.providerOptions,
      isChat: true,
      devLogging: input.devLogging ? { logDirPath: input.devLogging.logDirPath } : undefined,
    },
    {
      tools: [],
      executeTool: async () => {
        throw new Error("Cursor ask text has no BuildWarden tools.");
      },
    },
    () => undefined,
    input.signal ?? new AbortController().signal,
  );
  return {
    text: result.summary.trim(),
    usage: result.usage,
  };
}

export async function generateAskTextWithCursorAgent(input: GenerateAskTextWithCursorAgentInput): Promise<string> {
  return (await generateAskTextResultWithCursorAgent(input)).text;
}

export async function generateUtilityTextWithCursorAgent(
  input: GenerateAskTextWithCursorAgentInput & UtilityTextGenerationOptions,
): Promise<{ text: string; usage: RunTokenUsage }> {
  const apiEndpoint = getCursorAgentApiEndpoint(input.config);
  const launch = resolveCursorAgentProcessLaunch(getCursorAgentBinaryPath(input.config), [
    ...(apiEndpoint ? ["-e", apiEndpoint] : []),
    "--print", "--mode", "ask", "--trust", "--output-format", "json",
    "--model", input.modelId || CURSOR_DEFAULT_MODEL,
  ]);
  const stdout = await runTextGenerationProcess({
    ...launch,
    cwd: input.cwd,
    prompt: input.prompt,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Cursor text generation returned output that is not valid JSON.");
  }
  const result = isRecord(parsed) ? parsed : undefined;
  createCursorDevLogger({
    logDirPath: input.devLogging?.logDirPath,
    runId: input.devLogging?.runId ?? "utility-text",
    modelId: input.modelId,
    sessionType: "chat",
  }).log("cursor.print.result", result);
  if (result?.type !== "result" || result.is_error === true || result.subtype !== "success") {
    throw new Error(asString(result?.result) ?? "Cursor text generation did not complete successfully.");
  }
  const text = asString(result.result)?.trim();
  if (!text) throw new Error("Cursor text generation returned an empty answer.");
  // Some CLI versions omit usage in print mode. Never estimate or re-run a paid request.
  return { text, usage: normalizeCursorTokenUsage(result) ?? { inputTokens: 0, outputTokens: 0 } };
}

export async function suggestCommitMessageWithCursorAgent(input: {
  cwd: string;
  diffPrompt: string;
  modelId: string;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: ProviderExecutionOptions;
  signal?: AbortSignal;
}): Promise<string> {
  return generateAskTextWithCursorAgent({
    cwd: input.cwd,
    prompt: input.diffPrompt,
    modelId: input.modelId || CURSOR_DEFAULT_MODEL,
    config: input.config,
    modelConfig: input.modelConfig,
    providerOptions: input.providerOptions,
    signal: input.signal,
  });
}
