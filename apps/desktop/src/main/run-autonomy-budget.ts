import type { RunTokenUsage } from "@buildwarden/shared";

export interface RunBudgetExhaustion {
  kind: "time" | "tokens";
  reason: string;
  limit: number;
  observed?: number;
}

export const tokenBudgetExhaustion = (
  maxRunTokens: number,
  usage: Partial<RunTokenUsage>,
): RunBudgetExhaustion | null => {
  if (maxRunTokens <= 0) return null;
  const observed = Math.max(0, Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0));
  if (observed < maxRunTokens) return null;
  return {
    kind: "tokens",
    limit: maxRunTokens,
    observed,
    reason: `This turn used ${observed.toLocaleString("en-US")} tokens and reached its ${maxRunTokens.toLocaleString("en-US")} token autonomy limit.`,
  };
};

export const timeBudgetExhaustion = (maxRunMinutes: number): RunBudgetExhaustion => ({
  kind: "time",
  limit: maxRunMinutes,
  observed: maxRunMinutes,
  reason: `This turn reached its ${maxRunMinutes.toLocaleString("en-US")} minute autonomy limit.`,
});
