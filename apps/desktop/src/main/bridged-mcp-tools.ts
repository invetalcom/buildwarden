import { connectBridgedMcpServers, isBridgedMcpToolName, type BridgedMcpSession } from "@buildwarden/agent-runtime";
import type {
  BridgedMcpToolName,
  HarnessRunChunk,
  HarnessToolContext,
  McpServerRuntimeConfig,
  RunMode,
  RunToolResult,
  ShellApprovalDecision,
} from "@buildwarden/shared";

const MAX_APPROVAL_ARGUMENT_CHARS = 400;

/**
 * Adds a project's MCP server tools to a function-calling harness's tool context. Inspect modes
 * (ask, plan) get only tools their server marks read-only. Without Full Access every call asks
 * the user first, the same way shell commands do, and "allow for run" covers that tool.
 */
export const bridgeProjectMcpServers = async (
  servers: readonly McpServerRuntimeConfig[],
  base: HarnessToolContext,
  options: {
    mode: RunMode;
    yoloMode: boolean;
    requestApproval: (command: string) => Promise<ShellApprovalDecision>;
    onChunk: (chunk: HarnessRunChunk) => void;
    signal: AbortSignal;
    connect?: typeof connectBridgedMcpServers;
  },
): Promise<{ toolContext: HarnessToolContext; session: BridgedMcpSession; close: () => Promise<void> }> => {
  const session = await (options.connect ?? connectBridgedMcpServers)(servers, { signal: options.signal });
  const readOnlyOnly = options.mode !== "code";
  const tools = session.tools.filter((tool) => !readOnlyOnly || tool.readOnly);
  const exposed = new Set(tools.map((tool) => tool.name));
  const allowedForRun = new Set<string>();
  const failed = session.servers.filter((server) => server.status === "failed");
  options.onChunk({
    type: failed.length > 0 ? "error" : "status",
    title: "Project MCP servers",
    value: [
      ...session.servers.filter((server) => server.status === "connected").map((server) => `${server.name}: ${String(server.toolCount)} tools`),
      ...failed.map((server) => `${server.name}: could not connect (${server.error ?? "unknown error"})`),
      ...(readOnlyOnly && tools.length < session.tools.length
        ? [`${String(session.tools.length - tools.length)} tools without a read-only hint are unavailable in ${options.mode} mode.`]
        : []),
    ].join("\n"),
    metadata: {
      silent: failed.length === 0,
      sessionCapabilities: {
        reportedAt: new Date().toISOString(),
        mcpServers: session.servers.map((server) => ({ name: server.name, status: server.status })),
      },
    },
  });
  const toolContext: HarnessToolContext = {
    tools: [
      ...base.tools,
      ...tools.map((tool) => ({ name: tool.name as BridgedMcpToolName, description: tool.description, inputSchema: tool.inputSchema })),
    ],
    executeTool: async (call): Promise<RunToolResult> => {
      if (!isBridgedMcpToolName(call.name)) return base.executeTool(call);
      if (!exposed.has(call.name)) {
        return { toolCallId: call.id, name: call.name, ok: false, content: `MCP tool ${call.name} is not available in this run.` };
      }
      const tool = tools.find((entry) => entry.name === call.name)!;
      if (!options.yoloMode && !allowedForRun.has(tool.name)) {
        const argumentsText = JSON.stringify(call.arguments);
        const decision = await options.requestApproval(
          `mcp ${tool.serverName} ${tool.toolName} ${argumentsText.length > MAX_APPROVAL_ARGUMENT_CHARS ? `${argumentsText.slice(0, MAX_APPROVAL_ARGUMENT_CHARS)}…` : argumentsText}`,
        );
        if (decision === "deny") {
          return { toolCallId: call.id, name: call.name, ok: false, content: "The user denied this MCP tool call." };
        }
        if (decision !== "allow-once") allowedForRun.add(tool.name);
      }
      const result = await session.call(tool.name, call.arguments, options.signal);
      return {
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        content: result.content,
        ...(result.images.length > 0
          ? { images: result.images.filter((image): image is { mimeType: "image/png" | "image/jpeg"; data: string } =>
            image.mimeType === "image/png" || image.mimeType === "image/jpeg") }
          : {}),
        metadata: { mcpServer: tool.serverName, mcpTool: tool.toolName },
      };
    },
  };
  return { toolContext, session, close: () => session.close() };
};
