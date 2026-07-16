import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  parseIntegratedSkillsDisabledSetting,
  parseProjectActiveSkillsSetting,
  parseProjectLabSettingsSetting,
  type AppSnapshot,
  type DesktopApi,
  type IntegratedSkillMetadata,
  type ProjectLabSettings,
} from "@buildwarden/shared";

export interface SkillsSettingsDeps {
  buildwarden: DesktopApi | undefined;
  snapshotSettings: AppSnapshot["settings"];
  loadSnapshot: () => Promise<void>;
}

/**
 * Owns the integrated-skills catalog plus the persisted skill/lab settings
 * (globally disabled skills, per-project active skills, per-project lab config).
 */
export const useSkillsSettings = ({ buildwarden, snapshotSettings, loadSnapshot }: SkillsSettingsDeps) => {
  const [integratedSkillsCatalog, setIntegratedSkillsCatalog] = useState<IntegratedSkillMetadata[]>([]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    let cancelled = false;
    void buildwarden
      .listIntegratedSkills()
      .then((skills) => {
        if (!cancelled) {
          setIntegratedSkillsCatalog(skills);
        }
      })
      .catch(() => {
        // Skills are non-critical at boot; settings/composer surfaces handle an empty list.
      });
    return () => {
      cancelled = true;
    };
  }, [buildwarden]);

  const globallyDisabledIntegratedSkillIds = useMemo(
    () => parseIntegratedSkillsDisabledSetting(snapshotSettings[APP_SETTING_KEYS.integratedSkillsDisabled]),
    [snapshotSettings],
  );

  const projectActiveSkillsByProjectId = useMemo(
    () => parseProjectActiveSkillsSetting(snapshotSettings[APP_SETTING_KEYS.projectActiveSkills]),
    [snapshotSettings],
  );
  const projectLabSettingsByProjectId = useMemo(
    () => parseProjectLabSettingsSetting(snapshotSettings[APP_SETTING_KEYS.projectLabSettings]),
    [snapshotSettings],
  );

  const enabledIntegratedSkills = useMemo(() => {
    const disabledIds = new Set(globallyDisabledIntegratedSkillIds);
    return integratedSkillsCatalog.filter((skill) => !disabledIds.has(skill.id));
  }, [globallyDisabledIntegratedSkillIds, integratedSkillsCatalog]);

  const updateGloballyDisabledIntegratedSkills = useCallback(
    async (skillIds: string[]) => {
      if (!buildwarden) {
        return;
      }
      const validIds = new Set(integratedSkillsCatalog.map((skill) => skill.id));
      const normalized = [...new Set(skillIds.filter((skillId) => validIds.has(skillId)))].sort((a, b) => a.localeCompare(b));
      await buildwarden.setAppSetting(APP_SETTING_KEYS.integratedSkillsDisabled, JSON.stringify(normalized));
      await loadSnapshot();
    },
    [buildwarden, integratedSkillsCatalog, loadSnapshot],
  );

  const updateProjectActiveSkills = useCallback(
    async (projectId: string, skillIds: string[]) => {
      if (!buildwarden) {
        return;
      }
      const current = parseProjectActiveSkillsSetting(snapshotSettings[APP_SETTING_KEYS.projectActiveSkills]);
      const next = { ...current };
      const normalized = [...new Set(skillIds)].sort((a, b) => a.localeCompare(b));
      if (normalized.length > 0) {
        next[projectId] = normalized;
      } else {
        delete next[projectId];
      }
      await buildwarden.setAppSetting(APP_SETTING_KEYS.projectActiveSkills, JSON.stringify(next));
      await loadSnapshot();
    },
    [buildwarden, loadSnapshot, snapshotSettings],
  );

  const updateProjectLabSettings = useCallback(
    async (projectId: string, settings: ProjectLabSettings) => {
      if (!buildwarden) {
        return;
      }
      const current = parseProjectLabSettingsSetting(snapshotSettings[APP_SETTING_KEYS.projectLabSettings]);
      const next = { ...current, [projectId]: settings };
      await buildwarden.setAppSetting(APP_SETTING_KEYS.projectLabSettings, JSON.stringify(next));
      await loadSnapshot();
    },
    [buildwarden, loadSnapshot, snapshotSettings],
  );

  return {
    integratedSkillsCatalog,
    globallyDisabledIntegratedSkillIds,
    projectActiveSkillsByProjectId,
    projectLabSettingsByProjectId,
    enabledIntegratedSkills,
    updateGloballyDisabledIntegratedSkills,
    updateProjectActiveSkills,
    updateProjectLabSettings,
  };
};
