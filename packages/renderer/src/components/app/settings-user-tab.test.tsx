/** @vitest-environment happy-dom */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAttentionInboxSettings, DEFAULT_KEYBOARD_SHORTCUTS, getDesignSchemePreset } from "@buildwarden/shared";
import { UserSettingsTab } from "./settings-user-tab";

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

describe("UserSettingsTab", () => {
  it("contains visually hidden controls within positioned parents", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const onAttentionChange = vi.fn();
    const TestSettings = () => {
      const [attention, setAttention] = useState(parseAttentionInboxSettings);
      return (
      <UserSettingsTab
        busy={false}
        designScheme={getDesignSchemePreset("midnight-blue")!}
        sidebarContrastStrength={0}
        sidebarRunEntrySize="medium"
        sidebarGroupRunsByProject={false}
        attentionInboxSettings={attention}
        onAttentionInboxSettingsChange={(next) => { onAttentionChange(next); setAttention(next); }}
        recentRunDaysDraft="10"
        recentRunDaysInvalid={false}
        recentRunDaysMin={1}
        recentRunDaysMax={90}
        recentRunDaysDefault={10}
        enableDevMode={false}
        appLogDirPath=""
        appLogDirectorySize={{ totalBytes: 0, fileCount: 0, unreadableEntryCount: 0 }}
        ideDraft={{}}
        idePathsDirty={false}
        idePathsSaving={false}
        keyboardShortcuts={DEFAULT_KEYBOARD_SHORTCUTS}
        onDesignSchemeChange={vi.fn()}
        onSidebarContrastStrengthChange={vi.fn()}
        onSidebarContrastStrengthCommit={vi.fn()}
        onSidebarRunEntrySizeChange={vi.fn()}
        onSidebarGroupRunsByProjectChange={vi.fn()}
        onRecentRunDaysDraftChange={vi.fn()}
        onEnableDevModeChange={vi.fn()}
        onKeyboardShortcutChange={vi.fn()}
        onOpenAppLogDirectory={vi.fn()}
        onExportDataBackup={vi.fn(async () => ({ canceled: true }))}
        onSelectDataBackupForImport={vi.fn(async () => null)}
        onImportDataBackup={vi.fn()}
        onResetDatabase={vi.fn()}
        onIdeDraftChange={vi.fn()}
        onSaveIdePaths={vi.fn()}
        onResetIdeDraft={vi.fn()}
        onPickIdeExecutable={vi.fn()}
        nativeActions={false}
      />
      );
    };
    await act(async () => root?.render(<TestSettings />));

    const hiddenInputs = [...container.querySelectorAll<HTMLInputElement>("input.sr-only")];
    expect(hiddenInputs).toHaveLength(4);
    expect(hiddenInputs.every((input) => input.parentElement?.classList.contains("relative"))).toBe(true);
    const sections = [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(sections.indexOf("Attention inbox")).toBe(sections.indexOf("Sidebar") + 1);
    const question = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Question"]')!;
    await act(async () => question.click());
    expect(onAttentionChange.mock.lastCall?.[0].kinds.input).toBe(false);
    expect(onAttentionChange.mock.lastCall?.[0].kinds.approval).toBe(true);
    const master = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable attention inbox"]')!;
    await act(async () => master.click());
    expect(onAttentionChange.mock.lastCall?.[0].enabled).toBe(false);
    expect(question.disabled).toBe(true);
    await act(async () => master.click());
    expect(question.disabled).toBe(false);
    expect(question.getAttribute("aria-checked")).toBe("false");
  });
});
