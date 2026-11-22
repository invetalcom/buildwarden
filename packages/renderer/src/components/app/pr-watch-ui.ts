import {
  PR_WATCH_MAX_WAKES,
  PR_WATCH_TRIGGER_LABELS,
  type PrWatchVerdict,
  type PrWatchView,
  type PrWatchWakeResult,
  type RunForgeLinkSource,
} from "@buildwarden/shared";

const VERDICT_LABELS: Record<PrWatchVerdict, string> = {
  valid: "fixed",
  incorrect: "incorrect",
  intentional: "intentional",
  "already-fixed": "already fixed",
  "needs-user": "need you",
  "no-action": "no action",
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${String(count)} ${count === 1 ? singular : pluralForm}`;

/** Accepts a full URL, or a bare number resolved against the linked request's URL. */
export const resolveManualRequestUrl = (input: string, linkedUrl: string | null): string | null => {
  const value = input.trim();
  const number = /^[#!]?(\d+)$/.exec(value)?.[1];
  if (number) return linkedUrl && /\d+\/?$/.test(linkedUrl) ? linkedUrl.replace(/\d+\/?$/, number) : null;
  return /^https?:\/\/\S+$/i.test(value) ? value : null;
};

export const describeLinkSource = (source: RunForgeLinkSource): string =>
  source === "user" ? "Linked by you" : "Linked automatically by branch";

/** Short label for the dock button. */
export const prWatchButtonLabel = (watch: PrWatchView | null | undefined): string => {
  if (!watch || watch.status === "ended") return "Watch";
  if (watch.status === "working") return "Fixing";
  if (watch.status === "paused") return "Watch paused";
  return watch.wakeCount ? `Watching · ${plural(watch.wakeCount, "wake")}` : "Watching";
};

export const describeWakeResult = (result: PrWatchWakeResult): string => {
  const parts = [result.triggers.map((trigger) => PR_WATCH_TRIGGER_LABELS[trigger]).join(", ")];
  parts.push(result.pushed ? "pushed fixes" : "nothing pushed");
  if (result.replies) parts.push(plural(result.replies, "reply", "replies"));
  const verdicts = (Object.entries(result.verdicts) as Array<[PrWatchVerdict, number]>)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${String(count)} ${VERDICT_LABELS[verdict]}`);
  if (verdicts.length) parts.push(verdicts.join(", "));
  return parts.filter(Boolean).join(" · ");
};

/** How a run list shows a watch: null when there is nothing running or waiting on the user. */
export const prWatchIndicator = (watch: PrWatchView | null | undefined): { tone: "watching" | "working" | "paused"; label: string } | null => {
  if (!watch || watch.status === "ended") return null;
  if (watch.status === "working") return { tone: "working", label: "Agent is fixing what the watch found" };
  if (watch.status === "paused") return { tone: "paused", label: `Watch paused${watch.message ? `: ${watch.message}` : ""}` };
  return { tone: "watching", label: watch.wakeCount ? `Watching · ${plural(watch.wakeCount, "wake")} so far` : "Watching" };
};

export interface PrWatchWakeRecord {
  label: string;
  repair: boolean;
}

/** The watch wake a timeline prompt belongs to, from its step metadata. */
export const readPrWatchWake = (metadata: Record<string, unknown>): PrWatchWakeRecord | null => {
  const wake = metadata.prWatchWake;
  if (!wake || typeof wake !== "object" || Array.isArray(wake)) return null;
  const { label, repair } = wake as Record<string, unknown>;
  return typeof label === "string" && label ? { label, repair: repair === true } : null;
};

export const describeWakeBudget =(watch: Pick<PrWatchView, "wakeCount">): string =>
  `${String(watch.wakeCount)} of ${String(PR_WATCH_MAX_WAKES)} wakes used`;
