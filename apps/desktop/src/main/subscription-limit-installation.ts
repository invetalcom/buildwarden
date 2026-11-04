import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY, PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY, PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY, type ProviderAccountRecord } from "@buildwarden/shared";
import { resolveClaudeCodeBinaryPath } from "@buildwarden/provider-claude-code/configuration";
import { resolveCodexCliExecutable } from "@buildwarden/provider-codex-cli/configuration";
import { getCursorAgentBinaryPath } from "@buildwarden/provider-cursor-agent/configuration";
import { resolveProviderCliCommandPath } from "./provider-cli-install";
import { subscriptionTargets } from "./subscription-limit-providers";

/** Local executable discovery only: no authentication, network calls, or CLI processes. */
export function installedSubscriptionTargets(providers: readonly ProviderAccountRecord[], exists = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}) {
  return subscriptionTargets(providers, (target) => {
    const key = target.providerType === "codex-cli" ? PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY
      : target.providerType === "claude-code" ? PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY : PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY;
    const configured = target.config[key];
    let binary = target.providerType === "codex-cli" ? resolveCodexCliExecutable(target.config).binaryPath
      : target.providerType === "claude-code" ? resolveClaudeCodeBinaryPath(target.config) : getCursorAgentBinaryPath(target.config);
    if (/^~[/\\]/.test(binary)) binary = join(homedir(), binary.slice(2));
    const options = { platform: process.platform, env: process.env, homeDir: homedir(), exists };
    const path = resolveProviderCliCommandPath(binary, options)
      ?? (target.providerType === "cursor-agent" && !configured ? resolveProviderCliCommandPath("cursor-agent", options) : null);
    if (!path) return null;
    return { ...target, config: { ...target.config, [key]: path }, key: target.key };
  });
}
