import type { AcpRegistryAgent } from "@buildwarden/shared";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Only package distributions with pinned versions produce executable command suggestions. */
export const parseAcpRegistry = (value: unknown): AcpRegistryAgent[] => {
  if (!record(value) || !Array.isArray(value.agents)) throw new Error("Invalid ACP registry response.");
  return value.agents.filter(record).slice(0, 500).flatMap((agent): AcpRegistryAgent[] => {
    if (typeof agent.id !== "string" || typeof agent.name !== "string") return [];
    const distribution = record(agent.distribution) ? agent.distribution : {};
    const npx = record(distribution.npx) ? distribution.npx : null;
    // The picker imports only a command; do not silently discard required environment settings.
    if (npx?.env !== undefined && (!record(npx.env) || Object.keys(npx.env).length > 0)) return [];
    const packageName = npx?.package;
    if (typeof packageName !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(packageName)) return [];
    const args = npx?.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && /^[a-z0-9_./:=@-]+$/i.test(arg))) return [];
    return [{ id: agent.id.slice(0, 120), name: agent.name.slice(0, 120),
      description: typeof agent.description === "string" ? agent.description.slice(0, 500) : "",
      command: ["npx", "--yes", packageName, ...args].join(" ") }];
  });
};

export const listAcpRegistryAgents = async (fetcher: typeof fetch): Promise<AcpRegistryAgent[]> => {
  const response = await fetcher("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ACP registry returned HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("ACP registry response is too large.");
  return parseAcpRegistry(JSON.parse(body));
};
