import { AiSdkHarnessAdapter } from "@buildwarden/provider-ai-sdk";
import { ClaudeCodeHarnessAdapter } from "@buildwarden/provider-claude-code";
import { CodexCliHarnessAdapter } from "@buildwarden/provider-codex-cli";
import { CursorAgentHarnessAdapter } from "@buildwarden/provider-cursor-agent";
import { AzureLegacyHarnessAdapter } from "@buildwarden/provider-azure-legacy";
import type {
  HarnessAdapter,
  HarnessType,
  ProviderType,
  RunUserInputAnswers,
  RunUserInputRequest,
  ShellApprovalDecision,
} from "@buildwarden/shared";

export interface HarnessAdapterOptions {
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
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
    case "azure-legacy":
      return "azure-legacy";
    case "ai-sdk":
      return "ai-sdk";
  }
};

export const createHarnessAdapter = (providerType: ProviderType, options: HarnessAdapterOptions = {}): HarnessAdapter => {
  switch (providerType) {
    case "codex-cli":
      return new CodexCliHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "claude-code":
      return new ClaudeCodeHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "cursor-agent":
      return new CursorAgentHarnessAdapter(options.requestShellApproval, options.requestUserInput);
    case "azure-legacy":
      return new AzureLegacyHarnessAdapter();
    case "ai-sdk":
      return new AiSdkHarnessAdapter();
  }
};
