import { useEffect, useMemo, useRef, useState } from "react";
import {
  APP_SETTING_KEYS,
  COUNCIL_MAX_REVIEWERS,
  parseCouncilSettings,
  type AppSnapshot,
  type CouncilSettings,
} from "@buildwarden/shared";
import { Plus, Trash2 } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settings-layout";

const EFFORT_OPTIONS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const TIME_LIMIT_MINUTES = [5, 10, 15, 30, 60];

export const CouncilSettingsSection = ({ models, providerAccounts, serializedValue, canEdit }: Readonly<{
  models: AppSnapshot["models"];
  providerAccounts: AppSnapshot["providerAccounts"];
  serializedValue: string;
  canEdit: boolean;
}>) => {
  const client = useBuildWardenClient();
  const [settings, setSettings] = useState<CouncilSettings>(() => parseCouncilSettings(serializedValue));
  const [error, setError] = useState("");
  const saved = useRef(serializedValue);
  const saves = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (serializedValue === saved.current) return;
    saved.current = serializedValue;
    setSettings(parseCouncilSettings(serializedValue));
  }, [serializedValue]);

  const modelOptions = useMemo(() => {
    const providers = new Map(providerAccounts.map((account) => [account.id, account.label]));
    return models.filter((model) => Boolean(model.enabled)).map((model) => ({
      value: model.id,
      label: model.displayName,
      description: providers.get(model.providerAccountId),
    }));
  }, [models, providerAccounts]);

  const update = (next: CouncilSettings) => {
    const normalized = parseCouncilSettings(JSON.stringify(next));
    setSettings(normalized);
    setError("");
    const serialized = JSON.stringify(normalized);
    saved.current = serialized;
    // Keep quick successive changes in order.
    saves.current = saves.current.then(() => client.setAppSetting(APP_SETTING_KEYS.council, serialized)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not save these settings.");
    });
  };

  const usedModelIds = new Set(settings.reviewers.map((reviewer) => reviewer.modelId));
  const nextModel = modelOptions.find((option) => !usedModelIds.has(option.value));
  const hasReviewers = settings.reviewers.length > 0;

  return (
    <SettingsSection title="Council validation">
      <SettingsRow
        title="Reviewers"
        description="These models independently check a run's changes or answer, each on its own copy of the workspace. Using several providers gives the most useful range of views."
        align="start"
      >
        <div className="space-y-1.5 text-xs">
          {settings.reviewers.map((reviewer, index) => {
            const missing = !modelOptions.some((option) => option.value === reviewer.modelId);
            const options = [
              ...(missing ? [{ value: reviewer.modelId, label: "Unavailable model", disabled: true }] : []),
              ...modelOptions.filter((option) => option.value === reviewer.modelId || !usedModelIds.has(option.value)),
            ];
            return (
              <div key={reviewer.modelId} className="flex min-w-0 items-center gap-1.5">
                <Select
                  className="min-w-0 flex-1"
                  triggerClassName="h-8 text-xs"
                  ariaLabel={`Reviewer ${String(index + 1)} model`}
                  value={reviewer.modelId}
                  options={options}
                  disabled={!canEdit}
                  onValueChange={(modelId) => update({ ...settings, reviewers: settings.reviewers.map((entry, at) => (at === index ? { ...entry, modelId } : entry)) })}
                />
                <Select
                  className="w-32 shrink-0"
                  triggerClassName="h-8 text-xs"
                  ariaLabel={`Reviewer ${String(index + 1)} reasoning effort`}
                  value={reviewer.effort ?? ""}
                  options={EFFORT_OPTIONS}
                  disabled={!canEdit}
                  onValueChange={(effort) => update({ ...settings, reviewers: settings.reviewers.map((entry, at) => (at === index ? { modelId: entry.modelId, ...(effort ? { effort } : {}) } : entry)) })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-[var(--ec-muted)] hover:text-[var(--ec-danger)]"
                  aria-label={`Remove reviewer ${String(index + 1)}`}
                  title="Remove reviewer"
                  disabled={!canEdit}
                  onClick={() => update({ ...settings, reviewers: settings.reviewers.filter((_, at) => at !== index) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
          {modelOptions.length ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="gap-1"
              disabled={!canEdit || !nextModel || settings.reviewers.length >= COUNCIL_MAX_REVIEWERS}
              onClick={() => nextModel && update({ ...settings, reviewers: [...settings.reviewers, { modelId: nextModel.value }] })}
            >
              <Plus className="h-3 w-3" />Add reviewer
            </Button>
          ) : (
            <p className="text-xs text-[var(--ec-muted)]">Enable a model under Provider &amp; models first.</p>
          )}
        </div>
      </SettingsRow>
      {hasReviewers ? (
        <>
          <SettingsRow
            title="Apply accepted findings automatically"
            description="When off, you get the combined findings and choose what to fix. When on, the run's model fixes everything it accepts in one turn."
          >
            <div className="flex justify-end">
              <Switch aria-label="Apply accepted findings automatically" checked={settings.autoApply} disabled={!canEdit} onCheckedChange={(autoApply) => update({ ...settings, autoApply })} />
            </div>
          </SettingsRow>
          <SettingsRow
            title="Validate automatically"
            description="Start a validation when a Code run with changes or a Plan run completes. Ask runs stay manual. Every validation uses tokens on each reviewer."
          >
            <div className="flex justify-end">
              <Switch aria-label="Validate automatically" checked={settings.autoRun} disabled={!canEdit} onCheckedChange={(autoRun) => update({ ...settings, autoRun })} />
            </div>
          </SettingsRow>
          <SettingsRow title="Limits" description="Results need this many finished reviews. Reviewers that fail or run out of time are skipped, and the rest continue.">
            <div className="flex flex-wrap justify-end gap-1.5 text-xs">
              <Select
                className="w-36"
                triggerClassName="h-8 text-xs"
                ariaLabel="Minimum finished reviews"
                value={String(settings.minReviews)}
                options={settings.reviewers.map((_, index) => ({ value: String(index + 1), label: `At least ${String(index + 1)}` }))}
                disabled={!canEdit}
                onValueChange={(value) => update({ ...settings, minReviews: Number(value) })}
              />
              <Select
                className="w-32"
                triggerClassName="h-8 text-xs"
                ariaLabel="Time limit"
                value={String(settings.timeoutMinutes)}
                options={[...new Set([...TIME_LIMIT_MINUTES, settings.timeoutMinutes])].sort((left, right) => left - right).map((minutes) => ({ value: String(minutes), label: `${String(minutes)} minutes` }))}
                disabled={!canEdit}
                onValueChange={(value) => update({ ...settings, timeoutMinutes: Number(value) })}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
      {error ? <p role="alert" className="px-4 py-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
    </SettingsSection>
  );
};
