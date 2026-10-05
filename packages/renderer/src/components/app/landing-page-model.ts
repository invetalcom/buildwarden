import type { AppSnapshot, ProviderAccountRecord, RunRecord, TokenUsageTotals } from "@buildwarden/shared";
import { isRunDisplayStatusActive, resolveRunDisplayStatus, type RunDisplayStatus } from "./run-display-status";

export type LandingRun = RunRecord & { projectName?: string };

export type RunOutcome = "completed" | "failed" | "active" | "other";

export const resolveRunOutcome = (run: Pick<RunRecord, "status" | "orchestrationStatus">): RunOutcome => {
  const status: RunDisplayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  if (status === "completed") return "completed";
  if (status === "failed" || status === "deletion-failed") return "failed";
  if (isRunDisplayStatusActive(status)) return "active";
  return "other";
};

/** Stacking order, bottom to top, with the theme status token that carries each outcome. */
export const RUN_OUTCOME_SERIES: ReadonlyArray<{ key: RunOutcome; label: string; color: string }> = [
  { key: "completed", label: "Done", color: "var(--ec-success)" },
  { key: "failed", label: "Failed", color: "var(--ec-danger)" },
  { key: "active", label: "Active", color: "var(--ec-accent)" },
  { key: "other", label: "Cancelled", color: "var(--ec-border-strong)" },
];

export type RunOutcomeCounts = Record<RunOutcome, number>;

export const countRunOutcomes = (runs: ReadonlyArray<Pick<RunRecord, "status" | "orchestrationStatus">>): RunOutcomeCounts => {
  const counts: RunOutcomeCounts = { completed: 0, failed: 0, active: 0, other: 0 };
  for (const run of runs) counts[resolveRunOutcome(run)] += 1;
  return counts;
};

/** Share of finished runs (completed + failed) that completed; null until something has finished. */
export const successRate = (counts: RunOutcomeCounts): number | null => {
  const finished = counts.completed + counts.failed;
  return finished > 0 ? counts.completed / finished : null;
};

const compactNumberFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export const formatFullNumber = (value: number) => value.toLocaleString();

export const formatCompactNumber = (value: number) =>
  Math.abs(value) < 10_000 ? value.toLocaleString() : compactNumberFormat.format(value);

const localDayKey = (date: Date) =>
  `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const buildTodayActivity = (
  runs: ReadonlyArray<RunRecord>,
  usageToday: TokenUsageTotals | undefined,
  now = new Date(),
) => {
  const today = localDayKey(now);
  const todaysRuns = runs.filter((run) => localDayKey(new Date(run.createdAt)) === today);
  const counts = countRunOutcomes(todaysRuns);
  return {
    runsStarted: todaysRuns.length,
    completedRuns: counts.completed,
    failedRuns: counts.failed,
    activeRuns: counts.active,
    tokensUsed: usageToday
      ? usageToday.inputTokens + usageToday.outputTokens
      : todaysRuns.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0),
  };
};

export interface DailyRunActivity extends RunOutcomeCounts {
  key: string;
  date: Date;
  total: number;
  tokens: number;
}

/** Runs created per local calendar day for the trailing `days` window, oldest first. */
export const buildDailyRunActivity = (
  runs: ReadonlyArray<RunRecord>,
  days: number,
  now = new Date(),
): DailyRunActivity[] => {
  const buckets: DailyRunActivity[] = [];
  const byKey = new Map<string, DailyRunActivity>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const bucket: DailyRunActivity = { key: localDayKey(date), date, total: 0, tokens: 0, completed: 0, failed: 0, active: 0, other: 0 };
    buckets.push(bucket);
    byKey.set(bucket.key, bucket);
  }
  for (const run of runs) {
    const bucket = byKey.get(localDayKey(new Date(run.createdAt)));
    if (!bucket) continue;
    bucket[resolveRunOutcome(run)] += 1;
    bucket.total += 1;
    bucket.tokens += run.inputTokens + run.outputTokens;
  }
  return buckets;
};

export interface ProviderUsage {
  providerAccountId: string;
  label: string;
  harnessType: RunRecord["harnessType"];
  providerType: ProviderAccountRecord["providerType"] | null;
  runs: number;
  tokens: number;
}

/** Run count and token totals per provider account, busiest first. */
export const buildProviderUsage = (
  runs: ReadonlyArray<RunRecord>,
  providerAccounts: ReadonlyArray<ProviderAccountRecord>,
): ProviderUsage[] => {
  const accounts = new Map(providerAccounts.map((account) => [account.id, account]));
  const usage = new Map<string, ProviderUsage>();
  for (const run of runs) {
    const account = accounts.get(run.providerAccountId);
    const entry = usage.get(run.providerAccountId) ?? {
      providerAccountId: run.providerAccountId,
      label: account?.label ?? "Removed provider",
      harnessType: run.harnessType,
      providerType: account?.providerType ?? null,
      runs: 0,
      tokens: 0,
    };
    entry.runs += 1;
    entry.tokens += run.inputTokens + run.outputTokens;
    usage.set(run.providerAccountId, entry);
  }
  return [...usage.values()].sort((left, right) => right.runs - left.runs || right.tokens - left.tokens);
};

export const buildLandingTotals = (snapshot: AppSnapshot, runs: ReadonlyArray<RunRecord>) => {
  const inputTokens = snapshot.projects.reduce((sum, entry) => sum + entry.project.cumulativeInputTokens, 0) +
    (snapshot.tokenUsage?.standaloneChats.inputTokens ?? 0);
  const outputTokens = snapshot.projects.reduce((sum, entry) => sum + entry.project.cumulativeOutputTokens, 0) +
    (snapshot.tokenUsage?.standaloneChats.outputTokens ?? 0);
  return {
    projects: snapshot.projects.length,
    runs: runs.length,
    outcomes: countRunOutcomes(runs),
    providerAccounts: snapshot.providerAccounts.length,
    models: snapshot.models.length,
    chats: snapshot.chats.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
};
