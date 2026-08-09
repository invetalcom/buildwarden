/** @vitest-environment happy-dom */

import type { DesktopApi } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./lib/buildwarden-client-core";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("App startup failure", () => {
  it("releases the retention gate when the initial snapshot cannot load", async () => {
    const capabilities = createElectronBuildWardenClient({} as DesktopApi).capabilities;
    const refreshSnapshot = vi.fn(async () => {
      throw new Error("Snapshot unavailable");
    });
    const client = new Proxy({ capabilities, refreshSnapshot } as unknown as BuildWardenClient, {
      get: (target, property) => {
        if (property in target) return Reflect.get(target, property);
        if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
        if (property === "listIntegratedSkills") return async () => [];
        if (property === "getDetectedCodexInstallation") return async () => ({ binaryPath: null });
        if (property === "getDetectedClaudeInstallation") return async () => ({ binaryPath: null });
        if (property === "getDetectedCursorInstallation") return async () => ({ binaryPath: null, message: null });
        if (property === "getAppPaths") {
          return async () => ({ logDirPath: "", logDirectorySize: { fileCount: 0, totalBytes: 0 } });
        }
        return vi.fn(async () => undefined);
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <BuildWardenClientProvider client={client}>
          <App />
        </BuildWardenClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Checking saved data"));

    expect(refreshSnapshot).toHaveBeenCalledOnce();
    expect(container?.textContent).toContain("Select project");
  });
});
