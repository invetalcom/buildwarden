import type { McpServerRuntimeConfig, ProjectMcpServerConfig } from "@buildwarden/shared";

export const resolveMcpServerRuntimeConfigs = (
  servers: ProjectMcpServerConfig[],
  environment: NodeJS.ProcessEnv = process.env,
): McpServerRuntimeConfig[] => servers.filter((server) => server.enabled).map((server) => {
  const headers: Record<string, string> = {};
  for (const header of server.headers) {
    const value = environment[header.environmentVariable];
    if (!value) {
      throw new Error(
        `MCP server "${server.name}" requires environment variable ${header.environmentVariable} for header ${header.name}.`,
      );
    }
    headers[header.name] = value;
  }
  return {
    name: server.name,
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
});
