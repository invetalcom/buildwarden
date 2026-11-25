import { dirname, join } from "node:path";
import {
  APP_SETTING_KEYS,
  parseUsageCostTrackingEnabledSetting,
  type SubscriptionLimitsInput,
  type SubscriptionLimitsReport,
  type SubscriptionResetInput,
  type SubscriptionResetResult,
  type UsageCostReport,
  type UsageCostReportInput,
} from "@buildwarden/shared";
import { CursorAccountUsage } from "../cursor-account-usage";
import { sessionUsageRoots } from "../local-session-usage";
import { ModelPriceList } from "../model-price-list";
import { loadProxyAwareFetch } from "../provider-modules";
import { SessionUsageWorkerClient } from "../session-usage-worker-client";
import { installedSubscriptionTargets } from "../subscription-limit-installation";
import { SubscriptionLimitProviders } from "../subscription-limit-providers";
import { SubscriptionLimits } from "../subscription-limits";
import {
  buildUsageCostReport,
  CURSOR_ACCOUNT_PROJECT_ID,
  cursorAccountUsageRows,
  localSessionUsageRows,
  sessionHistoryProjectId,
  usageReportWindow,
} from "../usage-cost-report";
import { AppService } from "./app-service";

/** Reports usage costs and subscription limits. */
export class UsageService extends AppService<"settings"> {
  /** Created on first use so no price list is read or downloaded while cost tracking is off. */
  private modelPriceList: ModelPriceList | null = null;
  private cursorAccountUsage: CursorAccountUsage | null = null;
  private localSessionUsage: SessionUsageWorkerClient | null = null;
  private subscriptionLimits: SubscriptionLimits | null = null;

  private getSubscriptionLimitsService(): SubscriptionLimits {
    this.subscriptionLimits ??= new SubscriptionLimits(new SubscriptionLimitProviders({
      cwd: dirname(this.db.getFilePath()),
      resolveFetch: async () => await loadProxyAwareFetch(await this.services.settings.resolveNetworkProxyRuntimeConfig()) ?? fetch,
      resolveProxy: () => this.services.settings.resolveNetworkProxyRuntimeConfig(),
    }));
    return this.subscriptionLimits;
  }

  async getSubscriptionLimits(input: SubscriptionLimitsInput): Promise<SubscriptionLimitsReport> {
    return this.getSubscriptionLimitsService().load(installedSubscriptionTargets(this.db.listProviderAccounts()), input.refresh === true);
  }

  async getSubscriptionLimitsAvailability() {
    return [...new Set(installedSubscriptionTargets(this.db.listProviderAccounts()).map((target) => target.providerType))];
  }

  async useSubscriptionReset(input: SubscriptionResetInput): Promise<SubscriptionResetResult> {
    if (!input || typeof input.accountId !== "string" || typeof input.actionToken !== "string" || !/^[\da-f-]{36}$/i.test(input.actionToken)) throw new Error("Invalid reset request.");
    return this.getSubscriptionLimitsService().useReset(installedSubscriptionTargets(this.db.listProviderAccounts()), input);
  }

  async getUsageCostReport(input: UsageCostReportInput): Promise<UsageCostReport> {
    const scope = input.scope ?? "buildwarden";
    if (scope !== "buildwarden" && scope !== "account") throw new Error("Invalid usage scope.");
    const settings = this.db.getSettings();
    if (!parseUsageCostTrackingEnabledSetting(settings[APP_SETTING_KEYS.usageCostTrackingEnabled])) {
      throw new Error("Usage cost tracking is turned off. Enable it in Settings -> Network.");
    }
    const rangeDays = input.rangeDays === null ? null : Math.min(3_650, Math.max(1, Math.floor(input.rangeDays)));
    this.modelPriceList ??= new ModelPriceList({
      cacheFilePath: join(dirname(this.db.getFilePath()), "model-prices.json"),
      resolveFetch: async () => await loadProxyAwareFetch(await this.services.settings.resolveNetworkProxyRuntimeConfig()) ?? fetch,
    });
    const { table, pricing } = await this.modelPriceList.load(input.refreshPricing === true);
    const now = new Date();
    const earliest = scope === "buildwarden" && rangeDays === null ? this.db.getEarliestTokenUsageAt() : null;
    let window = usageReportWindow(rangeDays, now, earliest ? new Date(earliest) : null);
    if (scope === "buildwarden") {
      return buildUsageCostReport({
        rows: this.db.listTokenUsageCostRows(
          window.since?.toISOString() ?? null,
          window.bucketSize,
          window.exclude ? { from: window.exclude.from.toISOString(), to: window.exclude.to.toISOString() } : undefined,
        ),
        table, pricing, rangeDays, now, window, ranks: this.db.getTokenUsageRanks(),
      });
    }
    const providers = this.db.listProviderAccounts();
    const hasCursor = providers.some((provider) => provider.providerType === "cursor-agent") || Boolean(process.env.CURSOR_API_KEY);
    this.cursorAccountUsage ??= new CursorAccountUsage({
      cacheFilePath: join(dirname(this.db.getFilePath()), "cursor-account-usage.json"),
      resolveFetch: async () => await loadProxyAwareFetch(await this.services.settings.resolveNetworkProxyRuntimeConfig()) ?? fetch,
    });
    this.localSessionUsage ??= new SessionUsageWorkerClient({ cacheFilePath: join(dirname(this.db.getFilePath()), "local-session-usage.json") });
    const [cursor, sessions] = await Promise.all([
      hasCursor ? this.cursorAccountUsage.load(window.since?.getTime() ?? 0) : null,
      this.localSessionUsage.load(sessionUsageRoots(providers), input.refreshPricing === true),
    ]);
    if (rangeDays === null) {
      let first = Infinity;
      for (const event of cursor?.events ?? []) first = Math.min(first, event.timestampMs);
      for (const record of sessions.records) first = Math.min(first, record.timestampMs);
      window = usageReportWindow(rangeDays, now, Number.isFinite(first) ? new Date(first) : null);
    }
    const historyRows = [...cursorAccountUsageRows(cursor?.events ?? [], window), ...localSessionUsageRows(sessions.records, window)];
    const weights = new Map<string, { providerType: string; modelId: string; tokens: number }>();
    const addWeight = (providerType: string, modelId: string, tokens: number) => {
      const key = `${providerType}:${modelId}`;
      const model = weights.get(key) ?? { providerType, modelId, tokens: 0 };
      model.tokens += tokens;
      weights.set(key, model);
    };
    for (const event of cursor?.events ?? []) addWeight("cursor-agent", event.modelId, event.inputTokens + event.outputTokens);
    for (const record of sessions.records) addWeight(record.provider === "codex" ? "codex-cli" : "claude-code", record.model,
      record.totals.uncachedInputTokens + record.totals.cachedInputTokens + record.totals.cacheCreationTokens + record.totals.outputTokens);
    const ranks = {
      models: [...weights.values()].sort((a, b) => b.tokens - a.tokens || a.modelId.localeCompare(b.modelId)),
      projectIds: [...new Set(sessions.records.map((record) => sessionHistoryProjectId(record.provider)))],
    };
    if (cursor) ranks.projectIds.push(CURSOR_ACCOUNT_PROJECT_ID);
    const report = buildUsageCostReport({
      rows: historyRows,
      table,
      pricing,
      rangeDays,
      now,
      window,
      ranks,
    });
    const histories = sessions.histories.filter((history) => history.status !== "unavailable" || providers.some((provider) => provider.providerType === history.providerType));
    return { ...report, ...(cursor ? { accounts: [cursor.status] } : {}), histories };
  }
}
