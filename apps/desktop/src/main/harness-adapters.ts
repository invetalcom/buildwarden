import { loadAcpProvider, loadAiSdkProvider, loadAzureLegacyProvider, loadCodexProvider, loadClaudeProvider, loadCursorProvider } from "./provider-modules";
import type {
  HarnessAdapter,
  HarnessType,
  ProviderType,
  RunUserInputAnswers,
  RunUserInputRequest,
  ApprovalRequester,
} from "@buildwarden/shared";

export interface HarnessAdapterOptions {
  requestShellApproval?: ApprovalRequester;
  requestUserInput?: (request: RunUserInputRequest) => Promise<RunUserInputAnswers>;
}

export const getHarnessTypeForProvider = (providerType: ProviderType): HarnessType => {
  switch (providerType) {
    case "codex-cli":
      return "codex-app-server";
    case "claude-code":
      return "claude-code";
    case "cursor-agent":
      return "cursor-acp";
    case "acp":
      return "acp";
    case "azure-legacy":
      return "azure-legacy";
    case "ai-sdk":
    case "openrouter":
      return "ai-sdk";
  }
};

export const createHarnessAdapter = async (providerType: ProviderType, options: HarnessAdapterOptions = {}): Promise<HarnessAdapter> => {
  switch (providerType) {
    case "codex-cli":
      return new (await loadCodexProvider()).CodexCliHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "claude-code":
      return new (await loadClaudeProvider()).ClaudeCodeHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "cursor-agent":
      return new (await loadCursorProvider()).CursorAgentHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "acp":
      return new (await loadAcpProvider()).AcpHarnessAdapter(options.requestShellApproval);
    case "azure-legacy":
      return new (await loadAzureLegacyProvider()).AzureLegacyHarnessAdapter();
    case "ai-sdk":
    case "openrouter":
      return new (await loadAiSdkProvider()).AiSdkHarnessAdapter(options.requestUserInput);
  }
};
