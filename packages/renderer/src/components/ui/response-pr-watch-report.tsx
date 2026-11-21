import { useMemo } from "react";
import { PR_WATCH_VERDICTS, type PrWatchVerdict } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { ResponseCodeView } from "./response-code-view";

interface ReportRow {
  item: string;
  verdict: PrWatchVerdict;
  reply: string;
  commits: string[];
}

const VERDICT_STYLES: Record<PrWatchVerdict, string> = {
  valid: "text-[var(--ec-success)]",
  incorrect: "text-[var(--ec-muted)]",
  intentional: "text-[var(--ec-muted)]",
  "already-fixed": "text-[var(--ec-success)]",
  "needs-user": "text-[var(--ec-warning)]",
  "no-action": "text-[var(--ec-faint)]",
};

/** Reads the block while it may still be streaming; null shows the source instead. */
const readRows = (code: string): ReportRow[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // One row per item, the last entry winning, as in the parser that posts the replies.
  const rows = new Map<string, ReportRow>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const item = typeof record.item === "string" ? record.item.trim().toUpperCase() : "";
    const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
    if (!item || !PR_WATCH_VERDICTS.includes(verdict as PrWatchVerdict)) continue;
    const commits = Array.isArray(record.commits) ? record.commits.filter((sha): sha is string => typeof sha === "string") : [];
    rows.set(item, { item, verdict: verdict as PrWatchVerdict, reply: typeof record.reply === "string" ? record.reply : "", commits });
  }
  return rows.size ? [...rows.values()] : null;
};

/** The verdicts a PR watch turn reported, one compact row per comment. */
export const ResponsePrWatchReport = ({ code, preClassName }: { code: string; preClassName?: string }) => {
  const rows = useMemo(() => readRows(code), [code]);
  if (!rows) return <ResponseCodeView code={code} language="json" preClassName={preClassName} />;
  return (
    <div className="my-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2.5 py-1.5 text-xs">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ec-faint)]">Review report</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.item} className="grid grid-cols-[2rem_6.5rem_minmax(0,1fr)] gap-2 leading-5">
            <span className="font-mono text-[var(--ec-faint)]">{row.item}</span>
            <span className={cn("font-medium", VERDICT_STYLES[row.verdict])}>{row.verdict.replace("-", " ")}</span>
            <span className="min-w-0 text-[var(--ec-text)]">
              {row.reply || <span className="text-[var(--ec-faint)]">No reply</span>}
              {row.commits.length ? <span className="ml-1 font-mono text-[11px] text-[var(--ec-faint)]">{row.commits.map((sha) => sha.slice(0, 7)).join(", ")}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
