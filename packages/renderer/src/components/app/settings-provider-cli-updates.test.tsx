/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_SETTING_KEYS,
  createDisabledProviderCliUpdateSnapshot,
  type DesktopApi,
  type ProviderCliUpdateSnapshot,
  type ProviderCliUpdateStatus,
} from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient, type BuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProviderCliUpdatesSettings } from "./settings-provider-cli-updates";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const claude: ProviderCliUpdateStatus = {
  providerType: "claude-code", label: "Claude Code", binaryPath: "/home/dev/.local/bin/claude",
  installedVersion: "2.1.302", latestVersion: "2.1.303", releaseChannel: "latest", state: "update-available", installMethod: "native",
  updateCommand: "/home/dev/.local/bin/claude update", canAutoUpdate: true, manualReason: null, inUse: false,
  dismissed: false, announced: true, message: null, checkedAt: "2026-10-19T08:00:00Z",
};

const render = async (
  initial: ProviderCliUpdateSnapshot,
  platform: BuildWardenClient["capabilities"]["platform"] = "electron",
  settings = true,
) => {
  let current = initial;
  const getProviderCliUpdates = vi.fn(async () => current);
  const setAppSetting = vi.fn(async (_key: string, value: string) => {
    const parsed = JSON.parse(value) as { enabled: boolean; notify: boolean };
    current = { ...current, ...parsed, providers: parsed.enabled ? current.providers : [] };
  });
  const runProviderCliUpdate = vi.fn(async () => ({ ...current, providers: [{ ...claude, state: "current" as const, installedVersion: "2.1.303" }] }));
  const checkProviderCliUpdates = vi.fn(async () => current);
  const base = createElectronBuildWardenClient({
    getProviderCliUpdates, setAppSetting, runProviderCliUpdate, checkProviderCliUpdates,
    onProviderCliUpdatesChanged: () => () => {},
  } as unknown as DesktopApi);
  const client = { ...base, capabilities: { ...base.capabilities, platform, settings } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<BuildWardenClientProvider client={client}><ProviderCliUpdatesSettings /></BuildWardenClientProvider>));
  return { getProviderCliUpdates, setAppSetting, runProviderCliUpdate, checkProviderCliUpdates };
};

const checkbox = (label: string) =>
  [...container.querySelectorAll("label")].find((entry) => entry.textContent?.includes(label))!.querySelector("input")!;
const button = (text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));

describe("provider CLI update settings", () => {
  it("is off by default and only shows provider rows once enabled", async () => {
    const { setAppSetting, checkProviderCliUpdates } = await render(createDisabledProviderCliUpdateSnapshot());
    expect(container.textContent).toContain("Off");
    expect(checkbox("Check for updates").checked).toBe(false);
    expect(button("Check now")).toBeUndefined();
    await act(async () => checkbox("Check for updates").click());
    expect(setAppSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.providerCliUpdates, '{"enabled":true,"notify":true}');
    expect(checkProviderCliUpdates).not.toHaveBeenCalled();
    expect(button("Check now")).toBeDefined();
  });

  it("updates a provider and reflects the verified version", async () => {
    const { runProviderCliUpdate } = await render({ enabled: true, notify: true, checking: false, lastCheckedAt: claude.checkedAt, providers: [claude] });
    expect(container.textContent).toContain("v2.1.302 → v2.1.303");
    await act(async () => button("Update")!.click());
    expect(runProviderCliUpdate).toHaveBeenCalledWith("claude-code");
    expect(container.textContent).toContain("Up to date");
  });

  it("labels non-default release channels", async () => {
    await render({ enabled: true, notify: true, checking: false, lastCheckedAt: null, providers: [
      { ...claude, releaseChannel: "stable", latestVersion: "2.1.292", installedVersion: "2.1.290" },
    ] });
    expect(container.textContent).toContain("stable channel");
    expect(container.textContent).toContain("v2.1.290 → v2.1.292");
  });

  it("explains manual-only installs and blocks updates while the CLI is in use", async () => {
    await render({
      enabled: true, notify: true, checking: false, lastCheckedAt: null, providers: [
        { ...claude, providerType: "codex-cli", label: "Codex CLI", canAutoUpdate: false, manualReason: "Run the command with sudo in a terminal." },
        { ...claude, inUse: true },
      ],
    });
    expect(container.textContent).toContain("Run the command with sudo in a terminal.");
    expect(container.textContent).toContain("In use by an active run or chat.");
    const updates = [...container.querySelectorAll("button")].filter((entry) => entry.textContent === "Update");
    expect(updates).toHaveLength(1);
    expect(updates[0].disabled).toBe(true);
  });

  it("is available to web sessions with settings access and explains that updates run on the host", async () => {
    await render({ enabled: true, notify: true, checking: false, lastCheckedAt: null, providers: [claude] }, "web");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("run on the BuildWarden host computer");
  });

  it("is hidden for remote sessions without settings access", async () => {
    await render(createDisabledProviderCliUpdateSnapshot(), "web", false);
    expect(container.textContent).toBe("");
  });

  it("shows host errors without the Electron IPC prefix", async () => {
    const { runProviderCliUpdate } = await render({ enabled: true, notify: true, checking: false, lastCheckedAt: null, providers: [claude] });
    runProviderCliUpdate.mockRejectedValueOnce(new Error("Error invoking remote method 'buildwarden:run-provider-cli-update': Error: Claude Code update failed: EACCES"));
    await act(async () => button("Update")!.click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Claude Code update failed: EACCES");
  });
});
