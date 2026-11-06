/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SETTING_KEYS, type DesktopApi } from "@buildwarden/shared";
import { TerminalSettingsRow } from "./TerminalSettingsRow";

const mocks = vi.hoisted(() => ({
  get: vi.fn<DesktopApi["getTerminalSettings"]>(),
  set: vi.fn<DesktopApi["setAppSetting"]>(),
}));
vi.mock("../../lib/buildwarden-client", () => {
  const client = { getTerminalSettings: mocks.get, setAppSetting: mocks.set, capabilities: { settings: true } };
  return { useOptionalBuildWardenClient: () => client };
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ defaultShell: "auto", shells: ["auto", "bash", "zsh", "sh"] });
});

describe("default terminal shell setting", () => {
  it("shows host shell choices in the shared dropdown and saves the preference", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<TerminalSettingsRow />));
      expect(container.querySelector('[role="combobox"]')?.textContent).toContain("System default");
      await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["System default", "bash", "zsh", "sh"]);
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "zsh")!.click());
      expect(mocks.set).toHaveBeenCalledExactlyOnceWith(APP_SETTING_KEYS.terminalDefaultShell, "zsh");
      expect(container.querySelector('[role="combobox"]')?.textContent).toContain("zsh");
    } finally { await act(async () => root.unmount()); }
  });

  it("keeps the previous selection and reports a failed save", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    mocks.set.mockRejectedValue(new Error("Unable to save"));
    try {
      await act(async () => root.render(<TerminalSettingsRow />));
      await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === "bash")!.click());
      expect(container.querySelector('[role="combobox"]')?.textContent).toContain("System default");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to save");
    } finally { await act(async () => root.unmount()); }
  });
});
