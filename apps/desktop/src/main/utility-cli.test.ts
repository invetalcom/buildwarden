import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTextGenerationProcessLaunch, runTextGenerationProcess } from "@buildwarden/agent-runtime";
import { generateUtilityTextWithCodexCli } from "@buildwarden/provider-codex-cli";
import { generateUtilityTextWithCursorAgent } from "@buildwarden/provider-cursor-agent";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const path = relative(tmpdir(), directory);
    if (!path || isAbsolute(path) || path.startsWith("..")) throw new Error("Unsafe fixture cleanup path.");
    rmSync(directory, { recursive: true, force: true });
  }
});

const makeFakeCli = () => {
  const cwd = mkdtempSync(join(tmpdir(), "buildwarden utility test "));
  directories.push(cwd);
  const script = join(cwd, "cli.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => prompt += value);
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      const schemaIndex = args.indexOf('--output-schema');
      const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : null;
      if (schemaPath) fs.writeFileSync(require('node:path').join(require('node:path').dirname(schemaPath), 'extra.tmp'), 'temporary CLI output');
      const capture = { prompt, args, schemaPath, home: process.env.CODEX_HOME,
        schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null };
      fs.writeFileSync('capture.json', JSON.stringify(capture));
      if (prompt === 'hang') { setInterval(() => {}, 1000); return; }
      if (prompt === 'fail') { process.stderr.write('provider rejected the request'); process.exit(3); }
      if (prompt === 'empty-output') return;
      if (prompt === 'invalid-json') { console.log('Please log in before continuing.'); return; }
      if (prompt === 'noise') console.log('An update is available.');
      if (args.includes('exec')) {
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fix login' } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 70, output_tokens: 3, cached_input_tokens: 10 } }));
      } else {
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fix login', usage: { input_tokens: 70, output_tokens: 3 } }));
      }
    });
  `);
  const binary = join(cwd, process.platform === "win32" ? "agent.cmd" : "agent");
  writeFileSync(binary, process.platform === "win32"
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { cwd, binary, capture: () => JSON.parse(readFileSync(join(cwd, "capture.json"), "utf8")) };
};

describe("CLI utility generation", () => {
  it("runs Codex exec with a stdin prompt, ephemeral read-only settings and schema cleanup", async () => {
    const fixture = makeFakeCli();
    const prompt = "Unicode: Grüß dich. Shell text: & | %PATH% $(example) `example`\nSecond line";
    const result = await generateUtilityTextWithCodexCli({
      cwd: fixture.cwd, prompt, modelId: "test-model",
      config: { codexBinaryPath: fixture.binary, codexHomePath: fixture.cwd },
      modelConfig: { codexReasoningEffort: "low" },
      outputSchema: { type: "object", properties: { title: { type: "string" } } },
    });
    expect(result.text).toBe("Fix login");
    expect(result.usage).toMatchObject({ inputTokens: 70, outputTokens: 3, cachedInputTokens: 10 });
    const captured = fixture.capture();
    expect(captured.prompt).toBe(prompt);
    expect(captured.home).toBe(fixture.cwd);
    expect(captured.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--json", "read-only", "never"]));
    expect(captured.args).not.toContain("app-server");
    expect(captured.schema.type).toBe("object");
    expect(existsSync(captured.schemaPath)).toBe(false);
    expect(existsSync(dirname(captured.schemaPath))).toBe(false);
  });

  it("runs Cursor print in ask mode without enabling writes or resuming a session", async () => {
    const fixture = makeFakeCli();
    const result = await generateUtilityTextWithCursorAgent({
      cwd: fixture.cwd, prompt: "Generate a branch", modelId: "test-model",
      config: { cursorBinaryPath: fixture.binary },
    });
    expect(result).toMatchObject({ text: "Fix login", usage: { inputTokens: 70, outputTokens: 3 } });
    expect(fixture.capture().args).toEqual(["--print", "--mode", "ask", "--trust", "--output-format", "json", "--model", "test-model"]);
  });

  it("reports process errors and removes the Codex schema after failure", async () => {
    const fixture = makeFakeCli();
    await expect(generateUtilityTextWithCodexCli({
      cwd: fixture.cwd, prompt: "fail", modelId: "test-model", config: { codexBinaryPath: fixture.binary },
      outputSchema: { type: "object" },
    })).rejects.toThrow("provider rejected");
    expect(existsSync(fixture.capture().schemaPath)).toBe(false);
  });

  it("ignores Codex stdout notices when completed JSON events follow", async () => {
    const fixture = makeFakeCli();
    const result = await generateUtilityTextWithCodexCli({
      cwd: fixture.cwd, prompt: "noise", modelId: "test-model", config: { codexBinaryPath: fixture.binary },
    });
    expect(result).toMatchObject({ text: "Fix login", usage: { inputTokens: 70, outputTokens: 3 } });
  });

  it.each(["empty-output", "invalid-json"])("reports provider-specific errors for %s", async (prompt) => {
    const fixture = makeFakeCli();
    await expect(generateUtilityTextWithCodexCli({
      cwd: fixture.cwd, prompt, modelId: "test-model", config: { codexBinaryPath: fixture.binary },
    })).rejects.toThrow("Codex text generation returned no completed answer.");
    await expect(generateUtilityTextWithCursorAgent({
      cwd: fixture.cwd, prompt, modelId: "test-model", config: { cursorBinaryPath: fixture.binary },
    })).rejects.toThrow("Cursor text generation returned output that is not valid JSON.");
  });

  it("terminates a hung child at its deadline", async () => {
    const fixture = makeFakeCli();
    await expect(generateUtilityTextWithCursorAgent({
      cwd: fixture.cwd, prompt: "hang", modelId: "test-model", config: { cursorBinaryPath: fixture.binary }, timeoutMs: 300,
    })).rejects.toThrow("timed out");
  });

  it("does not launch an already cancelled request", async () => {
    const fixture = makeFakeCli();
    const signal = AbortSignal.abort();
    expect(signal.reason).toMatchObject({ name: "AbortError" });
    await expect(runTextGenerationProcess({
      ...resolveTextGenerationProcessLaunch(fixture.binary, []),
      cwd: fixture.cwd, prompt: "test", signal,
    })).rejects.toBe(signal.reason);
    expect(existsSync(join(fixture.cwd, "capture.json"))).toBe(false);
  });

  it("cancels a running request and closes its child process", async () => {
    const fixture = makeFakeCli();
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 300);
    try {
      await expect(generateUtilityTextWithCursorAgent({
        cwd: fixture.cwd, prompt: "hang", modelId: "test-model", config: { cursorBinaryPath: fixture.binary },
        signal: controller.signal,
      })).rejects.toThrow("cancelled");
    } finally {
      clearTimeout(abort);
    }
  });

  it("rejects shell metacharacters in Windows shim arguments", () => {
    expect(() => resolveTextGenerationProcessLaunch("codex.cmd", ["--model", "bad&echo injected"], "win32")).toThrow("metacharacters");
    expect(resolveTextGenerationProcessLaunch("C:\\Program Files\\codex.exe", ["exec"], "win32"))
      .toEqual({ command: "C:\\Program Files\\codex.exe", args: ["exec"] });
  });
});
