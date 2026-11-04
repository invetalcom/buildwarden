/*!
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code).
 * MIT License - Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { SubscriptionLimitWindow } from "@buildwarden/shared";

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: number) => Math.min(100, Math.max(0, value));
export const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
};
export interface ResetCredits {
  availableCount: number;
  nextExpiresAt?: string;
  nextCreditId?: string;
}
export const codexIdentity = (account: unknown, usage: unknown): string =>
  JSON.stringify([record(account).account, record(usage).accountId]);

export function parseCodexLimits(raw: unknown): { windows: SubscriptionLimitWindow[]; resetCredits?: ResetCredits; plan?: string } {
  const response = record(raw);
  const snapshot = record(record(response.rateLimitsByLimitId).codex ?? response.rateLimits);
  const plan = nonempty(snapshot.planType);
  const windows: SubscriptionLimitWindow[] = [];
  if (!snapshot.limitId || snapshot.limitId === "codex") {
    for (const [id, fallback] of [["primary", plan === "free" || plan === "go" ? 43200 : 300], ["secondary", 10080]] as const) {
      const w = record(snapshot[id]);
      if (!finite(w.usedPercent)) continue;
      const mins = finite(w.windowDurationMins) && w.windowDurationMins >= 0 ? w.windowDurationMins : fallback;
      const kind = mins >= 43200 ? "monthly" : mins >= 10080 ? "weekly" : "session";
      windows.push({ id, kind, label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session",
        usedPercent: percent(w.usedPercent), windowDurationMins: mins, resetsAt: finite(w.resetsAt) ? iso(w.resetsAt * 1000) : undefined });
    }
    const individual = record(snapshot.individualLimit);
    if (finite(individual.remainingPercent)) windows.push({ id: "individual", kind: "monthly", label: "Monthly credit limit",
      usedPercent: percent(100 - individual.remainingPercent), resetsAt: finite(individual.resetsAt) ? iso(individual.resetsAt * 1000) : undefined });
  }
  const credits = record(response.rateLimitResetCredits);
  let resetCredits: ResetCredits | undefined;
  if (finite(credits.availableCount) && Number.isSafeInteger(credits.availableCount) && credits.availableCount >= 0) {
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).map(record)
      .filter((credit) => credit.status === "available").flatMap((credit) => finite(credit.expiresAt) && iso(credit.expiresAt * 1000) ? [credit.expiresAt * 1000] : []);
    resetCredits = { availableCount: credits.availableCount, ...(expiries.length ? { nextExpiresAt: iso(Math.min(...expiries)) } : {}) };
  }
  return { windows, resetCredits, plan };
}

export function parseClaudeLimits(raw: unknown): SubscriptionLimitWindow[] {
  const response = record(raw);
  if (response.rate_limits_available !== true) return [];
  const limits = record(response.rate_limits);
  const windows: SubscriptionLimitWindow[] = [];
  for (const [id, label, kind, mins] of [
    ["five_hour", "Session", "session", 300], ["seven_day", "Weekly", "weekly", 10080],
    ["seven_day_opus", "Weekly · Opus", "weekly", 10080], ["seven_day_sonnet", "Weekly · Sonnet", "weekly", 10080],
  ] as const) {
    const w = record(limits[id]);
    if (finite(w.utilization)) windows.push({ id, label, kind, windowDurationMins: mins, usedPercent: percent(w.utilization), resetsAt: iso(w.resets_at) });
  }
  for (const raw of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const w = record(raw);
    const name = nonempty(w.display_name);
    if (!name || !finite(w.utilization)) continue;
    const id = "seven_day_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const existing = windows.findIndex((w) => w.id === id);
    if (existing >= 0) windows.splice(existing, 1);
    windows.push({ id, label: "Weekly · " + name, kind: "weekly", windowDurationMins: 10080, usedPercent: percent(w.utilization), resetsAt: iso(w.resets_at) });
  }
  const spend = record(limits.spend);
  const used = record(spend.used);
  const limit = record(spend.limit);
  const extra = record(limits.extra_usage);
  let monthly: number | undefined;
  if (spend.enabled === true && nonempty(used.currency) && nonempty(used.currency) === nonempty(limit.currency)
    && Number.isSafeInteger(used.exponent) && Number(used.exponent) >= 0 && used.exponent === limit.exponent
    && finite(used.amount_minor) && used.amount_minor >= 0 && finite(limit.amount_minor) && limit.amount_minor > 0) {
    monthly = used.amount_minor / limit.amount_minor * 100;
  } else if (extra.is_enabled === true) {
    monthly = finite(extra.used_credits) && extra.used_credits >= 0 && finite(extra.monthly_limit) && extra.monthly_limit > 0
      ? extra.used_credits / extra.monthly_limit * 100 : finite(extra.utilization) && extra.utilization >= 0 ? extra.utilization : undefined;
  }
  if (monthly !== undefined && Number.isFinite(monthly)) windows.push({ id: "monthly_spend", label: "Monthly spend", kind: "monthly", usedPercent: percent(monthly) });
  return windows;
}

export function parseClaudeResetCredits(raw: unknown, now: number): ResetCredits | undefined {
  const block = record(raw);
  if (block.eligible !== true) return undefined;
  const live = (Array.isArray(block.grants) ? block.grants : []).map(record).filter((g) => {
    if (typeof g.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(g.id) || !Number.isSafeInteger(g.resets_left) || Number(g.resets_left) < 0
      || (g.paused !== undefined && typeof g.paused !== "boolean") || g.paused || g.usable_now !== true) return false;
    if (g.ends_at == null) return true;
    if (typeof g.ends_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(g.ends_at)) return false;
    const [year, month, day] = g.ends_at.slice(0, 10).split("-").map(Number);
    return Date.parse(g.ends_at) > now && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0);
  });
  const next = live.find((g) => g.id === block.next_grant_id && Number(g.resets_left) > 0);
  return { availableCount: next ? live.reduce((sum, g) => sum + Number(g.resets_left), 0) : 0,
    ...(next ? { nextCreditId: String(next.id), nextExpiresAt: iso(next.ends_at) } : {}) };
}

export function parseCursorLimits(raw: unknown): SubscriptionLimitWindow[] {
  const response = record(raw);
  const usage = record(response.planUsage);
  const reset = Number(response.billingCycleEnd);
  return [["totalPercentUsed", "Monthly"], ["autoPercentUsed", "Auto"], ["apiPercentUsed", "API"]].flatMap(([id, label]) => {
    const value = usage[id!];
    return finite(value) ? [{ id: id!, label: label!, kind: "monthly" as const, usedPercent: percent(value), resetsAt: iso(reset) }] : [];
  });
}

