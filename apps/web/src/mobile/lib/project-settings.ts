import {
  APP_SETTING_KEYS,
  buildDefaultProjectRunDefaults,
  parseProjectActiveSkillsSetting,
  parseProjectRunDefaultsSetting,
  serializeProjectActiveSkillsSetting,
  type ProjectRunDefaults,
} from "@buildwarden/shared";

/**
 * Per-project settings live inside two app-wide settings keys, each a JSON object keyed by project
 * id. Reading and writing therefore always means merging into the existing map — never replacing
 * it, or one project's edit would wipe every other project's defaults.
 */

export const readProjectRunDefaults = (
  settings: Record<string, string>,
  projectId: string,
): ProjectRunDefaults => {
  const byProjectId = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults]);
  return byProjectId[projectId] ?? buildDefaultProjectRunDefaults();
};

/** Serialised `projectRunDefaults` with only this project's entry replaced. */
export const writeProjectRunDefaults = (
  settings: Record<string, string>,
  projectId: string,
  next: ProjectRunDefaults,
): string => {
  const byProjectId = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults]);
  return JSON.stringify({ ...byProjectId, [projectId]: next });
};

export const readProjectActiveSkills = (settings: Record<string, string>, projectId: string): string[] =>
  parseProjectActiveSkillsSetting(settings[APP_SETTING_KEYS.projectActiveSkills])[projectId] ?? [];

/** Serialised `projectActiveSkills` with only this project's entry replaced. */
export const writeProjectActiveSkills = (
  settings: Record<string, string>,
  projectId: string,
  skillIds: readonly string[],
): string => {
  const byProjectId = parseProjectActiveSkillsSetting(settings[APP_SETTING_KEYS.projectActiveSkills]);
  return serializeProjectActiveSkillsSetting({ ...byProjectId, [projectId]: [...skillIds] });
};
