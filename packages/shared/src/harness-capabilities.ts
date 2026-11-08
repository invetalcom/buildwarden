import type { ModelExecutionControlId, ProviderType } from "./index";

export type HarnessApprovalKind = "shell" | "file-change" | "tool";

/** Implemented integration behavior, not capabilities inferred from a model name. */
export interface HarnessCapabilities {
  /** A running turn accepts more user input. */
  liveSteering: boolean;
  nativeSessionResume: boolean;
  replayRunHistory: boolean;
  instructionChannel: "developer" | "system" | "prompt";
  /** `native-http`: the agent connects to project MCP servers itself; `bridged`: BuildWarden's MCP client exposes their tools. */
  projectMcp: "native-http" | "bridged" | "unsupported";
  toolTransport: "dynamic-tools" | "sdk-mcp" | "http-mcp" | "function-tools";
  /** `native`: the agent stops the turn and keeps its session; `abort`: BuildWarden ends the request or process. */
  interrupt: "native" | "abort";
  /** Approval prompts the integration raises for the user. Full Access skips them. */
  approvals: readonly HarnessApprovalKind[];
  /** The agent can ask the user structured questions mid-turn. */
  structuredQuestions: boolean;
  /** The agent can start its own subagents or background tasks inside one turn. */
  nativeSubagents: boolean;
  /** Steered input may carry attachments. */
  attachmentSteering: boolean;
  /** Execution settings a delegated task may override, when the model also offers them. */
  taskExecutionOptions: readonly ModelExecutionControlId[];
}

const apiCapabilities: HarnessCapabilities = {
  liveSteering: false, nativeSessionResume: false, replayRunHistory: true,
  instructionChannel: "system", projectMcp: "bridged", toolTransport: "function-tools",
  interrupt: "abort", approvals: ["shell"], structuredQuestions: true, nativeSubagents: false,
  attachmentSteering: false, taskExecutionOptions: ["reasoningEffort", "serviceTier", "speed", "thinkingLevel"],
};

const capabilities: Record<ProviderType, Readonly<HarnessCapabilities>> = {
  "ai-sdk": apiCapabilities,
  openrouter: apiCapabilities,
  "azure-legacy": { ...apiCapabilities, replayRunHistory: false, taskExecutionOptions: [] },
  "codex-cli": {
    liveSteering: true, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "developer", projectMcp: "native-http", toolTransport: "dynamic-tools",
    interrupt: "native", approvals: ["shell", "file-change"], structuredQuestions: true, nativeSubagents: true,
    attachmentSteering: true, taskExecutionOptions: ["reasoningEffort", "serviceTier"],
  },
  "claude-code": {
    liveSteering: true, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "system", projectMcp: "native-http", toolTransport: "sdk-mcp",
    interrupt: "native", approvals: ["shell", "file-change", "tool"], structuredQuestions: true, nativeSubagents: true,
    attachmentSteering: true, taskExecutionOptions: ["reasoningEffort", "speed", "thinkingLevel"],
  },
  "cursor-agent": {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "prompt", projectMcp: "native-http", toolTransport: "http-mcp",
    interrupt: "native", approvals: ["shell", "file-change"], structuredQuestions: true, nativeSubagents: false,
    attachmentSteering: false, taskExecutionOptions: ["reasoningEffort", "contextMode", "speed"],
  },
  acp: {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "prompt", projectMcp: "native-http", toolTransport: "http-mcp",
    interrupt: "native", approvals: ["shell", "file-change", "tool"], structuredQuestions: false, nativeSubagents: false,
    attachmentSteering: false, taskExecutionOptions: [],
  },
};

export const getHarnessCapabilities = (providerType: ProviderType): Readonly<HarnessCapabilities> => capabilities[providerType];

/**
 * What a live session reported about itself when it started. Static capabilities describe the
 * integration; these describe the installed agent (its version, which MCP servers connected),
 * and may only narrow what the integration supports.
 */
export interface HarnessSessionCapabilities {
  reportedAt: string;
  agentName?: string;
  agentVersion?: string;
  /** False when this agent build cannot accept input mid-turn. */
  liveSteering?: boolean;
  /** False when the agent cannot reach HTTP MCP servers, so orchestration tools and project MCP are unavailable. */
  mcpHttp?: boolean;
  /** False when the agent cannot reload an earlier session. */
  sessionResume?: boolean;
  nativeSubagents?: boolean;
  /** Connection state the agent reported for each MCP server, including BuildWarden's own. */
  mcpServers?: Array<{ name: string; status: string }>;
}

/** Static capabilities narrowed by what a session reported. A report never widens support. */
export const effectiveHarnessCapabilities = (
  providerType: ProviderType,
  reported?: HarnessSessionCapabilities | null,
): Readonly<HarnessCapabilities> => {
  const base = getHarnessCapabilities(providerType);
  if (!reported) return base;
  return {
    ...base,
    liveSteering: base.liveSteering && reported.liveSteering !== false,
    nativeSessionResume: base.nativeSessionResume && reported.sessionResume !== false,
    nativeSubagents: base.nativeSubagents && reported.nativeSubagents !== false,
    projectMcp: base.projectMcp === "native-http" && reported.mcpHttp === false ? "unsupported" : base.projectMcp,
  };
};

/** Reads a session report from chunk metadata, ignoring anything malformed. */
export const parseHarnessSessionCapabilities = (value: unknown): HarnessSessionCapabilities | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const optionalBoolean = (key: string) => typeof raw[key] === "boolean" ? { [key]: raw[key] as boolean } : {};
  const optionalString = (key: string) => typeof raw[key] === "string" && raw[key] ? { [key]: (raw[key] as string).slice(0, 120) } : {};
  const mcpServers = Array.isArray(raw.mcpServers)
    ? raw.mcpServers.flatMap((entry): Array<{ name: string; status: string }> => {
      if (!entry || typeof entry !== "object") return [];
      const { name, status } = entry as Record<string, unknown>;
      return typeof name === "string" && typeof status === "string" ? [{ name: name.slice(0, 120), status: status.slice(0, 40) }] : [];
    }).slice(0, 40)
    : undefined;
  return {
    reportedAt: typeof raw.reportedAt === "string" ? raw.reportedAt : new Date().toISOString(),
    ...optionalString("agentName"),
    ...optionalString("agentVersion"),
    ...optionalBoolean("liveSteering"),
    ...optionalBoolean("mcpHttp"),
    ...optionalBoolean("sessionResume"),
    ...optionalBoolean("nativeSubagents"),
    ...(mcpServers ? { mcpServers } : {}),
  };
};

/** Application-owned delivery and session availability are separate from adapter support. */
export const resolveHarnessDelivery = (
  providerType: ProviderType,
  state: { running: boolean; resumable: boolean },
  reported?: HarnessSessionCapabilities | null,
) => {
  const support = effectiveHarnessCapabilities(providerType, reported);
  return {
    liveSteering: {
      supported: support.liveSteering,
      available: support.liveSteering && state.running,
      reason: !support.liveSteering ? "This integration does not implement live steering." : !state.running ? "No turn is running." : null,
    },
    queuedDelivery: { supported: true, available: true },
    interruptAndResume: {
      supported: support.nativeSessionResume || support.replayRunHistory,
      available: state.running && (support.replayRunHistory || (support.nativeSessionResume && state.resumable)),
    },
  };
};
