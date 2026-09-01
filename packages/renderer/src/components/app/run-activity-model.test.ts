import { describe, expect, it } from "vitest";
import { describeActivityDetail } from "./run-activity-model";

describe("run activity details", () => {
  it("shows the selected code-intelligence operation and target", () => {
    expect(
      describeActivityDetail({
        toolName: "code_intelligence",
        arguments: { operation: "find_references", name: "Warden" },
      }),
    ).toBe("find_references · Warden");
    expect(describeActivityDetail({ toolName: "code_intelligence", operation: "codebase_map" })).toBe(
      "codebase_map",
    );
  });
});
