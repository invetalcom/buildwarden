import type { AppSnapshot } from "@buildwarden/shared";
import { CheckCircle2, ChevronDown, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { PROVIDER_TYPE_LABELS } from "./provider-model-labels";

type OpenPanel = "connection" | "model" | null;

const ReadinessBadge = ({ ready, children }: { ready: boolean; children: React.ReactNode }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs",
      ready
        ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
        : "border-[var(--ec-border)] bg-[var(--ec-control)] text-[var(--ec-muted)]",
    )}
  >
    {ready ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
    {children} {ready ? "ready" : "needed"}
  </span>
);

const WelcomeReadiness = ({ providerReady, modelReady }: { providerReady: boolean; modelReady: boolean }) => (
  <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm leading-5 text-[var(--ec-muted)]">
        Add one provider and one model to get started. You can add more anytime in Settings.
      </p>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <ReadinessBadge ready={providerReady}>Connection</ReadinessBadge>
        <ReadinessBadge ready={modelReady}>Model</ReadinessBadge>
      </div>
    </div>
  </div>
);

const EmptyRegistry = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-xl border border-dashed border-zinc-800/80 px-3 py-4 text-center text-sm text-zinc-500">{children}</p>
);

const SavedConnections = ({
  accounts,
  onDelete,
}: {
  accounts: AppSnapshot["providerAccounts"];
  onDelete: (providerAccountId: string) => void;
}) => (
  <Card className="app-surface-inset-soft border-white/8 p-4">
    <div className="flex items-center justify-between gap-2">
      <div>
        <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/60">Saved connections</p>
        <p className="mt-0.5 text-sm text-zinc-400">Provider accounts on this device</p>
      </div>
      <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-0.5 text-xs text-zinc-400">
        {accounts.length}
      </span>
    </div>
    <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-0.5">
      {accounts.length === 0 ? <EmptyRegistry>No connections yet. Add one below.</EmptyRegistry> : null}
      {accounts.map((provider) => (
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
            onClick={() => onDelete(provider.id)}
            title="Delete provider"
            aria-label={`Delete provider ${provider.label}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  </Card>
);

const SavedModels = ({
  accounts,
  models,
  onDelete,
}: {
  accounts: AppSnapshot["providerAccounts"];
  models: AppSnapshot["models"];
  onDelete: (modelId: string) => void;
}) => (
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
      {models.length === 0 ? <EmptyRegistry>No models yet. Add one to pick it in the composer.</EmptyRegistry> : null}
      {models.map((model) => {
        const provider = accounts.find((entry) => entry.id === model.providerAccountId);
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
              onClick={() => onDelete(model.id)}
              title="Delete model"
              aria-label={`Delete model ${model.displayName}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  </Card>
);

export const ProviderModelsOverview = ({
  welcome,
  accounts,
  models,
  onDeleteProvider,
  onDeleteModel,
}: {
  welcome: boolean;
  accounts: AppSnapshot["providerAccounts"];
  models: AppSnapshot["models"];
  onDeleteProvider: (providerAccountId: string) => void;
  onDeleteModel: (modelId: string) => void;
}) => {
  if (welcome) {
    return <WelcomeReadiness providerReady={accounts.length > 0} modelReady={models.length > 0} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SavedConnections accounts={accounts} onDelete={onDeleteProvider} />
      <SavedModels accounts={accounts} models={models} onDelete={onDeleteModel} />
    </div>
  );
};

const PanelButton = ({
  panel,
  openPanel,
  welcome,
  ready,
  disabled,
  onClick,
}: {
  panel: Exclude<OpenPanel, null>;
  openPanel: OpenPanel;
  welcome: boolean;
  ready: boolean;
  disabled: boolean;
  onClick: () => void;
}) => {
  const isConnection = panel === "connection";
  const open = openPanel === panel;
  const activeClass = isConnection
    ? "border-cyan-400/35 bg-cyan-500/[0.08] text-cyan-100"
    : "border-fuchsia-400/30 bg-fuchsia-500/[0.07] text-fuchsia-100";
  let title = `Add a ${panel}`;
  if (welcome) {
    title = isConnection ? "1. Connection" : "2. Model";
  }
  let description = "Tied to a connection; presets match your account";
  if (isConnection) {
    description = "Local SDK/CLI or bring your own API key";
  } else if (disabled) {
    description = "Unlocks after the connection";
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 border text-left transition",
        welcome ? "rounded-lg px-3 py-2.5 disabled:cursor-not-allowed disabled:opacity-55" : "rounded-2xl px-4 py-3.5",
        open ? activeClass : "border-white/8 bg-white/[0.02] text-zinc-200 hover:border-white/12 hover:bg-white/[0.04]",
      )}
    >
      <div className="space-y-0.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      {welcome && ready ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--ec-success)]" aria-hidden />
      ) : (
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition", open && "rotate-180")} />
      )}
    </button>
  );
};

export const ProviderModelPanelButtons = ({
  welcome,
  providerReady,
  modelReady,
  openPanel,
  onOpenPanelChange,
}: {
  welcome: boolean;
  providerReady: boolean;
  modelReady: boolean;
  openPanel: OpenPanel;
  onOpenPanelChange: (panel: OpenPanel) => void;
}) => {
  const selectPanel = (panel: Exclude<OpenPanel, null>) => {
    onOpenPanelChange(welcome || openPanel !== panel ? panel : null);
  };
  return (
    <div className={cn("grid sm:grid-cols-2", welcome ? "gap-2" : "gap-3")}>
      <PanelButton
        panel="connection"
        openPanel={openPanel}
        welcome={welcome}
        ready={providerReady}
        disabled={false}
        onClick={() => selectPanel("connection")}
      />
      <PanelButton
        panel="model"
        openPanel={openPanel}
        welcome={welcome}
        ready={modelReady}
        disabled={welcome && !providerReady}
        onClick={() => selectPanel("model")}
      />
    </div>
  );
};
