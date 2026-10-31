import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY } from "@buildwarden/shared";

/** Executable selection without importing the Claude Agent SDK. */
export const resolveClaudeCodeBinaryPath = (config: Record<string, unknown> | undefined): string => {
  const configured = config?.[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (process.platform === "win32") {
    const nativeInstallerPath = join(homedir(), ".local", "bin", "claude.exe");
    if (existsSync(nativeInstallerPath)) return nativeInstallerPath;
  }
  return "claude";
};

/** Release channel used by `claude update`, including CLAUDE_CONFIG_DIR overrides. */
export const readClaudeCodeReleaseChannel = (env: NodeJS.ProcessEnv = process.env, home = homedir()): "latest" | "stable" => {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  try {
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { autoUpdatesChannel?: unknown };
    return settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
};
