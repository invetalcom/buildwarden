import { describe, expect, it } from "vitest";
import { APP_SETTING_KEYS, buildDefaultProjectRunDefaults, parseProjectRunDefaultsSetting } from "@buildwarden/shared";
import {
  readProjectActiveSkills,
  readProjectRunDefaults,
  writeProjectActiveSkills,
  writeProjectRunDefaults,
} from "./project-settings";

const settingsWith = (key: string, value: unknown): Record<string, string> => ({ [key]: JSON.stringify(value) });

describe("project run defaults", () => {
  it("falls back to the shared defaults for an unknown project", () => {
    expect(readProjectRunDefaults({}, "p1")).toEqual(buildDefaultProjectRunDefaults());
  });

  it("reads a stored entry", () => {
    const settings = settingsWith(APP_SETTING_KEYS.projectRunDefaults, {
      p1: { ...buildDefaultProjectRunDefaults(), mode: "plan", yoloMode: true },
    });
    const defaults = readProjectRunDefaults(settings, "p1");
    expect(defaults.mode).toBe("plan");
    expect(defaults.yoloMode).toBe(true);
  });

  it("leaves other projects untouched when writing", () => {
    const settings = settingsWith(APP_SETTING_KEYS.projectRunDefaults, {
      p1: { ...buildDefaultProjectRunDefaults(), mode: "plan" },
      p2: { ...buildDefaultProjectRunDefaults(), mode: "ask" },
    });
    const serialized = writeProjectRunDefaults(settings, "p1", { ...buildDefaultProjectRunDefaults(), mode: "code" });
    const parsed = parseProjectRunDefaultsSetting(serialized);
    expect(parsed.p1.mode).toBe("code");
    expect(parsed.p2.mode).toBe("ask");
  });

  it("writes into an empty settings map", () => {
    const serialized = writeProjectRunDefaults({}, "p1", { ...buildDefaultProjectRunDefaults(), workspaceType: "local" });
    expect(parseProjectRunDefaultsSetting(serialized).p1.workspaceType).toBe("local");
  });

  it("survives a corrupted stored value", () => {
    const settings = { [APP_SETTING_KEYS.projectRunDefaults]: "{not json" };
    expect(readProjectRunDefaults(settings, "p1")).toEqual(buildDefaultProjectRunDefaults());
    expect(parseProjectRunDefaultsSetting(writeProjectRunDefaults(settings, "p1", buildDefaultProjectRunDefaults())).p1)
      .toEqual(buildDefaultProjectRunDefaults());
  });
});

describe("project active skills", () => {
  it("reads an empty list when nothing is stored", () => {
    expect(readProjectActiveSkills({}, "p1")).toEqual([]);
  });

  it("round-trips a selection and keeps other projects", () => {
    const settings = settingsWith(APP_SETTING_KEYS.projectActiveSkills, { p1: ["openai:angular"], p2: ["openai:react"] });
    const serialized = writeProjectActiveSkills(settings, "p1", ["openai:vue", "openai:angular"]);
    const next = { [APP_SETTING_KEYS.projectActiveSkills]: serialized };
    expect(readProjectActiveSkills(next, "p1")).toEqual(["openai:angular", "openai:vue"]);
    expect(readProjectActiveSkills(next, "p2")).toEqual(["openai:react"]);
  });

  it("drops a project entry when its selection is cleared", () => {
    const settings = settingsWith(APP_SETTING_KEYS.projectActiveSkills, { p1: ["openai:angular"] });
    const serialized = writeProjectActiveSkills(settings, "p1", []);
    expect(readProjectActiveSkills({ [APP_SETTING_KEYS.projectActiveSkills]: serialized }, "p1")).toEqual([]);
  });
});
