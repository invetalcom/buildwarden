import type { DesktopApi } from "@buildwarden/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildWardenClientProvider } from "./buildwarden-client";
import { createElectronBuildWardenClient } from "./buildwarden-client-core";

export const renderWithBuildWardenClient = (
  node: ReactNode,
  api: DesktopApi = {} as DesktopApi,
): string => renderToStaticMarkup(
  <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
    {node}
  </BuildWardenClientProvider>,
);
