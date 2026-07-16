import { useMemo, useState } from "react";
import type { RunTokenUsage } from "@buildwarden/shared";

interface RunTokenBadgeProps {
  inputTokens: number;
  outputTokens: number;
  usage?: Partial<RunTokenUsage> | null;
}

type TokenMetrics = ReturnType<typeof buildTokenMetrics>;

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
};

const tokenCenterTextClass = (length: number) => {
  if (length >= 4) {
    return "text-[6.5px]";
  }
  return length >= 3 ? "text-[7px]" : "text-[8px]";
};

const buildTokenMetrics = (inputTokens: number, outputTokens: number, usage?: Partial<RunTokenUsage> | null) => {
  const processedInputTokens = usage?.inputTokens ?? inputTokens;
  const processedOutputTokens = usage?.outputTokens ?? outputTokens;
  const processedTotal = usage?.totalProcessedTokens ?? usage?.totalTokens ?? processedInputTokens + processedOutputTokens;
  const contextUsed = usage?.usedTokens ?? usage?.lastUsedTokens;
  const displayTotal = contextUsed ?? processedTotal;
  const maxTokens = usage?.maxTokens;
  const contextRatio = contextUsed !== undefined && maxTokens !== undefined && maxTokens > 0
    ? Math.max(0, Math.min(1, contextUsed / maxTokens))
    : null;
  const inputRatio = processedTotal > 0 ? processedInputTokens / processedTotal : 0;
  const outputRatio = processedTotal > 0 ? processedOutputTokens / processedTotal : 0;
  return {
    displayTotal,
    processedTotal,
    processedInputTokens,
    processedOutputTokens,
    contextUsed,
    maxTokens,
    contextRatio,
    inputRatio,
    outputRatio,
    inputPercent: Math.round(inputRatio * 100),
    outputPercent: Math.round(outputRatio * 100),
    totalCompact: formatCompactNumber(displayTotal),
  };
};

const TokenRing = ({ metrics }: { metrics: TokenMetrics }) => {
  const size = 28;
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const gap = 3;
  const inputLength = Math.max(0, circumference * metrics.inputRatio - gap / 2);
  const outputLength = Math.max(0, circumference * metrics.outputRatio - gap / 2);
  const contextLength = metrics.contextRatio === null ? 0 : Math.max(0, circumference * metrics.contextRatio);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 h-8 w-8 -rotate-90" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className="stroke-[var(--ec-border)]" strokeWidth="2" />
      {metrics.contextRatio !== null && (
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className="stroke-[var(--ec-accent)]" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${contextLength} ${circumference}`} />
      )}
      {metrics.contextRatio === null && inputLength > 0 && (
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className="stroke-[var(--ec-accent)]" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${inputLength} ${circumference}`} />
      )}
      {metrics.contextRatio === null && outputLength > 0 && (
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className="stroke-[var(--ec-success)]" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${outputLength} ${circumference}`} strokeDashoffset={-(inputLength + gap)} />
      )}
    </svg>
  );
};

const TokenMetricRow = ({ colorClass, label, value }: { colorClass: string; label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex items-center gap-2 text-[var(--ec-muted)]">
      <span className={`h-2 w-2 rounded-full ${colorClass}`} />
      <span>{label}</span>
    </div>
    <span className="tabular-nums text-[var(--ec-text)]">{value}</span>
  </div>
);

const OptionalTokenMetric = ({ label, value }: { label: string; value?: number }) => value ? (
  <div className="flex items-center justify-between gap-3 text-[var(--ec-muted)]">
    <span>{label}</span>
    <span className="tabular-nums">{value.toLocaleString()}</span>
  </div>
) : null;

const TokenUsagePopover = ({ metrics, usage }: { metrics: TokenMetrics; usage?: Partial<RunTokenUsage> | null }) => (
  <div className="absolute left-1/2 top-[calc(100%+0.6rem)] z-[95] w-64 -translate-x-1/2 glass-popover p-3 text-left">
    <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--ec-faint)]">Token Usage</p>
    {metrics.contextUsed === undefined ? (
      <p className="mt-2 text-sm font-semibold text-[var(--ec-text)]">{metrics.processedTotal.toLocaleString()} processed</p>
    ) : (
      <p className="mt-2 text-sm font-semibold text-[var(--ec-text)]">
        {metrics.contextUsed.toLocaleString()}
        {metrics.maxTokens ? ` / ${metrics.maxTokens.toLocaleString()}` : ""} context used
      </p>
    )}
    {metrics.contextUsed !== undefined && metrics.processedTotal > metrics.contextUsed && (
      <p className="mt-1 text-xs text-[var(--ec-muted)]">Total processed: {metrics.processedTotal.toLocaleString()} tokens</p>
    )}
    <div className="mt-3 space-y-2 text-xs">
      <TokenMetricRow colorClass="bg-[var(--ec-accent)]" label="Input" value={`${metrics.processedInputTokens.toLocaleString()} (${String(metrics.inputPercent)}%)`} />
      <TokenMetricRow colorClass="bg-[var(--ec-success)]" label="Output" value={`${metrics.processedOutputTokens.toLocaleString()} (${String(metrics.outputPercent)}%)`} />
      <OptionalTokenMetric label="Cached read" value={usage?.cachedInputTokens} />
      <OptionalTokenMetric label="Cache write" value={usage?.cacheCreationInputTokens} />
      <OptionalTokenMetric label="Reasoning" value={usage?.reasoningTokens} />
    </div>
  </div>
);

export const RunTokenBadge = ({ inputTokens, outputTokens, usage }: RunTokenBadgeProps) => {
  const [open, setOpen] = useState(false);
  const metrics = useMemo(() => buildTokenMetrics(inputTokens, outputTokens, usage), [inputTokens, outputTokens, usage]);
  const centerTextClass = tokenCenterTextClass(metrics.totalCompact.length);

  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] font-semibold text-[var(--ec-text)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)]"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Run token usage"
      >
        <span className="sr-only">
          Token usage: {metrics.displayTotal.toLocaleString()} shown, {metrics.processedInputTokens.toLocaleString()} input, {metrics.processedOutputTokens.toLocaleString()} output
        </span>
        <TokenRing metrics={metrics} />
        <span className={`relative z-[1] whitespace-nowrap leading-none tabular-nums ${centerTextClass}`}>
          {metrics.totalCompact}
        </span>
      </button>
      {open && <TokenUsagePopover metrics={metrics} usage={usage} />}
    </div>
  );
};
