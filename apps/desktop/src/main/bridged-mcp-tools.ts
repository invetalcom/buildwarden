import { connectBridgedMcpServers, isBridgedMcpToolName, type BridgedMcpSession } from "@buildwarden/agent-runtime";
import {
  mcpToolApprovalKey,
  type ApprovalRequester,
  type BridgedMcpToolName,
  type HarnessRunChunk,
  type HarnessToolContext,
  type McpServerRuntimeConfig,
  type RunMode,
  type RunToolResult,
} from "@buildwarden/shared";

const MAX_APPROVAL_ARGUMENT_CHARS = 400;

/**
 * Adds a project's MCP server tools to a function-calling harness's tool context. Inspect modes
 * (ask, plan) get only tools their server marks read-only. Without Full Access every call asks
 * the user first, the same way shell commands do. "Allow for run" covers that tool for the run;
 * "always allow" is stored by server and tool name, apart from shell patterns. A required server
 * that cannot connect fails the run; an optional one is reported and skipped.
 */
export const bridgeProjectMcpServers = async (
  servers: readonly McpServerRuntimeConfig[],
  base: HarnessToolContext,
  options: {
    mode: RunMode;
    yoloMode: boolean;
    requestApproval: ApprovalRequester;
    /** Approval keys the user chose to always allow in this project. */
    alwaysAllowed?: readonly string[];
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
  const requiredFailures = failed.filter((server) => servers.some((entry) => entry.name === server.name && entry.required === true));
  if (requiredFailures.length > 0) {
    await session.close().catch(() => undefined);
    throw new Error(`Required project MCP server${requiredFailures.length === 1 ? "" : "s"} could not connect: ${
      requiredFailures.map((server) => `${server.name} (${server.error ?? "unknown error"})`).join("; ")}.`);
  }
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
      const approvalKey = mcpToolApprovalKey(tool.serverName, tool.toolName);
      if (!options.yoloMode && !allowedForRun.has(tool.name) && !options.alwaysAllowed?.includes(approvalKey)) {
        const argumentsText = JSON.stringify(call.arguments);
        const decision = await options.requestApproval(
          `mcp ${tool.serverName} ${tool.toolName} ${argumentsText.length > MAX_APPROVAL_ARGUMENT_CHARS ? `${argumentsText.slice(0, MAX_APPROVAL_ARGUMENT_CHARS)}…` : argumentsText}`,
          { approvalKey },
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
