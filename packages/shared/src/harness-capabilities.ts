import type { ProviderType } from "./index";

/** Implemented integration behavior, not capabilities inferred from a model name. */
export interface HarnessCapabilities {
  liveSteering: boolean;
  nativeSessionResume: boolean;
  replayRunHistory: boolean;
  instructionChannel: "developer" | "system" | "prompt";
  projectMcp: "native-http" | "unsupported";
  toolTransport: "dynamic-tools" | "sdk-mcp" | "http-mcp" | "function-tools";
}

const apiCapabilities: HarnessCapabilities = {
  liveSteering: false, nativeSessionResume: false, replayRunHistory: true,
  instructionChannel: "system", projectMcp: "unsupported", toolTransport: "function-tools",
};

const capabilities: Record<ProviderType, Readonly<HarnessCapabilities>> = {
  "ai-sdk": apiCapabilities,
  openrouter: apiCapabilities,
  "azure-legacy": { ...apiCapabilities, replayRunHistory: false },
  "codex-cli": {
    liveSteering: true, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "developer", projectMcp: "native-http", toolTransport: "dynamic-tools",
  },
  "claude-code": {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "system", projectMcp: "native-http", toolTransport: "sdk-mcp",
  },
  "cursor-agent": {
    liveSteering: false, nativeSessionResume: true, replayRunHistory: false,
    instructionChannel: "prompt", projectMcp: "native-http", toolTransport: "http-mcp",
  },
};

export const getHarnessCapabilities = (providerType: ProviderType): Readonly<HarnessCapabilities> => capabilities[providerType];

/** Application-owned delivery and session availability are separate from adapter support. */
export const resolveHarnessDelivery = (providerType: ProviderType, state: { running: boolean; resumable: boolean }) => {
  const support = getHarnessCapabilities(providerType);
  return {
    liveSteering: {
      supported: support.liveSteering,
      available: support.liveSteering && state.running,
      reason: !support.liveSteering ? "This integration does not implement live steering." : !state.running ? "No turn is running." : null,
    },
    queuedDelivery: { supported: true, available: true },
    interruptAndResume: {
      supported: support.nativeSessionResume || support.replayRunHistory,
      available: state.running && (support.replayRunHistory || (support.nativeSessionResume && state.resumable)),
    },
  };
};
