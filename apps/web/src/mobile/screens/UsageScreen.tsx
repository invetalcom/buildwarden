import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APP_SETTING_KEYS,
  isUsageCostTrackingEnabled,
  normalizeModelPriceOverrideKey,
  parseModelPriceOverridesSetting,
  serializeModelPriceOverridesSetting,
  type UsageCostReport,
  type UsageModelCostRow,
} from "@buildwarden/shared";
import {
  COST_CATEGORIES,
  USAGE_RANGE_OPTIONS,
  formatRate,
  formatTokenCount,
  formatUsd,
  parsePriceOverrideDraft,
  priceOverrideDraftFor,
  providerTypeLabel,
  type PriceOverrideDraft,
} from "@buildwarden/renderer/logic";
import { CircleDollarSign, FolderGit2, MessageSquare, RefreshCw } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { useAppSettings } from "../data/use-app-settings";
import { errorMessage, relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { AppBar } from "../components/AppBar";
import { Sheet } from "../components/Sheet";
import {
  Badge,
  Button,
  CenteredSpinner,
  EmptyState,
  IconButton,
  InlineError,
  Input,
  ListRow,
  SectionLabel,
  SegmentedTabs,
  type SegmentOption,
} from "../components/primitives";

type RangeKey = "1" | "7" | "30" | "90" | "all";

const RANGE_OPTIONS: readonly SegmentOption<RangeKey>[] = USAGE_RANGE_OPTIONS.map((option) => ({
  value: (option.days === null ? "all" : String(option.days)) as RangeKey,
  label: option.label,
}));

const rangeDaysFor = (key: RangeKey): number | null => key === "all" ? null : Number(key);

const RANGE_CAPTIONS: Record<RangeKey, string> = {
  "1": "today",
  "7": "last 7 days",
  "30": "last 30 days",
  "90": "last 90 days",
  all: "all recorded usage",
};

const shortDay = (day: string): string =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Daily cost bars. A phone has no hover, so tapping a bar selects it and the caption above the
 * chart reports that day; the latest day is selected by default.
 */
const DailyCostChart = ({ report }: { report: UsageCostReport }) => {
  const days = report.daily.slice(-90);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const max = Math.max(...days.map((day) => day.costUsd), 0);
  const selected = days.find((day) => day.day === selectedDay) ?? days.at(-1);
  if (days.length < 2 || !selected) return null;

  return (
    <section className="mx-4 mt-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 pt-2.5 pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--ec-faint)]">{shortDay(selected.day)}</p>
        <p className="text-xs text-[var(--ec-muted)]">
          <span className="font-semibold text-[var(--ec-text)]">{formatUsd(selected.costUsd)}</span>
          {" · "}
          {formatTokenCount(selected.inputTokens + selected.outputTokens)} tokens
        </p>
      </div>
      <div className="mt-2 flex h-20 items-end gap-px" role="group" aria-label="Daily estimated cost">
        {days.map((day) => (
          <button
            key={day.day}
            type="button"
            aria-label={`${shortDay(day.day)}: ${formatUsd(day.costUsd)}`}
            aria-pressed={day.day === selected.day}
            onClick={() => setSelectedDay(day.day)}
            className="flex h-full min-w-0 flex-1 items-end"
          >
            <span
              className={cn(
                "w-full rounded-t-sm",
                day.day === selected.day ? "bg-[var(--ec-accent)]" : "bg-[var(--ec-accent)] opacity-45",
              )}
              style={{ height: max > 0 ? `${Math.max(day.costUsd > 0 ? 4 : 1, (day.costUsd / max) * 100)}%` : "1%" }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--ec-faint)]">
        <span>{shortDay(days[0]!.day)}</span>
        <span>peak {formatUsd(max)}</span>
        <span>{shortDay(days.at(-1)!.day)}</span>
      </div>
    </section>
  );
};

const SummaryCard = ({ report, rangeKey }: { report: UsageCostReport; rangeKey: RangeKey }) => {
  const { totals } = report;
  const unattributed = report.unattributed.inputTokens + report.unattributed.outputTokens;
  return (
    <section className="mx-4 mt-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-3">
      <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--ec-faint)]">Estimated API cost · {RANGE_CAPTIONS[rangeKey]}</p>
      <p className="mt-0.5 text-3xl font-semibold tracking-tight">{formatUsd(totals.costUsd)}</p>
      <p className="mt-0.5 text-xs text-[var(--ec-muted)]">
        {formatTokenCount(totals.tokens.inputTokens)} in · {formatTokenCount(totals.tokens.outputTokens)} out
        {totals.cacheSavingsUsd > 0 ? (
          <span className="text-[var(--ec-success)]"> · cache saved {formatUsd(totals.cacheSavingsUsd)}</span>
        ) : null}
      </p>

      {totals.costUsd > 0 ? (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-[var(--ec-control)]" aria-hidden>
            {COST_CATEGORIES.map((category) => (
              <span key={category.key} style={{ width: `${(totals.cost[category.key] / totals.costUsd) * 100}%`, background: category.colorVar }} />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {COST_CATEGORIES.map((category) => (
              <p key={category.key} className="flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">
                <span className="size-2 shrink-0 rounded-full" style={{ background: category.colorVar }} />
                <span className="flex-1 truncate">{category.label}</span>
                <span className="font-medium text-[var(--ec-text)]">{formatUsd(totals.cost[category.key])}</span>
              </p>
            ))}
          </div>
        </>
      ) : null}

      {totals.unpricedTokens + unattributed > 0 ? (
        <p className="mt-2 border-t border-[var(--ec-border)] pt-2 text-[11px] leading-4 text-[var(--ec-warning)]">
          {formatTokenCount(totals.unpricedTokens + unattributed)} tokens are not priced
          {unattributed > 0 ? ` (${formatTokenCount(unattributed)} recorded before cost tracking)` : ""}.
        </p>
      ) : null}
    </section>
  );
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]">
    <span className="text-[var(--ec-muted)]">{label}</span>
    <span className="m-mono text-right">{value}</span>
  </div>
);

const PRICE_FIELDS: ReadonlyArray<[keyof PriceOverrideDraft, string]> = [
  ["inputPerMillion", "Input"],
  ["outputPerMillion", "Output"],
  ["cacheReadPerMillion", "Cache read"],
  ["cacheWritePerMillion", "Cache write"],
];

const ModelSheet = ({
  row,
  onClose,
  onSaved,
}: {
  row: UsageModelCostRow | null;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const settings = useAppSettings();
  const overridesSetting = settings.read(APP_SETTING_KEYS.modelPriceOverrides);
  const overrides = useMemo(() => parseModelPriceOverridesSetting(overridesSetting), [overridesSetting]);
  const overrideKey = row ? normalizeModelPriceOverrideKey(row.modelId) : "";
  const override = overrides[overrideKey];
  // The parent remounts this sheet per model, so the draft seeds once from the opened row.
  const [draft, setDraft] = useState<PriceOverrideDraft | null>(() => row ? priceOverrideDraftFor(row, override) : null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const saveOverrides = async (next: typeof overrides) => {
    if (await settings.write(APP_SETTING_KEYS.modelPriceOverrides, serializeModelPriceOverridesSetting(next))) {
      onSaved();
      onClose();
    }
  };

  const save = () => {
    if (!draft) return;
    const parsed = parsePriceOverrideDraft(draft);
    if (typeof parsed === "string") {
      setDraftError(parsed);
      return;
    }
    setDraftError(null);
    void saveOverrides({ ...overrides, [overrideKey]: parsed });
  };

  const reset = () => {
    const next = { ...overrides };
    delete next[overrideKey];
    void saveOverrides(next);
  };

  return (
    <Sheet open={row !== null} onClose={onClose} title={row?.modelId} dismissable={!settings.saving}>
      {row ? (
        <div className="pb-3">
          <p className="px-4 pt-3 text-xs text-[var(--ec-muted)]">
            {providerTypeLabel(row.providerType)}
            {row.priceSource === "override"
              ? " · custom price"
              : row.matchedKey
                ? ` · LiteLLM price for ${row.matchedKey}`
                : " · no public price found"}
          </p>

          <SectionLabel>Tokens</SectionLabel>
          <DetailRow label="Input (uncached)" value={formatTokenCount(row.tokens.uncachedInputTokens)} />
          <DetailRow label="Cache read" value={formatTokenCount(row.tokens.cacheReadTokens)} />
          <DetailRow label="Cache write" value={formatTokenCount(row.tokens.cacheWriteTokens)} />
          <DetailRow label="Output" value={formatTokenCount(row.tokens.outputTokens)} />
          {row.tokens.reasoningTokens > 0 ? <DetailRow label="of which reasoning" value={formatTokenCount(row.tokens.reasoningTokens)} /> : null}

          {row.cost && row.costUsd !== null ? (
            <>
              <SectionLabel>Estimated cost</SectionLabel>
              {COST_CATEGORIES.map((category) => (
                <DetailRow key={category.key} label={category.label} value={formatUsd(row.cost![category.key])} />
              ))}
              <DetailRow label="Total" value={formatUsd(row.costUsd)} />
              {row.cacheSavingsUsd > 0 ? <DetailRow label="Saved by caching" value={formatUsd(row.cacheSavingsUsd)} /> : null}
            </>
          ) : null}

          {row.rates && !settings.canWrite ? (
            <>
              <SectionLabel>Price per 1M tokens</SectionLabel>
              <DetailRow label="Input / output" value={`${formatRate(row.rates.inputPerMillion)} / ${formatRate(row.rates.outputPerMillion)}`} />
              <DetailRow label="Cache read / write" value={`${formatRate(row.rates.cacheReadPerMillion)} / ${formatRate(row.rates.cacheWritePerMillion)}`} />
            </>
          ) : null}

          {settings.canWrite && draft ? (
            <>
              <SectionLabel>{override ? "Custom price per 1M tokens" : "Price per 1M tokens"}</SectionLabel>
              <div className="grid grid-cols-2 gap-2 px-4">
                {PRICE_FIELDS.map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--ec-muted)]">{label} (USD)</span>
                    <Input
                      value={draft[key]}
                      inputMode="decimal"
                      placeholder={key.startsWith("cache") ? "Same as input" : "0.00"}
                      aria-label={`${label} USD per million tokens`}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      className="text-[13px]"
                    />
                  </label>
                ))}
              </div>
              <p className="px-4 pt-1.5 text-[11px] leading-4 text-[var(--ec-muted)]">
                Saving replaces the automatic price for this model on the host.
              </p>
              {draftError || settings.error ? (
                <p className="px-4 pt-1 text-[11px] text-[var(--ec-danger)]">{draftError ?? settings.error}</p>
              ) : null}
              <div className="flex gap-2 px-4 pt-3">
                <Button block busy={settings.saving} onClick={save}>Save price</Button>
                {override ? (
                  <Button block tone="neutral" disabled={settings.saving} onClick={reset}>Use automatic</Button>
                ) : null}
              </div>
            </>
          ) : null}

          {!settings.canWrite && row.costUsd === null ? (
            <p className="px-4 pt-3 text-[11px] leading-4 text-[var(--ec-muted)]">
              A session paired with the admin scope can set a custom price for this model.
            </p>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
};

/**
 * Estimated API-equivalent cost of recorded runs and chats, the mobile counterpart of the desktop
 * usage dialog. Reachable from More and from Settings → Network while the host has cost tracking on.
 */
export const UsageScreen = () => {
  const { client, snapshot, router } = useMobileApp();
  const enabled = isUsageCostTrackingEnabled(snapshot);
  const [rangeKey, setRangeKey] = useState<RangeKey>("30");
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openModelKey, setOpenModelKey] = useState<string | null>(null);

  const load = useCallback(async (refreshPricing = false) => {
    if (!enabled) return;
    setLoading(true);
    try {
      setReport(await client.getUsageCostReport({ rangeDays: rangeDaysFor(rangeKey), refreshPricing }));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load usage."));
    } finally {
      setLoading(false);
    }
  }, [client, enabled, rangeKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const modelKey = (row: UsageModelCostRow) => `${row.providerType}:${row.modelId}`;
  const openModel = report?.models.find((row) => modelKey(row) === openModelKey) ?? null;

  const pricingSubtitle = !report
    ? "Estimated API cost"
    : report.pricing.status === "unavailable"
      ? "Price list unavailable"
      : `LiteLLM prices · updated ${relativeTime(report.pricing.fetchedAt)}`;

  if (!enabled) {
    return (
      <>
        <AppBar title="Usage & cost" onBack={router.back} />
        <EmptyState
          icon={<CircleDollarSign className="size-7" />}
          title="Cost tracking is off"
          message={client.capabilities.settings
            ? "Turn it on in Settings → Network. The host then downloads a public model price list to estimate costs."
            : "An admin session or the desktop app can turn it on in Settings → Network."}
          action={client.capabilities.settings ? (
            <Button tone="neutral" onClick={() => router.push({ name: "settings", section: "network" })}>Open network settings</Button>
          ) : undefined}
        />
      </>
    );
  }

  return (
    <>
      <AppBar
        title="Usage & cost"
        subtitle={pricingSubtitle}
        onBack={router.back}
        actions={(
          <IconButton label="Refresh prices" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw className={cn("size-5", loading && "animate-spin")} />
          </IconButton>
        )}
      />
      <SegmentedTabs options={RANGE_OPTIONS} value={rangeKey} onChange={setRangeKey} />

      <div className="m-scroll m-screen-enter flex-1">
        {error ? <InlineError message={error} onRetry={() => void load()} /> : null}
        {report?.pricing.error ? <p className="px-4 pt-3 text-[11px] leading-4 text-[var(--ec-warning)]">{report.pricing.error}</p> : null}
        {!report ? (
          loading ? <CenteredSpinner label="Loading usage" /> : null
        ) : (
          <div className={cn(loading && "opacity-60 transition-opacity")}>
            <SummaryCard report={report} rangeKey={rangeKey} />
            <DailyCostChart key={`${rangeKey}:${report.generatedAt}`} report={report} />

            <SectionLabel>Models</SectionLabel>
            {report.models.length === 0 ? (
              <p className="px-4 pb-2 text-xs text-[var(--ec-muted)]">No usage recorded with a model in this period yet.</p>
            ) : report.models.map((row) => (
              <ListRow
                key={modelKey(row)}
                title={<span className="m-mono text-[13px]">{row.modelId}</span>}
                subtitle={`${providerTypeLabel(row.providerType)} · ${formatTokenCount(row.tokens.inputTokens)} in · ${formatTokenCount(row.tokens.outputTokens)} out`}
                trailing={row.costUsd === null
                  ? <Badge tone="warning">No price</Badge>
                  : <span className="text-sm font-semibold text-[var(--ec-text)]">{formatUsd(row.costUsd)}</span>}
                className="border-b border-[var(--ec-border)]"
                onClick={() => setOpenModelKey(modelKey(row))}
              />
            ))}

            {report.projects.length > 0 ? (
              <>
                <SectionLabel>Projects</SectionLabel>
                {report.projects.map((project) => (
                  <ListRow
                    key={project.projectId ?? "standalone"}
                    leading={project.projectId ? <FolderGit2 className="size-5" /> : <MessageSquare className="size-5" />}
                    title={project.name}
                    subtitle={`${formatTokenCount(project.tokens.inputTokens + project.tokens.outputTokens)} tokens${project.unpricedTokens > 0 ? ` · ${formatTokenCount(project.unpricedTokens)} unpriced` : ""}`}
                    trailing={<span className="text-sm font-semibold text-[var(--ec-text)]">{formatUsd(project.costUsd)}</span>}
                    className="border-b border-[var(--ec-border)]"
                    onClick={project.projectId && snapshot.projects.some((entry) => entry.project.id === project.projectId)
                      ? () => router.push({ name: "project", projectId: project.projectId!, tab: "overview" })
                      : undefined}
                  />
                ))}
              </>
            ) : null}

            <p className="px-4 py-4 text-[11px] leading-4 text-[var(--ec-faint)]">
              Public per-token API prices applied to recorded usage. Subscription plans bill differently, so this is an
              API-equivalent estimate, not your bill.
            </p>
          </div>
        )}
      </div>

      <ModelSheet key={openModelKey ?? "closed"} row={openModel} onClose={() => setOpenModelKey(null)} onSaved={() => void load()} />
    </>
  );
};
