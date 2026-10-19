import { useCallback, useEffect, useMemo, useState } from "react";
import {
  normalizeModelPriceOverrideKey,
  type ModelPriceOverride,
  type UsageCostReport,
  type UsageModelCostRow,
} from "@buildwarden/shared";
import { CircleDollarSign, Loader2, Pencil, RefreshCw, RotateCcw, X } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import {
  COST_CATEGORIES,
  formatRate,
  formatTokenCount,
  formatUsd,
  parsePriceOverrideDraft,
  priceOverrideDraftFor,
  providerTypeLabel,
  USAGE_RANGE_OPTIONS,
  type PriceOverrideDraft,
} from "./usage-dashboard-model";

export type UsageDashboardDialogProps = {
  /** Price overrides are host settings, so read-only sessions see prices but cannot change them. */
  canEditPrices: boolean;
  priceOverrides: Readonly<Record<string, ModelPriceOverride>>;
  onPriceOverridesChange: (next: Record<string, ModelPriceOverride>) => Promise<void>;
  onClose: () => void;
};

const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const Kpi = ({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warning" | "success" }) => (
  <div className="min-w-0 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2">
    <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">{label}</p>
    <p className={cn(
      "mt-0.5 truncate font-mono text-lg font-semibold text-[var(--ec-text)]",
      tone === "warning" && "text-[var(--ec-warning)]",
      tone === "success" && "text-[var(--ec-success)]",
    )}>{value}</p>
    {detail ? <p className="truncate text-[11px] text-[var(--ec-muted)]">{detail}</p> : null}
  </div>
);

const DailyCostChart = ({ report }: { report: UsageCostReport }) => {
  const days = report.daily.slice(-90);
  const max = Math.max(...days.map((day) => day.costUsd), 0);
  if (days.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">
        <span>Daily estimated cost</span>
        <span className="font-mono normal-case tracking-normal">peak {formatUsd(max)}</span>
      </div>
      <div className="mt-2 flex h-16 items-end gap-px" role="img" aria-label="Daily estimated cost">
        {days.map((day) => (
          <div
            key={day.day}
            className="group relative flex h-full min-w-0 flex-1 items-end"
            title={`${day.day}: ${formatUsd(day.costUsd)} · ${formatTokenCount(day.inputTokens)} in / ${formatTokenCount(day.outputTokens)} out`}
          >
            <div
              className="w-full rounded-t-sm bg-[var(--ec-accent)] opacity-80 group-hover:opacity-100"
              style={{ height: max > 0 ? `${Math.max(day.costUsd > 0 ? 3 : 0, (day.costUsd / max) * 100)}%` : "0%" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--ec-faint)]">
        <span>{days[0]?.day}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
    </div>
  );
};

const CostSplitBar = ({ report }: { report: UsageCostReport }) => {
  const total = report.totals.costUsd;
  if (total <= 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex h-2 min-w-40 flex-1 overflow-hidden rounded-full bg-[var(--ec-control)]">
        {COST_CATEGORIES.map((category) => (
          <div
            key={category.key}
            style={{ width: `${(report.totals.cost[category.key] / total) * 100}%`, background: category.colorVar }}
            title={`${category.label}: ${formatUsd(report.totals.cost[category.key])}`}
          />
        ))}
      </div>
      {COST_CATEGORIES.map((category) => (
        <span key={category.key} className="flex items-center gap-1 text-[11px] text-[var(--ec-muted)]">
          <span className="size-2 rounded-full" style={{ background: category.colorVar }} />
          {category.label} <span className="font-mono text-[var(--ec-text)]">{formatUsd(report.totals.cost[category.key])}</span>
        </span>
      ))}
    </div>
  );
};

const PriceEditor = ({
  draft,
  error,
  saving,
  onDraftChange,
  onSave,
  onCancel,
}: {
  draft: PriceOverrideDraft;
  error: string | null;
  saving: boolean;
  onDraftChange: (draft: PriceOverrideDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) => (
  <div className="flex flex-wrap items-end gap-2 py-1">
    {([
      ["inputPerMillion", "Input"],
      ["outputPerMillion", "Output"],
      ["cacheReadPerMillion", "Cache read"],
      ["cacheWritePerMillion", "Cache write"],
    ] as const).map(([key, label]) => (
      <label key={key} className="w-24 space-y-0.5">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--ec-muted)]">{label}</span>
        <Input
          className="h-7 px-2 font-mono text-xs"
          value={draft[key]}
          inputMode="decimal"
          placeholder={key.startsWith("cache") ? "= input" : "$ / 1M"}
          aria-label={`${label} USD per million tokens`}
          onChange={(event) => onDraftChange({ ...draft, [key]: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSave();
          }}
        />
      </label>
    ))}
    <Button type="button" size="xs" disabled={saving} onClick={onSave}>
      {saving ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
      Save
    </Button>
    <Button type="button" size="xs" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
    <span className="text-[11px] text-[var(--ec-muted)]">USD per 1M tokens. Blank cache rates use the input rate.</span>
    {error ? <span className="w-full text-[11px] text-[var(--ec-danger)]">{error}</span> : null}
  </div>
);

const ModelRow = ({
  row,
  override,
  editing,
  canEditPrices,
  onEdit,
  onReset,
}: {
  row: UsageModelCostRow;
  override: ModelPriceOverride | undefined;
  editing: boolean;
  canEditPrices: boolean;
  onEdit: () => void;
  onReset: () => void;
}) => (
  <tr className={cn("border-t border-[var(--ec-border)] align-top", editing && "bg-[var(--ec-accent-soft)]")}>
    <td className="max-w-64 py-1.5 pr-3">
      <p className="truncate font-mono text-xs text-[var(--ec-text)]" title={row.modelId}>{row.modelId}</p>
      <p className="truncate text-[10px] text-[var(--ec-muted)]">
        {providerTypeLabel(row.providerType)}
        {row.priceSource === "override" ? " · custom price" : row.matchedKey && row.matchedKey !== row.modelId.toLowerCase() ? ` · priced as ${row.matchedKey}` : ""}
      </p>
    </td>
    <td className="py-1.5 pr-3 text-right font-mono text-xs">{formatTokenCount(row.tokens.uncachedInputTokens)}</td>
    <td className="py-1.5 pr-3 text-right font-mono text-xs">{formatTokenCount(row.tokens.cacheReadTokens)}</td>
    <td className="py-1.5 pr-3 text-right font-mono text-xs">{formatTokenCount(row.tokens.cacheWriteTokens)}</td>
    <td className="py-1.5 pr-3 text-right font-mono text-xs">{formatTokenCount(row.tokens.outputTokens)}</td>
    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-[11px] text-[var(--ec-muted)]">
      {row.rates ? `${formatRate(row.rates.inputPerMillion)} / ${formatRate(row.rates.outputPerMillion)}` : "—"}
    </td>
    <td className="py-1.5 pr-3 text-right font-mono text-xs font-semibold text-[var(--ec-text)]">
      {row.costUsd === null ? <span className="font-normal text-[var(--ec-warning)]">No price</span> : formatUsd(row.costUsd)}
    </td>
    <td className="whitespace-nowrap py-1 text-right">
      {canEditPrices ? (
        <Button type="button" size="xs" variant={row.costUsd === null ? "secondary" : "ghost"} onClick={onEdit} aria-label={`Set price for ${row.modelId}`}>
          <Pencil className="mr-1 size-3" />
          {row.costUsd === null ? "Set price" : "Edit"}
        </Button>
      ) : null}
      {canEditPrices && override ? (
        <Button type="button" size="xs" variant="ghost" onClick={onReset} title="Reset to automatic price" aria-label={`Reset price for ${row.modelId}`}>
          <RotateCcw className="size-3" />
        </Button>
      ) : null}
    </td>
  </tr>
);

export const UsageDashboardDialog = ({ canEditPrices, priceOverrides, onPriceOverridesChange, onClose }: UsageDashboardDialogProps) => {
  const buildwarden = useBuildWardenClient();
  const [rangeDays, setRangeDays] = useState<number | null>(30);
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<PriceOverrideDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savingPrice, setSavingPrice] = useState(false);

  const loadReport = useCallback(async (refreshPricing = false) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await buildwarden.getUsageCostReport({ rangeDays, refreshPricing }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Usage could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [buildwarden, rangeDays]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const modelKey = (row: UsageModelCostRow) => `${row.providerType}:${row.modelId}`;
  const editingRow = useMemo(
    () => report?.models.find((row) => modelKey(row) === editingModelKey) ?? null,
    [editingModelKey, report],
  );

  const saveOverrides = async (next: Record<string, ModelPriceOverride>) => {
    setSavingPrice(true);
    try {
      await onPriceOverridesChange(next);
      setEditingModelKey(null);
      setDraft(null);
      await loadReport();
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : "The price could not be saved.");
    } finally {
      setSavingPrice(false);
    }
  };

  const savePrice = () => {
    if (!editingRow || !draft) return;
    const parsed = parsePriceOverrideDraft(draft);
    if (typeof parsed === "string") {
      setDraftError(parsed);
      return;
    }
    setDraftError(null);
    void saveOverrides({ ...priceOverrides, [normalizeModelPriceOverrideKey(editingRow.modelId)]: parsed });
  };

  const resetPrice = (row: UsageModelCostRow) => {
    const next = { ...priceOverrides };
    delete next[normalizeModelPriceOverrideKey(row.modelId)];
    void saveOverrides(next);
  };

  const totals = report?.totals;
  const unattributedTokens = report ? report.unattributed.inputTokens + report.unattributed.outputTokens : 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-dashboard-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="flex max-h-[92vh] w-full max-w-6xl flex-col !bg-[var(--ec-bg-elevated)] p-0 shadow-[var(--ec-popover-shadow)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ec-border)] px-4 py-2.5">
          <CircleDollarSign className="size-4 text-[var(--ec-accent)]" />
          <h2 id="usage-dashboard-title" className="text-sm font-semibold text-[var(--ec-text)]">Usage &amp; estimated cost</h2>
          <div className="ml-2 flex items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-0.5 text-xs" role="group" aria-label="Usage period">
            {USAGE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={rangeDays === option.days}
                className={cn(
                  "rounded px-2 py-0.5",
                  rangeDays === option.days ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:text-[var(--ec-text)]",
                )}
                onClick={() => setRangeDays(option.days)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {loading ? <Loader2 className="size-3.5 animate-spin text-[var(--ec-muted)]" /> : null}
          <div className="ml-auto flex items-center gap-2">
            {report ? (
              <span
                className={cn("text-[11px]", report.pricing.status === "unavailable" ? "text-[var(--ec-warning)]" : "text-[var(--ec-muted)]")}
                title={[report.pricing.source, report.pricing.error].filter(Boolean).join("\n")}
              >
                {report.pricing.status === "unavailable"
                  ? "Price list unavailable"
                  : `LiteLLM prices · ${report.pricing.knownModels.toLocaleString()} models · ${formatRelativeTime(report.pricing.fetchedAt)}`}
              </span>
            ) : null}
            <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={() => void loadReport(true)}>
              <RefreshCw className="mr-1 size-3" />
              Refresh prices
            </Button>
            <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Close usage dashboard" autoFocus onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error ? <p className="rounded-md border border-[var(--ec-danger)] px-3 py-2 text-xs text-[var(--ec-danger)]">{error}</p> : null}
          {report?.pricing.error ? <p className="text-[11px] text-[var(--ec-warning)]">{report.pricing.error}</p> : null}

          {report && totals ? (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Kpi label="Estimated API cost" value={formatUsd(totals.costUsd)} detail={`${report.models.filter((row) => row.costUsd !== null).length} priced models`} />
                <Kpi
                  label="Tokens"
                  value={formatTokenCount(totals.tokens.inputTokens + totals.tokens.outputTokens)}
                  detail={`${formatTokenCount(totals.tokens.inputTokens)} in · ${formatTokenCount(totals.tokens.outputTokens)} out`}
                />
                <Kpi
                  label="Cache savings"
                  value={formatUsd(totals.cacheSavingsUsd)}
                  detail={`${formatTokenCount(totals.tokens.cacheReadTokens)} cached input tokens`}
                  tone={totals.cacheSavingsUsd > 0 ? "success" : undefined}
                />
                <Kpi
                  label="Unpriced tokens"
                  value={formatTokenCount(totals.unpricedTokens + unattributedTokens)}
                  detail={unattributedTokens > 0
                    ? `${formatTokenCount(unattributedTokens)} recorded before cost tracking`
                    : canEditPrices ? "Set a price for models without one" : "Models without a known price"}
                  tone={totals.unpricedTokens + unattributedTokens > 0 ? "warning" : undefined}
                />
              </div>
              <CostSplitBar report={report} />
              <DailyCostChart report={report} />

              <section>
                <h3 className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">Models</h3>
                {report.models.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[var(--ec-text)]">
                      <thead>
                        <tr className="text-right text-[10px] uppercase tracking-[0.12em] text-[var(--ec-muted)]">
                          <th className="py-1 pr-3 text-left font-medium">Model</th>
                          <th className="py-1 pr-3 font-medium">Input</th>
                          <th className="py-1 pr-3 font-medium">Cache read</th>
                          <th className="py-1 pr-3 font-medium">Cache write</th>
                          <th className="py-1 pr-3 font-medium">Output</th>
                          <th className="py-1 pr-3 font-medium" title="USD per 1M input / output tokens">$/1M in / out</th>
                          <th className="py-1 pr-3 font-medium">Cost</th>
                          <th className="py-1 font-medium"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.models.map((row) => {
                          const key = modelKey(row);
                          const override = priceOverrides[normalizeModelPriceOverrideKey(row.modelId)];
                          return [
                            <ModelRow
                              key={key}
                              row={row}
                              override={override}
                              editing={editingModelKey === key}
                              canEditPrices={canEditPrices}
                              onEdit={() => {
                                setEditingModelKey(key);
                                setDraft(priceOverrideDraftFor(row, override));
                                setDraftError(null);
                              }}
                              onReset={() => resetPrice(row)}
                            />,
                            editingModelKey === key && draft ? (
                              <tr key={`${key}:editor`} className="bg-[var(--ec-accent-soft)]">
                                <td colSpan={8} className="px-1">
                                  <PriceEditor
                                    draft={draft}
                                    error={draftError}
                                    saving={savingPrice}
                                    onDraftChange={setDraft}
                                    onSave={savePrice}
                                    onCancel={() => {
                                      setEditingModelKey(null);
                                      setDraft(null);
                                    }}
                                  />
                                </td>
                              </tr>
                            ) : null,
                          ];
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--ec-muted)]">No attributed usage in this period yet. Runs and chats record their model from now on.</p>
                )}
              </section>

              {report.projects.length ? (
                <section>
                  <h3 className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">Projects</h3>
                  <div className="grid gap-x-6 sm:grid-cols-2">
                    {report.projects.map((project) => (
                      <div key={project.projectId ?? "standalone"} className="flex items-center gap-3 border-t border-[var(--ec-border)] py-1.5 text-xs">
                        <span className="min-w-0 flex-1 truncate text-[var(--ec-text)]">{project.name}</span>
                        <span className="font-mono text-[var(--ec-muted)]">{formatTokenCount(project.tokens.inputTokens + project.tokens.outputTokens)}</span>
                        <span className="w-20 text-right font-mono font-semibold text-[var(--ec-text)]">{formatUsd(project.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        <p className="border-t border-[var(--ec-border)] px-4 py-2 text-[11px] leading-4 text-[var(--ec-muted)]">
          Estimates apply public per-token API prices to recorded usage. Subscription plans (Claude, ChatGPT, Cursor) bill
          differently, so this is an API-equivalent figure, not your bill. Usage recorded before cost tracking is counted but not priced.
        </p>
      </Card>
    </div>
  );
};
