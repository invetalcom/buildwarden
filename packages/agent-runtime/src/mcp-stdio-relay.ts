import { MCP_RELAY_HEADERS_ENV, MCP_RELAY_URL_ENV } from "./mcp-stdio-relay-main";

export { runMcpStdioRelay } from "./mcp-stdio-relay-main";

/**
 * How to start the stdio relay (`mcp-stdio-relay-main.ts`). The desktop main process sets it once at
 * startup; workers inherit the environment, so every harness reads the same launch.
 */
export const MCP_STDIO_RELAY_LAUNCH_ENV = "BUILDWARDEN_MCP_STDIO_RELAY";

export interface McpStdioRelayLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** An MCP server entry as ACP's `session/new` takes it for the stdio transport. */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export const configureMcpStdioRelay = (launch: McpStdioRelayLaunch, env: NodeJS.ProcessEnv = process.env): void => {
  env[MCP_STDIO_RELAY_LAUNCH_ENV] = JSON.stringify(launch);
};

export const resolveMcpStdioRelayLaunch = (env: NodeJS.ProcessEnv = process.env): McpStdioRelayLaunch | null => {
  const raw = env[MCP_STDIO_RELAY_LAUNCH_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<McpStdioRelayLaunch>;
    if (typeof parsed.command !== "string" || !parsed.command || !Array.isArray(parsed.args)) return null;
    return {
      command: parsed.command,
      args: parsed.args.filter((arg): arg is string => typeof arg === "string"),
      ...(parsed.env && typeof parsed.env === "object" ? { env: parsed.env } : {}),
    };
  } catch {
    return null;
  }
};

/** A stdio MCP server that relays to the HTTP endpoint `target`. */
export const acpStdioRelayServer = (
  launch: McpStdioRelayLaunch,
  name: string,
  target: { url: string; headers?: Record<string, string> },
): AcpStdioMcpServer => ({
  name,
  command: launch.command,
  args: launch.args,
  env: [
    ...Object.entries(launch.env ?? {}).map(([key, value]) => ({ name: key, value })),
    { name: MCP_RELAY_URL_ENV, value: target.url },
    { name: MCP_RELAY_HEADERS_ENV, value: JSON.stringify(target.headers ?? {}) },
  ],
});
