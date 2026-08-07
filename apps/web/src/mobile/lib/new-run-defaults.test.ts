import { describe, expect, it } from "vitest";
import { APP_SETTING_KEYS, buildDefaultProjectRunDefaults } from "@buildwarden/shared";
import { reconcileNewRunModelIds, resolveNewRunDefaults } from "./new-run-defaults";

const settingsFor = (projectId: string, defaults: Partial<ReturnType<typeof buildDefaultProjectRunDefaults>>) => ({
  [APP_SETTING_KEYS.projectRunDefaults]: JSON.stringify({
    [projectId]: { ...buildDefaultProjectRunDefaults(), ...defaults },
  }),
});

const resolve = (settings: Record<string, string>, overrides: Partial<Parameters<typeof resolveNewRunDefaults>[0]> = {}) =>
  resolveNewRunDefaults({
    settings,
    projectId: "p1",
    projectKind: "git",
    modelIds: ["m1", "m2"],
    fallbackModelId: "m1",
    ...overrides,
  });

describe("new run defaults", () => {
  it("keeps the current model-list identity when empty reconciliation has no work", () => {
    const currentIds: string[] = [];

    expect(reconcileNewRunModelIds(currentIds, [], [])).toBe(currentIds);
    expect(reconcileNewRunModelIds(["gone"], ["m1"], ["m1"])).toEqual(["m1"]);
  });

  it("preselects the project's stored mode, workspace, efforts and Full Access", () => {
    const settings = settingsFor("p1", {
      mode: "plan",
      workspaceType: "local",
      yoloMode: true,
      reasoningEffort: "high",
      anthropicEffort: "xhigh",
      executionMode: "fast",
    });
    expect(resolve(settings)).toEqual({
      mode: "plan",
      workspaceType: "local",
      modelId: "m1",
      modelIds: ["m1"],
      modelConfigurations: {},
      reasoningEffort: "high",
      anthropicEffort: "xhigh",
      executionMode: "fast",
      yoloMode: true,
    });
  });

  it("prefers the project's stored model over the last used one, while it is still configured", () => {
    expect(resolve(settingsFor("p1", { modelId: "m2" })).modelId).toBe("m2");
    expect(resolve(settingsFor("p1", { modelId: "removed" })).modelId).toBe("m1");
    expect(resolve(settingsFor("p1", { modelId: "" })).modelId).toBe("m1");
  });

  it("restores per-model chip settings for isolated runs", () => {
    const resolved = resolve(settingsFor("p1", {
      modelId: "m1",
      worktreeModelIds: ["m1", "m2"],
      modelConfigurations: {
        m1: { effort: "high", executionMode: "priority" },
        m2: { effort: "xhigh", executionMode: "auto" },
      },
    }));
    expect(resolved.modelIds).toEqual(["m1", "m2"]);
    expect(resolved.modelConfigurations).toEqual({
      m1: { effort: "high", executionMode: "priority" },
      m2: { effort: "xhigh", executionMode: "auto" },
    });
  });

  it("drops model selections and configurations that are no longer enabled", () => {
    const resolved = resolve(settingsFor("p1", {
      modelId: "m1",
      worktreeModelIds: ["m1", "removed-model"],
      modelConfigurations: {
        m1: { effort: "high", executionMode: "auto" },
        "removed-model": { effort: "low", executionMode: "fast" },
      },
    }));

    expect(resolved.modelIds).toEqual(["m1"]);
    expect(resolved.modelConfigurations).toEqual({
      m1: { effort: "high", executionMode: "auto" },
    });
  });

  it("keeps the workspace within what the project kind allows", () => {
    // A git project's stored "copy" and a folder project's stored "worktree" are both offered by
    // neither composer, so they fall back to that kind's first option.
    expect(resolve(settingsFor("p1", { workspaceType: "copy" })).workspaceType).toBe("worktree");
    expect(resolve(settingsFor("p1", { workspaceType: "worktree" }), { projectKind: "folder" }).workspaceType).toBe("copy");
    expect(resolve(settingsFor("p1", { workspaceType: "local" }), { projectKind: "folder" }).workspaceType).toBe("local");
  });

  it("falls back to the shared defaults for a project that has never been configured", () => {
    expect(resolve(settingsFor("other", { mode: "ask", yoloMode: true }))).toEqual({
      mode: "code",
      workspaceType: "worktree",
      modelId: "m1",
      modelIds: ["m1"],
      modelConfigurations: {},
      reasoningEffort: "auto",
      anthropicEffort: "auto",
      executionMode: "auto",
      yoloMode: false,
    });
    expect(resolve({})).toEqual(expect.objectContaining({ mode: "code", workspaceType: "worktree", yoloMode: false }));
  });
});
