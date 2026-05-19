import { AiSdkHarnessAdapter } from "@easycode/provider-ai-sdk";
import { ClaudeCodeHarnessAdapter } from "@easycode/provider-claude-code";
import { CodexCliHarnessAdapter } from "@easycode/provider-codex-cli";
import { AzureLegacyHarnessAdapter } from "@easycode/provider-azure-legacy";
import type { HarnessAdapter, HarnessType, ProviderType, ShellApprovalDecision } from "@easycode/shared";

export interface HarnessAdapterOptions {
  requestShellApproval?: (command: string) => Promise<ShellApprovalDecision>;
}

export const getHarnessTypeForProvider = (providerType: ProviderType): HarnessType => {
  switch (providerType) {
    case "codex-cli":
      return "codex-app-server";
    case "claude-code":
      return "claude-code";
    case "azure-legacy":
      return "azure-legacy";
    case "ai-sdk":
      return "ai-sdk";
  }
};

export const createHarnessAdapter = (providerType: ProviderType, options: HarnessAdapterOptions = {}): HarnessAdapter => {
  switch (providerType) {
    case "codex-cli":
      return new CodexCliHarnessAdapter(options.requestShellApproval);
    case "claude-code":
      return new ClaudeCodeHarnessAdapter(options.requestShellApproval);
    case "azure-legacy":
      return new AzureLegacyHarnessAdapter();
    case "ai-sdk":
      return new AiSdkHarnessAdapter();
  }
};
