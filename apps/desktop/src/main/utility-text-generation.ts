import { loadAiSdkProvider, loadAzureLegacyProvider, loadCodexProvider, loadClaudeProvider, loadCursorProvider } from "./provider-modules";
import type { NetworkProxyRuntimeConfig, ProviderType, RunTokenUsage } from "@buildwarden/shared";
import { normalizeJsonResponse } from "./json-response";

export type UtilityTextPurpose = "commit-message" | "branch-name" | "pull-request-draft";

const PULL_REQUEST_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    commitMessage: { type: ["string", "null"] },
  },
  required: ["title", "description", "commitMessage"],
  additionalProperties: false,
};

export const validateUtilityText = (text: string, purpose: UtilityTextPurpose): string => {
  if (!text.trim()) throw new Error("The model returned an empty answer.");
  if (purpose !== "pull-request-draft") return text.trim();
  const parsed: unknown = JSON.parse(normalizeJsonResponse(text));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model did not return a pull request draft object.");
  }
  const draft = parsed as Record<string, unknown>;
  if (
    typeof draft.title !== "string" || !draft.title.trim() ||
    typeof draft.description !== "string" || !draft.description.trim() ||
    !(typeof draft.commitMessage === "string" || draft.commitMessage == null)
  ) throw new Error("The model returned an invalid pull request draft.");
  // Older providers may omit this optional content; preserve the existing title fallback.
  return JSON.stringify({
    title: draft.title,
    description: draft.description,
    commitMessage: draft.commitMessage ?? null,
  });
};

export interface UtilityTextInput {
  purpose: UtilityTextPurpose;
  cwd: string;
  providerType: ProviderType;
  modelId: string;
  apiKey: string;
  apiBaseUrl?: string | null;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  networkProxy?: NetworkProxyRuntimeConfig;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
  devLogging?: { logDirPath: string; runId?: string };
}

/** These calls produce text only; they never create or resume a BuildWarden run. */
export const generateUtilityText = async (input: UtilityTextInput): Promise<{ text: string; usage: RunTokenUsage }> => {
  const outputSchema = input.purpose === "pull-request-draft" ? PULL_REQUEST_DRAFT_SCHEMA : undefined;
  const systemPrompt = [
    input.systemPrompt,
    "Use only the supplied context. Do not execute commands, change files, create commits, or publish anything.",
    ...(outputSchema ? [`Return JSON matching this schema: ${JSON.stringify(outputSchema)}`] : []),
  ].join("\n");
  const options = { ...input, systemPrompt, outputSchema, timeoutMs: 180_000 };
  const cliOptions = { ...options, prompt: `${systemPrompt}\n\n${input.prompt}` };
  switch (input.providerType) {
    case "codex-cli": return (await loadCodexProvider()).generateUtilityTextWithCodexCli(cliOptions);
    case "claude-code": return (await loadClaudeProvider()).generateUtilityTextWithClaudeCode(cliOptions);
    case "cursor-agent": return (await loadCursorProvider()).generateUtilityTextWithCursorAgent(cliOptions);
    case "azure-legacy": return (await loadAzureLegacyProvider()).generateUtilityTextWithAzureLegacy({ ...options, apiBaseUrl: input.apiBaseUrl });
    case "ai-sdk":
    case "openrouter": return (await loadAiSdkProvider()).generateUtilityTextWithAiSdk({ ...options, providerType: input.providerType });
  }
};
