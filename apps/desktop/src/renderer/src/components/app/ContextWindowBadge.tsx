import { useDeferredValue, useMemo, useState } from "react";
import { estimateContextWindow, formatCompactTokens } from "../../lib/context-window-estimate";

interface ContextWindowBadgeProps {
  modelIds: string[];
  prompt: string;
  historyText?: string;
  attachmentFiles?: File[];
  isRun?: boolean;
}

export const ContextWindowBadge = ({
  modelIds,
  prompt,
  historyText,
  attachmentFiles,
  isRun = false,
}: ContextWindowBadgeProps) => {
  const [open, setOpen] = useState(false);
  const deferredPrompt = useDeferredValue(prompt);
  const deferredHistoryText = useDeferredValue(historyText ?? "");
  const ringSize = 24;
  const radius = 10;
  const circumference = 2 * Math.PI * radius;

  const estimate = useMemo(
    () =>
      estimateContextWindow({
        modelIds,
        prompt: deferredPrompt,
        historyText: deferredHistoryText,
        attachmentFiles,
        isRun,
      }),
    [attachmentFiles, deferredHistoryText, deferredPrompt, isRun, modelIds],
  );

  if (!estimate) {
    return null;
  }

  const toneClass =
    estimate.usedPercent >= 85
      ? "text-[var(--ec-danger)]"
      : estimate.usedPercent >= 65
        ? "text-[var(--ec-warning)]"
        : "text-[var(--ec-text)]";
  const ringClass =
    estimate.usedPercent >= 85
      ? "stroke-rose-400"
      : estimate.usedPercent >= 65
        ? "stroke-amber-300"
        : "stroke-cyan-300";
  const dashOffset = circumference - (estimate.usedPercent / 100) * circumference;

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] ${toneClass}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Estimated context window"
      >
        <span className="sr-only">Estimated context window: {estimate.usedPercent}% used</span>
        <svg
          width={ringSize}
          height={ringSize}
          viewBox={`0 0 ${ringSize} ${ringSize}`}
          className="h-6 w-6 -rotate-90"
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
            Estimate based on draft, attachments, and visible history.
            {isRun ? " Workspace context and tool state can increase actual usage." : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
};
