import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { AcpHarnessAdapter } from "@buildwarden/provider-acp";
import type { RunExecutionRequest } from "@buildwarden/shared";

// Replay over real stdio: response IDs are rebound, while method order and payloads are preserved.
const REPLAYER = String.raw`
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const exchanges = JSON.parse(readFileSync(process.env.REPLAY_FIXTURE, 'utf8')).exchanges;
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message})+'\n');
const pending = new Map();
createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  appendFileSync(process.env.REPLAY_LOG, JSON.stringify(message)+'\n');
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
  if (!message.method || message.id === undefined) return;
  const exchange = exchanges.shift();
  if (exchange?.method !== message.method) { send({id:message.id,error:{code:-32601,message:'Unexpected method '+message.method}}); return; }
  if (exchange.request) {
    const answer = new Promise(resolve => pending.set('permission',resolve));
    send({id:'permission', ...exchange.request}); await answer;
  }
  for (const update of exchange.updates ?? []) send({method:'session/update',params:{sessionId:'fresh',update}});
  send({id:message.id, ...(exchange.error ? {error:exchange.error} : {result:exchange.result})});
});`;

it("replays failed ACP resume, fresh config, inspect permission, and restored context through the real transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-protocol-replay-"));
  try {
    const script = join(root, "replay.mjs");
    const log = join(root, "messages.jsonl");
    writeFileSync(script, REPLAYER);
    const fixture = join(__dirname, "__fixtures__/provider-protocol/acp-resume.json");
    const input: RunExecutionRequest = {
      runId: "replay", worktreePath: root, providerType: "acp", modelId: "default", apiKey: "", mode: "ask", requireReadOnly: true,
      prompt: "Continue", resumeFallbackContext: "Earlier requirement: retain audit logs.",
      providerSessionRuntime: { resumeCursor: { sessionId: "expired" } } as unknown as RunExecutionRequest["providerSessionRuntime"],
      config: { acpCommand: `"${process.execPath}" "${script}"`, acpEnv: `REPLAY_FIXTURE=${fixture}\nREPLAY_LOG=${log}` },
    };
    const result = await new AcpHarnessAdapter().run(input, { tools: [], executeTool: vi.fn() }, () => undefined, new AbortController().signal);
    expect(result.summary).toBe("Read-only review complete.");
    const messages = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(JSON.stringify(messages.find((message) => message.method === "session/prompt"))).toContain("retain audit logs");
    expect(messages.find((message) => message.id === "permission")).toMatchObject({ result: { outcome: { optionId: "deny" } } });
    expect(messages.map((message) => message.method).filter(Boolean)).toEqual(["initialize", "session/load", "session/new", "session/prompt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
