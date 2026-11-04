import { describe, expect, it, vi } from "vitest";
import { SubscriptionLimits } from "./subscription-limits";
import { LimitsRequestError, type LimitsProbe, type LimitsTarget } from "./subscription-limit-providers";
import { parseClaudeLimits, parseClaudeResetCredits, parseCodexLimits, parseCursorLimits } from "./subscription-limit-parsers";

const now = Date.parse("2026-11-04T12:00:00Z");
const reset = "2026-11-05T12:00:00.000Z";
const target: LimitsTarget = { id: "codex", key: "local-codex", label: "Codex", providerType: "codex-cli", config: {} };
const probe: LimitsProbe = { identity: "account-1", windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 90, resetsAt: reset }], resetCredits: { availableCount: 2, nextExpiresAt: reset } };
function setup() {
  let time = now;
  const providers = { probe: vi.fn(async () => probe), consume: vi.fn(async () => "reset" as const) };
  const service = new SubscriptionLimits(providers, () => time);
  return { service, providers, advance: (ms: number) => { time += ms; } };
}

describe("subscription limit responses", () => {
  it("uses Codex's main allowance, epoch-second resets, and available credits", () => {
    const result = parseCodexLimits({
      rateLimits: { limitId: "model-special", primary: { usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { planType: "plus", primary: { usedPercent: 24, resetsAt: Date.parse(reset) / 1000 }, secondary: { usedPercent: 120 }, individualLimit: { remainingPercent: 60 } } },
      rateLimitResetCredits: { availableCount: 2, credits: [{ status: "used", expiresAt: 1 }, { status: "available", expiresAt: Date.parse(reset) / 1000 }] },
    });
    expect(result.windows).toMatchObject([{ kind: "session", usedPercent: 24, resetsAt: reset }, { kind: "weekly", usedPercent: 100 }, { kind: "monthly", usedPercent: 40 }]);
    expect(result.resetCredits).toEqual({ availableCount: 2, nextExpiresAt: reset });
    expect(parseCodexLimits({ rateLimits: { limitId: "other", primary: { usedPercent: 5 } } }).windows).toEqual([]);
    expect(parseCodexLimits({ rateLimits: { planType: "free", primary: { usedPercent: 5 }, secondary: { usedPercent: NaN } } }).windows).toMatchObject([{ kind: "monthly", windowDurationMins: 43200 }]);
  });
  it("reads Claude percentages without scaling, named windows, and exact spend ratios", () => {
    const limits = { five_hour: { utilization: 25, resets_at: reset }, seven_day: { utilization: 60 },
      model_scoped: [{ display_name: "Opus", utilization: 75, resets_at: reset }],
      spend: { enabled: true, used: { amount_minor: 15, currency: "USD", exponent: 2 }, limit: { amount_minor: 40, currency: "USD", exponent: 2 } } };
    expect(parseClaudeLimits({ rate_limits_available: true, rate_limits: limits })).toMatchObject([
      { id: "five_hour", usedPercent: 25, resetsAt: reset }, { id: "seven_day", usedPercent: 60 },
      { id: "seven_day_opus", usedPercent: 75 }, { id: "monthly_spend", usedPercent: 37.5 },
    ]);
    expect(parseClaudeLimits({ rate_limits_available: false, rate_limits: limits })).toEqual([]);
    expect(parseClaudeLimits({ rate_limits_available: true, rate_limits: { spend: { ...limits.spend, limit: { amount_minor: 40, currency: "EUR", exponent: 2 } } } })).toEqual([]);
    expect(parseClaudeLimits({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: true, used_credits: 30, monthly_limit: 120 } } })).toMatchObject([{ usedPercent: 25 }]);
  });
  it("ignores malformed, paused, unusable, expired and nonselected Claude credits", () => {
    const live = { id: "grant_1", resets_left: 2, usable_now: true, ends_at: reset };
    const grants = [live, { ...live, id: "grant_2", resets_left: 1, ends_at: null },
      { ...live, id: "paused", paused: true }, { ...live, id: "unusable", usable_now: false },
      { ...live, id: "bad_flag", usable_now: "yes" }, { ...live, id: "expired", ends_at: "2026-11-01T00:00:00Z" },
      { ...live, id: "bad_date", ends_at: "2027-02-30T00:00:00Z" }, { ...live, id: "bad_count", resets_left: 1.5 }, { ...live, id: "../bad" }];
    expect(parseClaudeResetCredits({ eligible: true, grants, next_grant_id: "grant_1" }, now)).toEqual({ availableCount: 3, nextCreditId: "grant_1", nextExpiresAt: reset });
    expect(parseClaudeResetCredits({ eligible: true, grants, next_grant_id: "paused" }, now)).toEqual({ availableCount: 0 });
    expect(parseClaudeResetCredits({ eligible: false, grants }, now)).toBeUndefined();
  });
  it("uses Cursor's bonus-adjusted percentages and millisecond billing boundary", () => {
    expect(parseCursorLimits({ billingCycleEnd: String(Date.parse(reset)), planUsage: { totalPercentUsed: 20, autoPercentUsed: -1, apiPercentUsed: 150, spend: 10, limit: 10 } }))
      .toMatchObject([{ usedPercent: 20, resetsAt: reset }, { usedPercent: 0 }, { usedPercent: 100 }]);
    expect(parseCursorLimits({ planUsage: { totalPercentUsed: NaN, autoPercentUsed: "50" } })).toEqual([]);
    expect(parseCursorLimits({ planUsage: { totalPercentUsed: 0 } })[0]?.resetsAt).toBeUndefined();
  });
});

describe("local subscription limits service", () => {
  it("caches successful and failed probes, coalesces requests, and retains clearly stale windows", async () => {
    const { service, providers, advance } = setup();
    await Promise.all([service.load([target]), service.load([target])]);
    expect(providers.probe).toHaveBeenCalledTimes(1);
    advance(9_999);
    await service.load([target]);
    expect(providers.probe).toHaveBeenCalledTimes(1);
    advance(1);
    providers.probe.mockRejectedValue(new Error("private credential / secret response"));
    const report = await service.load([target], true);
    expect(report.accounts[0]).toMatchObject({ status: "cached", checkedAt: new Date(now).toISOString(), windows: probe.windows });
    expect(report.accounts[0]?.resetCredits?.actionToken).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("private credential");
    await service.load([target]);
    expect(providers.probe).toHaveBeenCalledTimes(2);
  });

  it("refreshes on every explicit open even while the five-minute cache is fresh", async () => {
    const { service, providers } = setup();
    await service.load([target], true);
    await service.load([target], true);
    expect(providers.probe).toHaveBeenCalledTimes(2);
    await service.load([target]);
    expect(providers.probe).toHaveBeenCalledTimes(2);
  });
  it("requires a current displayed credit and rejects tampered or expired snapshots", async () => {
    const { service, providers, advance } = setup();
    const report = await service.load([target]);
    const actionToken = report.accounts[0]!.resetCredits!.actionToken!;
    await expect(service.useReset([target], { accountId: target.id, actionToken: "made-up" })).rejects.toThrow("changed or expired");
    advance(300_001);
    await expect(service.useReset([target], { accountId: target.id, actionToken })).rejects.toThrow("changed or expired");
    expect(providers.consume).not.toHaveBeenCalled();
  });
  it("reuses one idempotency key and pinned credit after an uncertain failure, even after refresh", async () => {
    const { service, providers, advance } = setup();
    const first = await service.load([target]);
    providers.consume.mockRejectedValueOnce(new Error("timeout"));
    const input = { accountId: target.id, actionToken: first.accounts[0]!.resetCredits!.actionToken! };
    await expect(service.useReset([target], input)).rejects.toThrow("Retry to check the same request");
    advance(11_000);
    const newer = await service.load([target], true);
    const newInput = { ...input, actionToken: newer.accounts[0]!.resetCredits!.actionToken! };
    const [one, two] = await Promise.all([service.useReset([target], newInput), service.useReset([target], input)]);
    expect(one.outcome).toBe("reset");
    expect(two).toEqual(one);
    expect(providers.consume).toHaveBeenCalledTimes(2);
    expect(providers.consume.mock.calls[0]).toEqual(providers.consume.mock.calls[1]);
    await service.useReset([target], newInput);
    await service.useReset([target], input);
    expect(providers.consume).toHaveBeenCalledTimes(2);
  });
  it("invalidates a settled failure and prevents the old confirmation from being reused", async () => {
    const { service, providers } = setup();
    const report = await service.load([target]);
    const input = { accountId: target.id, actionToken: report.accounts[0]!.resetCredits!.actionToken! };
    providers.consume.mockRejectedValue(new LimitsRequestError("Account changed", true));
    await expect(service.useReset([target], input)).rejects.toThrow("Account changed");
    await expect(service.useReset([target], input)).rejects.toThrow("changed or expired");
    expect(providers.consume).toHaveBeenCalledTimes(1);
  });
  it("reports a successful reset even when the following limit refresh fails", async () => {
    const { service, providers } = setup();
    const report = await service.load([target]);
    providers.probe.mockRejectedValue(new Error("offline"));
    const result = await service.useReset([target], { accountId: target.id, actionToken: report.accounts[0]!.resetCredits!.actionToken! });
    expect(result.outcome).toBe("reset");
    expect(result.warning).toContain("reset was applied");
    expect(result.report.accounts[0]?.status).toBe("cached");
  });
  it("never offers manual resets for Cursor", async () => {
    const { service, providers } = setup();
    const cursor: LimitsTarget = { ...target, providerType: "cursor-agent" };
    const report = await service.load([cursor]);
    expect(report.accounts[0]?.resetCredits?.actionToken).toBeUndefined();
    await expect(service.useReset([cursor], { accountId: cursor.id, actionToken: "anything" })).rejects.toThrow("does not support");
    expect(providers.consume).not.toHaveBeenCalled();
  });
});
