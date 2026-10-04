/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { APP_SETTING_KEYS, type AppSnapshot, type ProjectSnapshot, type WorkspaceSetupProfile } from "@buildwarden/shared";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const profile: WorkspaceSetupProfile = { id: "setup", name: "Web setup", dependencies: "isolated", submodules: "none", environmentFiles: [], commands: ["pnpm install"], previewCommand: "pnpm dev", previewUrl: "http://localhost:3000" };
const project = { project: { id: "p", kind: "git", name: "Project", baseBranch: "main", repoPath: "/repo" } } as ProjectSnapshot;
const setupSettings = { p: { activeProfileId: "setup", profiles: [profile] }, other: { activeProfileId: "other", profiles: [{ ...profile, id: "other" }] } };
const snapshot = { projects: [project], models: [], providerAccounts: [], settings: { [APP_SETTING_KEYS.workspaceSetupProfiles]: JSON.stringify(setupSettings) } } as unknown as AppSnapshot;
const render = async (admin: boolean) => {
  const getSnapshot = vi.fn(async () => snapshot);
  const setAppSetting = vi.fn<BuildWardenClient["setAppSetting"]>(async () => undefined);
  const client = {
    capabilities: { platform: "web", settings: admin, projectSettingsMutations: admin, projectCreation: admin },
    getSnapshot, setAppSetting, getProjectBranches: async () => ["main"], listIntegratedSkills: async () => [],
  } as unknown as BuildWardenClient;
  const value = { client, snapshot, snapshotStore: { refresh: vi.fn(async () => undefined) }, router: {} } as unknown as MobileAppValue;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<MobileAppProvider value={value}><ProjectSettingsPanel project={project} /></MobileAppProvider>));
  return { getSnapshot, setAppSetting };
};

describe("browser project workspace setup profiles", () => {
  it("loads and saves host profiles without a desktop client provider and preserves other projects", async () => {
    const { setAppSetting } = await render(true);
    const section = container.querySelector('[aria-label="Workspace setup profiles"]')!;
    expect(section.textContent).toContain("Web setup");
    expect(section.querySelector("textarea")?.value).toBe("pnpm install");
    await act(async () => [...section.querySelectorAll("button")].find((button) => button.textContent === "Add profile")?.click());
    await act(async () => [...section.querySelectorAll("button")].find((button) => button.textContent === "Save profiles")?.click());
    expect(setAppSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.workspaceSetupProfiles, expect.any(String));
    const stored = JSON.parse(setAppSetting.mock.calls[0]![1]) as typeof setupSettings;
    expect(stored.p.profiles).toHaveLength(2);
    expect(stored.other).toEqual(setupSettings.other);
  });
  it("shows the missing admin permission instead of hiding the setting or exposing write controls", async () => {
    const { getSnapshot, setAppSetting } = await render(false);
    const section = container.querySelector('[aria-label="Workspace setup profiles"]')!;
    expect(section.textContent).toContain("admin scope");
    expect(section.querySelectorAll("button, input, textarea")).toHaveLength(0);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(setAppSetting).not.toHaveBeenCalled();
  });
});
