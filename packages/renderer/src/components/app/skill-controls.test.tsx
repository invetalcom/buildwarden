/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_SETTING_KEYS, type DesktopApi, type IntegratedSkillMetadata, type SkillSessionSnapshot } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { SkillControls, type SkillControlsProps } from "./skill-controls";
import { SkillImportForm } from "./skill-import-form";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; vi.restoreAllMocks(); });
const skill: IntegratedSkillMetadata = { id: "local:example:123", source: "local", category: "custom", name: "example", title: "Example", description: "Workflow", license: null, relativeDir: "", sourceUrl: "" };
const snapshot: SkillSessionSnapshot = { version: 1, createdAt: "2026-01-01", overrideIds: [skill.id], selectedIds: [skill.id], packages: [], explicitIds: [], loadedIds: [skill.id], diagnostics: [{ skillId: skill.id, status: "loaded" }] };
const createClient = () => {
  const setSessionSkills = vi.fn(async () => {});
  const getSessionSkills = vi.fn(async () => snapshot);
  const importSkill = vi.fn(async () => skill);
  const client = createElectronBuildWardenClient({
    listIntegratedSkills: async () => [skill, { ...skill, id: "disabled", title: "Disabled" }],
    getSnapshot: async () => ({ settings: { [APP_SETTING_KEYS.projectActiveSkills]: JSON.stringify({ project: [skill.id] }), [APP_SETTING_KEYS.integratedSkillsDisabled]: '["disabled"]' } }),
    getSessionSkills, setSessionSkills, importSkill,
    onRunEvent: () => () => {}, onChatEvent: () => () => {},
  } as unknown as DesktopApi);
  return { client, setSessionSkills, getSessionSkills, importSkill };
};
const render = async (props: Partial<SkillControlsProps> = {}) => {
  const fixture = createClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const onMention = vi.fn(); const onSelectionChange = vi.fn();
  await act(() => root!.render(<BuildWardenClientProvider client={fixture.client}><SkillControls projectId="project" onMention={onMention} onSelectionChange={onSelectionChange} {...props} /></BuildWardenClientProvider>));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  return { ...fixture, onMention, onSelectionChange };
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;

describe("skill controls", () => {
  it("shows project defaults, excludes globally disabled skills, and inserts an explicit invocation", async () => {
    const { onMention } = await render();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Select Example"]')?.checked).toBe(true);
    expect(document.querySelector('input[aria-label="Select Disabled"]')).toBeNull();
    await act(() => button("Use now").click());
    expect(onMention).toHaveBeenCalledWith(`$skill(${skill.id})`);
  });

  it("submits an empty override instead of changing project defaults", async () => {
    const { onSelectionChange } = await render();
    await act(() => button("Select none").click());
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("shows loaded diagnostics and resets a persisted session override", async () => {
    const { setSessionSkills } = await render({ session: { kind: "run", id: "run-1" } });
    expect(document.body.textContent).toContain("1 loaded");
    expect(document.body.textContent).toContain(`${skill.id}: loaded`);
    await act(async () => button("Use project defaults").click());
    expect(setSessionSkills).toHaveBeenCalledWith("run", "run-1", null);
  });

  it("allows inspecting skills while preventing active-turn selection changes", async () => {
    await render({ disabled: true });
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Select Example"]')?.disabled).toBe(true);
    expect(button("Use now").disabled).toBe(true);
    expect(button("Select none").disabled).toBe(true);
  });

  it("imports a local folder through the client and invalidates the catalog", async () => {
    const { client, importSkill } = createClient();
    const changed = vi.fn(); window.addEventListener("buildwarden-skills-changed", changed);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(() => root!.render(<BuildWardenClientProvider client={client}><SkillImportForm /></BuildWardenClientProvider>));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Skill source location"]')!;
    await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "C:/skills/example"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("Import skill").click());
    expect(importSkill).toHaveBeenCalledWith({ source: "local", path: "C:/skills/example" });
    expect(changed).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Imported Example");
    window.removeEventListener("buildwarden-skills-changed", changed);
  });
});
