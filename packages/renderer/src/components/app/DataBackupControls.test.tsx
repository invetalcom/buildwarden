/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DataBackupControls } from "./DataBackupControls";

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

const renderControls = async (overrides: Partial<React.ComponentProps<typeof DataBackupControls>> = {}) => {
  const props: React.ComponentProps<typeof DataBackupControls> = {
    disabled: false,
    onExport: vi.fn(async () => ({ canceled: false, filePath: "C:\\Backups\\data.bwarden" })),
    onSelectImport: vi.fn(async () => null),
    onImport: vi.fn(async () => undefined),
    ...overrides,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<DataBackupControls {...props} />));
  return props;
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes(text));

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("DataBackupControls", () => {
  it("opens the password popup and confirms the password before export", async () => {
    const onExport = vi.fn(async () => ({ canceled: false, filePath: "C:\\Backups\\data.bwarden" }));
    await renderControls({ onExport });

    await act(async () => buttonByText("Export all data")?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    const inputs = [...(container?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? [])];
    expect(inputs).toHaveLength(2);
    await act(async () => {
      setInputValue(inputs[0]!, "portable-password");
      setInputValue(inputs[1]!, "portable-password");
    });
    await act(async () => buttonByText("Choose export location")?.click());

    expect(onExport).toHaveBeenCalledWith("portable-password");
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    expect(container?.textContent).toContain("Backup exported to");
  });

  it("selects a backup before requesting its password and importing it", async () => {
    const selection = {
      filePath: "C:\\Backups\\data.bwarden",
      createdAt: "2026-09-01T08:00:00.000Z",
      appVersion: "0.6.5",
    };
    const onSelectImport = vi.fn(async () => selection);
    const onImport = vi.fn(async () => undefined);
    await renderControls({ onSelectImport, onImport });

    await act(async () => buttonByText("Import backup")?.click());
    expect(onSelectImport).toHaveBeenCalledOnce();
    expect(container?.textContent).toContain(selection.filePath);
    const passwordInput = container?.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => setInputValue(passwordInput!, "portable-password"));
    await act(async () => buttonByText("Import and restart")?.click());

    expect(onImport).toHaveBeenCalledWith({ filePath: selection.filePath, password: "portable-password" });
  });

  it("restores from welcome with the existing password popup and skips setup after import", async () => {
    const selection = {
      filePath: "C:\\Backups\\data.bwarden",
      createdAt: "2026-09-01T08:00:00.000Z",
      appVersion: "0.6.5",
    };
    const onImport = vi.fn(async () => undefined);
    const onImportComplete = vi.fn();
    await renderControls({
      presentation: "welcome",
      onSelectImport: vi.fn(async () => selection),
      onImport,
      onImportComplete,
    });

    expect(buttonByText("Export all data")).toBeUndefined();
    await act(async () => buttonByText("Restore Backup")?.click());
    const passwordInput = container?.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => setInputValue(passwordInput!, "portable-password"));
    await act(async () => buttonByText("Import and restart")?.click());

    expect(onImport).toHaveBeenCalledWith({
      filePath: selection.filePath,
      password: "portable-password",
      skipWelcome: true,
    });
    expect(onImportComplete).toHaveBeenCalledOnce();
  });
});
