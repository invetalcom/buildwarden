import { useEffect, useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  parseIntegratedSkillsDisabledSetting,
  serializeIntegratedSkillsDisabledSetting,
  type IntegratedSkillMetadata,
} from "@buildwarden/shared";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAppSettings } from "../../data/use-app-settings";
import { errorMessage } from "../../lib/format";
import { CheckRow, SettingGroup } from "../../components/SettingControls";
import { CenteredSpinner, EmptyState, InlineError, Input } from "../../components/primitives";

/**
 * Global skill enable/disable. Disabling here hides a skill from every project; per-project
 * selection lives in that project's own settings tab.
 */
export const SkillsSection = () => {
  const { client } = useMobileApp();
  const settings = useAppSettings();
  const [skills, setSkills] = useState<IntegratedSkillMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Memoise on the raw persisted string: `settings` itself is a fresh object every render.
  const disabledRaw = settings.read(APP_SETTING_KEYS.integratedSkillsDisabled);
  const disabledIds = useMemo(() => parseIntegratedSkillsDisabledSetting(disabledRaw), [disabledRaw]);

  useEffect(() => {
    let cancelled = false;
    void client
      .listIntegratedSkills()
      .then((next) => {
        if (!cancelled) setSkills(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorMessage(caught, "Could not load the skill catalog."));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!skills) return [];
    if (!term) return skills;
    return skills.filter(
      (skill) => skill.title.toLowerCase().includes(term) || skill.description.toLowerCase().includes(term),
    );
  }, [query, skills]);

  const toggle = (skillId: string) => {
    const next = disabledIds.includes(skillId)
      ? disabledIds.filter((entry) => entry !== skillId)
      : [...disabledIds, skillId];
    void settings.write(APP_SETTING_KEYS.integratedSkillsDisabled, serializeIntegratedSkillsDisabledSetting(next));
  };

  if (loadError) return <InlineError message={loadError} />;
  if (skills === null) return <CenteredSpinner label="Loading skills" />;

  return (
    <>
      {settings.error ? <InlineError message={settings.error} onRetry={settings.clearError} /> : null}
      <div className="px-4 py-2.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter skills"
          autoCapitalize="none"
          className="text-[13px]"
        />
      </div>
      <SettingGroup
        title={`Integrated skills (${skills.length - disabledIds.length} of ${skills.length} enabled)`}
        hint="Disabled skills are never offered to any project."
      >
        {visible.length === 0 ? (
          <EmptyState title="No matching skills" />
        ) : (
          visible.map((skill) => (
            <CheckRow
              key={skill.id}
              title={skill.title}
              description={skill.description}
              checked={!disabledIds.includes(skill.id)}
              disabled={!settings.canWrite || settings.saving}
              onToggle={() => toggle(skill.id)}
            />
          ))
        )}
      </SettingGroup>
      <div className="h-6" />
    </>
  );
};
