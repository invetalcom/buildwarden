/** @vitest-environment happy-dom */

import { CODE_INTELLIGENCE_TOOL_NAMES, enabledCodeIntelligenceTools } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeIntelligenceSettingsSection } from "./settings-code-intelligence-section";

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

const render = async (onChange = vi.fn()) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<CodeIntelligenceSettingsSection settings={{}} onChange={onChange} />));
  return onChange;
};

describe("CodeIntelligenceSettingsSection", () => {
  it("renders every new operation disabled by default", async () => {
    await render();

    expect(container?.textContent).toContain("help coding agents navigate your project");
    expect(container?.textContent).toContain("leaving everything off keeps its current behavior");
    expect(container?.textContent).toContain("Finds the most likely definition when the same name appears in several places");
    expect(container?.querySelectorAll('[role="switch"]')).toHaveLength(CODE_INTELLIGENCE_TOOL_NAMES.length);
    for (const toggle of container?.querySelectorAll('[role="switch"]') ?? []) {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("can enable and disable all operations for the selected provider", async () => {
    const onChange = await render();
    const enableAll = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === "Enable all");
    await act(async () => enableAll?.click());

    const enabledSettings = onChange.mock.calls.at(-1)?.[0];
    expect(enabledCodeIntelligenceTools(enabledSettings, "ai-sdk")).toEqual(CODE_INTELLIGENCE_TOOL_NAMES);
    for (const toggle of container?.querySelectorAll('[role="switch"]') ?? []) {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    }

    const disableAll = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === "Disable all");
    await act(async () => disableAll?.click());

    const disabledSettings = onChange.mock.calls.at(-1)?.[0];
    expect(enabledCodeIntelligenceTools(disabledSettings, "ai-sdk")).toEqual([]);
  });
});
