import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccountRecord } from "@buildwarden/shared";
import { SubscriptionLimitProviders, subscriptionTargets, type LimitsTarget } from "./subscription-limit-providers";

const mocks = vi.hoisted(() => ({ request: vi.fn(), claude: vi.fn(), credential: vi.fn(), readFile: vi.fn() }));
vi.mock("@buildwarden/provider-codex-cli", () => ({ withCodexAccountClient: async (_: unknown, action: (client: { request: typeof mocks.request }) => unknown) => action({ request: mocks.request }) }));
vi.mock("@buildwarden/provider-claude-code", () => ({ readClaudeSubscription: mocks.claude }));
vi.mock("./cursor-account-usage", () => ({ readCursorUsageCredential: mocks.credential }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

const target = (providerType: LimitsTarget["providerType"]): LimitsTarget => ({ id: providerType, key: providerType, label: providerType, providerType, config: {} });
const fetchMock = vi.fn<typeof fetch>();
const adapters = () => new SubscriptionLimitProviders({ cwd: tmpdir(), resolveFetch: async () => fetchMock, resolveProxy: async () => undefined });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ["CURSOR_AUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_API_ENDPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME"]) vi.stubEnv(key, "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(tmpdir(), "limits-test-claude"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("subscription provider protocols", () => {
  it("reads Codex account allowances and consumes the native reset with an idempotency key", async () => {
    mocks.request.mockImplementation(async (method: string) => method === "account/read" ? { account: { type: "chatgpt", email: "sample@example.test" } }
      : method === "account/rateLimits/read" ? { accountId: "one", rateLimits: { primary: { usedPercent: 100 } }, rateLimitResetCredits: { availableCount: 1 } }
      : { outcome: "reset" });
    const provider = adapters();
    const reading = await provider.probe(target("codex-cli"));
    expect(reading.windows[0]?.usedPercent).toBe(100);
    expect(await provider.consume(target("codex-cli"), reading, "same-request")).toBe("reset");
    expect(mocks.request).toHaveBeenLastCalledWith("account/rateLimitResetCredit/consume", { idempotencyKey: "same-request" }, 20_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses to reset Codex when the login changed after displaying the credit", async () => {
    mocks.request.mockResolvedValue({ account: { type: "chatgpt", email: "different@example.test" }, accountId: "other" });
    await expect(adapters().consume(target("codex-cli"), { windows: [], identity: "old" }, "request")).rejects.toMatchObject({ settled: true });
    expect(mocks.request.mock.calls.map(([method]) => method)).not.toContain("account/rateLimitResetCredit/consume");
  });
  it("treats Codex API-key accounts as unsupported instead of fabricating allowances", async () => {
    mocks.request.mockResolvedValue({ account: { type: "apiKey" } });
    expect(await adapters().probe(target("codex-cli"))).toMatchObject({ windows: [], message: expect.stringContaining("API-key") });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("exchanges a Cursor API key, then reads the same dashboard endpoint as T3 Code", async () => {
    mocks.credential.mockResolvedValue({ kind: "apiKey", value: "test-api-key" });
    fetchMock.mockResolvedValueOnce(response({ accessToken: "test-access-token" }))
      .mockResolvedValueOnce(response({ planUsage: { totalPercentUsed: 35 } }));
    const reading = await adapters().probe(target("cursor-agent"));
    expect(reading.windows[0]?.usedPercent).toBe(35);
    expect(fetchMock.mock.calls[0]).toMatchObject(["https://api2.cursor.sh/auth/exchange_user_api_key", { method: "POST", headers: { authorization: "Bearer test-api-key" } }]);
    expect(fetchMock.mock.calls[1]).toMatchObject(["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", { method: "POST", body: "{}", redirect: "error", headers: { authorization: "Bearer test-access-token", "connect-protocol-version": "1", "x-cursor-client-type": "cli" } }]);
    expect(reading.resetCredits).toBeUndefined();
  });
  it("prioritizes Cursor's explicit auth token and does not send API keys to custom endpoints", async () => {
    vi.stubEnv("CURSOR_AUTH_TOKEN", "explicit-token");
    fetchMock.mockResolvedValue(response({ planUsage: { totalPercentUsed: 0 } }));
    await adapters().probe(target("cursor-agent"));
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer explicit-token" });
    vi.stubEnv("CURSOR_AUTH_TOKEN", "");
    vi.stubEnv("CURSOR_API_ENDPOINT", "https://other.example");
    mocks.credential.mockResolvedValue({ kind: "apiKey", value: "test-api-key" });
    expect(await adapters().probe(target("cursor-agent"))).toMatchObject({ windows: [], message: expect.stringContaining("default API endpoint") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never includes HTTP response bodies or credentials in errors", async () => {
    vi.stubEnv("CURSOR_AUTH_TOKEN", "private-token");
    fetchMock.mockResolvedValue(response({ error: "private-token from response" }, 401));
    await expect(adapters().probe(target("cursor-agent"))).rejects.toThrow("Sign in to the provider again");
  });
  it("reads Claude reset grants and posts the pinned grant to the logged-in organization", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.claude.mockResolvedValue({ account: { subscriptionType: "max" }, version: "2.1.0", usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 90 } } } });
    mocks.readFile.mockImplementation(async (path: string) => JSON.stringify(path.endsWith(".credentials.json") ? { claudeAiOauth: { accessToken: "test-token" } } : { oauthAccount: { organizationUuid: "org-id" } }));
    fetchMock.mockResolvedValueOnce(response({ cedar_ember: { eligible: true, next_grant_id: "grant_1", grants: [{ id: "grant_1", resets_left: 2, usable_now: true, ends_at: null }] } }))
      .mockResolvedValueOnce(response({ result: "reset" }));
    const provider = adapters();
    const reading = await provider.probe(target("claude-code"));
    expect(reading.resetCredits).toMatchObject({ availableCount: 2, nextCreditId: "grant_1" });
    expect(await provider.consume(target("claude-code"), reading, "request-1")).toBe("reset");
    expect(fetchMock.mock.calls[1]).toMatchObject(["https://api.anthropic.com/api/organizations/org-id/reset_rate_limits", { headers: { "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.1.0 (external, cli)" }, body: JSON.stringify({ program: "cedar_ember", grant_id: "grant_1", request_id: "request-1" }) }]);
    mocks.readFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "changed-token" }, oauthAccount: { organizationUuid: "other" } }));
    await expect(provider.consume(target("claude-code"), reading, "request-2")).rejects.toMatchObject({ settled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("keeps Claude limits available when reset grants fail or login uses Keychain", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.claude.mockResolvedValue({ account: { subscriptionType: "pro" }, version: "2.1.0", usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } } });
    expect(await adapters().probe(target("claude-code"))).toMatchObject({ windows: [{ usedPercent: 20 }], message: expect.stringContaining("Keychain") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("always includes all three providers and deduplicates configurations sharing a local account", () => {
    expect(subscriptionTargets([]).map((p) => p.providerType)).toEqual(["codex-cli", "claude-code", "cursor-agent"]);
    const providers = ["first", "second"].map((id) => ({ id, providerType: "codex-cli", label: id, configJson: "{}" } as ProviderAccountRecord));
    expect(subscriptionTargets(providers).filter((p) => p.providerType === "codex-cli")).toHaveLength(1);
  });
});
