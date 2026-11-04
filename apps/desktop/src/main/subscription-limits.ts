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
import { randomUUID } from "node:crypto";
import type { SubscriptionLimitsAccount, SubscriptionLimitsReport, SubscriptionResetInput, SubscriptionResetResult } from "@buildwarden/shared";
import { LimitsRequestError, type LimitsProbe, type LimitsTarget, type SubscriptionLimitProviders } from "./subscription-limit-providers";

const AUTO_TTL = 5 * 60_000;
const REFRESH_FLOOR = 10_000;
interface Entry { at: number; account: SubscriptionLimitsAccount; probe?: LimitsProbe }
interface Attempt { token: string; key: string; probe: LimitsProbe; inFlight?: Promise<SubscriptionResetResult> }

/** Local host only. Cache snapshots, never credentials; failed probes retain visibly stale bars. */
export class SubscriptionLimits {
  private readonly cache = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly completed = new Map<string, { at: number; result: SubscriptionResetResult }>();

  constructor(private readonly providers: Pick<SubscriptionLimitProviders, "probe" | "consume">, private readonly now = Date.now) {}

  async load(targets: LimitsTarget[], force = false): Promise<SubscriptionLimitsReport> {
    return { accounts: await Promise.all(targets.map(async (target) => {
      const cached = this.cache.get(target.key);
      if (cached && this.now() - cached.at < (force ? REFRESH_FLOOR : AUTO_TTL)) return { ...cached.account, id: target.id, label: target.label };
      return (await this.refresh(target)).account;
    })) };
  }

  private async refresh(target: LimitsTarget): Promise<Entry> {
    const current = this.loading.get(target.key);
    if (current) return current;
    const task = (async (): Promise<Entry> => {
      const at = this.now();
      const checkedAt = new Date(at).toISOString();
      const base = { id: target.id, providerType: target.providerType, label: target.label, checkedAt };
      try {
        const probe = await this.providers.probe(target);
        const credits = probe.resetCredits;
        const canReset = target.providerType !== "cursor-agent" && credits && credits.availableCount > 0
          && (!credits.nextExpiresAt || Date.parse(credits.nextExpiresAt) > at);
        return { at, probe, account: {
          ...base, plan: probe.plan, windows: probe.windows, status: probe.windows.length ? "fresh" : "unsupported",
          message: probe.message ?? (!probe.windows.length ? "This account does not report subscription limits." : undefined),
          ...(credits ? { resetCredits: { availableCount: credits.availableCount, nextExpiresAt: credits.nextExpiresAt,
            ...(canReset && probe.windows.length ? { actionToken: randomUUID() } : {}) } } : {}),
        } };
      } catch {
        const previous = this.cache.get(target.key)?.account;
        return { at, account: previous?.windows.length
          ? { ...previous, id: target.id, label: target.label, status: "cached", resetCredits: previous.resetCredits ? { ...previous.resetCredits, actionToken: undefined } : undefined,
              message: "Could not refresh limits. Showing the last reading; refresh before using a reset." }
          : { ...base, windows: [], status: "unavailable", message: "Could not read limits. Check the provider CLI login, version and connection, then refresh." } };
      }
    })();
    this.loading.set(target.key, task);
    try {
      const result = await task;
      this.cache.set(target.key, result);
      return result;
    } finally { if (this.loading.get(target.key) === task) this.loading.delete(target.key); }
  }

  async useReset(targets: LimitsTarget[], input: SubscriptionResetInput): Promise<SubscriptionResetResult> {
    const target = targets.find((candidate) => candidate.id === input.accountId);
    if (!target || target.providerType === "cursor-agent") throw new Error("This account does not support reset credits.");
    const completedKey = target.key + ":" + input.actionToken;
    const completed = this.completed.get(completedKey);
    if (completed && this.now() - completed.at < AUTO_TTL) return completed.result;
    for (const [key, value] of this.completed) if (this.now() - value.at >= AUTO_TTL) this.completed.delete(key);
    let attempt = this.attempts.get(target.key);
    const entry = this.cache.get(target.key);
    if (input.actionToken !== attempt?.token && (input.actionToken !== entry?.account.resetCredits?.actionToken || entry?.account.status !== "fresh"
      || this.now() - entry.at > AUTO_TTL || !entry.probe)) throw new Error("The limits reading changed or expired. Refresh Limits before using a reset.");
    if (!attempt) {
      const credits = entry?.probe?.resetCredits;
      if (!entry?.probe || !credits || credits.availableCount < 1 || (credits.nextExpiresAt && Date.parse(credits.nextExpiresAt) <= this.now())) throw new Error("No reset credit is available.");
      attempt = { token: input.actionToken, key: randomUUID(), probe: entry.probe };
      this.attempts.set(target.key, attempt);
    }
    if (attempt.inFlight) return attempt.inFlight;
    const pending = attempt;
    const task = (async (): Promise<SubscriptionResetResult> => {
      let outcome;
      try { outcome = await this.providers.consume(target, pending.probe, pending.key); }
      catch (error) {
        // Unanswered claims keep their idempotency key and grant for safe retries.
        if (error instanceof LimitsRequestError && error.settled) {
          this.attempts.delete(target.key);
          this.cache.delete(target.key);
        }
        throw error instanceof LimitsRequestError ? error : new Error("The provider could not confirm the reset. Retry to check the same request.");
      }
      // Wait for any pre-reset probe before fetching a post-reset reading.
      await this.loading.get(target.key);
      const refreshed = await this.refresh(target);
      const result: SubscriptionResetResult = {
        outcome, report: await this.load(targets),
        ...(outcome === "reset" && refreshed.account.status !== "fresh" ? { warning: "The reset was applied, but updated limits could not be read. Refresh to check." } : {}),
      };
      this.completed.set(target.key + ":" + pending.token, { at: this.now(), result });
      this.completed.set(completedKey, { at: this.now(), result });
      this.attempts.delete(target.key);
      return result;
    })();
    pending.inFlight = task;
    try { return await task; } finally { pending.inFlight = undefined; }
  }
}

