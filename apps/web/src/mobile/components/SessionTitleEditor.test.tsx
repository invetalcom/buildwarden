/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { APP_SETTING_KEYS, type ModelRecord } from "@buildwarden/shared";
import { MobileAppProvider, type MobileAppValue } from "../data/mobile-app-context";
import { useAppSettings } from "../data/use-app-settings";
import { SessionTitleSettingsRows } from "../screens/settings/SessionTitleSettingsRows";
import { useSessionTitleEditor } from "../data/use-session-title-editor";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const session = { id: "conversation-1", title: "Login redirects", prompt: "Fix the login redirects", titleGenerationEnabled: true, titleGenerationPending: false };
const saved = vi.fn(async () => undefined);
const Editor = ({ kind = "run", enabled = true, pending = false }: { kind?: "run" | "chat"; enabled?: boolean; pending?: boolean }) => {
  const editor = useSessionTitleEditor(kind, { ...session, titleGenerationEnabled: enabled, titleGenerationPending: pending }, saved);
  return <>{editor.actions.map((action) => <button key={action.label} onClick={action.onSelect}>{action.label}</button>)}{editor.sheet}</>;
};
const titleModel: ModelRecord = { id: "title-model", displayName: "Fast model", enabled: 1, providerAccountId: "provider", modelId: "fast",
  baseUrlOverride: null, configJson: "{}", capabilitiesJson: "{}", createdAt: "2026-11-08", updatedAt: "2026-11-08" };
const Settings = () => <SessionTitleSettingsRows settings={useAppSettings()} models={[titleModel]} />;
const client = () => ({
  capabilities: { runMutations: true, chatMutations: true, settings: true },
  renameRunTitle: vi.fn(async () => undefined), regenerateRunTitle: vi.fn(async () => undefined),
  renameChatTitle: vi.fn(async () => undefined), regenerateChatTitle: vi.fn(async () => undefined),
  setAppSetting: vi.fn(async () => undefined),
});
const render = async (node: ReactNode, api = client(), settings: Record<string, string> = {}) => {
  const refresh = vi.fn(async () => undefined);
  const value = { client: api as unknown as BuildWardenClient, snapshot: { settings }, snapshotStore: { refresh } } as unknown as MobileAppValue;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<MobileAppProvider value={value}>{node}</MobileAppProvider>));
  return { api, refresh };
};
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text)!;
const tap = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };
const type = async (value: string) => {
  const input = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("mobile title controls", () => {
  it.each(["run", "chat"] as const)("renames and regenerates a %s from a mobile sheet", async (kind) => {
    const { api } = await render(<Editor kind={kind} />);
    await tap(button("Rename or regenerate title"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector("input")?.value).toBe(session.title);
    await type("  Repair   login redirects  ");
    await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(kind === "run" ? api.renameRunTitle : api.renameChatTitle).toHaveBeenCalledWith(session.id, "Repair login redirects");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await tap(button("Rename or regenerate title"));
    await tap(button("Regenerate title"));
    expect(kind === "run" ? api.regenerateRunTitle : api.regenerateChatTitle).toHaveBeenCalledWith(session.id);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["disabled", "read-only"])("hides title actions when %s", async (mode) => {
    const api = client();
    api.capabilities.runMutations = mode !== "read-only";
    await render(<Editor enabled={mode !== "disabled"} />, api);
    expect(container.querySelector("button")).toBeNull();
  });

  it("allows manual rename during automatic generation and keeps failures visible", async () => {
    const api = client();
    api.renameRunTitle.mockRejectedValueOnce(new Error("Host offline"));
    await render(<Editor pending />, api);
    await tap(button("Rename or regenerate title"));
    expect(button("Generating…").disabled).toBe(true);
    expect(button("Save").disabled).toBe(false);
    await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Host offline");
  });

  it("defaults on and saves toggle, model, and instructions through host settings", async () => {
    const { api, refresh } = await render(<Settings />);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await tap(toggle);
    expect(api.setAppSetting).toHaveBeenLastCalledWith(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "title-model";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.setAppSetting).toHaveBeenLastCalledWith(APP_SETTING_KEYS.sessionTitleModelId, "title-model");
    await type("Use German titles.");
    await tap(button("Save"));
    expect(api.setAppSetting).toHaveBeenLastCalledWith(APP_SETTING_KEYS.sessionTitleInstructions, "Use German titles.");
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("hides options when disabled and prevents settings changes without admin access", async () => {
    const api = client(); api.capabilities.settings = false;
    await render(<Settings />, api, { [APP_SETTING_KEYS.sessionTitlesEnabled]: "false" });
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  });
});
