import { expect, it } from "vitest";
import { parseAcpRegistry } from "./acp-registry";

it("offers pinned package commands without shell metacharacters", () => {
  const agent = (name: string, args: string[] = []) => ({ id: name, name, distribution: { npx: { package: name, args } } });
  expect(parseAcpRegistry({ agents: [agent("@example/agent@1.2.3", ["--acp"]), agent("agent@latest"), agent("agent@1.2.3", ["& calc"])] }))
    .toEqual([{ id: "@example/agent@1.2.3", name: "@example/agent@1.2.3", description: "", command: "npx --yes @example/agent@1.2.3 --acp" }]);
});
