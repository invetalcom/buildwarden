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
  /**
   * What happens to the agent's background subagents still running when its turn finishes.
   * `continue`: the turn keeps the session open until they finish (within a limit), and the agent
   * may answer what they found before the run ends. `end-with-turn`: they stop with the turn, and
   * the result says that part of the work never finished.
   */
  backgroundSubagents: "continue" | "end-with-turn";
  /** Steered input may carry attachments. */
  attachmentSteering: boolean;
  /** Execution settings a delegated task may override, when the model also offers them. */
  taskExecutionOptions: readonly ModelExecutionControlId[];
  /**
   * `reported`: the integration returns token counts. `unavailable`: it reports none, so token
   * budgets cannot measure it and its totals are not real zeros.
   */
  usageReporting: "reported" | "unavailable";
  /**
   * How `auto` delivery reaches a running turn without live steering. `restart` interrupts the
   * turn and continues the saved session with the message; `queue` waits for the turn to end.
   */
  steeringFallback: "queue" | "restart";
}

const apiCapabilities: HarnessCapabilities = {
  liveSteering: false, nativeSessionResume: false, replayRunHistory: true,
  instructionChannel: "system", projectMcp: "bridged", toolTransport: "function-tools",
  interrupt: "abort", approvals: ["shell"], structuredQuestions: true, nativeSubagents: false,
  backgroundSubagents: "end-with-turn",
  attachmentSteering: false, taskExecutionOptions: ["reasoningEffort", "serviceTier", "speed", "thinkingLevel"],
  usageReporting: "reported", steeringFallback: "queue",
};

const capabilities: Record<ProviderType, Readonly<HarnessCapabilities>> = {
  "ai-sdk": apiCapabilities,
  openrouter: apiCapabilities,
  "azure-legacy": { ...apiCapabilities, replayRunHistory: false, taskExecutionOptions: [] },
  "codex-cli": {
    liveSteering: true, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "developer", projectMcp: "native-http", toolTransport: "dynamic-tools",
    interrupt: "native", approvals: ["shell", "file-change"], structuredQuestions: true, nativeSubagents: true,
    backgroundSubagents: "end-with-turn",
    attachmentSteering: true, taskExecutionOptions: ["reasoningEffort", "serviceTier"],
    usageReporting: "reported", steeringFallback: "queue",
  },
  "claude-code": {
    liveSteering: true, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "system", projectMcp: "native-http", toolTransport: "sdk-mcp",
    interrupt: "native", approvals: ["shell", "file-change", "tool"], structuredQuestions: true, nativeSubagents: true,
    backgroundSubagents: "continue",
    attachmentSteering: true, taskExecutionOptions: ["reasoningEffort", "speed", "thinkingLevel"],
    usageReporting: "reported", steeringFallback: "queue",
  },
  "cursor-agent": {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "prompt", projectMcp: "native-http", toolTransport: "http-mcp",
    interrupt: "native", approvals: ["shell", "file-change"], structuredQuestions: true, nativeSubagents: false,
    backgroundSubagents: "end-with-turn",
    attachmentSteering: false, taskExecutionOptions: ["reasoningEffort", "contextMode", "speed"],
    usageReporting: "reported", steeringFallback: "queue",
  },
  acp: {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "prompt", projectMcp: "native-http", toolTransport: "http-mcp",
    interrupt: "native", approvals: ["shell", "file-change", "tool"], structuredQuestions: false, nativeSubagents: false,
    backgroundSubagents: "end-with-turn",
    attachmentSteering: false, taskExecutionOptions: [],
    // ACP has no usage messages; a cancelled prompt keeps the session, so restarting is safe.
    usageReporting: "unavailable", steeringFallback: "restart",
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
  /**
   * The installed agent build the report came from, when BuildWarden can identify it. A report
   * from another build no longer describes the agent, so it stops counting once the build changes.
   */
  executableFingerprint?: string;
}

/** The result of asking BuildWarden to check a provider's capabilities again. */
export interface ProviderCapabilityRecheckResult {
  /** The fresh report, or null when the provider reports only once a session starts. */
  report: HarnessSessionCapabilities | null;
  message: string;
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
    // Without a resumable session, a restart would lose the turn's context.
    steeringFallback: reported.sessionResume === false ? "queue" : base.steeringFallback,
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
    ...(typeof raw.executableFingerprint === "string" && raw.executableFingerprint
      ? { executableFingerprint: raw.executableFingerprint.slice(0, 1_000) }
      : {}),
  };
};

/** Parses persisted session reports keyed by provider account id, dropping anything malformed. */
export const parseSessionCapabilityReportsSetting = (raw: string | undefined | null): Record<string, HarnessSessionCapabilities> => {
  if (raw == null || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, HarnessSessionCapabilities> = {};
    for (const [providerAccountId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const report = parseHarnessSessionCapabilities(value);
      if (report) result[providerAccountId] = report;
    }
    return result;
  } catch {
    return {};
  }
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
