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
        modelConfigurations: {
          "model-a": { effort: "high", executionMode: "fast" },
          "model-b": { effort: "xhigh", executionMode: "auto" },
        },
        reasoningEffort: "high",
        anthropicEffort: "xhigh",
        executionMode: "fast",
        yoloMode: true,
        verificationCommands: ["pnpm typecheck", "pnpm test"],
        maxRunMinutes: 45,
        maxRunTokens: 120000,
      },
    };

    const parsed = parseProjectRunDefaultsSetting(JSON.stringify(stored));
    expect(parsed["project-1"]).toEqual(stored["project-1"]);
  });

  it("sanitizes verification commands and caps their count", () => {
    const parsed = parseProjectRunDefaultsSetting(JSON.stringify({
      "project-1": {
        verificationCommands: ["  pnpm typecheck  ", "", 42, ...Array.from({ length: 12 }, (_, index) => `check-${index}`)],
      },
    }));

    expect(parsed["project-1"]?.verificationCommands).toHaveLength(10);
    expect(parsed["project-1"]?.verificationCommands[0]).toBe("pnpm typecheck");
  });

  it("clamps autonomy budgets and treats invalid values as unlimited", () => {
    const parsed = parseProjectRunDefaultsSetting(JSON.stringify({
      "project-1": { maxRunMinutes: 9999, maxRunTokens: -10 },
      "project-2": { maxRunMinutes: "invalid", maxRunTokens: 2500.8 },
    }));

    expect(parsed["project-1"]).toMatchObject({ maxRunMinutes: 1440, maxRunTokens: 0 });
    expect(parsed["project-2"]).toMatchObject({ maxRunMinutes: 0, maxRunTokens: 2500 });
  });

  it("falls back to defaults for invalid field values", () => {
    const parsed = parseProjectRunDefaultsSetting(
      JSON.stringify({
        "project-1": {
          mode: "yeet",
          workspaceType: 42,
          modelId: 7,
            worktreeModelIds: ["ok", "", 3, "ok"],
            modelConfigurations: {
              ok: { effort: "medium", executionMode: "priority" },
              broken: { effort: "extreme", executionMode: "" },
            },
          reasoningEffort: "extreme",
          anthropicEffort: "medium",
          yoloMode: "yes",
        },
      }),
    );

    expect(parsed["project-1"]).toEqual({
      ...buildDefaultProjectRunDefaults(),
      worktreeModelIds: ["ok"],
      modelConfigurations: {
        ok: { effort: "medium", executionMode: "priority" },
        broken: { effort: "auto", executionMode: "auto" },
      },
      anthropicEffort: "medium",
    });
  });

  it("validates execution-mode length after trimming surrounding whitespace", () => {
    const paddedMode = `${" ".repeat(65)}priority${" ".repeat(65)}`;
    const parsed = parseProjectRunDefaultsSetting(JSON.stringify({
      "project-1": {
        executionMode: paddedMode,
        modelConfigurations: {
          "model-a": { effort: "high", executionMode: paddedMode },
        },
      },
    }));

    expect(parsed["project-1"]?.executionMode).toBe("priority");
    expect(parsed["project-1"]?.modelConfigurations["model-a"]?.executionMode).toBe("priority");
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
