import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorAccountUsage, cursorAuthPath, fetchCursorUsageEvents, parseCursorUsageEvent, type CursorUsageCredential } from "./cursor-account-usage";

const directories: string[] = [];
const cacheFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "buildwarden-cursor-usage-"));
  directories.push(directory);
  return join(directory, "usage.json");
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const token = (subject: string) => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
const credential: CursorUsageCredential = { kind: "token", value: token("auth0|user-1") };
const event = (timestamp = 1000, overrides: Record<string, unknown> = {}) => ({
  timestamp: String(timestamp), model: "cursor-composer-2.5", conversationId: "conversation",
  tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 50, totalCents: 1.25 },
  ...overrides,
});
const response = (events: unknown[], total = events.length) => new Response(JSON.stringify({ usageEventsDisplay: events, totalUsageEventsCount: total }));

describe("Cursor account API", () => {
  it("uses the CLI session cookie without redirects, converts cents and includes all input categories", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response([event(), event(20_000)]));
    const result = await fetchCursorUsageEvents(fetchMock, credential, 0, 10_000);
    expect(result.events).toEqual([{ timestampMs: 1000, modelId: "cursor-composer-2.5", inputTokens: 350, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 50, reportedCostUsd: 0.0125 }]);
    expect(result.accountKey).not.toContain("user-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`user-1::${credential.value}`)}` } });
    expect(JSON.parse(String(init?.body))).toEqual({ page: 1, pageSize: 1000, startDate: "0", endDate: "10000" });
  });

  it("exchanges API keys and uses the bearer-authenticated Cursor RPC endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => String(url).endsWith("exchange_user_api_key")
      ? new Response(JSON.stringify({ accessToken: credential.value })) : response([event()]));
    await fetchCursorUsageEvents(fetchMock, { kind: "apiKey", value: "test-key" }, 0, 10_000);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test-key" } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${credential.value}`, "connect-protocol-version": "1" } });
  });

  it("preserves identical billed rows and reconciles only overlapping page boundaries", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => event(1000 + index));
    first[1] = first[0]!;
    const fetchMock = vi.fn().mockResolvedValueOnce(response(first, 1001)).mockResolvedValueOnce(response([first[999], event(3000)], 1001));
    const result = await fetchCursorUsageEvents(fetchMock, credential, 0, 10_000);
    expect(result.events).toHaveLength(1001);
    expect(result.events[0]).toEqual(result.events[1]);
    expect(result.events.filter((row) => row.timestampMs === 1999)).toHaveLength(1);
  });

  it("keeps legitimate identical events across a page boundary when the count includes both", async () => {
    const first = Array.from({ length: 1000 }, () => event());
    const fetchMock = vi.fn().mockResolvedValueOnce(response(first, 1001)).mockResolvedValueOnce(response([event()], 1001));
    expect((await fetchCursorUsageEvents(fetchMock, credential, 0, 10_000)).events).toHaveLength(1001);
  });

  it("reads counted pages ahead and keeps results in page order", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const page = Number(JSON.parse(String(init?.body)).page);
      return response(Array.from({ length: page === 4 ? 1 : 1000 }, (_, index) => event(page * 1000 + index)), 3001);
    });
    const result = await fetchCursorUsageEvents(fetchMock, credential, 0, 10_000);
    expect(result.events).toHaveLength(3001);
    expect(result.events[1000]?.timestampMs).toBe(2000);
    expect(result.events.at(-1)?.timestampMs).toBe(4000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    { usageEventsDisplay: [event()], totalUsageEventsCount: 2 },
    { usageEventsDisplay: [event(1000, { tokenUsage: { inputTokens: -1 } })], totalUsageEventsCount: 1 },
    { usageEventsDisplay: [event(1000, { model: "" })], totalUsageEventsCount: 1 },
    { usageEventsDisplay: [], totalUsageEventsCount: -1 },
    { message: "error" },
    [],
  ])("rejects incomplete or malformed account pages: %j", async (body) => {
    await expect(fetchCursorUsageEvents(vi.fn(async () => new Response(JSON.stringify(body))), credential, 0, 10_000)).rejects.toThrow();
  });

  it("does not turn missing usage into invented tokens and preserves reported zero cost", () => {
    expect(parseCursorUsageEvent({ timestamp: 1000, model: "auto" })).toBeNull();
    expect(parseCursorUsageEvent(event(1000, { tokenUsage: { totalCents: 0 } }))?.reportedCostUsd).toBe(0);
    expect(parseCursorUsageEvent(event(1000, { tokenUsage: { inputTokens: 100 } }))?.reportedCostUsd).toBeNull();
  });

  it("reports authentication failures without exposing the token", async () => {
    await expect(fetchCursorUsageEvents(vi.fn(async () => new Response("", { status: 401 })), credential, 0, 10_000)).rejects.toThrow("Sign in to Cursor again");
  });
});

describe("Cursor history cache", () => {
  it("reuses requests and disk caches, with no credentials persisted", async () => {
    const file = cacheFile();
    const fetchMock = vi.fn(async () => response([event()]));
    const options = { cacheFilePath: file, resolveFetch: async () => fetchMock, readCredential: async () => credential, now: () => 10_000 };
    const usage = new CursorAccountUsage(options);
    const results = await Promise.all([usage.load(0), usage.load(0), usage.load(0)]);
    expect(results.map((r) => r.events.length)).toEqual([1, 1, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain(credential.value);
    expect(stored).not.toContain("user-1");
    expect((await new CursorAccountUsage(options).load(0)).events).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replaces an overlap on refresh, including finalized cost changes, without double counting", async () => {
    let now = 10_000_000;
    let changed = false;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const since = Number(JSON.parse(String(init?.body)).startDate);
      return response([event(1000), event(9_000_000, changed ? { tokenUsage: { inputTokens: 200, totalCents: 2 } } : {})].filter((e) => Number(e.timestamp) >= since));
    });
    const usage = new CursorAccountUsage({ cacheFilePath: cacheFile(), resolveFetch: async () => fetchMock, readCredential: async () => credential, now: () => now });
    await usage.load(0);
    changed = true;
    now += 61_000;
    const result = await usage.load(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[1]?.reportedCostUsd).toBe(0.02);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).startDate).toBe(String(10_000_000 - 3_600_000));
  });

  it("fetches an expanded date window even inside the TTL", async () => {
    const fetchMock = vi.fn(async () => response([event()]));
    const usage = new CursorAccountUsage({ cacheFilePath: cacheFile(), resolveFetch: async () => fetchMock, readCredential: async () => credential, now: () => 10_000 });
    await usage.load(500);
    await usage.load(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps good cached history when a refresh fails, throttles retries and recovers", async () => {
    let now = 10_000;
    let failing = false;
    const fetchMock = vi.fn(async () => {
      if (failing) throw new Error(`Network failure with secret ${credential.value}`);
      return response([event()]);
    });
    const usage = new CursorAccountUsage({ cacheFilePath: cacheFile(), resolveFetch: async () => fetchMock, readCredential: async () => credential, now: () => now });
    await usage.load(0);
    now += 61_000;
    failing = true;
    const cached = await usage.load(0);
    expect(cached.status.status).toBe("cached");
    expect(cached.events).toHaveLength(1);
    expect(JSON.stringify(cached)).not.toContain(credential.value);
    now += 30_000;
    await usage.load(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 31_000;
    failing = false;
    expect((await usage.load(0)).status.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never shows the previous account's history after switching accounts or signing out", async () => {
    let current: CursorUsageCredential | null = credential;
    let failing = false;
    const fetchMock = vi.fn(async () => failing ? new Response("", { status: 401 }) : response([event()]));
    const usage = new CursorAccountUsage({ cacheFilePath: cacheFile(), resolveFetch: async () => fetchMock, readCredential: async () => current, now: () => 10_000 });
    await usage.load(0);
    current = { kind: "token", value: token("auth0|user-2") };
    failing = true;
    const switched = await usage.load(0);
    expect(switched.events).toEqual([]);
    expect(switched.status.status).toBe("unavailable");
    current = null;
    expect((await usage.load(0)).events).toEqual([]);
  });
});

describe("CLI credential locations", () => {
  it("follows Windows, Linux XDG, and macOS CLI locations", () => {
    expect(cursorAuthPath("win32", { APPDATA: "C:/roaming" }, "C:/home")).toBe("C:\\roaming\\Cursor\\auth.json");
    expect(cursorAuthPath("linux", { XDG_CONFIG_HOME: "/config" }, "/home/user")).toBe("/config/cursor/auth.json");
    expect(cursorAuthPath("darwin", {}, "/Users/user")).toBe("/Users/user/.cursor/auth.json");
  });

  it.each(["relative/config", "C:/config", ""])("ignores non-absolute Linux XDG paths: %s", (config) => {
    expect(cursorAuthPath("linux", { XDG_CONFIG_HOME: config }, "/home/user")).toBe("/home/user/.config/cursor/auth.json");
  });

  it("uses platform-specific home overrides and Windows' default roaming directory", () => {
    expect(cursorAuthPath("win32", { USERPROFILE: "D:/user" }, "C:/fallback")).toBe("D:\\user\\AppData\\Roaming\\Cursor\\auth.json");
    expect(cursorAuthPath("linux", { HOME: "/users/linux" }, "/fallback")).toBe("/users/linux/.config/cursor/auth.json");
    expect(cursorAuthPath("darwin", { HOME: "/Users/mac", XDG_CONFIG_HOME: "/ignored" }, "/fallback")).toBe("/Users/mac/.cursor/auth.json");
  });
});
