/*!
 * @license Portions adapted from T3 Code (https://github.com/pingdotgg/t3code).
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
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
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { CursorAccountUsageEvent, UsageAccountStatus } from "@buildwarden/shared";

// Same account API and token semantics as T3 Code's provider-cursor/server/accountUsage.ts.
const DASHBOARD_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const RPC_ORIGIN = "https://api2.cursor.sh";
const PAGE_SIZE = 1000;
const TTL_MS = 60_000;
const OVERLAP_MS = 60 * 60_000;
const execFileAsync = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): value is number => finite(value) && value <= 8.64e15;

export type CursorUsageCredential = { kind: "apiKey" | "token"; value: string };

export const cursorAuthPath = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string => {
  const path = platform === "win32" ? win32 : posix;
  const userHome = (platform === "win32" ? env.USERPROFILE : env.HOME) || home;
  if (platform === "darwin") return path.join(userHome, ".cursor", "auth.json");
  const config = env.XDG_CONFIG_HOME?.trim();
  const root = platform === "win32" ? env.APPDATA || path.join(userHome, "AppData", "Roaming")
    : config && path.isAbsolute(config) ? config : path.join(userHome, ".config");
  return path.join(root, platform === "win32" ? "Cursor" : "cursor", "auth.json");
};

/** Credentials stay in main-process memory; neither tokens nor API keys enter the usage cache. */
export const readCursorUsageCredential = async (): Promise<CursorUsageCredential | null> => {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey) return { kind: "apiKey", value: apiKey };
  try {
    const data: unknown = JSON.parse(await readFile(cursorAuthPath(process.platform, process.env, homedir()), "utf8"));
    const token = object(data).accessToken;
    if (typeof token === "string" && token) return { kind: "token", value: token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cursor CLI credentials could not be read.");
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], { timeout: 10_000, windowsHide: true });
      if (stdout.trim()) return { kind: "token", value: stdout.trim() };
    } catch {
      throw new Error("Cursor usage needs CLI login and Keychain access on this Mac, or CURSOR_API_KEY.");
    }
  }
  return null;
};

export const parseCursorUsageEvent = (raw: unknown): CursorAccountUsageEvent | null => {
  const event = object(raw);
  if (event.tokenUsage === undefined || event.tokenUsage === null) return null;
  const usage = object(event.tokenUsage);
  if (Object.keys(usage).length === 0 && (typeof event.tokenUsage !== "object" || Array.isArray(event.tokenUsage))) {
    throw new Error("Invalid Cursor usage totals.");
  }
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalCents"]) {
    if (usage[key] !== undefined && !finite(usage[key])) throw new Error("Invalid Cursor usage totals.");
  }
  const timestampMs = typeof event.timestamp === "string" && event.timestamp.trim() ? Number(event.timestamp) : event.timestamp;
  if (!finite(timestampMs) || timestampMs > 8.64e15 || typeof event.model !== "string" || !event.model.trim()) {
    throw new Error("Invalid Cursor usage event.");
  }
  const tokens = (key: string): number => Math.trunc(usage[key] as number ?? 0);
  const cacheReadTokens = tokens("cacheReadTokens");
  const cacheWriteTokens = tokens("cacheWriteTokens");
  return {
    timestampMs,
    modelId: event.model,
    // Cursor reports uncached input separately, unlike BuildWarden's processed input counter.
    inputTokens: tokens("inputTokens") + cacheReadTokens + cacheWriteTokens,
    outputTokens: tokens("outputTokens"),
    cacheReadTokens,
    cacheWriteTokens,
    reportedCostUsd: finite(usage.totalCents) ? usage.totalCents / 100 : null,
  };
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** Remove only excess overlapping page boundaries; identical billed events remain distinct. */
const boundaryOverlap = (previous: string[], current: string[]): number => {
  const sequence = [...current, "", ...previous];
  const lengths = sequence.map(() => 0);
  for (let index = 1; index < sequence.length; index++) {
    let length = lengths[index - 1]!;
    while (length > 0 && sequence[index] !== sequence[length]) length = lengths[length - 1]!;
    if (sequence[index] === sequence[length]) length++;
    lengths[index] = length;
  }
  return lengths.at(-1) ?? 0;
};

export const fetchCursorUsageEvents = async (
  fetchImpl: typeof fetch, credential: CursorUsageCredential, sinceMs: number, untilMs: number,
): Promise<{ accountKey: string; events: CursorAccountUsageEvent[] }> => {
  if (!timestamp(sinceMs) || !timestamp(untilMs) || sinceMs > untilMs) throw new Error("Invalid Cursor usage date window.");
  const overall = AbortSignal.timeout(60_000);
  const request = async (url: string, headers: Record<string, string>, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([overall, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 401 || response.status === 403) throw new Error("Sign in to Cursor again to read account usage.");
    if (!response.ok) throw new Error(`Cursor account usage request failed (HTTP ${response.status}).`);
    return response.json();
  };
  let token = credential.value;
  if (credential.kind === "apiKey") {
    const result = object(await request(`${RPC_ORIGIN}/auth/exchange_user_api_key`, { Authorization: `Bearer ${token}` }, {}));
    if (typeof result.accessToken !== "string" || !result.accessToken) throw new Error("Cursor API key exchange failed.");
    token = result.accessToken;
  }
  let subject: unknown;
  try { subject = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))).sub; }
  catch { throw new Error("Invalid Cursor login. Sign in to Cursor again."); }
  if (typeof subject !== "string" || !subject.split("|").at(-1)) throw new Error("Invalid Cursor login. Sign in to Cursor again.");
  const accountKey = hash(subject);
  const url = credential.kind === "apiKey" ? `${RPC_ORIGIN}/aiserver.v1.DashboardService/GetFilteredUsageEvents` : DASHBOARD_URL;
  const headers: Record<string, string> = credential.kind === "apiKey"
    ? { Authorization: `Bearer ${token}`, "connect-protocol-version": "1" }
    : { Origin: "https://cursor.com", Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${subject.split("|").at(-1)}::${token}`)}` };
  const pages: unknown[][] = [];
  let total: number | undefined;
  const readPage = async (page: number): Promise<unknown[]> => {
    if (page > (total === undefined ? 1000 : Math.ceil(total / PAGE_SIZE) * 2 + 1)) throw new Error("Cursor usage page limit exceeded.");
    const raw = await request(url, headers, { page, pageSize: PAGE_SIZE, startDate: String(sinceMs), endDate: String(untilMs) });
    const body = object(raw);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || "error" in body || "message" in body || "code" in body) throw new Error("Invalid Cursor usage page.");
    const keys = Object.keys(body);
    const count = keys.length === 0 ? 0 : body.totalUsageEventsCount;
    const events = keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount") ? [] : body.usageEventsDisplay;
    if ((count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0 || (total !== undefined && total !== count))) || !Array.isArray(events) || events.length > PAGE_SIZE) throw new Error("Inconsistent Cursor usage pages.");
    if (typeof count === "number") total = count;
    return events;
  };
  pages.push(await readPage(1));
  while (pages.at(-1)!.length === PAGE_SIZE) {
    // Like T3 Code, use the first count to fetch up to six pages ahead, in page order.
    const count = Math.min(6, Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE) - pages.length));
    const batch = await Promise.all(Array.from({ length: count }, (_, index) => readPage(pages.length + index + 1)));
    for (const events of batch) {
      pages.push(events);
      if (events.length < PAGE_SIZE) break;
    }
  }
  const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
  if (total !== undefined && rawCount < total) throw new Error("Incomplete Cursor usage pages.");
  let excess = total === undefined ? 0 : rawCount - total;
  let previousKeys: string[] = [];
  const events: CursorAccountUsageEvent[] = [];
  for (const page of pages) {
    const keys = excess > 0 ? page.map((event) => hash(canonicalJson(event))) : [];
    const overlap = Math.min(excess, boundaryOverlap(previousKeys, keys));
    excess -= overlap;
    previousKeys = keys;
    for (const raw of page.slice(overlap)) {
      const event = parseCursorUsageEvent(raw);
      if (event && event.timestampMs >= sinceMs && event.timestampMs <= untilMs) events.push(event);
    }
  }
  if (excess !== 0) throw new Error("Inconsistent Cursor usage page boundaries.");
  return { accountKey, events };
};

interface AccountCache {
  version: 1;
  credentialKey: string;
  accountKey: string;
  sinceMs: number;
  untilMs: number;
  fetchedAtMs: number;
  events: CursorAccountUsageEvent[];
}

export interface CursorAccountUsageResult {
  events: CursorAccountUsageEvent[];
  status: UsageAccountStatus;
}

export class CursorAccountUsage {
  private cache: AccountCache | null = null;
  private diskChecked = false;
  private inFlight: Promise<CursorAccountUsageResult> | null = null;
  private failure: { atMs: number; credentialKey: string; message: string } | null = null;

  constructor(private readonly options: {
    cacheFilePath: string;
    resolveFetch: () => Promise<typeof fetch>;
    readCredential?: () => Promise<CursorUsageCredential | null>;
    now?: () => number;
  }) {}

  async load(sinceMs: number): Promise<CursorAccountUsageResult> {
    // Serialize different ranges, then re-check coverage for callers requesting more history.
    while (this.inFlight) await this.inFlight;
    const task = this.refresh(sinceMs);
    this.inFlight = task;
    try { return await task; }
    finally { if (this.inFlight === task) this.inFlight = null; }
  }

  private async refresh(sinceMs: number): Promise<CursorAccountUsageResult> {
    const now = (this.options.now ?? Date.now)();
    if (!this.diskChecked) {
      this.diskChecked = true;
      try {
        const data = object(JSON.parse(await readFile(this.options.cacheFilePath, "utf8")));
        if (data.version === 1 && typeof data.credentialKey === "string" && typeof data.accountKey === "string" && timestamp(data.sinceMs) && timestamp(data.untilMs) && timestamp(data.fetchedAtMs) && data.sinceMs <= data.untilMs && Array.isArray(data.events) && data.events.every(validCachedEvent)) {
          this.cache = data as unknown as AccountCache;
        }
      } catch { /* Missing or corrupt cache is refetched. */ }
    }
    if (this.failure?.credentialKey === "missing" && now - this.failure.atMs < TTL_MS) return this.result("unavailable", this.failure.message);
    let credentialKey = "missing";
    try {
      const credential = await (this.options.readCredential ?? readCursorUsageCredential)();
      if (!credential) {
        this.cache = null;
        return { events: [], status: { providerType: "cursor-agent", status: "unavailable", fetchedAt: null, message: "Cursor account usage needs an agent login or CURSOR_API_KEY on this host." } };
      }
      // Token refreshes preserve the account cache, while account/key changes invalidate it.
      let identity = credential.value;
      if (credential.kind === "token") {
        try {
          const sub = object(JSON.parse(Buffer.from(credential.value.split(".")[1] ?? "", "base64url").toString("utf8"))).sub;
          if (typeof sub === "string" && sub) identity = sub;
        } catch { /* The API reader reports invalid credentials without exposing them. */ }
      }
      credentialKey = hash(`${credential.kind}:${identity}`);
      if (this.cache?.credentialKey !== credentialKey) this.cache = null;
      if (this.failure?.credentialKey === credentialKey && now - this.failure.atMs < TTL_MS) return this.result(this.cache ? "cached" : "unavailable", this.failure.message);
      if (this.cache && this.cache.sinceMs <= sinceMs && now - this.cache.fetchedAtMs < TTL_MS) return this.result("fresh");
      const from = this.cache && this.cache.sinceMs <= sinceMs ? Math.max(this.cache.sinceMs, this.cache.untilMs - OVERLAP_MS) : sinceMs;
      const fetched = await fetchCursorUsageEvents(await this.options.resolveFetch(), credential, from, now);
      // Never combine history from two accounts, including a replaced API key's account.
      if (this.cache && this.cache.accountKey !== fetched.accountKey) this.cache = null;
      if (!this.cache && from > sinceMs) throw new Error("Cursor account changed. Refresh to load its full history.");
      this.cache = {
        version: 1, credentialKey, accountKey: fetched.accountKey,
        sinceMs: Math.min(this.cache?.sinceMs ?? sinceMs, sinceMs), untilMs: now, fetchedAtMs: now,
        events: [...(this.cache?.events ?? []).filter((event) => event.timestampMs < from), ...fetched.events],
      };
      this.failure = null;
      await this.persist().catch(() => undefined);
      return this.result("fresh");
    } catch (error) {
      // Network errors can contain request details; only our own fixed messages are displayed.
      const detail = error instanceof Error && /^(Cursor |Invalid Cursor |Inconsistent Cursor |Incomplete Cursor |Sign in to Cursor )/.test(error.message)
        ? error.message : "Cursor account usage could not be read. Try refreshing again.";
      this.failure = { atMs: now, credentialKey, message: detail };
      if (credentialKey === "missing") this.cache = null;
      return this.result(this.cache ? "cached" : "unavailable", detail);
    }
  }

  private result(status: UsageAccountStatus["status"], message?: string): CursorAccountUsageResult {
    return {
      events: this.cache?.events ?? [],
      status: { providerType: "cursor-agent", status, fetchedAt: this.cache ? new Date(this.cache.fetchedAtMs).toISOString() : null, ...(message ? { message } : {}) },
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.cacheFilePath), { recursive: true });
    const temp = `${this.options.cacheFilePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.cache), "utf8");
    await rename(temp, this.options.cacheFilePath);
  }
}

const validCachedEvent = (value: unknown): value is CursorAccountUsageEvent => {
  const event = object(value);
  return typeof event.modelId === "string" && event.modelId.length > 0
    && timestamp(event.timestampMs) && [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens].every(finite)
    && (event.reportedCostUsd === null || finite(event.reportedCostUsd));
};
