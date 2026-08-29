import { describe, expect, it } from "vitest";
import { resolveMcpServerRuntimeConfigs } from "./mcp-server-registry";

describe("MCP server registry", () => {
  const servers = [{
    id: "docs",
    name: "Docs",
    url: "https://example.test/mcp",
    enabled: true,
    headers: [{ name: "Authorization", environmentVariable: "DOCS_MCP_TOKEN" }],
  }];

  it("resolves header secrets from the environment without changing persisted config", () => {
    expect(resolveMcpServerRuntimeConfigs(servers, { DOCS_MCP_TOKEN: "Bearer secret" })).toEqual([{
      name: "Docs",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer secret" },
    }]);
    expect(servers[0]?.headers[0]).toEqual({ name: "Authorization", environmentVariable: "DOCS_MCP_TOKEN" });
  });

  it("fails before starting an agent when a required environment variable is missing", () => {
    expect(() => resolveMcpServerRuntimeConfigs(servers, {})).toThrow("DOCS_MCP_TOKEN");
  });

  it("omits disabled servers", () => {
    expect(resolveMcpServerRuntimeConfigs([{ ...servers[0]!, enabled: false }], {})).toEqual([]);
  });
});
