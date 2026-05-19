import { useMemo, useState } from "react";

interface RunTokenBadgeProps {
  inputTokens: number;
  outputTokens: number;
}

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
};

export const RunTokenBadge = ({ inputTokens, outputTokens }: RunTokenBadgeProps) => {
  const [open, setOpen] = useState(false);

  const metrics = useMemo(() => {
    const total = inputTokens + outputTokens;
    const inputRatio = total > 0 ? inputTokens / total : 0;
    const outputRatio = total > 0 ? outputTokens / total : 0;
    return {
      total,
      inputRatio,
      outputRatio,
      inputPercent: Math.round(inputRatio * 100),
      outputPercent: Math.round(outputRatio * 100),
      totalCompact: formatCompactNumber(total),
    };
  }, [inputTokens, outputTokens]);

  const size = 28;
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const gap = 3;
  const inputLength = Math.max(0, circumference * metrics.inputRatio - gap / 2);
  const outputLength = Math.max(0, circumference * metrics.outputRatio - gap / 2);
  const inputOffset = 0;
  const outputOffset = -(inputLength + gap);
  const centerTextClass =
    metrics.totalCompact.length >= 4
      ? "text-[6.5px]"
      : metrics.totalCompact.length >= 3
        ? "text-[7px]"
        : "text-[8px]";

  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-800/80 bg-zinc-950/60 font-semibold text-zinc-100 transition hover:border-zinc-700 hover:bg-zinc-900/70"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title="Run token usage"
      >
        <span className="sr-only">
          Token usage: {metrics.total.toLocaleString()} total, {inputTokens.toLocaleString()} input, {outputTokens.toLocaleString()} output
        </span>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="absolute inset-0 h-8 w-8 -rotate-90"
          aria-hidden="true"
        >
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" className="stroke-zinc-800/90" strokeWidth="2" />
          {inputLength > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className="stroke-cyan-300"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${inputLength} ${circumference}`}
              strokeDashoffset={inputOffset}
            />
          ) : null}
          {outputLength > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className="stroke-emerald-300"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${outputLength} ${circumference}`}
              strokeDashoffset={outputOffset}
            />
          ) : null}
        </svg>
        <span className={`relative z-[1] whitespace-nowrap leading-none tabular-nums ${centerTextClass}`}>
          {metrics.totalCompact}
        </span>
      </button>
      {open ? (
        <div className="absolute left-1/2 top-[calc(100%+0.6rem)] z-[95] w-56 -translate-x-1/2 rounded-2xl border border-zinc-800 bg-zinc-950/98 p-3 text-left shadow-2xl shadow-black/40 backdrop-blur">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Token Usage</p>
          <p className="mt-2 text-sm font-semibold text-zinc-100">{metrics.total.toLocaleString()} total</p>
          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-300" />
                <span>Input</span>
              </div>
              <span className="tabular-nums text-zinc-100">
                {inputTokens.toLocaleString()} ({metrics.inputPercent}%)
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-emerald-300" />
                <span>Output</span>
              </div>
              <span className="tabular-nums text-zinc-100">
                {outputTokens.toLocaleString()} ({metrics.outputPercent}%)
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
