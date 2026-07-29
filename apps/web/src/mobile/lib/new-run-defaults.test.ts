import { describe, expect, it } from "vitest";
import { APP_SETTING_KEYS, buildDefaultProjectRunDefaults } from "@buildwarden/shared";
import { resolveNewRunDefaults } from "./new-run-defaults";

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
  it("preselects the project's stored mode, workspace, efforts and Full Access", () => {
    const settings = settingsFor("p1", {
      mode: "plan",
      workspaceType: "local",
      yoloMode: true,
      reasoningEffort: "high",
      anthropicEffort: "xhigh",
    });
    expect(resolve(settings)).toEqual({
      mode: "plan",
      workspaceType: "local",
      modelId: "m1",
      reasoningEffort: "high",
      anthropicEffort: "xhigh",
      yoloMode: true,
    });
  });

  it("prefers the project's stored model over the last used one, while it is still configured", () => {
    expect(resolve(settingsFor("p1", { modelId: "m2" })).modelId).toBe("m2");
    expect(resolve(settingsFor("p1", { modelId: "removed" })).modelId).toBe("m1");
    expect(resolve(settingsFor("p1", { modelId: "" })).modelId).toBe("m1");
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
      reasoningEffort: "medium",
      anthropicEffort: "medium",
      yoloMode: false,
    });
    expect(resolve({})).toEqual(expect.objectContaining({ mode: "code", workspaceType: "worktree", yoloMode: false }));
  });
});
