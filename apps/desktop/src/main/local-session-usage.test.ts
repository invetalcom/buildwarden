import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionUsage, dedupeSessionUsage, sessionUsageRoots, type SessionUsageRoot } from "./local-session-usage";
import { parseClaudeLine } from "./claude-session-usage";

const tempDirs: string[] = [];
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "buildwarden-history-"));
  tempDirs.push(home);
  const roots = sessionUsageRoots([], {}, home);
  const cacheFilePath = join(home, "usage-cache.json");
  const service = new LocalSessionUsage({ cacheFilePath });
  return { home, roots, cacheFilePath, service };
};
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const write = (path: string, text: string) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, text); };
const time = "2026-10-30T12:00:00.000Z";
const claude = (id = "msg-1", extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", timestamp: time, sessionId: "claude-1", requestId: `req-${id}`,
  message: { id, model: "claude-sonnet-4-5", content: [{ type: "text", text: "private answer" }], usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 20 } }, ...extra,
});
const codexCount = (input: number, output: number, totalInput = input, totalOutput = output) => JSON.stringify({
  type: "event_msg", timestamp: time, payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: input, output_tokens: output }, total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput },
  } },
});
const codex = (id = "codex-1", counts = [codexCount(100, 20)]) => [
  JSON.stringify({ type: "session_meta", timestamp: time, payload: { id, model_provider: "openai" } }),
  JSON.stringify({ type: "turn_context", timestamp: time, payload: { model: "gpt-5", turn_id: "turn-1" } }),
  JSON.stringify({ type: "response_item", payload: { content: "private user prompt" } }),
  ...counts,
].join("\n") + "\n";

describe("local transcript discovery", () => {
  it("uses host environment homes and configured Codex homes without duplicate roots", () => {
    const home = resolve("fixture-home");
    const custom = join(home, "custom-codex");
    const roots = sessionUsageRoots([
      { providerType: "codex-cli", configJson: JSON.stringify({ codexHomePath: custom }) },
      { providerType: "codex-cli", configJson: JSON.stringify({ codexHomePath: "~/custom-codex" }) },
    ], { CODEX_HOME: custom, CLAUDE_CONFIG_DIR: join(home, "custom-claude") }, home);
    expect(roots).toEqual([
      { provider: "codex", path: join(custom, "sessions") },
      { provider: "codex", path: join(custom, "archived_sessions") },
      { provider: "claude", path: join(home, "custom-claude", "projects") },
    ]);
  });

  it("finds nested sessions, archives and Claude subagents, retaining only usage metadata", async () => {
    const f = fixture();
    write(join(f.roots[0]!.path, "2026", "10", "30", "session.jsonl"), codex());
    write(join(f.roots[1]!.path, "archived.jsonl"), codex("archived"));
    write(join(f.roots[2]!.path, "project", "session.jsonl"), `${claude()}\n${claude()}\n`);
    write(join(f.roots[2]!.path, "project", "session", "subagents", "agent.jsonl"), `${claude("advisor")}\n`);
    const result = await f.service.load(f.roots);
    expect(result.records).toHaveLength(4);
    expect(result.histories.every((history) => history.status === "fresh")).toBe(true);
    expect(result.histories.every((history) => history.status === "fresh")).toBe(true);
    const cached = readFileSync(f.cacheFilePath, "utf8");
    expect(cached).not.toContain("private answer");
    expect(cached).not.toContain("private user prompt");
    expect(cached).not.toContain('"content"');
  });

  it("deduplicates moved rollouts without deleting equal legitimate requests within a file", async () => {
    const f = fixture();
    const text = codex("shared", [codexCount(100, 20), codexCount(100, 20, 200, 40)]);
    write(join(f.roots[0]!.path, "a.jsonl"), text);
    write(join(f.roots[1]!.path, "b.jsonl"), text);
    const result = await f.service.load(f.roots);
    expect(result.records).toHaveLength(2);
    expect(result.records.reduce((sum, record) => sum + record.totals.outputTokens, 0)).toBe(40);
  });

  it("refreshes appends and partial JSON tails without adding old counts again", async () => {
    const f = fixture();
    const path = join(f.roots[0]!.path, "a.jsonl");
    const second = codexCount(50, 10, 150, 30);
    write(path, codex() + second.slice(0, 40));
    expect((await f.service.load(f.roots)).records).toHaveLength(1);
    appendFileSync(path, second.slice(40) + "\n");
    // An explicit dashboard refresh scans growing files even inside the normal scan interval.
    const refreshed = await f.service.load(f.roots, true);
    expect(refreshed.records).toHaveLength(2);
    expect(refreshed.records.reduce((sum, record) => sum + record.totals.outputTokens, 0)).toBe(30);
  });

  it("reparses rewritten and truncated files and persists refreshed statistics", async () => {
    const f = fixture();
    const path = join(f.roots[0]!.path, "a.jsonl");
    write(path, codex());
    await f.service.load(f.roots);
    writeFileSync(path, codex("codex-1", [codexCount(40, 8)]));
    expect((await f.service.load(f.roots, true)).records[0]?.totals.outputTokens).toBe(8);
    const relaunch = new LocalSessionUsage({ cacheFilePath: f.cacheFilePath });
    expect((await relaunch.load(f.roots)).records[0]?.totals.outputTokens).toBe(8);
    writeFileSync(path, "");
    expect((await f.service.load(f.roots, true)).records).toHaveLength(0);
  });

  it("retains history when logs are removed or archived, including across restarts", async () => {
    const f = fixture();
    const path = join(f.roots[0]!.path, "a.jsonl");
    write(path, codex());
    await f.service.load(f.roots);
    mkdirSync(f.roots[1]!.path, { recursive: true });
    const archive = join(f.roots[1]!.path, "a.jsonl");
    renameSync(path, archive);
    expect((await f.service.load(f.roots, true)).records).toHaveLength(1);
    rmSync(archive);
    expect((await new LocalSessionUsage({ cacheFilePath: f.cacheFilePath }).load(f.roots)).records).toHaveLength(1);
    expect((await f.service.load([], true)).records).toHaveLength(0);
  });

  it("reports unavailable history without a ledger fallback, and keeps providers independent", async () => {
    const f = fixture();
    const missing = await f.service.load(f.roots);
    expect(missing.records).toEqual([]);
    expect(missing.histories.every((history) => history.status === "unavailable")).toBe(true);
    write(join(f.roots[2]!.path, "claude.jsonl"), claude());
    const next = await f.service.load(f.roots, true);
    expect(next.histories.find((history) => history.providerType === "claude-code")?.status).toBe("fresh");
    expect(next.records).toHaveLength(1);
  });

  it("keeps cached usage when an entire root becomes unavailable", async () => {
    const f = fixture();
    write(join(f.roots[0]!.path, "a.jsonl"), codex());
    await f.service.load(f.roots);
    rmSync(f.roots[0]!.path, { recursive: true });
    const cached = await f.service.load(f.roots, true);
    expect(cached.records).toHaveLength(1);
    expect(cached.histories[0]?.status).toBe("cached");
  });

  it("does not scan relative configuration paths or count an unreadable root as complete", async () => {
    const f = fixture();
    const notADirectory = join(f.home, "file");
    writeFileSync(notADirectory, "");
    const roots: SessionUsageRoot[] = [{ provider: "codex", path: "relative/sessions" }, { provider: "claude", path: notADirectory }];
    const result = await f.service.load(roots);
    expect(result.records).toEqual([]);
    expect(result.histories.every((history) => history.status === "unavailable")).toBe(true);
  });

  it("ignores corrupt cache entries and rebuilds them from the original transcript", async () => {
    const f = fixture();
    write(join(f.roots[0]!.path, "a.jsonl"), codex());
    writeFileSync(f.cacheFilePath, '{"version":1,"files":{"bad":{"provider":"codex","records":[null]}}}');
    expect((await f.service.load(f.roots)).records).toHaveLength(1);
  });
});

describe("Claude message dedupe", () => {
  it("deduplicates content blocks and copied sessions while retaining distinct requests", () => {
    const first = parseClaudeLine(claude());
    const second = parseClaudeLine(claude("msg-2"));
    expect(dedupeSessionUsage([[...first, ...first, ...second], first])).toHaveLength(2);
  });
});
