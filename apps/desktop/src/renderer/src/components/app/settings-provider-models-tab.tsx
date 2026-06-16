import type { AppSnapshot, ProviderType, UnifiedModelPresetGroup, UnifiedProviderFamily } from "@buildwarden/shared";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, KeyRound, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
import {
  DEFAULT_ADD_MODEL_DRAFT,
  MODEL_PRESET_CUSTOM,
  PROVIDER_CONNECTION_KIND_LABELS,
  PROVIDER_TYPES_BY_CONNECTION_KIND,
  UNIFIED_MODEL_PRESET_GROUP_LABELS,
  connectionKindForProviderType,
  getModelPresetsByGroupForProvider,
  unifiedModelPresetGroupsInOrder,
} from "../../lib/openai-model-presets";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/cn";
import {
  EMPTY_AVAILABLE_PROVIDER_MODELS_STATE,
  shouldRequestAvailableProviderModels,
  type AvailableProviderModelsState,
} from "../../lib/available-provider-models";

const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  "ai-sdk": "AI SDK",
  "azure-legacy": "Azure Legacy",
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
};

const DEFAULT_LABEL_BY_TYPE: Record<ProviderType, string> = {
  "ai-sdk": "AI SDK",
  "azure-legacy": "Azure Legacy",
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
};

type ModelQuickPick = {
  modelId: string;
  displayName: string;
  description: string;
  disabled?: boolean;
};

const SettingsField = ({
  label,
  hint,
  compact = false,
  children,
}: {
  label: string;
  hint?: string;
  compact?: boolean;
  children: React.ReactNode;
}) => (
  <label className={cn("block", compact ? "space-y-1.5" : "space-y-2")}>
    <div className="space-y-1">
      <span className="block text-sm font-medium text-zinc-200">{label}</span>
      {hint ? <span className={cn("block text-zinc-500", compact ? "text-[11px] leading-4" : "text-xs leading-relaxed")}>{hint}</span> : null}
    </div>
    {children}
  </label>
);

export type ProviderModelsOpenPanel = "connection" | "model" | null;
export type ProviderModelsPresentation = "settings" | "welcome";

export type ProviderModelsSettingsTabProps = {
  busy: boolean;
  providerLabel: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily;
  apiKey: string;
  codexBinaryPath: string;
  codexHomePath: string;
  detectedCodexBinaryPath: string | null;
  claudeBinaryPath: string;
  claudeLaunchArgs: string;
  detectedClaudeBinaryPath: string | null;
  providerBaseUrl: string;
  providerConfigJson: string;
  providerAzureApiVersion: string;
  selectedProviderId: string;
  modelId: string;
  modelDisplayName: string;
  modelBaseUrl: string;
  providerAccounts: AppSnapshot["providerAccounts"];
  models: AppSnapshot["models"];
  openAiPresetUserChoseCustom: boolean;
  openAiPresetsGrouped: ReturnType<typeof getModelPresetsByGroupForProvider>;
  availableModelsState?: AvailableProviderModelsState;
  onSubmitProvider: () => void;
  onSubmitModel: () => void;
  onEnsureAvailableModels: (providerAccountId: string) => void;
  onDeleteProviderAccount: (providerAccountId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onProviderLabelChange: (value: string) => void;
  onProviderTypeChange: (value: ProviderType) => void;
  onProviderFamilyChange: (value: UnifiedProviderFamily) => void;
  onApiKeyChange: (value: string) => void;
  onCodexBinaryPathChange: (value: string) => void;
  onCodexHomePathChange: (value: string) => void;
  onClaudeBinaryPathChange: (value: string) => void;
  onClaudeLaunchArgsChange: (value: string) => void;
  onProviderBaseUrlChange: (value: string) => void;
  onProviderConfigJsonChange: (value: string) => void;
  onProviderAzureApiVersionChange: (value: string) => void;
  onSelectedProviderIdChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onModelDisplayNameChange: (value: string) => void;
  onModelBaseUrlChange: (value: string) => void;
  onSetOpenAiPresetUserChoseCustom: (value: boolean) => void;
  openPanel?: ProviderModelsOpenPanel;
  defaultOpenPanel?: ProviderModelsOpenPanel;
  onOpenPanelChange?: (panel: ProviderModelsOpenPanel) => void;
  presentation?: ProviderModelsPresentation;
};

export const ProviderModelsSettingsTab = ({
  busy,
  providerLabel,
  providerType,
  providerFamily,
  apiKey,
  codexBinaryPath,
  codexHomePath,
  detectedCodexBinaryPath,
  claudeBinaryPath,
  claudeLaunchArgs,
  detectedClaudeBinaryPath,
  providerBaseUrl,
  providerConfigJson,
  providerAzureApiVersion,
  selectedProviderId,
  modelId,
  modelDisplayName,
  modelBaseUrl,
  providerAccounts,
  models,
  openAiPresetUserChoseCustom,
  openAiPresetsGrouped,
  availableModelsState = EMPTY_AVAILABLE_PROVIDER_MODELS_STATE,
  onSubmitProvider,
  onSubmitModel,
  onEnsureAvailableModels,
  onDeleteProviderAccount,
  onDeleteModel,
  onProviderLabelChange,
  onProviderTypeChange,
  onProviderFamilyChange,
  onApiKeyChange,
  onCodexBinaryPathChange,
  onCodexHomePathChange,
  onClaudeBinaryPathChange,
  onClaudeLaunchArgsChange,
  onProviderBaseUrlChange,
  onProviderConfigJsonChange,
  onProviderAzureApiVersionChange,
  onSelectedProviderIdChange,
  onModelIdChange,
  onModelDisplayNameChange,
  onModelBaseUrlChange,
  onSetOpenAiPresetUserChoseCustom,
  openPanel: controlledOpenPanel,
  defaultOpenPanel = null,
  onOpenPanelChange,
  presentation = "settings",
}: ProviderModelsSettingsTabProps) => {
  const [internalOpenPanel, setInternalOpenPanel] = useState<ProviderModelsOpenPanel>(defaultOpenPanel);
  const [connectionKind, setConnectionKind] = useState<ReturnType<typeof connectionKindForProviderType> | null>(null);
  const openPanel = controlledOpenPanel ?? internalOpenPanel;
  const isWelcomePresentation = presentation === "welcome";
  const providerReady = providerAccounts.length > 0;
  const modelReady = models.length > 0;
  const showProviderBaseUrlField =
    !isWelcomePresentation ||
    providerType === "azure-legacy" ||
    (providerType === "ai-sdk" && providerFamily === "openai-compatible");
  const setOpenPanel = (next: ProviderModelsOpenPanel | ((current: ProviderModelsOpenPanel) => ProviderModelsOpenPanel)) => {
    const resolved = typeof next === "function" ? next(openPanel) : next;
    if (controlledOpenPanel === undefined) {
      setInternalOpenPanel(resolved);
    }
    onOpenPanelChange?.(resolved);
  };

  useEffect(() => {
    if (controlledOpenPanel === undefined) {
      setInternalOpenPanel(defaultOpenPanel);
    }
  }, [controlledOpenPanel, defaultOpenPanel]);

  useEffect(() => {
    if (openPanel === "connection") {
      setConnectionKind(connectionKindForProviderType(providerType));
    }
  }, [openPanel, providerType]);

  const setProviderTypeWithDefaults = (t: ProviderType) => {
    onProviderTypeChange(t);
    onProviderLabelChange(DEFAULT_LABEL_BY_TYPE[t]);
    if (t === "ai-sdk") onProviderFamilyChange("openai");
    setConnectionKind(connectionKindForProviderType(t));
  };

  const groupOrderForSelect = useMemo(
    () =>
      unifiedModelPresetGroupsInOrder().filter(
        (group: UnifiedModelPresetGroup) => (openAiPresetsGrouped[group] ?? []).length > 0,
      ),
    [openAiPresetsGrouped],
  );
  const fallbackQuickPicks = useMemo<ModelQuickPick[]>(
    () =>
      groupOrderForSelect.flatMap((group: UnifiedModelPresetGroup) =>
        (openAiPresetsGrouped[group] ?? []).map((preset) => ({
          modelId: preset.modelId,
          displayName: preset.displayName,
          description: UNIFIED_MODEL_PRESET_GROUP_LABELS[group],
        })),
      ),
    [groupOrderForSelect, openAiPresetsGrouped],
  );
  const providerQuickPicks = useMemo<ModelQuickPick[]>(
    () =>
      availableModelsState.models.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        description: model.unavailableReason ?? (model.source === "provider" ? "Provider" : "Curated"),
        disabled: Boolean(model.unavailableReason),
      })),
    [availableModelsState.models],
  );
  const quickPicks = useMemo<ModelQuickPick[]>(
    () =>
      availableModelsState.status === "loaded"
        ? providerQuickPicks
        : availableModelsState.status === "error" && providerQuickPicks.length > 0
          ? providerQuickPicks
          : fallbackQuickPicks,
    [availableModelsState.status, fallbackQuickPicks, providerQuickPicks],
  );
  const quickPickSourceLabel = quickPicks.some((model) => model.description === "Provider")
    ? "Available models reported for the selected account."
    : "Curated models for the selected account.";
  const quickPickMatch = quickPicks.find((preset) => preset.modelId === modelId.trim());
  const quickPickSelectValue =
    quickPicks.length === 0 || openAiPresetUserChoseCustom || !quickPickMatch ? MODEL_PRESET_CUSTOM : quickPickMatch.modelId;
  const modelLookupPending =
    selectedProviderId !== "" && (availableModelsState.status === "idle" || availableModelsState.status === "loading");

  useEffect(() => {
    if (shouldRequestAvailableProviderModels(openPanel, selectedProviderId, availableModelsState)) {
      onEnsureAvailableModels(selectedProviderId);
    }
  }, [availableModelsState, onEnsureAvailableModels, openPanel, selectedProviderId]);

  useEffect(() => {
    if (
      openPanel !== "model" ||
      !selectedProviderId ||
      openAiPresetUserChoseCustom ||
      availableModelsState.status !== "loaded" ||
      providerQuickPicks.length === 0
    ) {
      return;
    }
    const stillValid = providerQuickPicks.some((preset) => preset.modelId === modelId.trim() && !preset.disabled);
    if (stillValid) {
      return;
    }
    const first = providerQuickPicks.find((preset) => !preset.disabled);
    if (!first) {
      return;
    }
    onModelIdChange(first.modelId);
    onModelDisplayNameChange(first.displayName);
  }, [
    availableModelsState.status,
    modelId,
    onModelDisplayNameChange,
    onModelIdChange,
    openAiPresetUserChoseCustom,
    openPanel,
    providerQuickPicks,
    selectedProviderId,
  ]);

  return (
    <div className={cn(isWelcomePresentation ? "space-y-3" : "space-y-4")}>
      {isWelcomePresentation ? (
        <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-5 text-[var(--ec-muted)]">
              Add one provider and one model to get started. You can add more anytime in Settings.
            </p>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs",
                  providerReady
                    ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
                    : "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-muted)]",
                )}
              >
                {providerReady ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
                Connection {providerReady ? "ready" : "needed"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs",
                  modelReady
                    ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
                    : "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-muted)]",
                )}
              >
                {modelReady ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
                Model {modelReady ? "ready" : "needed"}
              </span>
            </div>
          </div>
        </div>
      ) : (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="app-surface-inset-soft border-white/8 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/60">Saved connections</p>
              <p className="mt-0.5 text-sm text-zinc-400">Provider accounts on this device</p>
            </div>
            <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-0.5 text-xs text-zinc-400">
              {providerAccounts.length}
            </span>
          </div>
          <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-0.5">
            {providerAccounts.length > 0 ? (
              providerAccounts.map((provider) => (
                <div
                  key={provider.id}
                  className="app-settings-list-row flex items-center justify-between gap-2 rounded-xl border border-zinc-800/90 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-100">{provider.label}</p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{PROVIDER_TYPE_LABELS[provider.providerType]}</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 text-rose-400 hover:border-rose-500/25 hover:bg-zinc-900 hover:text-rose-300"
                    onClick={() => onDeleteProviderAccount(provider.id)}
                    title="Delete provider"
                    aria-label={`Delete provider ${provider.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-zinc-800/80 px-3 py-4 text-center text-sm text-zinc-500">
                No connections yet. Add one below.
              </p>
            )}
          </div>
        </Card>

        <Card className="app-surface-inset-soft border-white/8 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-fuchsia-300/50">Model registry</p>
              <p className="mt-0.5 text-sm text-zinc-400">Registered for runs and chat</p>
            </div>
            <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-0.5 text-xs text-zinc-400">
              {models.length}
            </span>
          </div>
          <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-0.5">
            {models.length > 0 ? (
              models.map((model) => {
                const provider = providerAccounts.find((entry) => entry.id === model.providerAccountId);
                return (
                  <div
                    key={model.id}
                    className="app-settings-list-row flex items-center justify-between gap-2 rounded-xl border border-zinc-800/90 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-100">{model.displayName}</p>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">
                        {model.modelId}
                        {provider ? ` · ${provider.label}` : ""}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 text-rose-400 hover:border-rose-500/25 hover:bg-zinc-900 hover:text-rose-300"
                      onClick={() => onDeleteModel(model.id)}
                      title="Delete model"
                      aria-label={`Delete model ${model.displayName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })
            ) : (
              <p className="rounded-xl border border-dashed border-zinc-800/80 px-3 py-4 text-center text-sm text-zinc-500">
                No models yet. Add one to pick it in the composer.
              </p>
            )}
          </div>
        </Card>
      </div>
      )}

      <div className={cn("grid sm:grid-cols-2", isWelcomePresentation ? "gap-2" : "gap-3")}>
        <button
          type="button"
          onClick={() => {
            if (isWelcomePresentation) {
              setOpenPanel("connection");
              return;
            }
            setOpenPanel((p) => (p === "connection" ? null : "connection"));
          }}
          className={cn(
            "flex w-full items-center justify-between gap-3 border text-left transition",
            isWelcomePresentation ? "rounded-lg px-3 py-2.5" : "rounded-2xl px-4 py-3.5",
            openPanel === "connection"
              ? "border-cyan-400/35 bg-cyan-500/[0.08] text-cyan-100"
              : "border-white/8 bg-white/[0.02] text-zinc-200 hover:border-white/12 hover:bg-white/[0.04]",
          )}
        >
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">{isWelcomePresentation ? "1. Connection" : "Add a connection"}</p>
            <p className="text-xs text-zinc-500">Local SDK/CLI or bring your own API key</p>
          </div>
          {isWelcomePresentation && providerReady ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
          ) : (
            <ChevronDown className={cn("h-4 w-4 shrink-0 transition", openPanel === "connection" ? "rotate-180" : "")} />
          )}
        </button>
        <button
          type="button"
          disabled={isWelcomePresentation && !providerReady}
          onClick={() => {
            if (isWelcomePresentation) {
              setOpenPanel("model");
              return;
            }
            setOpenPanel((p) => (p === "model" ? null : "model"));
          }}
          className={cn(
            "flex w-full items-center justify-between gap-3 border text-left transition",
            isWelcomePresentation ? "rounded-lg px-3 py-2.5 disabled:cursor-not-allowed disabled:opacity-55" : "rounded-2xl px-4 py-3.5",
            openPanel === "model"
              ? "border-fuchsia-400/30 bg-fuchsia-500/[0.07] text-fuchsia-100"
              : "border-white/8 bg-white/[0.02] text-zinc-200 hover:border-white/12 hover:bg-white/[0.04]",
          )}
        >
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">{isWelcomePresentation ? "2. Model" : "Add a model"}</p>
            <p className="text-xs text-zinc-500">
              {isWelcomePresentation && !providerReady ? "Unlocks after the connection" : "Tied to a connection; presets match your account"}
            </p>
          </div>
          {isWelcomePresentation && modelReady ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
          ) : (
            <ChevronDown className={cn("h-4 w-4 shrink-0 transition", openPanel === "model" ? "rotate-180" : "")} />
          )}
        </button>
      </div>

      {openPanel === "connection" ? (
        <Card
          className={cn(
            "app-surface-settings-form-card overflow-hidden p-0",
            isWelcomePresentation ? "rounded-lg border-[var(--ec-border)]" : "border-cyan-500/15",
          )}
        >
          <div className={cn("border-b border-white/6", isWelcomePresentation ? "px-4 py-2.5" : "px-5 py-3")}>
            <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/60">New connection</p>
            <h3 className={cn("mt-1 font-semibold text-zinc-50", isWelcomePresentation ? "text-base" : "text-lg")}>
              {isWelcomePresentation ? "Give BuildWarden a way to reach an AI" : "Set up a provider account"}
            </h3>
            <p className={cn("mt-0.5 text-zinc-500", isWelcomePresentation ? "text-xs" : "text-sm")}>
              Pick local tools or bring an API key. Nothing fancy required.
            </p>
          </div>
          <div className={cn(isWelcomePresentation ? "space-y-3 px-4 py-3" : "space-y-4 px-5 py-4")}>
            <div className={cn("grid sm:grid-cols-2", isWelcomePresentation ? "gap-2" : "gap-3")}>
              {(["local-sdk-cli", "bring-your-own-key"] as const).map((kind) => {
                const active = (connectionKind ?? connectionKindForProviderType(providerType)) === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      setConnectionKind(kind);
                      if (!PROVIDER_TYPES_BY_CONNECTION_KIND[kind].includes(providerType)) {
                        const [first] = PROVIDER_TYPES_BY_CONNECTION_KIND[kind];
                        if (first) setProviderTypeWithDefaults(first);
                      }
                    }}
                    className={cn(
                      "flex h-full flex-col items-start gap-1 border text-left transition",
                      isWelcomePresentation ? "min-h-[3.75rem] rounded-lg px-3 py-2.5" : "min-h-[4.5rem] rounded-2xl px-4 py-3",
                      active
                        ? "border-cyan-400/40 bg-cyan-500/10"
                        : "border-white/8 bg-zinc-950/40 hover:border-white/15",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                      {kind === "local-sdk-cli" ? <Terminal className="h-4 w-4 text-cyan-300/90" /> : null}
                      {kind === "bring-your-own-key" ? <KeyRound className="h-4 w-4 text-amber-200/80" /> : null}
                      {PROVIDER_CONNECTION_KIND_LABELS[kind]}
                    </span>
                    <span className={cn("text-zinc-500", isWelcomePresentation ? "text-[11px] leading-4" : "text-xs leading-relaxed")}>
                      {kind === "local-sdk-cli"
                        ? "Uses tools already on your machine (Codex or Claude Code)."
                        : "You supply a key or endpoint: AI SDK or Azure deployments."}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Integration</p>
                <div className="flex flex-wrap gap-2">
                  {PROVIDER_TYPES_BY_CONNECTION_KIND[connectionKind ?? connectionKindForProviderType(providerType)].map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setProviderTypeWithDefaults(t)}
                      className={cn(
                        "rounded-full border px-3.5 py-1.5 text-sm transition",
                        providerType === t
                          ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100"
                          : "border-zinc-700/80 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
                      )}
                    >
                      {PROVIDER_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

            <div className={cn("app-surface-inset-soft border", isWelcomePresentation ? "rounded-lg p-3" : "rounded-2xl p-4")}>
              {!isWelcomePresentation ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <SettingsField label="Display label" hint="Shown in menus next to this connection.">
                    <Input
                      value={providerLabel}
                      onChange={(event) => onProviderLabelChange(event.target.value)}
                      placeholder="e.g. Work OpenAI"
                    />
                  </SettingsField>
                  <div className="hidden md:block" aria-hidden />
                </div>
              ) : null}

              {providerType === "ai-sdk" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Provider family" hint="Select which vendor backs this account." compact={isWelcomePresentation}>
                    <Select
                      value={providerFamily}
                      onValueChange={(value) => {
                        const next = value as UnifiedProviderFamily;
                        onProviderFamilyChange(next);
                        if (isWelcomePresentation && next !== "openai-compatible") {
                          onProviderBaseUrlChange("");
                        }
                      }}
                      options={[
                        { value: "openai", label: "OpenAI" },
                        { value: "anthropic", label: "Anthropic" },
                        { value: "google", label: "Google" },
                        { value: "xai", label: "xAI" },
                        { value: "openai-compatible", label: "OpenAI-compatible" },
                      ]}
                      triggerClassName={cn("h-11", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}
                    />
                  </SettingsField>
                  <SettingsField
                    label="API key"
                    hint={providerFamily === "openai-compatible" ? "Optional on some self-hosted servers." : "Stored only on this machine."}
                    compact={isWelcomePresentation}
                  >
                    <Input value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} type="password" placeholder="Key" />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "codex-cli" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Codex binary path" hint="Leave blank to use `codex` on PATH." compact={isWelcomePresentation}>
                    <Input
                      value={codexBinaryPath}
                      onChange={(event) => onCodexBinaryPathChange(event.target.value)}
                      placeholder={detectedCodexBinaryPath ?? "codex or path to codex.cmd"}
                    />
                  </SettingsField>
                  <SettingsField label="CODEX_HOME" hint="If auth lives in a custom folder." compact={isWelcomePresentation}>
                    <Input value={codexHomePath} onChange={(event) => onCodexHomePathChange(event.target.value)} placeholder="Optional" />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "claude-code" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Claude binary path" hint="Leave blank to use `claude` on PATH." compact={isWelcomePresentation}>
                    <Input
                      value={claudeBinaryPath}
                      onChange={(event) => onClaudeBinaryPathChange(event.target.value)}
                      placeholder={detectedClaudeBinaryPath ?? "claude or path to claude.cmd"}
                    />
                  </SettingsField>
                  <SettingsField label="Launch arguments" hint="Optional extra CLI flags." compact={isWelcomePresentation}>
                    <Input
                      value={claudeLaunchArgs}
                      onChange={(event) => onClaudeLaunchArgsChange(event.target.value)}
                      placeholder="--add-dir C:\\path"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType !== "codex-cli" && providerType !== "claude-code" && (providerType === "azure-legacy" || showProviderBaseUrlField) ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {providerType === "azure-legacy" ? (
                    <SettingsField label="API key" hint="Optional for some Azure setups." compact={isWelcomePresentation}>
                      <Input
                        value={apiKey}
                        onChange={(event) => onApiKeyChange(event.target.value)}
                        type="password"
                        placeholder="Key"
                      />
                    </SettingsField>
                  ) : null}
                  {showProviderBaseUrlField ? (
                    <SettingsField
                      label="Base URL"
                      hint={
                        providerType === "azure-legacy"
                          ? "Deployment URL (includes deployment segment)."
                          : providerFamily === "openai-compatible"
                            ? "Root URL for the compatible server."
                            : "Gateway or proxy, optional."
                      }
                      compact={isWelcomePresentation}
                    >
                      <Input
                        value={providerBaseUrl}
                        onChange={(event) => onProviderBaseUrlChange(event.target.value)}
                        placeholder="Optional"
                      />
                    </SettingsField>
                  ) : null}
                </div>
              ) : null}

              {providerType === "azure-legacy" ? (
                <div className="mt-3">
                  <SettingsField label="Azure api-version" hint="The model ID below should match the deployment name." compact={isWelcomePresentation}>
                    <Input
                      value={providerAzureApiVersion}
                      onChange={(event) => onProviderAzureApiVersionChange(event.target.value)}
                      placeholder="2024-06-01"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "ai-sdk" && !isWelcomePresentation ? (
                <div className="mt-3">
                  <SettingsField label="Advanced provider config JSON" hint="Optional extra headers, etc.">
                    <Textarea
                      className="min-h-24 rounded-xl"
                      value={providerConfigJson}
                      onChange={(event) => onProviderConfigJsonChange(event.target.value)}
                      placeholder="{}"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "codex-cli" ? (
                <p className={cn("mt-3 border border-cyan-500/12 bg-cyan-500/[0.04] px-3 py-2 text-xs leading-relaxed text-zinc-500", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}>
                  Runs and chats go through a local <code className="text-zinc-400">codex app-server</code> using your CLI login
                  {detectedCodexBinaryPath ? <span> (detected: {detectedCodexBinaryPath})</span> : null}.
                </p>
              ) : null}
              {providerType === "claude-code" ? (
                <p className={cn("mt-3 border border-violet-500/12 bg-violet-500/[0.04] px-3 py-2 text-xs leading-relaxed text-zinc-500", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}>
                  Uses <code className="text-zinc-400">claude -p</code> and your local Claude Code session
                  {detectedClaudeBinaryPath ? <span> (detected: {detectedClaudeBinaryPath})</span> : null}.
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className={cn("min-w-[9rem]", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}
                onClick={onSubmitProvider}
                disabled={
                  busy ||
                  !providerLabel ||
                  (providerType === "azure-legacy" && !providerBaseUrl.trim()) ||
                  (providerType === "ai-sdk" && providerFamily === "openai-compatible" && !providerBaseUrl.trim()) ||
                  (providerType === "ai-sdk" && providerFamily !== "openai-compatible" && !apiKey.trim())
                }
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Save connection
              </Button>
              {!isWelcomePresentation ? (
                <Button type="button" variant="secondary" className="rounded-xl" onClick={() => setOpenPanel(null)}>
                  Collapse
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {openPanel === "model" ? (
        <Card
          className={cn(
            "app-surface-settings-form-card overflow-hidden p-0",
            isWelcomePresentation ? "rounded-lg border-[var(--ec-border)]" : "border-fuchsia-500/12",
          )}
        >
          <div className={cn("border-b border-white/6", isWelcomePresentation ? "px-4 py-2.5" : "px-5 py-3")}>
            <p className="text-[11px] uppercase tracking-[0.28em] text-fuchsia-300/50">New model</p>
            <h3 className={cn("mt-1 font-semibold text-zinc-50", isWelcomePresentation ? "text-base" : "text-lg")}>
              {isWelcomePresentation ? "Pick the model BuildWarden should use first" : "Register a model for a connection"}
            </h3>
            <p className={cn("mt-0.5 text-zinc-500", isWelcomePresentation ? "text-xs" : "text-sm")}>
              Presets are filtered to match the selected connection.
            </p>
          </div>
          <div className={cn(isWelcomePresentation ? "space-y-3 px-4 py-3" : "space-y-4 px-5 py-4")}>
            <SettingsField label="Connection" hint="Model entries always belong to one account." compact={isWelcomePresentation}>
              <Select
                value={selectedProviderId}
                onValueChange={onSelectedProviderIdChange}
                options={[
                  { value: "", label: "Select a connection" },
                  ...providerAccounts.map((provider) => ({
                    value: provider.id,
                    label: provider.label,
                    description: PROVIDER_TYPE_LABELS[provider.providerType],
                  })),
                ]}
                triggerClassName={cn("h-11", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}
              />
            </SettingsField>

            {selectedProviderId ? (
              <div className={cn("border border-fuchsia-500/15 bg-fuchsia-500/[0.04] p-3", isWelcomePresentation ? "rounded-lg" : "rounded-2xl")}>
                <p className="text-sm font-medium text-fuchsia-100/95">Quick picks</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {availableModelsState.status === "loaded"
                    ? quickPickSourceLabel
                    : "Only models that apply to the selected account."}
                </p>
                {modelLookupPending ? (
                  <div
                    className={cn(
                      "mt-2 flex h-11 items-center gap-2 border border-zinc-800 bg-black/30 px-3 text-sm text-zinc-400",
                      isWelcomePresentation ? "rounded-lg" : "rounded-xl",
                    )}
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Loading models...
                  </div>
                ) : availableModelsState.status === "loaded" && quickPicks.length === 0 ? (
                  <p className={cn("mt-2 border border-zinc-800/90 px-3 py-2 text-xs text-zinc-500", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}>
                    No models reported; enter a model ID manually.
                  </p>
                ) : (
                  <>
                    {availableModelsState.status === "error" ? (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-amber-300/90">Could not load live models. Showing curated quick picks.</p>
                        <Button
                          type="button"
                          variant="secondary"
                          className={cn("h-7 px-2.5 text-xs", isWelcomePresentation ? "rounded-md" : "rounded-lg")}
                          onClick={() => onEnsureAvailableModels(selectedProviderId)}
                        >
                          Retry
                        </Button>
                      </div>
                    ) : null}
                    <Select
                      className="mt-2"
                      triggerClassName={cn("h-11", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}
                      maxMenuHeightPx={320}
                      value={quickPickSelectValue}
                      onValueChange={(value) => {
                        if (value === MODEL_PRESET_CUSTOM) {
                          onSetOpenAiPresetUserChoseCustom(true);
                          return;
                        }
                        onSetOpenAiPresetUserChoseCustom(false);
                        const preset = quickPicks.find((p) => p.modelId === value);
                        if (preset) {
                          onModelIdChange(preset.modelId);
                          onModelDisplayNameChange(preset.displayName);
                        }
                      }}
                      options={[
                        { value: MODEL_PRESET_CUSTOM, label: "Custom" },
                        ...quickPicks.map((preset) => ({
                          value: preset.modelId,
                          label: `${preset.displayName} - ${preset.modelId}`,
                          description: preset.description,
                          disabled: preset.disabled,
                        })),
                      ]}
                    />
                  </>
                )}
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <SettingsField label="Model ID" hint="Identifier sent in API calls." compact={isWelcomePresentation}>
                <Input
                  value={modelId}
                  onChange={(event) => {
                    onSetOpenAiPresetUserChoseCustom(true);
                    onModelIdChange(event.target.value);
                  }}
                  placeholder={`e.g. ${DEFAULT_ADD_MODEL_DRAFT.modelId}`}
                />
              </SettingsField>
              <SettingsField label="Display name" hint="Label in the UI." compact={isWelcomePresentation}>
                <Input
                  value={modelDisplayName}
                  onChange={(event) => {
                    onModelDisplayNameChange(event.target.value);
                  }}
                  placeholder={`e.g. ${DEFAULT_ADD_MODEL_DRAFT.displayName}`}
                />
              </SettingsField>
            </div>
            {!isWelcomePresentation ? (
              <SettingsField label="Base URL override" hint="Only if this deployment needs its own URL.">
                <Input
                  value={modelBaseUrl}
                  onChange={(event) => onModelBaseUrlChange(event.target.value)}
                  placeholder="Optional"
                />
              </SettingsField>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className={cn("min-w-[9rem]", isWelcomePresentation ? "rounded-lg" : "rounded-xl")}
                onClick={onSubmitModel}
                disabled={busy || !selectedProviderId || !modelId}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add model
              </Button>
              {!isWelcomePresentation ? (
                <Button type="button" variant="secondary" className="rounded-xl" onClick={() => setOpenPanel(null)}>
                  Collapse
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
};
