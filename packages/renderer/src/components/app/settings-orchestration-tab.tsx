import {
  createOrchestrationRoleFromPreset,
  ORCHESTRATION_ROLE_PRESETS,
  parseOrchestrationTeamSettings,
  type AppSnapshot,
  type OrchestrationRoleProfile,
  type OrchestrationTeamSettings,
} from "@buildwarden/shared";
import { CircleHelp, Plus, Save, Trash2, UsersRound } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";

interface OrchestrationSettingsTabProps {
  models: AppSnapshot["models"];
  providerAccounts: AppSnapshot["providerAccounts"];
  serializedValue: string;
  canEdit: boolean;
  onSave: (serialized: string) => void | Promise<void>;
}

const EFFORT_OPTIONS = [
  { value: "", label: "Model default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const clampInteger = (value: string, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

const newRole = (preferredModelId: string): OrchestrationRoleProfile => ({
  id: globalThis.crypto?.randomUUID?.() ?? `role-${Date.now()}`,
  name: "Implementer",
  description: "Implements a focused, isolated part of the coordinator task.",
  eligibleModelIds: preferredModelId ? [preferredModelId] : [],
  preferredModelId,
  maxConcurrent: 1,
});

const SettingsHelp = ({
  label,
  title,
  align,
  children,
}: {
  label: string;
  title: string;
  align: "left" | "right";
  children: ReactNode;
}) => {
  const tooltipId = useId();
  return (
    <span className="group/help relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        className="inline-flex size-4 items-center justify-center rounded-full text-[var(--ec-faint)] outline-none transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
      >
        <CircleHelp className="size-3.5" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`glass-popover invisible absolute top-[calc(100%+0.5rem)] z-[100] w-80 max-w-[calc(100vw-2rem)] p-3 text-left normal-case opacity-0 transition duration-150 group-hover/help:visible group-hover/help:opacity-100 group-focus-within/help:visible group-focus-within/help:opacity-100 ${
          align === "left" ? "left-0" : "right-0"
        }`}
      >
        <span className="block text-xs font-semibold tracking-normal text-[var(--ec-text)]">{title}</span>
        <span className="mt-1 block text-[11px] font-normal leading-4 tracking-normal text-[var(--ec-muted)]">
          {children}
        </span>
      </span>
    </span>
  );
};

export const OrchestrationSettingsTab = ({
  models,
  providerAccounts,
  serializedValue,
  canEdit,
  onSave,
}: OrchestrationSettingsTabProps) => {
  const [draft, setDraft] = useState<OrchestrationTeamSettings>(() => parseOrchestrationTeamSettings(serializedValue));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabledModels = useMemo(() => models.filter((model) => model.enabled !== 0), [models]);
  const providerLabels = useMemo(
    () => new Map(providerAccounts.map((provider) => [provider.id, provider.label])),
    [providerAccounts],
  );
  const selectedModelIds = useMemo(
    () => new Set(draft.models.filter((entry) => entry.enabled).map((entry) => entry.modelId)),
    [draft.models],
  );

  useEffect(() => {
    setDraft(parseOrchestrationTeamSettings(serializedValue));
    setSaveError(null);
  }, [serializedValue]);

  const setModelEnabled = (modelId: string, enabled: boolean) => {
    setSaved(false);
    setDraft((current) => {
      const existing = current.models.find((entry) => entry.modelId === modelId);
      const modelsNext = existing
        ? current.models.map((entry) => entry.modelId === modelId ? { ...entry, enabled } : entry)
        : [...current.models, { modelId, enabled, maxConcurrent: 1 }];
      const roles = enabled
        ? current.roles
        : current.roles.map((role) => {
            const eligibleModelIds = role.eligibleModelIds.filter((id) => id !== modelId);
            return {
              ...role,
              eligibleModelIds,
              preferredModelId: role.preferredModelId === modelId ? (eligibleModelIds[0] ?? "") : role.preferredModelId,
            };
          });
      return { ...current, models: modelsNext, roles };
    });
  };

  const updateModel = (
    modelId: string,
    update: (profile: OrchestrationTeamSettings["models"][number]) => OrchestrationTeamSettings["models"][number],
  ) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      models: current.models.map((entry) => entry.modelId === modelId ? update(entry) : entry),
    }));
  };

  const updateRole = (roleId: string, update: (role: OrchestrationRoleProfile) => OrchestrationRoleProfile) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      roles: current.roles.map((role) => role.id === roleId ? update(role) : role),
    }));
  };

  const validRoleCount = draft.roles.filter(
    (role) => role.name.trim() && role.preferredModelId && role.eligibleModelIds.includes(role.preferredModelId),
  ).length;
  const predefinedRoleOptions = ORCHESTRATION_ROLE_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.name,
    description: preset.description,
    disabled: draft.roles.some((role) => role.id === preset.id),
  }));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const normalized = parseOrchestrationTeamSettings(JSON.stringify(draft));
      await onSave(JSON.stringify(normalized));
      setDraft(normalized);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save orchestration settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
            <div className="min-w-0 flex-1 self-center">
              <CardTitle className="flex items-center gap-2 text-base">
                <UsersRound className="size-4 text-[var(--ec-accent)]" />
                Durable orchestration
              </CardTitle>
              <CardDescription className="mt-1 max-w-2xl">
                Choose the models and reusable roles available to delegation-enabled coordinator runs.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32 space-y-1">
                <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">
                  <span>Parallel tasks</span>
                  <SettingsHelp
                    label="About maximum concurrent tasks"
                    title="Maximum concurrent tasks"
                    align="left"
                  >
                    The most durable child tasks BuildWarden may run at once across active orchestrations. Extra tasks
                    wait in the queue. Role and model capacity can lower the actual concurrency; provider-native
                    subagents are not counted.
                  </SettingsHelp>
                </span>
                <Input
                  type="number"
                  min={1}
                  max={8}
                  aria-label="Maximum concurrent orchestration tasks"
                  className="h-8 text-xs tabular-nums"
                  value={draft.maxConcurrentTasks}
                  disabled={!canEdit}
                  onChange={(event) => {
                    setSaved(false);
                    setDraft((current) => ({
                      ...current,
                      maxConcurrentTasks: clampInteger(event.target.value, current.maxConcurrentTasks, 1, 8),
                    }));
                  }}
                />
              </div>
              <div className="w-32 space-y-1">
                <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">
                  <span>Tasks per run</span>
                  <SettingsHelp
                    label="About maximum tasks per orchestration"
                    title="Lifetime task limit"
                    align="right"
                  >
                    The most durable tasks one orchestration may create over its lifetime—not a target. Completed,
                    failed, cancelled, and retry replacement tasks all count. Further delegation is rejected after
                    this limit is reached.
                  </SettingsHelp>
                </span>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  aria-label="Maximum tasks per orchestration"
                  className="h-8 text-xs tabular-nums"
                  value={draft.maxTasksPerOrchestration}
                  disabled={!canEdit}
                  onChange={(event) => {
                    setSaved(false);
                    setDraft((current) => ({
                      ...current,
                      maxTasksPerOrchestration: clampInteger(event.target.value, current.maxTasksPerOrchestration, 1, 64),
                    }));
                  }}
                />
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5"
                disabled={!canEdit || saving}
                onClick={() => void save()}
              >
                <Save className="size-3.5" />
                {saving ? "Saving…" : saved ? "Saved" : "Save team"}
              </Button>
            </div>
          </div>
          {saveError ? (
            <p role="alert" className="mt-2 text-right text-[11px] text-[var(--ec-danger)]">
              {saveError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <CardTitle className="text-base">Model pool</CardTitle>
            <CardDescription>
              Only selected models can receive delegated work. Capacity limits queue excess tasks.
            </CardDescription>
          </div>
          <span className="shrink-0 rounded-full bg-[var(--ec-panel-soft)] px-2 py-1 text-[10px] font-medium tabular-nums text-[var(--ec-muted)]">
            {selectedModelIds.size} active
          </span>
        </CardHeader>
        <CardContent className="border-t border-[var(--ec-border)] p-0">
          {enabledModels.length === 0 ? (
            <p className="px-4 py-5 text-sm text-[var(--ec-muted)]">Configure and enable a model first.</p>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,1fr)_10rem_5.5rem] gap-3 bg-[var(--ec-panel-soft)] px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)] sm:grid">
                <span>Model</span>
                <span>Default effort</span>
                <span>Capacity</span>
              </div>
              <div className="divide-y divide-[var(--ec-border)]">
                {enabledModels.map((model) => {
                  const profile = draft.models.find((entry) => entry.modelId === model.id);
                  const enabled = profile?.enabled === true;
                  return (
                    <div
                      key={model.id}
                      className="grid min-h-12 items-center gap-2 px-4 py-2 transition-colors hover:bg-[var(--ec-hover)] sm:grid-cols-[minmax(0,1fr)_10rem_5.5rem] sm:gap-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Switch
                          checked={enabled}
                          disabled={!canEdit}
                          aria-label={`${enabled ? "Disable" : "Enable"} ${model.displayName}`}
                          onCheckedChange={(checked) => setModelEnabled(model.id, checked)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-[var(--ec-text)]">
                            {model.displayName}
                          </span>
                          <span className="block truncate text-[10px] text-[var(--ec-faint)]">
                            {providerLabels.get(model.providerAccountId) ?? "Provider"} · {model.modelId}
                          </span>
                        </span>
                      </div>
                      <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 sm:block">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)] sm:hidden">
                          Effort
                        </span>
                        <Select
                          value={profile?.defaultEffort ?? ""}
                          options={EFFORT_OPTIONS}
                          ariaLabel={`Default effort for ${model.displayName}`}
                          disabled={!canEdit || !enabled}
                          triggerClassName="h-8 rounded-md px-2.5 text-xs"
                          maxMenuHeightPx={240}
                          onValueChange={(value) => updateModel(model.id, (current) => ({
                            ...current,
                            defaultEffort: value || undefined,
                          }))}
                        />
                      </div>
                      <label className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 sm:block">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)] sm:hidden">
                          Capacity
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={8}
                          aria-label={`Concurrency for ${model.displayName}`}
                          className="h-8 text-xs tabular-nums"
                          value={profile?.maxConcurrent ?? 1}
                          disabled={!canEdit || !enabled}
                          onChange={(event) => updateModel(model.id, (current) => ({
                            ...current,
                            maxConcurrent: clampInteger(event.target.value, current.maxConcurrent, 1, 8),
                          }))}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <span>Roles</span>
              <SettingsHelp
                label="About orchestration roles"
                title="How role selection works"
                align="left"
              >
                Roles are routing profiles used when the coordinator delegates a durable task. It chooses a role from
                the task purpose and the role name and description—for example research, implementation, or review.
                The preferred model is used unless the coordinator explicitly requests another eligible model. Role
                and model capacity then determine whether the task starts immediately or waits in the queue.
              </SettingsHelp>
            </CardTitle>
            <CardDescription>Every role needs an eligible preferred model before delegation can be enabled.</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value=""
              placeholder="Add predefined"
              ariaLabel="Add a predefined orchestration role"
              className="w-40"
              triggerClassName="h-8 rounded-md px-2.5 text-xs"
              menuClassName="w-80"
              maxMenuHeightPx={280}
              disabled={!canEdit || selectedModelIds.size === 0}
              options={predefinedRoleOptions}
              onValueChange={(presetId) => {
                const role = createOrchestrationRoleFromPreset(presetId, [...selectedModelIds]);
                if (!role) return;
                setSaved(false);
                setDraft((current) => current.roles.some((entry) => entry.id === role.id)
                  ? current
                  : { ...current, roles: [...current.roles, role] });
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              disabled={!canEdit || selectedModelIds.size === 0}
              onClick={() => {
                setSaved(false);
                setDraft((current) => ({
                  ...current,
                  roles: [...current.roles, newRole([...selectedModelIds][0] ?? "")],
                }));
              }}
            >
              <Plus className="size-3.5" />
              Add custom role
            </Button>
          </div>
        </CardHeader>
        <CardContent className="border-t border-[var(--ec-border)] p-0">
          {draft.roles.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--ec-muted)]">
              {selectedModelIds.size === 0
                ? "Enable at least one model, then add a role."
                : "Add a predefined role or create a custom role."}
            </div>
          ) : draft.roles.map((role) => (
            <section key={role.id} className="border-b border-[var(--ec-border)] p-3 last:border-b-0">
              <div className="grid gap-2 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(11rem,0.7fr)_5.5rem_auto]">
                <label className="space-y-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">Role</span>
                  <Input
                    className="h-8 text-xs"
                    value={role.name}
                    disabled={!canEdit}
                    placeholder="Role name"
                    onChange={(event) => updateRole(role.id, (current) => ({
                      ...current,
                      name: event.target.value,
                    }))}
                  />
                </label>
                <div className="space-y-1">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">
                    Preferred model
                  </span>
                  <Select
                    value={role.preferredModelId}
                    placeholder="Choose a model"
                    ariaLabel={`Preferred model for ${role.name || "role"}`}
                    disabled={!canEdit}
                    options={enabledModels.filter((model) => selectedModelIds.has(model.id)).map((model) => ({
                      value: model.id,
                      label: model.displayName,
                      description: providerLabels.get(model.providerAccountId) ?? "Provider",
                    }))}
                    triggerClassName="h-8 rounded-md px-2.5 text-xs"
                    maxMenuHeightPx={280}
                    onValueChange={(value) => updateRole(role.id, (current) => ({
                      ...current,
                      preferredModelId: value,
                      eligibleModelIds: current.eligibleModelIds.includes(value)
                        ? current.eligibleModelIds
                        : [...current.eligibleModelIds, value],
                    }))}
                  />
                </div>
                <label className="space-y-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">
                    Capacity
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    className="h-8 text-xs tabular-nums"
                    title="Per-role concurrency"
                    value={role.maxConcurrent}
                    disabled={!canEdit}
                    onChange={(event) => updateRole(role.id, (current) => ({
                      ...current,
                      maxConcurrent: clampInteger(event.target.value, current.maxConcurrent, 1, 8),
                    }))}
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-5 size-8 text-[var(--ec-muted)] hover:text-[var(--ec-danger)]"
                  disabled={!canEdit}
                  title="Remove role"
                  onClick={() => {
                    setSaved(false);
                    setDraft((current) => ({
                      ...current,
                      roles: current.roles.filter((entry) => entry.id !== role.id),
                    }));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Input
                className="mt-2 h-8 text-xs"
                value={role.description}
                aria-label={`Description for ${role.name || "role"}`}
                disabled={!canEdit}
                placeholder="What should coordinators use this role for?"
                onChange={(event) => updateRole(role.id, (current) => ({
                  ...current,
                  description: event.target.value,
                }))}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">
                  Eligible
                </span>
                {enabledModels.filter((model) => selectedModelIds.has(model.id)).map((model) => {
                  const checked = role.eligibleModelIds.includes(model.id);
                  return (
                    <button
                      type="button"
                      key={model.id}
                      aria-pressed={checked}
                      disabled={!canEdit}
                      className={`rounded-md border px-2 py-1 text-[10px] font-medium transition disabled:opacity-50 ${
                        checked
                          ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                          : "border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]"
                      }`}
                      onClick={() => updateRole(role.id, (current) => {
                        const eligibleModelIds = checked
                          ? current.eligibleModelIds.filter((id) => id !== model.id)
                          : Array.from(new Set([...current.eligibleModelIds, model.id]));
                        return {
                          ...current,
                          eligibleModelIds,
                          preferredModelId: eligibleModelIds.includes(current.preferredModelId)
                            ? current.preferredModelId
                            : (eligibleModelIds[0] ?? ""),
                        };
                      })}
                    >
                      {model.displayName}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {!canEdit ? (
            <p className="border-t border-[var(--ec-border)] px-4 py-2 text-[11px] text-[var(--ec-faint)]">
              The admin scope is required to edit orchestration settings.
            </p>
          ) : validRoleCount === 0 ? (
            <p className="border-t border-[var(--ec-border)] px-4 py-2 text-[11px] text-[var(--ec-danger)]">
              Add a valid role before enabling delegation.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
};
