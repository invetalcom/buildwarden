import { useMemo } from "react";
import { APP_SETTING_KEYS, COUNCIL_MAX_REVIEWERS, parseCouncilSettings, type CouncilSettings } from "@buildwarden/shared";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAppSettings } from "../../data/use-app-settings";
import { CheckRow, SelectRow, SettingGroup, ToggleRow } from "../../components/SettingControls";

const TIME_LIMITS = [5, 10, 15, 30, 60];

/**
 * Reviewers are checkboxes here. Per-reviewer effort is set on desktop, and an existing value is
 * kept as long as that reviewer stays selected.
 */
export const CouncilSection = () => {
  const { snapshot, client } = useMobileApp();
  const settings = useAppSettings();
  const raw = settings.read(APP_SETTING_KEYS.council);
  const council = useMemo(() => parseCouncilSettings(raw), [raw]);
  const disabled = !client.capabilities.orchestrationSettings || !settings.canWrite || settings.saving;
  const models = snapshot.models.filter((model) => Boolean(model.enabled));
  const providerLabel = (providerAccountId: string) =>
    snapshot.providerAccounts.find((account) => account.id === providerAccountId)?.label;

  const save = (patch: Partial<CouncilSettings>) => {
    void settings.write(APP_SETTING_KEYS.council, JSON.stringify({ ...council, ...patch }));
  };
  const toggleReviewer = (modelId: string) => {
    const selected = council.reviewers.some((reviewer) => reviewer.modelId === modelId);
    save({ reviewers: selected ? council.reviewers.filter((reviewer) => reviewer.modelId !== modelId) : [...council.reviewers, { modelId }] });
  };

  const timeLimits = [...new Set([...TIME_LIMITS, council.timeoutMinutes])].sort((left, right) => left - right);
  const full = council.reviewers.length >= COUNCIL_MAX_REVIEWERS;

  return (
    <>
      <SettingGroup title="Council validation" hint="These models independently check a run's changes or answer. Validation stays hidden until you choose at least one.">
        {models.length === 0 ? <p className="px-4 py-3 text-xs text-[var(--ec-muted)]">Enable a model first.</p> : null}
        {models.map((model) => {
          const selected = council.reviewers.some((reviewer) => reviewer.modelId === model.id);
          return (
            <CheckRow
              key={model.id}
              title={model.displayName}
              description={providerLabel(model.providerAccountId)}
              checked={selected}
              disabled={disabled || (full && !selected)}
              onToggle={() => toggleReviewer(model.id)}
            />
          );
        })}
      </SettingGroup>
      {council.reviewers.length ? (
        <SettingGroup title="Validation options">
          <ToggleRow
            title="Apply accepted findings automatically"
            description="When off, you get the combined findings and choose what to fix."
            checked={council.autoApply}
            disabled={disabled}
            onChange={(autoApply) => save({ autoApply })}
          />
          <ToggleRow
            title="Validate automatically"
            description="When a Code run with changes or a Plan run completes. Every validation uses tokens on each reviewer."
            checked={council.autoRun}
            disabled={disabled}
            onChange={(autoRun) => save({ autoRun })}
          />
          <SelectRow
            title="Minimum finished reviews"
            description="Reviewers that fail or run out of time are skipped, and the rest continue."
            value={String(council.minReviews)}
            options={council.reviewers.map((_, index) => ({ value: String(index + 1), label: `At least ${String(index + 1)}` }))}
            disabled={disabled}
            onChange={(value) => save({ minReviews: Number(value) })}
          />
          <SelectRow
            title="Time limit"
            value={String(council.timeoutMinutes)}
            options={timeLimits.map((minutes) => ({ value: String(minutes), label: `${String(minutes)} minutes` }))}
            disabled={disabled}
            onChange={(value) => save({ timeoutMinutes: Number(value) })}
          />
        </SettingGroup>
      ) : null}
    </>
  );
};
