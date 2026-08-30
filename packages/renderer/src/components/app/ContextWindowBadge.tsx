import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { estimateContextWindow, formatCompactTokens } from "../../lib/context-window-estimate";
import { requestExactContextWindowTokenCounts } from "../../lib/context-window-tokenizer-client";
import type { ContextWindowTextTokenCounts } from "../../lib/context-window-estimate";
import type { RunTokenUsage } from "@buildwarden/shared";

interface ContextWindowBadgeProps {
  modelIds: string[];
  prompt: string;
  historyText?: string;
  attachmentFiles?: File[];
  isRun?: boolean;
  tokenUsage?: Partial<RunTokenUsage> | null;
}

const contextToneClasses = (usedPercent: number) => {
  if (usedPercent >= 85) {
    return { text: "text-[var(--ec-danger)]", ring: "stroke-[var(--ec-danger)]" };
  }
  if (usedPercent >= 65) {
    return { text: "text-[var(--ec-warning)]", ring: "stroke-[var(--ec-warning)]" };
  }
  return { text: "text-[var(--ec-text)]", ring: "stroke-[var(--ec-accent)]" };
};

export const ContextWindowBadge = ({
  modelIds,
  prompt,
  historyText,
  attachmentFiles,
  isRun = false,
  tokenUsage,
}: ContextWindowBadgeProps) => {
  const [open, setOpen] = useState(false);
  const [exactTextTokenCounts, setExactTextTokenCounts] = useState<ContextWindowTextTokenCounts | null>(null);
  const deferredPrompt = useDeferredValue(prompt);
  const deferredHistoryText = useDeferredValue(historyText ?? "");
  const ringSize = 24;
  const radius = 10;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    let cancelled = false;
    setExactTextTokenCounts(null);
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      void requestExactContextWindowTokenCounts(deferredPrompt, deferredHistoryText).then((counts) => {
        if (!cancelled && counts) {
          setExactTextTokenCounts(counts);
        }
      });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferredHistoryText, deferredPrompt, open]);

  const reportedUsed = tokenUsage?.usedTokens ?? tokenUsage?.lastUsedTokens;
  const reportedMax = tokenUsage?.maxTokens;
  const hasReportedUsage = typeof reportedUsed === "number" && reportedUsed >= 0 &&
    typeof reportedMax === "number" && reportedMax > 0;
  const estimate = useMemo(() => {
    if (hasReportedUsage) {
      const usedTokens = Math.min(reportedUsed, reportedMax);
      const usedPercent = Math.min(100, Math.round((usedTokens / reportedMax) * 100));
      return {
        usedTokens,
        maxTokens: reportedMax,
        remainingTokens: Math.max(0, reportedMax - usedTokens),
        usedPercent,
        remainingPercent: 100 - usedPercent,
      };
    }
    return estimateContextWindow({
        modelIds,
        prompt: deferredPrompt,
        historyText: deferredHistoryText,
        attachmentFiles,
        isRun,
        textTokenCounts: exactTextTokenCounts,
      });
  }, [attachmentFiles, deferredHistoryText, deferredPrompt, exactTextTokenCounts, hasReportedUsage, isRun, modelIds, reportedMax, reportedUsed]);

  if (!estimate) {
    return null;
  }

  const { text: toneClass, ring: ringClass } = contextToneClasses(estimate.usedPercent);
  const dashOffset = circumference - (estimate.usedPercent / 100) * circumference;

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-[var(--ec-hover)] ${toneClass}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Estimated context window"
      >
        <span className="sr-only">Estimated context window: {estimate.usedPercent}% used</span>
        <svg
          width={ringSize}
          height={ringSize}
          viewBox={`0 0 ${ringSize} ${ringSize}`}
          className="h-5 w-5 -rotate-90"
          aria-hidden="true"
        >
          <circle cx={ringSize / 2} cy={ringSize / 2} r={radius} fill="none" className="stroke-[var(--ec-border)]" strokeWidth="2" />
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            className={ringClass}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
      </button>
      {open ? (
        <div className="absolute bottom-[calc(100%+0.65rem)] right-0 z-[95] w-60 glass-popover p-3 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--ec-faint)]">Context Window</p>
          <p className="mt-2 text-sm font-semibold text-[var(--ec-text)]">
            {estimate.usedPercent}% used ({estimate.remainingPercent}% left)
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--ec-text)]">
            {formatCompactTokens(estimate.usedTokens)} / {formatCompactTokens(estimate.maxTokens)} tokens
          </p>
          <p className="mt-3 text-xs leading-5 text-[var(--ec-muted)]">
            {hasReportedUsage
              ? "Reported by the active provider session."
              : "Estimate based on draft, attachments, and visible history."}
            {tokenUsage?.compactsAutomatically && tokenUsage.autoCompactThreshold
              ? ` Claude will compact automatically near ${formatCompactTokens(tokenUsage.autoCompactThreshold)} tokens.`
              : isRun ? " Workspace context and tool state can increase actual usage." : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
};
