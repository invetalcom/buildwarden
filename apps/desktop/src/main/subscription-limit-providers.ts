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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PROVIDER_CONFIG_CODEX_HOME_PATH_KEY, PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY, type NetworkProxyRuntimeConfig, type ProviderAccountRecord, type SubscriptionLimitsAccount, type SubscriptionProvider, type SubscriptionResetOutcome } from "@buildwarden/shared";
import { readCursorUsageCredential } from "./cursor-account-usage";
import { codexIdentity, nonempty, parseClaudeLimits, parseClaudeResetCredits, parseCodexLimits, parseCursorLimits, record, type ResetCredits } from "./subscription-limit-parsers";

export interface LimitsTarget { id: string; key: string; providerType: SubscriptionProvider; label: string; config: Record<string, unknown> }
export interface LimitsProbe {
  windows: SubscriptionLimitsAccount["windows"];
  identity: string;
  plan?: string;
  resetCredits?: ResetCredits;
  resetContext?: { version: string; organization: string; configDir: string; configFile: string };
  message?: string;
}
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export function subscriptionTargets(providers: readonly ProviderAccountRecord[], resolveTarget: (target: LimitsTarget) => LimitsTarget | null = (target) => target): LimitsTarget[] {
  const targets: LimitsTarget[] = [];
  for (const providerType of ["codex-cli", "claude-code", "cursor-agent"] as const) {
    const candidates = providers.filter((p) => p.providerType === providerType);
    const seen = new Set<string>();
    for (const p of [...candidates, null]) {
      let config: Record<string, unknown> = {};
      try { config = record(JSON.parse(p?.configJson ?? "{}")); } catch { /* Use provider defaults. */ }
      let home = providerType === "codex-cli" ? nonempty(config[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY]) || process.env.CODEX_HOME || join(homedir(), ".codex")
        : providerType === "claude-code" ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") : "cursor-login";
      if (providerType !== "cursor-agent") {
        if (/^~[/\\]/.test(home)) home = join(homedir(), home.slice(2));
        if (home === "~") home = homedir();
        // Match the configured runtime rather than guessing a working directory.
        if (isAbsolute(home)) home = resolve(home);
        if (providerType === "codex-cli") config = { ...config, [PROVIDER_CONFIG_CODEX_HOME_PATH_KEY]: home };
      }
      const identity = process.platform === "win32" ? home.toLowerCase() : home;
      if (seen.has(identity)) continue;
      const key = providerType + ":" + fingerprint(identity + JSON.stringify(config));
      const target = resolveTarget({ id: p?.id ?? providerType, key, providerType, label: p?.label ?? ({ "codex-cli": "Codex", "claude-code": "Claude", "cursor-agent": "Cursor" }[providerType]), config });
      if (!target) continue;
      seen.add(identity);
      targets.push(target);
    }
  }
  return targets;
}

export class LimitsRequestError extends Error {
  constructor(message: string, readonly settled = false) { super(message); }
}

const jsonFile = async (path: string): Promise<Record<string, unknown>> => record(JSON.parse(await readFile(path, "utf8")));
const claudeLogin = async () => {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  if (!isAbsolute(configDir)) throw new Error("Use an absolute CLAUDE_CONFIG_DIR to read reset credits.");
  const configFile = process.env.CLAUDE_CONFIG_DIR?.trim() ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
  const credentials = await jsonFile(join(configDir, ".credentials.json"));
  const config = await jsonFile(configFile);
  const token = nonempty(record(credentials.claudeAiOauth).accessToken);
  const organization = nonempty(record(config.oauthAccount).organizationUuid);
  if (!token || !organization) throw new Error("Sign in to Claude again to read reset credits.");
  return { token, organization, configDir, configFile, identity: fingerprint(token + organization) };
};

export class SubscriptionLimitProviders {
  constructor(private readonly options: {
    cwd: string;
    resolveFetch: () => Promise<typeof fetch>;
    resolveProxy: () => Promise<NetworkProxyRuntimeConfig | undefined>;
  }) {}

  private async request(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const fetchImpl = await this.options.resolveFetch();
    const response = await fetchImpl(url, { ...init, redirect: "error",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(25_000) });
    if (response.status === 401 || response.status === 403) throw new LimitsRequestError("Sign in to the provider again, then refresh Limits.", true);
    if (response.status === 429) throw new LimitsRequestError("The provider is rate limiting requests. Try again later.", true);
    if (!response.ok) throw new LimitsRequestError("The provider request failed (HTTP " + response.status + ").");
    return response.json();
  }

  async probe(target: LimitsTarget): Promise<LimitsProbe> {
    if (target.providerType === "codex-cli") {
      const { withCodexAccountClient } = await import("@buildwarden/provider-codex-cli");
      return withCodexAccountClient({ config: target.config, cwd: this.options.cwd, networkProxy: await this.options.resolveProxy() }, async (client) => {
        const account = await client.request("account/read", {});
        if (record(record(account).account).type === "apiKey") return { windows: [], identity: fingerprint(JSON.stringify(account)), message: "API-key accounts do not report subscription limits." };
        if (!record(account).account) throw new Error("Sign in to Codex to read subscription limits.");
        const usage = await client.request("account/rateLimits/read", null, 10_000);
        return { ...parseCodexLimits(usage), identity: fingerprint(codexIdentity(account, usage)) };
      });
    }
    if (target.providerType === "claude-code") {
      const { readClaudeSubscription } = await import("@buildwarden/provider-claude-code");
      const result = await readClaudeSubscription({ config: target.config, cwd: this.options.cwd, networkProxy: await this.options.resolveProxy() });
      const account = record(result.account);
      const windows = parseClaudeLimits(result.usage);
      const probe: LimitsProbe = { windows, plan: nonempty(account.subscriptionType), identity: fingerprint(JSON.stringify(account)) };
      if (!windows.length) probe.message = "This Claude connection does not report subscription limits.";
      if (process.platform === "darwin") {
        probe.message = "Claude reset credits are unavailable with macOS Keychain login.";
        return probe;
      }
      // The saved OAuth login may differ from an explicit environment/proxy credential.
      if (!probe.plan || !result.version || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
        || (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL.replace(/\/$/, "") !== "https://api.anthropic.com")) return probe;
      try {
        const login = await claudeLogin();
        const raw = record(await this.request("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", login.token,
          { headers: { "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/" + result.version + " (external, cli)" } }));
        probe.resetCredits = parseClaudeResetCredits(raw.cedar_ember, Date.now());
        probe.identity = login.identity;
        probe.resetContext = { version: result.version, organization: login.organization, configDir: login.configDir, configFile: login.configFile };
      } catch { probe.message = "Limits loaded, but reset credits could not be read."; }
      return probe;
    }
    const endpoint = (nonempty(target.config[PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY]) || process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh").replace(/\/$/, "");
    const explicit = process.env.CURSOR_AUTH_TOKEN?.trim();
    const credential = explicit ? { kind: "token" as const, value: explicit, source: undefined } : await readCursorUsageCredential(true);
    if (!credential) throw new Error("Sign in to Cursor to read subscription limits.");
    if (endpoint !== "https://api2.cursor.sh" && (credential.kind === "apiKey" || credential.source === "keychain")) {
      return { windows: [], identity: "", message: "Cursor subscription limits require the default API endpoint for this login." };
    }
    let token = credential.value;
    if (credential.kind === "apiKey") {
      const response = record(await this.request(endpoint + "/auth/exchange_user_api_key", token, { method: "POST", body: "{}" }));
      token = nonempty(response.accessToken) ?? "";
      if (!token) throw new Error("Cursor API key exchange failed.");
    }
    const raw = await this.request(endpoint + "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", token,
      { method: "POST", body: "{}", headers: { "connect-protocol-version": "1", "x-cursor-client-type": "cli" } });
    return { windows: parseCursorLimits(raw), identity: fingerprint(token) };
  }

  async consume(target: LimitsTarget, probe: LimitsProbe, idempotencyKey: string): Promise<SubscriptionResetOutcome> {
    if (target.providerType === "codex-cli") {
      const { withCodexAccountClient } = await import("@buildwarden/provider-codex-cli");
      return withCodexAccountClient({ config: target.config, cwd: this.options.cwd, networkProxy: await this.options.resolveProxy() }, async (client) => {
        const account = await client.request("account/read", {});
        const usage = await client.request("account/rateLimits/read", null, 10_000);
        if (fingerprint(codexIdentity(account, usage)) !== probe.identity) throw new LimitsRequestError("The Codex account changed. Refresh Limits before using a reset.", true);
        const result = record(await client.request("account/rateLimitResetCredit/consume", { idempotencyKey }, 20_000));
        if (["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(String(result.outcome))) return result.outcome as SubscriptionResetOutcome;
        throw new LimitsRequestError("Codex could not confirm the reset. Retry to check the same request.");
      });
    }
    if (target.providerType !== "claude-code" || !probe.resetContext || !probe.resetCredits?.nextCreditId) throw new LimitsRequestError("No reset credit is available.", true);
    const login = await claudeLogin();
    if (login.identity !== probe.identity || login.configDir !== probe.resetContext.configDir) throw new LimitsRequestError("The Claude account changed. Refresh Limits before using a reset.", true);
    const response = record(await this.request("https://api.anthropic.com/api/organizations/" + encodeURIComponent(login.organization) + "/reset_rate_limits", login.token,
      { method: "POST", headers: { "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/" + probe.resetContext.version + " (external, cli)" },
        body: JSON.stringify({ program: "cedar_ember", grant_id: probe.resetCredits.nextCreditId, request_id: idempotencyKey }) }));
    const outcomes: Record<string, SubscriptionResetOutcome> = { reset: "reset", not_limited: "nothingToReset", already_used: "alreadyRedeemed", ineligible: "noCredit" };
    const outcome = outcomes[String(response.result)];
    if (outcome) return outcome;
    if (response.result === "cooldown") throw new LimitsRequestError("Claude resets are cooling down. Try again later.", true);
    throw new LimitsRequestError("Claude could not confirm the reset. Retry to check the same request.");
  }
}

