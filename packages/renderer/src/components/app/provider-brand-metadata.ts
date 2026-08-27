import type { HarnessType } from "@buildwarden/shared";

export type ProviderBrandKey = HarnessType | "openrouter";

export const PROVIDER_BRAND_LABELS: Readonly<Record<ProviderBrandKey, string>> = {
  "claude-code": "Claude Code",
  "codex-app-server": "Codex CLI",
  "cursor-acp": "Cursor Agent",
  "ai-sdk": "AI SDK",
  openrouter: "OpenRouter",
  "azure-legacy": "Azure Legacy",
};
