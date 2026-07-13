import { describe, expect, it } from "vitest";
import { buildDefaultProjectRunDefaults, parseProjectRunDefaultsSetting } from "@buildwarden/shared";

describe("parseProjectRunDefaultsSetting", () => {
  it("returns an empty map for missing or malformed input", () => {
    expect(parseProjectRunDefaultsSetting(undefined)).toEqual({});
    expect(parseProjectRunDefaultsSetting("")).toEqual({});
    expect(parseProjectRunDefaultsSetting("not json")).toEqual({});
    expect(parseProjectRunDefaultsSetting(JSON.stringify(["array"]))).toEqual({});
  });

  it("round-trips persisted run defaults", () => {
    const stored = {
      "project-1": {
        mode: "plan",
        workspaceType: "local",
        modelId: "model-a",
        worktreeModelIds: ["model-a", "model-b"],
        reasoningEffort: "high",
        anthropicEffort: "xhigh",
        yoloMode: true,
      },
    };

    const parsed = parseProjectRunDefaultsSetting(JSON.stringify(stored));
    expect(parsed["project-1"]).toEqual(stored["project-1"]);
  });

  it("falls back to defaults for invalid field values", () => {
    const parsed = parseProjectRunDefaultsSetting(
      JSON.stringify({
        "project-1": {
          mode: "yeet",
          workspaceType: 42,
          modelId: 7,
          worktreeModelIds: ["ok", "", 3, "ok"],
          reasoningEffort: "extreme",
          anthropicEffort: "medium",
          yoloMode: "yes",
        },
      }),
    );

    expect(parsed["project-1"]).toEqual({
      ...buildDefaultProjectRunDefaults(),
      worktreeModelIds: ["ok"],
      anthropicEffort: "medium",
    });
  });

  it("skips entries that are not objects", () => {
    const parsed = parseProjectRunDefaultsSetting(
      JSON.stringify({ "project-1": "nope", "project-2": null, "project-3": buildDefaultProjectRunDefaults() }),
    );
    expect(Object.keys(parsed)).toEqual(["project-3"]);
  });

  it("ignores the legacy per-run base branch after consolidation into the project", () => {
    const parsed = parseProjectRunDefaultsSetting(
      JSON.stringify({ "project-1": { ...buildDefaultProjectRunDefaults(), baseBranch: "legacy-base" } }),
    );

    expect(parsed["project-1"]).toEqual(buildDefaultProjectRunDefaults());
    expect(parsed["project-1"]).not.toHaveProperty("baseBranch");
  });
});
