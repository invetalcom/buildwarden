import { useMemo } from "react";
import { APP_SETTING_KEYS, parseOrchestrationTeamSettings } from "@buildwarden/shared";
import { useMobileApp } from "../../data/mobile-app-context";
import { modelLabel } from "../../data/selectors";
import { useAppSettings } from "../../data/use-app-settings";
import { SettingGroup, TextRow } from "../../components/SettingControls";
import { Badge, EmptyState, InlineError } from "../../components/primitives";

const clampInt = (value: string, min: number, max: number): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
};

/**
 * Orchestration team limits and roles.
 *
 * The concurrency limits are the knobs worth changing from a phone. Role definitions (name,
 * description, eligible models, per-role concurrency) are shown read-only: composing them is a
 * multi-field editor per role that belongs on a desktop screen, and getting it wrong silently
 * changes how every delegated run is staffed.
 */
export const OrchestrationSection = () => {
  const { snapshot, client } = useMobileApp();
  const settings = useAppSettings();

  // Memoise on the raw persisted string: `settings` itself is a fresh object every render.
  const teamRaw = settings.read(APP_SETTING_KEYS.orchestrationTeam);
  const team = useMemo(() => parseOrchestrationTeamSettings(teamRaw), [teamRaw]);

  const canEdit = client.capabilities.orchestrationSettings && settings.canWrite;
  const disabled = !canEdit || settings.saving;

  const saveLimit = (patch: { maxConcurrentTasks?: number; maxTasksPerOrchestration?: number }) => {
    void settings.write(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({ ...team, ...patch }));
  };

  return (
    <>
      {settings.error ? <InlineError message={settings.error} onRetry={settings.clearError} /> : null}
      {!canEdit ? (
        <p className="px-4 pt-3 text-[11px] leading-4 text-[var(--ec-warning)]">
          This session cannot change orchestration settings.
        </p>
      ) : null}

      <SettingGroup title="Limits" hint="Applied to every coordinator run that delegates work.">
        <TextRow
          title="Concurrent tasks"
          description="How many delegated agents may run at once."
          value={String(team.maxConcurrentTasks)}
          inputMode="numeric"
          disabled={disabled}
          invalid={(draft) => (clampInt(draft, 1, 20) === null ? "Enter a whole number between 1 and 20." : null)}
          onCommit={(next) => {
            const parsed = clampInt(next, 1, 20);
            if (parsed !== null) saveLimit({ maxConcurrentTasks: parsed });
          }}
        />
        <TextRow
          title="Tasks per orchestration"
          description="Upper bound on delegated tasks for a single coordinator run."
          value={String(team.maxTasksPerOrchestration)}
          inputMode="numeric"
          disabled={disabled}
          invalid={(draft) => (clampInt(draft, 1, 100) === null ? "Enter a whole number between 1 and 100." : null)}
          onCommit={(next) => {
            const parsed = clampInt(next, 1, 100);
            if (parsed !== null) saveLimit({ maxTasksPerOrchestration: parsed });
          }}
        />
      </SettingGroup>

      <SettingGroup title="Roles" hint="Defined on the desktop app; shown here so you can check the team composition.">
        {team.roles.length === 0 ? (
          <EmptyState title="No roles configured" message="Delegated runs fall back to the coordinator's own model." />
        ) : (
          team.roles.map((role) => (
            <div key={role.id} className="border-b border-[var(--ec-border)] px-4 py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{role.name}</p>
                <Badge tone="neutral">{role.maxConcurrent}×</Badge>
              </div>
              {role.description ? (
                <p className="mt-0.5 text-[11px] leading-4 text-[var(--ec-muted)]">{role.description}</p>
              ) : null}
              <p className="mt-1 text-[11px] text-[var(--ec-faint)]">
                {role.eligibleModelIds.length === 0
                  ? "Any model"
                  : role.eligibleModelIds.map((id) => modelLabel(snapshot, id)).join(", ")}
              </p>
            </div>
          ))
        )}
      </SettingGroup>

      {team.models.length > 0 ? (
        <SettingGroup title="Model pool">
          {team.models.map((model) => (
            <div key={model.modelId} className="flex items-center gap-2 border-b border-[var(--ec-border)] px-4 py-2 last:border-b-0">
              <p className="min-w-0 flex-1 truncate text-[13px]">{modelLabel(snapshot, model.modelId)}</p>
              {model.defaultEffort ? <Badge tone="neutral">{model.defaultEffort}</Badge> : null}
              <Badge tone={model.enabled ? "success" : "neutral"}>{model.enabled ? "on" : "off"}</Badge>
            </div>
          ))}
        </SettingGroup>
      ) : null}

      <div className="h-6" />
    </>
  );
};
