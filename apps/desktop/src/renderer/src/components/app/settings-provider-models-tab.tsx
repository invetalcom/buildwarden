import type { AppSnapshot, ProviderType, UnifiedModelPreset, UnifiedModelPresetGroup, UnifiedProviderFamily } from "@easycode/shared";
import { useEffect, useState } from "react";
import { ChevronDown, KeyRound, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
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
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/cn";

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

const SettingsField = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <label className="block space-y-2">
    <div className="space-y-1">
      <span className="block text-sm font-medium text-zinc-200">{label}</span>
      {hint ? <span className="block text-xs leading-relaxed text-zinc-500">{hint}</span> : null}
    </div>
    {children}
  </label>
);

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
  modelPresetsForSelected: readonly UnifiedModelPreset[];
  showOpenAiModelPresets: boolean;
  openAiPresetSelectValue: string;
  openAiPresetsGrouped: ReturnType<typeof getModelPresetsByGroupForProvider>;
  onSubmitProvider: () => void;
  onSubmitModel: () => void;
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
  modelPresetsForSelected,
  showOpenAiModelPresets,
  openAiPresetSelectValue,
  openAiPresetsGrouped,
  onSubmitProvider,
  onSubmitModel,
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
}: ProviderModelsSettingsTabProps) => {
  const [openPanel, setOpenPanel] = useState<null | "connection" | "model">(null);
  const [connectionKind, setConnectionKind] = useState<ReturnType<typeof connectionKindForProviderType> | null>(null);

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

  const groupOrderForSelect = unifiedModelPresetGroupsInOrder().filter(
    (group: UnifiedModelPresetGroup) => (openAiPresetsGrouped[group] ?? []).length > 0,
  );

  return (
    <div className="space-y-4">
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

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setOpenPanel((p) => (p === "connection" ? null : "connection"))}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left transition",
            openPanel === "connection"
              ? "border-cyan-400/35 bg-cyan-500/[0.08] text-cyan-100"
              : "border-white/8 bg-white/[0.02] text-zinc-200 hover:border-white/12 hover:bg-white/[0.04]",
          )}
        >
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">Add a connection</p>
            <p className="text-xs text-zinc-500">Local SDK/CLI or bring your own API key</p>
          </div>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition", openPanel === "connection" ? "rotate-180" : "")} />
        </button>
        <button
          type="button"
          onClick={() => setOpenPanel((p) => (p === "model" ? null : "model"))}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left transition",
            openPanel === "model"
              ? "border-fuchsia-400/30 bg-fuchsia-500/[0.07] text-fuchsia-100"
              : "border-white/8 bg-white/[0.02] text-zinc-200 hover:border-white/12 hover:bg-white/[0.04]",
          )}
        >
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">Add a model</p>
            <p className="text-xs text-zinc-500">Tied to a connection; presets match your account</p>
          </div>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition", openPanel === "model" ? "rotate-180" : "")} />
        </button>
      </div>

      {openPanel === "connection" ? (
        <Card className="app-surface-settings-form-card overflow-hidden border-cyan-500/15 p-0">
          <div className="border-b border-white/6 px-5 py-3">
            <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/60">New connection</p>
            <h3 className="mt-1 text-lg font-semibold text-zinc-50">Set up a provider account</h3>
            <p className="mt-0.5 text-sm text-zinc-500">Pick how you authenticate, then the concrete integration.</p>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="grid gap-3 sm:grid-cols-2">
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
                      "flex h-full min-h-[4.5rem] flex-col items-start gap-1 rounded-2xl border px-4 py-3 text-left transition",
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
                    <span className="text-xs leading-relaxed text-zinc-500">
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

            <div className="app-surface-inset-soft rounded-2xl border p-4">
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

              {providerType === "ai-sdk" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Provider family" hint="Select which vendor backs this account.">
                    <select
                      className="app-input-surface h-11 w-full rounded-xl border border-zinc-800 px-3 text-sm text-zinc-100"
                      value={providerFamily}
                      onChange={(event) => onProviderFamilyChange(event.target.value as UnifiedProviderFamily)}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="google">Google</option>
                      <option value="xai">xAI</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                    </select>
                  </SettingsField>
                  <SettingsField
                    label="API key"
                    hint={providerFamily === "openai-compatible" ? "Optional on some self-hosted servers." : "Stored only on this machine."}
                  >
                    <Input value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} type="password" placeholder="Key" />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "codex-cli" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Codex binary path" hint="Leave blank to use `codex` on PATH.">
                    <Input
                      value={codexBinaryPath}
                      onChange={(event) => onCodexBinaryPathChange(event.target.value)}
                      placeholder={detectedCodexBinaryPath ?? "codex or path to codex.cmd"}
                    />
                  </SettingsField>
                  <SettingsField label="CODEX_HOME" hint="If auth lives in a custom folder.">
                    <Input value={codexHomePath} onChange={(event) => onCodexHomePathChange(event.target.value)} placeholder="Optional" />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "claude-code" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SettingsField label="Claude binary path" hint="Leave blank to use `claude` on PATH.">
                    <Input
                      value={claudeBinaryPath}
                      onChange={(event) => onClaudeBinaryPathChange(event.target.value)}
                      placeholder={detectedClaudeBinaryPath ?? "claude or path to claude.cmd"}
                    />
                  </SettingsField>
                  <SettingsField label="Launch arguments" hint="Optional extra CLI flags.">
                    <Input
                      value={claudeLaunchArgs}
                      onChange={(event) => onClaudeLaunchArgsChange(event.target.value)}
                      placeholder="--add-dir C:\\path"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType !== "codex-cli" && providerType !== "claude-code" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {providerType === "azure-legacy" ? (
                    <SettingsField label="API key" hint="Optional for some Azure setups.">
                      <Input
                        value={apiKey}
                        onChange={(event) => onApiKeyChange(event.target.value)}
                        type="password"
                        placeholder="Key"
                      />
                    </SettingsField>
                  ) : null}
                  <SettingsField
                    label="Base URL"
                    hint={
                      providerType === "azure-legacy"
                        ? "Deployment URL (includes deployment segment)."
                        : providerFamily === "openai-compatible"
                          ? "Root URL for the compatible server."
                          : "Gateway or proxy, optional."
                    }
                  >
                    <Input
                      value={providerBaseUrl}
                      onChange={(event) => onProviderBaseUrlChange(event.target.value)}
                      placeholder="Optional"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "azure-legacy" ? (
                <div className="mt-3">
                  <SettingsField label="Azure api-version" hint="The model ID below should match the deployment name.">
                    <Input
                      value={providerAzureApiVersion}
                      onChange={(event) => onProviderAzureApiVersionChange(event.target.value)}
                      placeholder="2024-06-01"
                    />
                  </SettingsField>
                </div>
              ) : null}

              {providerType === "ai-sdk" ? (
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
                <p className="mt-3 rounded-xl border border-cyan-500/12 bg-cyan-500/[0.04] px-3 py-2 text-xs leading-relaxed text-zinc-500">
                  Runs and chats go through a local <code className="text-zinc-400">codex app-server</code> using your CLI login
                  {detectedCodexBinaryPath ? <span> (detected: {detectedCodexBinaryPath})</span> : null}.
                </p>
              ) : null}
              {providerType === "claude-code" ? (
                <p className="mt-3 rounded-xl border border-violet-500/12 bg-violet-500/[0.04] px-3 py-2 text-xs leading-relaxed text-zinc-500">
                  Uses <code className="text-zinc-400">claude -p</code> and your local Claude Code session
                  {detectedClaudeBinaryPath ? <span> (detected: {detectedClaudeBinaryPath})</span> : null}.
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="min-w-[9rem] rounded-xl"
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
              <Button type="button" variant="secondary" className="rounded-xl" onClick={() => setOpenPanel(null)}>
                Collapse
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {openPanel === "model" ? (
        <Card className="app-surface-settings-form-card overflow-hidden border-fuchsia-500/12 p-0">
          <div className="border-b border-white/6 px-5 py-3">
            <p className="text-[11px] uppercase tracking-[0.28em] text-fuchsia-300/50">New model</p>
            <h3 className="mt-1 text-lg font-semibold text-zinc-50">Register a model for a connection</h3>
            <p className="mt-0.5 text-sm text-zinc-500">Presets are filtered to match the account you select.</p>
          </div>
          <div className="space-y-4 px-5 py-4">
            <SettingsField label="Connection" hint="Model entries always belong to one account.">
              <select
                className="app-input-surface h-11 w-full rounded-xl border border-zinc-800 px-3 text-sm text-zinc-100"
                value={selectedProviderId}
                onChange={(event) => onSelectedProviderIdChange(event.target.value)}
              >
                <option value="">Select a connection</option>
                {providerAccounts.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label} ({PROVIDER_TYPE_LABELS[provider.providerType]})
                  </option>
                ))}
              </select>
            </SettingsField>

            {showOpenAiModelPresets ? (
              <div className="rounded-2xl border border-fuchsia-500/15 bg-fuchsia-500/[0.04] p-3">
                <p className="text-sm font-medium text-fuchsia-100/95">Quick picks</p>
                <p className="mt-0.5 text-xs text-zinc-500">Only models that apply to the selected account.</p>
                <select
                  className="app-input-surface mt-2 h-11 w-full rounded-xl border border-zinc-800 px-3 text-sm text-zinc-100"
                  value={openAiPresetSelectValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === MODEL_PRESET_CUSTOM) {
                      onSetOpenAiPresetUserChoseCustom(true);
                      return;
                    }
                    onSetOpenAiPresetUserChoseCustom(false);
                    const preset = modelPresetsForSelected.find((p) => p.modelId === value);
                    if (preset) {
                      onModelIdChange(preset.modelId);
                      onModelDisplayNameChange(preset.displayName);
                    }
                  }}
                >
                  <option value={MODEL_PRESET_CUSTOM}>Custom</option>
                  {groupOrderForSelect.map((group: UnifiedModelPresetGroup) => (
                    <optgroup key={group} label={UNIFIED_MODEL_PRESET_GROUP_LABELS[group]}>
                      {openAiPresetsGrouped[group].map((preset) => (
                        <option key={`${group}-${preset.modelId}`} value={preset.modelId}>
                          {preset.displayName} — {preset.modelId}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            ) : selectedProviderId ? (
              <p className="rounded-xl border border-zinc-800/90 px-3 py-2 text-xs text-zinc-500">
                This connection has no quick picks (e.g. some Azure deployments). Enter the model ID your server expects.
              </p>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <SettingsField label="Model ID" hint="Identifier sent in API calls.">
                <Input
                  value={modelId}
                  onChange={(event) => onModelIdChange(event.target.value)}
                  placeholder={`e.g. ${DEFAULT_ADD_MODEL_DRAFT.modelId}`}
                />
              </SettingsField>
              <SettingsField label="Display name" hint="Label in the UI.">
                <Input
                  value={modelDisplayName}
                  onChange={(event) => onModelDisplayNameChange(event.target.value)}
                  placeholder={`e.g. ${DEFAULT_ADD_MODEL_DRAFT.displayName}`}
                />
              </SettingsField>
            </div>
            <SettingsField label="Base URL override" hint="Only if this deployment needs its own URL.">
              <Input
                value={modelBaseUrl}
                onChange={(event) => onModelBaseUrlChange(event.target.value)}
                placeholder="Optional"
              />
            </SettingsField>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="min-w-[9rem] rounded-xl"
                onClick={onSubmitModel}
                disabled={busy || !selectedProviderId || !modelId}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add model
              </Button>
              <Button type="button" variant="secondary" className="rounded-xl" onClick={() => setOpenPanel(null)}>
                Collapse
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
};
