import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PROVIDER_CONFIG_CODEX_HOME_PATH_KEY, type LocalSessionUsageRecord, type ProviderAccountRecord, type UsageHistoryStatus } from "@buildwarden/shared";
import { initialCodexScanState, parseCodexLine } from "./codex-session-usage";
import { parseClaudeLine } from "./claude-session-usage";

type HistoryProvider = LocalSessionUsageRecord["provider"];
export interface SessionUsageRoot { provider: HistoryProvider; path: string }
export interface SessionUsageResult {
  records: LocalSessionUsageRecord[];
  histories: UsageHistoryStatus[];
}
interface CachedFile {
  root: string;
  provider: HistoryProvider;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  malformedRecords: number;
  records: LocalSessionUsageRecord[];
}
const SCAN_TTL_MS = 30_000;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const pathKey = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;

/** Only homes on this host: no linked environments, account credentials, or remote discovery. */
export const sessionUsageRoots = (
  providers: readonly Pick<ProviderAccountRecord, "providerType" | "configJson">[],
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): SessionUsageRoot[] => {
  const expand = (path: string): string => {
    const value = path.trim();
    const expanded = value === "~" ? home : /^~[/\\]/.test(value) ? join(home, value.slice(2)) : value;
    // Relative CLI homes depend on the process's cwd, so cannot be reliably scanned globally.
    return isAbsolute(expanded) ? resolve(expanded) : expanded;
  };
  const codexHomes = [env.CODEX_HOME?.trim() || join(home, ".codex")];
  for (const provider of providers) {
    if (provider.providerType !== "codex-cli") continue;
    let config: Record<string, unknown>;
    try { config = object(JSON.parse(provider.configJson)); } catch { continue; }
    const configured = config[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY];
    if (typeof configured === "string" && configured.trim()) codexHomes.push(configured);
  }
  const roots: SessionUsageRoot[] = [
    ...codexHomes.flatMap((home): SessionUsageRoot[] => [
      { provider: "codex", path: join(expand(home), "sessions") },
      { provider: "codex", path: join(expand(home), "archived_sessions") },
    ]),
    { provider: "claude", path: join(expand(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")), "projects") },
  ];
  return [...new Map(roots.map((root) => [`${root.provider}:${pathKey(root.path)}`, root])).values()];
};

const validUsageRecord = (value: unknown): value is LocalSessionUsageRecord => {
  const row = object(value);
  const totals = object(row.totals);
  return (row.provider === "codex" || row.provider === "claude") && finite(row.timestampMs) && row.timestampMs <= 8.64e15
    && typeof row.model === "string" && row.model.length > 0 && typeof row.sessionId === "string"
    && ["uncachedInputTokens", "cachedInputTokens", "cacheCreationTokens", "outputTokens", "reasoningTokens"].every((key) => finite(totals[key]))
    && (row.reportedCostUsd === null || finite(row.reportedCostUsd))
    && (row.speed === "standard" || row.speed === "fast" || row.speed === "ultrafast")
    && (row.dedupeKey === null || typeof row.dedupeKey === "string");
};

/** T3's occurrence-based cross-file dedupe retains equal real requests within one rollout. */
export const dedupeSessionUsage = (files: Iterable<readonly LocalSessionUsageRecord[]>): LocalSessionUsageRecord[] => {
  const seen = new Set<string>();
  const records: LocalSessionUsageRecord[] = [];
  for (const file of files) {
    const occurrences = new Map<string, number>();
    for (const record of file) {
      if (record.model === "<synthetic>") continue;
      let key: string | null = record.dedupeKey === null ? null : `${record.provider}:${record.dedupeKey}`;
      if (record.provider === "codex" && record.sessionId) {
        const base = JSON.stringify([record.provider, record.sessionId, record.timestampMs, record.model, record.totals]);
        const occurrence = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, occurrence);
        key = `${base}:${occurrence}`;
      }
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      records.push(record);
    }
  }
  return records;
};

const readTranscript = async (path: string, provider: HistoryProvider, size: number): Promise<Pick<CachedFile, "records" | "malformedRecords">> => {
  if (size === 0) return { records: [], malformedRecords: 0 };
  // A bounded file snapshot makes concurrent appends appear on the next scan. No conversation
  // content is retained; only usage records are cached. Changed files are parsed from the start
  // so compaction, truncation, or replacement cannot leave stale parser counters behind.
  const stream = createReadStream(path, { end: size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const state = initialCodexScanState();
  const records: LocalSessionUsageRecord[] = [];
  const seen = new Set<string>();
  try {
    for await (const line of lines) {
      const relevant = provider === "claude" ? line.includes('"usage"')
        : /"(?:token_count|token_usage_record|turn_context|thread_settings_applied|session_meta)"/.test(line);
      if (!relevant) continue;
      const parsed = provider === "claude" ? parseClaudeLine(line) : parseCodexLine(line, state);
      for (const record of parsed) {
        if (record.dedupeKey !== null) {
          if (seen.has(record.dedupeKey)) continue;
          seen.add(record.dedupeKey);
        }
        records.push(record);
      }
    }
  } finally { lines.close(); stream.destroy(); }
  return { records, malformedRecords: state.malformedRecords };
};

export class LocalSessionUsage {
  private files = new Map<string, CachedFile>();
  private diskChecked = false;
  private lastScan: { key: string; at: number; result: SessionUsageResult } | null = null;
  private inFlight: Promise<SessionUsageResult> | null = null;

  constructor(private readonly options: { cacheFilePath: string; now?: () => number }) {}

  async load(roots: readonly SessionUsageRoot[], force = false): Promise<SessionUsageResult> {
    while (this.inFlight) await this.inFlight;
    const key = JSON.stringify(roots);
    const now = (this.options.now ?? Date.now)();
    if (!force && this.lastScan?.key === key && now - this.lastScan.at < SCAN_TTL_MS) return this.lastScan.result;
    const task = this.scan(roots);
    this.inFlight = task;
    try {
      const result = await task;
      this.lastScan = { key, at: now, result };
      return result;
    } finally { if (this.inFlight === task) this.inFlight = null; }
  }

  private async scan(roots: readonly SessionUsageRoot[]): Promise<SessionUsageResult> {
    if (!this.diskChecked) { this.diskChecked = true; await this.loadCache(); }
    const activeRoots = new Set<string>();
    const ready = new Set<HistoryProvider>();
    const failed = new Set<HistoryProvider>();
    const visited = new Set<string>();
    let changed = false;
    const walk = async (directory: string, root: string, provider: HistoryProvider): Promise<boolean> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { failed.add(provider); return false; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(path, root, provider); continue; }
        // Do not follow directory/file symlinks: roots are canonicalized, traversal stays bounded.
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const key = pathKey(path);
        if (visited.has(key)) continue;
        visited.add(key);
        try {
          const info = await stat(path);
          const cached = this.files.get(key);
          if (cached?.provider === provider && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
            if (cached.root !== root) { this.files.set(key, { ...cached, root }); changed = true; }
            continue;
          }
          const parsed = await readTranscript(path, provider, info.size);
          this.files.set(key, { root, provider, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ...parsed });
          changed = true;
        } catch { failed.add(provider); }
      }
      return true;
    };
    for (const source of roots) {
      if (!isAbsolute(source.path)) { failed.add(source.provider); continue; }
      let root: string;
      try { root = pathKey(await realpath(source.path)); }
      catch (error) {
        root = pathKey(resolve(source.path));
        activeRoots.add(`${source.provider}:${root}`);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.add(source.provider);
        continue;
      }
      const identity = `${source.provider}:${root}`;
      if (activeRoots.has(identity)) continue;
      activeRoots.add(identity);
      if (await walk(root, root, source.provider)) ready.add(source.provider);
    }
    // Retain saved statistics for removed transcripts, like T3; never include disabled homes.
    const files = [...this.files.values()].filter((file) => activeRoots.has(`${file.provider}:${file.root}`));
    const histories: UsageHistoryStatus[] = [];
    for (const provider of ["codex", "claude"] as const) {
      const own = files.filter((file) => file.provider === provider);
      const providerType = provider === "codex" ? "codex-cli" : "claude-code";
      const malformed = own.reduce((sum, file) => sum + file.malformedRecords, 0);
      const usable = ready.has(provider) || own.length > 0;
      const message = !usable ? "No local session history is available. This provider is excluded from account-wide usage."
        : failed.has(provider) || !ready.has(provider) ? "Some local history could not be read. Previously cached usage is retained where available."
          : malformed > 0 ? `${malformed} inconsistent usage records were skipped.` : undefined;
      histories.push({ providerType, status: !usable ? "unavailable" : !ready.has(provider) ? "cached" : message ? "partial" : "fresh", scannedFiles: own.length, ...(message ? { message } : {}) });
    }
    if (changed) await this.persist().catch(() => undefined);
    return { records: dedupeSessionUsage(files.map((file) => file.records)), histories };
  }

  private async loadCache(): Promise<void> {
    try {
      const document = object(JSON.parse(await readFile(this.options.cacheFilePath, "utf8")));
      if (document.version !== 1) return;
      for (const [path, raw] of Object.entries(object(document.files))) {
        const file = object(raw);
        if ((file.provider !== "claude" && file.provider !== "codex") || typeof file.root !== "string"
          || ![file.size, file.mtimeMs, file.ctimeMs, file.malformedRecords].every(finite) || !Array.isArray(file.records)
          || !file.records.every((record) => validUsageRecord(record) && record.provider === file.provider)) continue;
        this.files.set(path, file as unknown as CachedFile);
      }
    } catch { /* Missing/corrupt usage caches are rebuilt from transcripts. */ }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.cacheFilePath), { recursive: true });
    const temp = `${this.options.cacheFilePath}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, files: Object.fromEntries(this.files) }), "utf8");
    await rename(temp, this.options.cacheFilePath);
  }
}
