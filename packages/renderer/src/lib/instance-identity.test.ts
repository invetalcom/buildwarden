import { describe, expect, it } from "vitest";
import { mapEntityIds, parseScopedId, scopedId } from "./instance-identity";

describe("instance entity identity", () => {
  it("round-trips delimiters and unicode without collisions", () => {
    const value = scopedId("cookie:https://computer:47831", "run:ä/%");
    expect(parseScopedId(value)).toEqual({ instanceId: "cookie:https://computer:47831", id: "run:ä/%" });
    expect(parseScopedId("bw-instance:%broken:id")).toBeNull();
    expect(scopedId("a:b", "c")).not.toBe(scopedId("a", "b:c"));
  });
  it("keeps persisted and live metadata references consistent while preserving user content", () => {
    const metadata = { userInputRequestId: "request", browserRunId: "run", subagentId: "child", questions: [{ id: "choice" }], answers: { id: "literal" }, input: { id: "user-id" } };
    const mapped = mapEntityIds({ metadata, metadataJson: JSON.stringify(metadata), content: "run", mcpServers: [{ id: "mcp" }], forgeRequest: { id: "123" } }, (id) => scopedId("a", id));
    expect(JSON.parse(mapped.metadataJson)).toEqual(mapped.metadata);
    expect(mapped.metadata.userInputRequestId).toBe(scopedId("a", "request"));
    expect(mapped.metadata.questions).toEqual(metadata.questions);
    expect(mapped.metadata.answers).toEqual(metadata.answers);
    expect(mapped.metadata.input).toEqual(metadata.input);
    expect(mapped.content).toBe("run");
    expect(mapped.mcpServers).toEqual([{ id: "mcp" }]);
    expect(mapped.forgeRequest).toEqual({ id: "123" });
  });
});
