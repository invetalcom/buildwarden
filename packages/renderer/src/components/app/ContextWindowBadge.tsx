import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
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
  /** `statusbar` renders a text segment for the bottom status bar instead of the ring button. */
  variant?: "ring" | "statusbar";
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
  variant = "ring",
}: ContextWindowBadgeProps) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
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
  const inStatusBar = variant === "statusbar";

  return (
    <div ref={anchorRef} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        data-ui={inStatusBar ? "statusbar-item" : undefined}
        data-tone={inStatusBar && estimate.usedPercent >= 85 ? "bad" : inStatusBar && estimate.usedPercent >= 65 ? "warn" : undefined}
        className={inStatusBar ? "[&_svg]:size-3" : `inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-[var(--ec-hover)] ${toneClass}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Estimated context window"
      >
        <span className="sr-only">Estimated context window: {estimate.usedPercent}% used</span>
        <svg
          data-ui="usage-ring"
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
        {inStatusBar ? <span aria-hidden className="tabular-nums">ctx {estimate.usedPercent}%</span> : null}
      </button>
      {/* Portaled, because the status bar clips what it contains. */}
      <AnchorDropdownPortal open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} align="end" placement="top" widthPx={240}
        className="pointer-events-none glass-popover p-3 text-center font-sans">
          <p className="text-[11px] font-medium text-[var(--ec-faint)]">Context Window</p>
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
      </AnchorDropdownPortal>
    </div>
  );
};
