import type { DesktopApi } from "@buildwarden/shared";

export interface BuildWardenClientCapabilities {
  platform: "electron" | "web";
  nativeTitleBar: boolean;
  nativeAppMenu: boolean;
  directoryPicker: boolean;
  ideIntegration: boolean;
  fileManager: boolean;
  systemTerminal: boolean;
  embeddedTerminal: boolean;
  settings: boolean;
  mutations: boolean;
  runMutations: boolean;
  chatMutations: boolean;
  approvalResponses: boolean;
  gitMutations: boolean;
  projectCreation: boolean;
  hostDirectoryBrowser: boolean;
  liveEvents: boolean;
}

export interface BuildWardenClient extends DesktopApi {
  readonly capabilities: Readonly<BuildWardenClientCapabilities>;
}

const ELECTRON_CAPABILITIES: Readonly<BuildWardenClientCapabilities> = Object.freeze({
  platform: "electron",
  nativeTitleBar: true,
  nativeAppMenu: true,
  directoryPicker: true,
  ideIntegration: true,
  fileManager: true,
  systemTerminal: true,
  embeddedTerminal: true,
  settings: true,
  mutations: true,
  runMutations: true,
  chatMutations: true,
  approvalResponses: true,
  gitMutations: true,
  projectCreation: true,
  hostDirectoryBrowser: false,
  liveEvents: true,
});

export const createElectronBuildWardenClient = (api: DesktopApi): BuildWardenClient =>
  Object.freeze({
    ...api,
    capabilities: ELECTRON_CAPABILITIES,
  });

let activeBuildWardenClient: BuildWardenClient | null = null;

export const setActiveBuildWardenClient = (client: BuildWardenClient | null): void => {
  activeBuildWardenClient = client;
};

export const getActiveBuildWardenClient = (): BuildWardenClient | null => activeBuildWardenClient;
