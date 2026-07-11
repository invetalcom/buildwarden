import type { ProviderType } from "@buildwarden/shared";

export const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> = {
  "ai-sdk": "AI SDK",
  "azure-legacy": "Azure Legacy",
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor Agent",
};
