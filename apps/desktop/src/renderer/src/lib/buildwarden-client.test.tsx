import type { AppSnapshot, DesktopApi } from "@buildwarden/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BuildWardenClientProvider,
  useBuildWardenClient,
} from "./buildwarden-client";
import {
  createElectronBuildWardenClient,
  getActiveBuildWardenClient,
  setActiveBuildWardenClient,
  type BuildWardenClientCapabilities,
} from "./buildwarden-client-core";

describe("BuildWarden client boundary", () => {
  it("adapts the preload API without changing the Electron transport", async () => {
    const getSnapshot = vi.fn(async () => ({ projects: [] }) as unknown as AppSnapshot);
    const client = createElectronBuildWardenClient({ getSnapshot } as unknown as DesktopApi);

    await client.getSnapshot();

    expect(getSnapshot).toHaveBeenCalledOnce();
    const expectedCapabilities: BuildWardenClientCapabilities = {
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
      liveEvents: true,
    };
    expect(client.capabilities).toEqual(expectedCapabilities);
  });

  it("provides the same client to React and imperative error reporting", () => {
    const client = createElectronBuildWardenClient({} as DesktopApi);
    const Probe = () => <span>{useBuildWardenClient().capabilities.platform}</span>;

    setActiveBuildWardenClient(client);
    const markup = renderToStaticMarkup(
      <BuildWardenClientProvider client={client}>
        <Probe />
      </BuildWardenClientProvider>,
    );

    expect(markup).toContain("electron");
    expect(getActiveBuildWardenClient()).toBe(client);
  });
});
