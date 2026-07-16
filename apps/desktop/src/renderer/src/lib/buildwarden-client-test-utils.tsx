import type { DesktopApi } from "@buildwarden/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildWardenClientProvider } from "./buildwarden-client";
import {
  createElectronBuildWardenClient,
  type BuildWardenClientCapabilities,
} from "./buildwarden-client-core";

export const renderWithBuildWardenClient = (
  node: ReactNode,
  api: DesktopApi = {} as DesktopApi,
  capabilityOverrides: Partial<BuildWardenClientCapabilities> = {},
): string => {
  const electronClient = createElectronBuildWardenClient(api);
  const client = Object.freeze({
    ...electronClient,
    capabilities: Object.freeze({
      ...electronClient.capabilities,
      ...capabilityOverrides,
    }),
  });

  return renderToStaticMarkup(
    <BuildWardenClientProvider client={client}>
      {node}
    </BuildWardenClientProvider>,
  );
};
