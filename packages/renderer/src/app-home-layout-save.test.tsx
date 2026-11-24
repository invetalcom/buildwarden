/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { APP_SETTING_KEYS, DEFAULT_HOME_LAYOUT, serializeHomeLayout, type DesktopApi, type HomeLayout } from "@buildwarden/shared";
import { App } from "./App";
import { EMPTY_SNAPSHOT } from "./components/app/app-model";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "./lib/buildwarden-client-core";

type HomeProps = { onLayoutChange?: (layout: HomeLayout) => void | Promise<void> };

const view = vi.hoisted(() => ({ current: null as HomeProps | null }));
vi.mock("./components/app/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/app/LandingPage", () => ({ LandingPage: (props: HomeProps) => {
  view.current = props;
  return null;
} }));

/** The props the app last gave the Home page. */
const home = (): HomeProps | null => view.current;

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  view.current = null;
  const refreshSnapshot = vi.fn(async () => EMPTY_SNAPSHOT);
  const setAppSetting = vi.fn<DesktopApi["setAppSetting"]>(async () => undefined);
  const base = createElectronBuildWardenClient({} as DesktopApi).capabilities;
  const client = new Proxy({ capabilities: { ...base, platform: "web" }, refreshSnapshot, setAppSetting } as unknown as BuildWardenClient, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
      if (property === "listIntegratedSkills" || property === "getAttentionInbox") return async () => [];
      if (property === "getDetectedCodexInstallation" || property === "getDetectedClaudeInstallation" || property === "getDetectedCursorInstallation") return async () => ({ binaryPath: null });
      if (property === "getAppPaths") return async () => ({ logDirPath: "", logDirectorySize: { fileCount: 0, totalBytes: 0 } });
      return vi.fn(async () => undefined);
    },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<BuildWardenClientProvider client={client}><App /></BuildWardenClientProvider>));
  expect(home()?.onLayoutChange).toBeTypeOf("function");
  return { container, refreshSnapshot, setAppSetting, cleanup: async () => { await act(async () => root.unmount()); } };
}

/** Saves a layout from the Home page and reports whether the save was rejected. */
const save = async (layout: HomeLayout) => {
  let outcome: "saved" | Error = "saved";
  await act(async () => {
    await Promise.resolve(home()!.onLayoutChange!(layout)).catch((error: Error) => { outcome = error; });
  });
  return outcome as "saved" | Error;
};

describe("saving the Home layout", () => {
  const layout: HomeLayout = { ...DEFAULT_HOME_LAYOUT, position: "top" };

  it("counts as saved when only the refresh after it fails, and reports that failure", async () => {
    const h = await mount();
    try {
      h.refreshSnapshot.mockRejectedValueOnce(new Error("Refresh unavailable"));
      expect(await save(layout)).toBe("saved");
      expect(h.setAppSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.homeLayout, serializeHomeLayout(layout));
      expect(h.container.textContent).toContain("Refresh unavailable");
    } finally { await h.cleanup(); }
  });

  it("rejects when the write itself fails, and does not refresh", async () => {
    const h = await mount();
    try {
      const failure = new Error("Disk full");
      h.setAppSetting.mockRejectedValueOnce(failure);
      h.refreshSnapshot.mockClear();
      expect(await save(layout)).toBe(failure);
      expect(h.refreshSnapshot).not.toHaveBeenCalled();
      expect(h.container.textContent).toContain("Disk full");
    } finally { await h.cleanup(); }
  });
});
