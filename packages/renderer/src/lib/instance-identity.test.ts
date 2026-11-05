import { describe, expect, it } from "vitest";
import { mapEntityIds, parseScopedId, scopedId } from "./instance-identity";

describe("instance entity identity", () => {
  it("round-trips delimiters and unicode without collisions", () => {
    const value = scopedId("cookie:https://computer:47831", "run:ä/%");
    expect(parseScopedId(value)).toEqual({ instanceId: "cookie:https://computer:47831", id: "run:ä/%" });
    expect(parseScopedId("bw-instance:%broken:id")).toBeNull();
    expect(scopedId("a:b", "c")).not.toBe(scopedId("a", "b:c"));
  });
  it("scopes a validation round but keeps the links inside it intact", () => {
    const round = {
      id: "round", runId: "run", projectId: "project", stepId: "step", subjectFingerprint: "code:a",
      reviews: [{ id: "review", modelId: "model", childRunId: "child" }],
      assessment: { id: "assessment", modelId: "model" },
      findings: [{ id: "F1", reviewId: "review" }],
      groups: [{ id: "G1", findingIds: ["F1"] }],
      appliedGroupIds: ["G1"],
    };
    const mapped = mapEntityIds({ councilRounds: [round] }, (id) => scopedId("a", id)).councilRounds[0]!;

    expect(mapped).toMatchObject({ id: scopedId("a", "round"), runId: scopedId("a", "run"), projectId: scopedId("a", "project") });
    expect(mapped.groups[0]!.findingIds).toContain(mapped.findings[0]!.id);
    expect(mapped.reviews[0]!.id).toBe(mapped.findings[0]!.reviewId);
    expect(mapped.appliedGroupIds).toEqual(["G1"]);
    expect(mapped.assessment).toEqual(round.assessment);
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
