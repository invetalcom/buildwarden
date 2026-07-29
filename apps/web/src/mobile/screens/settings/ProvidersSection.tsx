import { useMemo, useState } from "react";
import type { ListAvailableProviderModelsResult, ModelRecord, ProviderAccountRecord } from "@buildwarden/shared";
import { PROVIDER_TYPE_LABELS } from "@buildwarden/renderer/logic";
import { Plus, Trash2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage } from "../../lib/format";
import { SettingGroup } from "../../components/SettingControls";
import { ConfirmSheet, Sheet } from "../../components/Sheet";
import { Badge, Button, CenteredSpinner, EmptyState, InlineError, Input, ListRow } from "../../components/primitives";

/**
 * Providers and models.
 *
 * Models can be added and removed here; creating a provider account cannot. A provider needs an API
 * key plus, for the CLI-backed providers, absolute paths to binaries on the host machine — neither
 * of which a phone can supply meaningfully, so that stays on the desktop app.
 */
export const ProvidersSection = () => {
  const { client, snapshot, snapshotStore } = useMobileApp();
  const action = useAction();
  const [addFor, setAddFor] = useState<ProviderAccountRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "model" | "provider"; id: string; label: string } | null>(null);

  const canEdit = client.capabilities.settings;
  const modelsByProvider = useMemo(() => {
    const map = new Map<string, ModelRecord[]>();
    for (const model of snapshot.models) {
      map.set(model.providerAccountId, [...(map.get(model.providerAccountId) ?? []), model]);
    }
    return map;
  }, [snapshot.models]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const run = pendingDelete.kind === "model"
      ? () => client.deleteModel(pendingDelete.id)
      : () => client.deleteProviderAccount(pendingDelete.id);
    if (!(await action.ok(run, `Could not delete ${pendingDelete.label}.`))) return;
    setPendingDelete(null);
    await snapshotStore.refresh();
  };

  return (
    <>
      {action.error ? <InlineError message={action.error} /> : null}

      {snapshot.providerAccounts.length === 0 ? (
        <EmptyState
          title="No providers configured"
          message="Add a provider in the BuildWarden desktop app; its models can then be managed here."
        />
      ) : (
        snapshot.providerAccounts.map((account) => {
          const models = modelsByProvider.get(account.id) ?? [];
          return (
            <SettingGroup
              key={account.id}
              title={account.label || PROVIDER_TYPE_LABELS[account.providerType]}
              hint={account.apiBaseUrl ?? PROVIDER_TYPE_LABELS[account.providerType]}
            >
              {models.length === 0 ? (
                <p className="px-4 py-2.5 text-[11px] text-[var(--ec-faint)]">No models yet.</p>
              ) : (
                models.map((model) => (
                  <ListRow
                    key={model.id}
                    title={model.displayName || model.modelId}
                    subtitle={model.modelId}
                    className="border-b border-[var(--ec-border)] last:border-b-0"
                    trailing={
                      <>
                        {model.enabled === 0 ? <Badge tone="neutral">off</Badge> : null}
                        {canEdit ? (
                          <button
                            type="button"
                            aria-label={`Delete ${model.displayName || model.modelId}`}
                            onClick={() =>
                              setPendingDelete({ kind: "model", id: model.id, label: model.displayName || model.modelId })
                            }
                            className="m-tap flex size-11 items-center justify-center text-[var(--ec-danger)]"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        ) : null}
                      </>
                    }
                  />
                ))
              )}
              {canEdit ? (
                <div className="flex gap-2 px-4 py-2.5">
                  <Button tone="neutral" size="sm" className="flex-1" onClick={() => setAddFor(account)}>
                    <Plus className="size-4" />
                    Add model
                  </Button>
                  <Button
                    tone="danger"
                    size="sm"
                    onClick={() =>
                      setPendingDelete({
                        kind: "provider",
                        id: account.id,
                        label: account.label || PROVIDER_TYPE_LABELS[account.providerType],
                      })
                    }
                  >
                    Remove provider
                  </Button>
                </div>
              ) : null}
            </SettingGroup>
          );
        })
      )}

      <p className="px-4 py-4 text-[11px] leading-5 text-[var(--ec-faint)]">
        Adding a provider needs an API key and, for the CLI providers, binary paths on the host machine, so it stays in
        the desktop app.
      </p>

      <AddModelSheet
        account={addFor}
        onClose={() => setAddFor(null)}
        onAdded={async () => {
          setAddFor(null);
          await snapshotStore.refresh();
        }}
      />

      <ConfirmSheet
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "provider" ? "Remove provider" : "Delete model"}
        message={
          pendingDelete?.kind === "provider"
            ? `Remove “${pendingDelete.label}” and every model configured under it? Existing runs keep their history.`
            : `Delete “${pendingDelete?.label ?? ""}”? Runs that used it keep their history.`
        }
        confirmLabel="Delete"
        danger
        busy={action.busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
};

/** Offers the provider's advertised models, falling back to typing a model id by hand. */
const AddModelSheet = ({
  account,
  onClose,
  onAdded,
}: {
  account: ProviderAccountRecord | null;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) => {
  const { client } = useMobileApp();
  const action = useAction();
  const [available, setAvailable] = useState<ListAvailableProviderModelsResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");

  const load = async () => {
    if (!account) return;
    setLoading(true);
    setListError(null);
    try {
      setAvailable(await client.listAvailableProviderModels({ providerAccountId: account.id }));
    } catch (caught) {
      setListError(errorMessage(caught, "The provider did not return a model list."));
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (!account || !modelId.trim()) return;
    const added = await action.run(
      () =>
        client.addModel({
          providerAccountId: account.id,
          modelId: modelId.trim(),
          displayName: displayName.trim() || modelId.trim(),
        }),
      "The host rejected that model.",
    );
    if (added) {
      setModelId("");
      setDisplayName("");
      setAvailable(null);
      await onAdded();
    }
  };

  return (
    <Sheet
      open={account !== null}
      onClose={onClose}
      title={`Add a model to ${account?.label ?? ""}`}
      dismissable={!action.busy}
      footer={
        <Button block busy={action.busy} disabled={!modelId.trim()} onClick={() => void submit()}>
          Add model
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        {action.error ? <InlineError message={action.error} /> : null}
        {listError ? <InlineError message={listError} /> : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Model id</span>
          <Input
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="gpt-5"
            autoCapitalize="none"
            autoCorrect="off"
            className="m-mono text-[13px]"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Display name</span>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Optional"
            className="text-[13px]"
          />
        </label>

        {available === null ? (
          <Button tone="neutral" size="sm" busy={loading} onClick={() => void load()}>
            List models this provider offers
          </Button>
        ) : loading ? (
          <CenteredSpinner />
        ) : available.models.length === 0 ? (
          <p className="text-[11px] text-[var(--ec-faint)]">
            {available.errorMessage ?? "The provider returned no models."}
          </p>
        ) : (
          <div className="m-scroll-thin max-h-64 overflow-y-auto rounded-md border border-[var(--ec-border)]">
            {available.models.map((model) => (
              <ListRow
                key={model.modelId}
                title={<span className="m-mono text-[12.5px]">{model.modelId}</span>}
                subtitle={model.unavailableReason ?? model.displayName}
                className="border-b border-[var(--ec-border)] last:border-b-0"
                onClick={() => {
                  setModelId(model.modelId);
                  setDisplayName(model.displayName);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
};
