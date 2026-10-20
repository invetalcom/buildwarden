import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeReleaseChannel } from "@buildwarden/provider-claude-code";
import { describe, expect, it } from "vitest";
import { compareProviderCliVersions, parseAttentionInboxSettings, parseProviderCliUpdateSettings, serializeProviderCliUpdateSettings } from "@buildwarden/shared";
import {
  PROVIDER_CLI_DEFINITIONS,
  formatProviderCliCommand,
  parseLatestProviderCliVersion,
  parseProviderCliVersion,
  resolveProviderCliCommandPath,
  resolveProviderCliInstallPlan,
  withExecutableDirOnPath,
  type ProviderCliInstallInput,
} from "./provider-cli-install";

const probe = (existing: string[], readOnly: string[] = []) => ({
  exists: (path: string) => existing.includes(path),
  isWritable: (path: string) => !readOnly.includes(path),
});

const plan = (input: Partial<ProviderCliInstallInput> & Pick<ProviderCliInstallInput, "commandPath">) =>
  resolveProviderCliInstallPlan({
    providerType: "claude-code",
    realPath: input.commandPath,
    platform: "linux",
    homeDir: "/home/dev",
    env: {},
    probe: probe([]),
    ...input,
  });

describe("provider CLI install plans", () => {
  it("updates an nvm npm install through that Node's npm with a pinned prefix", () => {
    const result = plan({
      commandPath: "/home/dev/.nvm/versions/node/v22.1.0/bin/claude",
      realPath: "/home/dev/.nvm/versions/node/v22.1.0/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      probe: probe(["/home/dev/.nvm/versions/node/v22.1.0/bin/npm"]),
    });
    expect(result.method).toBe("npm");
    expect(result.command).toEqual({
      file: "/home/dev/.nvm/versions/node/v22.1.0/bin/npm",
      args: ["install", "--global", "@anthropic-ai/claude-code@latest", "--prefix", "/home/dev/.nvm/versions/node/v22.1.0", "--no-fund", "--no-audit"],
    });
    expect(result.manualReason).toBeNull();
  });

  it("falls back to a sudo command for a root-owned system npm prefix", () => {
    const result = plan({
      providerType: "codex-cli",
      commandPath: "/usr/bin/codex",
      realPath: "/usr/lib/node_modules/@openai/codex/bin/codex.js",
      probe: probe(["/usr/bin/npm"], ["/usr/lib/node_modules"]),
    });
    expect(result.method).toBe("npm");
    expect(result.command).toBeNull();
    expect(result.manualReason).toContain("sudo");
    expect(result.displayCommand).toBe("sudo /usr/bin/npm install --global @openai/codex@latest --prefix /usr --no-fund --no-audit");
  });

  it("recognizes a Windows npm shim beside node_modules and uses the prefix's npm.cmd", () => {
    const prefix = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const result = plan({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      commandPath: `${prefix}\\claude.cmd`,
      probe: probe([`${prefix}\\node_modules\\@anthropic-ai\\claude-code`, `${prefix}\\npm.cmd`]),
    });
    expect(result.method).toBe("npm");
    expect(result.command?.file).toBe(`${prefix}\\npm.cmd`);
    expect(result.command?.args).toContain(prefix);
  });

  it("asks for an Administrator terminal when a Windows npm prefix is not writable", () => {
    const prefix = "C:\\Program Files\\nodejs";
    const result = plan({
      platform: "win32",
      homeDir: "C:\\Users\\dev",
      commandPath: `${prefix}\\claude.cmd`,
      probe: probe([`${prefix}\\node_modules\\@anthropic-ai\\claude-code`, `${prefix}\\npm.cmd`], [`${prefix}\\node_modules`]),
    });
    expect(result.command).toBeNull();
    expect(result.manualReason).toContain("Administrator");
    expect(result.displayCommand?.startsWith('& "C:\\Program Files\\nodejs\\npm.cmd" install')).toBe(true);
  });

  it("uses the native Claude updater for the Windows native installer", () => {
    const result = plan({ platform: "win32", homeDir: "C:\\Users\\dev", commandPath: "C:\\Users\\dev\\.local\\bin\\claude.exe" });
    expect(result.method).toBe("native");
    expect(result.command).toEqual({ file: "C:\\Users\\dev\\.local\\bin\\claude.exe", args: ["update"] });
  });

  it("uses `codex update` for the Windows standalone Codex install", () => {
    const commandPath = "C:\\Users\\dev\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const result = plan({ providerType: "codex-cli", platform: "win32", homeDir: "C:\\Users\\dev", commandPath });
    expect(result.method).toBe("native");
    expect(result.command).toEqual({ file: commandPath, args: ["update"] });
  });

  it("upgrades a Homebrew cask through the owning brew", () => {
    const result = plan({
      platform: "darwin",
      homeDir: "/Users/dev",
      commandPath: "/opt/homebrew/bin/claude",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.300/claude",
      probe: probe(["/opt/homebrew/bin/brew"]),
    });
    expect(result.method).toBe("homebrew");
    expect(result.command).toEqual({ file: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "claude-code"] });
  });

  it("keeps an unverifiable Homebrew install manual", () => {
    const result = plan({ platform: "darwin", commandPath: "/opt/homebrew/bin/codex", realPath: "/opt/homebrew/Cellar/codex/0.1.0/bin/codex", providerType: "codex-cli" });
    expect(result.command).toBeNull();
    expect(result.displayCommand).toBe("brew upgrade codex");
  });

  it.each([
    ["pnpm", "/home/dev/.local/share/pnpm/global/5/node_modules/.pnpm/@anthropic-ai+claude-code@2.1.0/node_modules/@anthropic-ai/claude-code/cli.js", ["add", "--global", "@anthropic-ai/claude-code@latest"]],
    ["bun", "/home/dev/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js", ["add", "--global", "@anthropic-ai/claude-code@latest"]],
    ["volta", "/home/dev/.volta/bin/volta-shim", ["install", "@anthropic-ai/claude-code@latest"]],
  ] as const)("uses %s when it owns the install", (method, realPath, args) => {
    const result = plan({ commandPath: "/home/dev/bin/claude", realPath });
    expect(result.method).toBe(method);
    expect(result.command?.args).toEqual(args);
  });

  it("keeps mise and winget installs manual", () => {
    expect(plan({ commandPath: "/home/dev/.local/share/mise/installs/claude/2.1.0/bin/claude" }).method).toBe("mise");
    const winget = plan({ platform: "win32", homeDir: "C:\\Users\\dev", commandPath: "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe" });
    expect(winget.method).toBe("winget");
    expect(winget.command).toBeNull();
  });

  it("falls back to the CLI's own updater when no installer is proven", () => {
    const result = plan({ providerType: "cursor-agent", commandPath: "/opt/tools/agent" });
    expect(result.method).toBe("self-updater");
    expect(result.command).toEqual({ file: "/opt/tools/agent", args: ["update"] });
  });

  it("changes the lock key when the install moves", () => {
    const before = plan({ commandPath: "/home/dev/.local/bin/claude", realPath: "/home/dev/.local/share/claude/versions/2.1.0" });
    const after = plan({ commandPath: "/home/dev/.local/bin/claude", realPath: "/home/dev/.local/share/claude/versions/2.1.1" });
    expect(before.lockKey).not.toBe(after.lockKey);
  });
});

describe("provider CLI versions", () => {
  it("parses installed versions from --version output", () => {
    expect(parseProviderCliVersion("claude-code", "2.1.302 (Claude Code)")).toBe("2.1.302");
    expect(parseProviderCliVersion("codex-cli", "codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseProviderCliVersion("cursor-agent", "2026.10.18-ea085cb\n")).toBe("2026.10.18-ea085cb");
    expect(parseProviderCliVersion("claude-code", "not installed")).toBeNull();
  });

  it("reads the latest version from npm and the Cursor installer", () => {
    expect(parseLatestProviderCliVersion("claude-code", '{"name":"@anthropic-ai/claude-code","version":"2.1.303"}')).toBe("2.1.303");
    expect(parseLatestProviderCliVersion("codex-cli", "<html>rate limited</html>")).toBeNull();
    expect(parseLatestProviderCliVersion("cursor-agent", 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.18-ea085cb/${OS}/${ARCH}/agent-cli-package.tar.gz"'))
      .toBe("2026.10.18-ea085cb");
  });
});

describe("provider CLI command lookup", () => {
  it("prefers Windows executable extensions in PATH order", () => {
    const found = resolveProviderCliCommandPath("codex", {
      platform: "win32",
      env: { Path: "C:\\tools;C:\\Users\\dev\\AppData\\Roaming\\npm" },
      homeDir: "C:\\Users\\dev",
      exists: (path) => path === "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd" || path === "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex",
    });
    expect(found).toBe("C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("searches per-user install folders missing from a desktop launch PATH", () => {
    const found = resolveProviderCliCommandPath("claude", {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      homeDir: "/Users/dev",
      exists: (path) => path === "/Users/dev/.local/bin/claude",
    });
    expect(found).toBe("/Users/dev/.local/bin/claude");
  });

  it("returns configured absolute paths only when they exist", () => {
    const options = { platform: "linux" as const, env: {}, homeDir: "/home/dev", exists: (path: string) => path === "/opt/claude" };
    expect(resolveProviderCliCommandPath("/opt/claude", options)).toBe("/opt/claude");
    expect(resolveProviderCliCommandPath("/opt/missing", options)).toBeNull();
  });

  it("puts the updater's folder first on PATH so npm finds its Node", () => {
    expect(withExecutableDirOnPath({ PATH: "/usr/bin" }, "/home/dev/.nvm/versions/node/v22/bin/npm", "linux").PATH)
      .toBe("/home/dev/.nvm/versions/node/v22/bin:/usr/bin");
    expect(withExecutableDirOnPath({ PATH: "/usr/bin" }, "npm", "linux").PATH).toBe("/usr/bin");
  });

  it("formats copyable commands for PowerShell and POSIX shells", () => {
    expect(formatProviderCliCommand({ file: "C:\\Program Files\\nodejs\\npm.cmd", args: ["install"] }, "win32")).toBe('& "C:\\Program Files\\nodejs\\npm.cmd" install');
    expect(formatProviderCliCommand({ file: "/opt/my tools/claude", args: ["update"] }, "linux")).toBe("'/opt/my tools/claude' update");
  });
});

describe("provider CLI update settings and versions", () => {
  it("keeps checks off unless explicitly enabled", () => {
    expect(parseProviderCliUpdateSettings(undefined)).toEqual({ enabled: false, notify: true });
    expect(parseProviderCliUpdateSettings("not json")).toEqual({ enabled: false, notify: true });
    expect(parseProviderCliUpdateSettings('{"enabled":"true"}').enabled).toBe(false);
    expect(parseProviderCliUpdateSettings(serializeProviderCliUpdateSettings({ enabled: true, notify: false }))).toEqual({ enabled: true, notify: false });
  });

  it("orders semver and Cursor date versions", () => {
    expect(compareProviderCliVersions("2.1.302", "2.1.303")).toBeLessThan(0);
    expect(compareProviderCliVersions("0.163.0", "0.99.9")).toBeGreaterThan(0);
    expect(compareProviderCliVersions("2.2.0-beta.1", "2.2.0")).toBeLessThan(0);
    expect(compareProviderCliVersions("2026.10.18-ea085cb", "2026.10.2-aaaaaaa")).toBeGreaterThan(0);
    expect(compareProviderCliVersions("2026.10.18-ea085cb", "2026.10.18-bbbbbbb")).toBe(0);
    expect(compareProviderCliVersions("garbage", "2.1.0")).toBe(0);
  });

  it("enables the update inbox kind by default", () => {
    expect(parseAttentionInboxSettings("{}").kinds.update).toBe(true);
    expect(parseAttentionInboxSettings('{"kinds":{"update":false}}').kinds.update).toBe(false);
  });
});

describe("provider CLI release channels", () => {
  it("installs the configured npm dist-tag", () => {
    const result = plan({
      releaseChannel: "stable",
      commandPath: "/home/dev/.nvm/versions/node/v22.1.0/bin/claude",
      realPath: "/home/dev/.nvm/versions/node/v22.1.0/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      probe: probe(["/home/dev/.nvm/versions/node/v22.1.0/bin/npm"]),
    });
    expect(result.command?.args).toContain("@anthropic-ai/claude-code@stable");
  });

  it("reads the release feed for the channel", () => {
    expect(PROVIDER_CLI_DEFINITIONS["claude-code"].latestVersionUrl("stable")).toBe("https://registry.npmjs.org/@anthropic-ai/claude-code/stable");
    expect(PROVIDER_CLI_DEFINITIONS["codex-cli"].latestVersionUrl("latest")).toBe("https://registry.npmjs.org/@openai/codex/latest");
    expect(PROVIDER_CLI_DEFINITIONS["cursor-agent"].latestVersionUrl("stable")).toBe("https://cursor.com/install");
  });

  it("follows Claude Code's autoUpdatesChannel setting", () => {
    const home = mkdtempSync(join(tmpdir(), "buildwarden-claude-channel-"));
    try {
      expect(readClaudeCodeReleaseChannel({}, home)).toBe("latest");
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
      expect(readClaudeCodeReleaseChannel({}, home)).toBe("stable");
      writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
      expect(readClaudeCodeReleaseChannel({}, home)).toBe("latest");
      const configDir = join(home, "custom-config");
      mkdirSync(configDir);
      writeFileSync(join(configDir, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
      expect(readClaudeCodeReleaseChannel({ CLAUDE_CONFIG_DIR: configDir }, join(home, "elsewhere"))).toBe("stable");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
