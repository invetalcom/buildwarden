/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_SETTING_KEYS, sessionTitle, type DesktopApi } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { SessionTitleActions } from "./SessionTitleActions";
import { SessionTitleSettings } from "./SessionTitleSettings";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
const render = async (node: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(node));
};
const session = { id: "run-1", title: "Login redirects", prompt: "Original long request", titleGenerationEnabled: true };

describe("conversation title controls", () => {
  it("hides controls when disabled or read-only and keeps prompt fallback compatibility", async () => {
    const client = createElectronBuildWardenClient({} as DesktopApi);
    await render(<BuildWardenClientProvider client={client}><SessionTitleActions kind="run" session={{ ...session, titleGenerationEnabled: false }} /></BuildWardenClientProvider>);
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.render(<BuildWardenClientProvider client={{ ...client, capabilities: { ...client.capabilities, runMutations: false } }}>
      <SessionTitleActions kind="run" session={session} />
    </BuildWardenClientProvider>));
    expect(container.querySelector("button")).toBeNull();
    expect(sessionTitle({ prompt: "Legacy prompt" })).toBe("Legacy prompt");
    expect(sessionTitle(session)).toBe("Login redirects");
  });

  it("renames the selected run and can regenerate it from the same dialog", async () => {
    const renameRunTitle = vi.fn().mockResolvedValue(undefined);
    const regenerateRunTitle = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const client = createElectronBuildWardenClient({ renameRunTitle, regenerateRunTitle } as unknown as DesktopApi);
    await render(<BuildWardenClientProvider client={client}><SessionTitleActions kind="run" session={session} onClose={onClose} /></BuildWardenClientProvider>);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    expect(input.value).toBe("Login redirects");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Fix redirect loops");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(renameRunTitle).toHaveBeenCalledWith("run-1", "Fix redirect loops");
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const regenerate = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Regenerate title"))!;
    await act(async () => regenerate.click());
    expect(regenerateRunTitle).toHaveBeenCalledWith("run-1");
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("allows manual naming while generation runs, but prevents duplicate regeneration", async () => {
    const client = createElectronBuildWardenClient({} as DesktopApi);
    await render(<BuildWardenClientProvider client={client}><SessionTitleActions kind="chat" session={{ ...session, titleGenerationPending: true }} /></BuildWardenClientProvider>);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled).toBe(false);
    const generating = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.includes("Generating"))!;
    expect(generating.disabled).toBe(true);
  });

  it("persists the feature toggle and hides title options when disabled", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    await render(<SessionTitleSettings enabled modelId="" instructions="" models={[]} onChange={onChange} />);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(onChange).toHaveBeenCalledWith(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
    await act(async () => root.render(<SessionTitleSettings enabled={false} modelId="" instructions="" models={[]} onChange={onChange} />));
    expect(container.querySelector("details")).toBeNull();
  });
});
