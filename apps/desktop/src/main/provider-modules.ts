import { flushCompileCacheSafely } from "./compile-cache";
import type { NetworkProxyRuntimeConfig, ProviderAdapter, ProviderType } from "@buildwarden/shared";

const flushedModules = new WeakSet<object>();
const cached = async <T extends object>(load: Promise<T>): Promise<T> => {
  const module = await load;
  if (!flushedModules.has(module)) {
    flushCompileCacheSafely();
    flushedModules.add(module);
  }
  return module;
};

// Explicit specifiers let Vite bundle internal packages as lazy chunks. Native
// module caching shares each import across adapter, model-discovery and utility calls.
export const loadAiSdkProvider = () => cached(import("@buildwarden/provider-ai-sdk"));
export const loadAzureLegacyProvider = () => cached(import("@buildwarden/provider-azure-legacy"));
export const loadCodexProvider = () => cached(import("@buildwarden/provider-codex-cli"));
export const loadClaudeProvider = () => cached(import("@buildwarden/provider-claude-code"));
export const loadCursorProvider = () => cached(import("@buildwarden/provider-cursor-agent"));

export const createProviderAdapter = async (providerType: ProviderType): Promise<ProviderAdapter> => {
  switch (providerType) {
    case "ai-sdk": return new (await loadAiSdkProvider()).AiSdkProviderAdapter();
    case "openrouter": return new (await loadAiSdkProvider()).OpenRouterProviderAdapter();
    case "azure-legacy": return new (await loadAzureLegacyProvider()).AzureLegacyProviderAdapter();
    case "codex-cli": return new (await loadCodexProvider()).CodexCliProviderAdapter();
    case "claude-code": return new (await loadClaudeProvider()).ClaudeCodeProviderAdapter();
    case "cursor-agent": return new (await loadCursorProvider()).CursorAgentProviderAdapter();
  }
};

export const loadProxyAwareFetch = async (proxy: NetworkProxyRuntimeConfig | undefined): Promise<typeof fetch | undefined> =>
  proxy ? (await import("@buildwarden/provider-ai-sdk/network-proxy")).createProxyAwareFetch(proxy) : undefined;
