import { PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY, PROVIDER_CONFIG_CODEX_HOME_PATH_KEY } from "@buildwarden/shared";

/** Lightweight executable configuration; importing it does not load the harness. */
export const resolveCodexCliExecutable = (config: Record<string, unknown> | undefined): { binaryPath: string; homePath?: string } => {
  const binary = config?.[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY];
  const home = config?.[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY];
  const binaryPath = typeof binary === "string" && binary.trim() ? binary.trim() : "codex";
  const homePath = typeof home === "string" && home.trim() ? home.trim() : undefined;
  return { binaryPath, ...(homePath ? { homePath } : {}) };
};
