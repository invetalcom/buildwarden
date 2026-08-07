import { parseProjectRunDefaultsSetting } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { resolveProjectRunModelSelection } from "./use-project-run-defaults";

describe("project run model defaults", () => {
  it("hydrates the last selected models and their effort/speed settings from a fresh app snapshot", () => {
    const persisted = parseProjectRunDefaultsSetting(JSON.stringify({
      "project-1": {
        mode: "code",
        workspaceType: "worktree",
        modelId: "model-a",
        worktreeModelIds: ["model-a", "model-b"],
        modelConfigurations: {
          "model-a": { effort: "high", executionMode: "fast" },
          "model-b": { effort: "xhigh", executionMode: "auto" },
        },
        reasoningEffort: "high",
        anthropicEffort: "xhigh",
        executionMode: "fast",
        yoloMode: false,
      },
    }));

    expect(resolveProjectRunModelSelection({
      stored: persisted["project-1"],
      models: [{ id: "model-a" }, { id: "model-b" }],
      preferredRunModelId: "model-b",
    })).toEqual({
      modelId: "model-a",
      worktreeModelIds: ["model-a", "model-b"],
      modelConfigurations: {
        "model-a": { effort: "high", executionMode: "fast" },
        "model-b": { effort: "xhigh", executionMode: "auto" },
      },
    });
  });

  it("falls back safely when a previously selected model is no longer configured", () => {
    const persisted = parseProjectRunDefaultsSetting(JSON.stringify({
      "project-1": {
        modelId: "removed-model",
        worktreeModelIds: ["removed-model"],
      },
    }));

    expect(resolveProjectRunModelSelection({
      stored: persisted["project-1"],
      models: [{ id: "model-a" }, { id: "model-b" }],
      preferredRunModelId: "model-b",
    })).toEqual({
      modelId: "model-b",
      worktreeModelIds: ["model-b"],
      modelConfigurations: {},
    });
  });
});
