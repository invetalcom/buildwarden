import type { DesktopApi } from "@buildwarden/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./lib/buildwarden-client-core";

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

beforeAll(() => {
  const buildwarden = new Proxy({} as DesktopApi, {
    get: () => vi.fn(),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { buildwarden },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "BuildWarden test" },
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
});

describe("App initial render", () => {
  it("renders the startup retention gate before the preload snapshot arrives", () => {
    const client = createElectronBuildWardenClient((window as unknown as { buildwarden: DesktopApi }).buildwarden);
    const markup = renderToStaticMarkup(
      <BuildWardenClientProvider client={client}>
        <App />
      </BuildWardenClientProvider>,
    );
    expect(markup).toContain("Checking saved data");
    expect(markup).not.toContain("Select project");
  });

  it("renders the main shell when the startup gate does not apply", () => {
    const electronClient = createElectronBuildWardenClient(
      (window as unknown as { buildwarden: DesktopApi }).buildwarden,
    );
    const webClient = {
      ...electronClient,
      capabilities: { ...electronClient.capabilities, platform: "web" },
    } as BuildWardenClient;
    const markup = renderToStaticMarkup(
      <BuildWardenClientProvider client={webClient}>
        <App />
      </BuildWardenClientProvider>,
    );

    expect(markup).toContain("Select project");
    expect(markup).not.toContain("Checking saved data");
  });
});
