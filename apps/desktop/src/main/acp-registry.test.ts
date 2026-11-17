import { expect, it, vi } from "vitest";
import { listAcpRegistryAgents, parseAcpRegistry } from "./acp-registry";

it("offers pinned package commands without shell metacharacters", () => {
  const agent = (name: string, args: string[] = []) => ({ id: name, name, distribution: { npx: { package: name, args } } });
  expect(parseAcpRegistry({ agents: [agent("@example/agent@1.2.3", ["--acp"]), agent("agent@latest"), agent("agent@1.2.3", ["& calc"])] }))
    .toEqual([{ id: "@example/agent@1.2.3", name: "@example/agent@1.2.3", description: "", command: "npx --yes @example/agent@1.2.3 --acp" }]);
});

it("omits distributions whose environment cannot be preserved by the command picker", () => {
  const agent = (id: string, env?: unknown) => ({ id, name: id, distribution: { npx: { package: "agent@1.2.3", env } } });
  expect(parseAcpRegistry({ agents: [
    agent("without-env"), agent("empty-env", {}),
    agent("requires-env", { AUGMENT_DISABLE_AUTO_UPDATE: "1" }),
    agent("invalid-env", "SETTING=value"), agent("null-env", null), agent("array-env", []),
  ] }).map((entry) => entry.id)).toEqual(["without-env", "empty-env"]);
});

it("loads the registry through the supplied application fetch", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ agents: [
    { id: "agent", name: "Agent", distribution: { npx: { package: "agent@1.2.3" } } },
  ] })));
  await expect(listAcpRegistryAgents(fetcher)).resolves.toEqual([
    { id: "agent", name: "Agent", description: "", command: "npx --yes agent@1.2.3" },
  ]);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json", { signal: expect.any(AbortSignal) },
  );
});
