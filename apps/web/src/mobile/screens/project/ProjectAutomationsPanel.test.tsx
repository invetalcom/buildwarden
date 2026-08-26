/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BuildWardenClient } from "@buildwarden/renderer";
import type { AutomationModelOption } from "@buildwarden/renderer/automation-model-effort";
import type { AppSnapshot, ProjectAutomationRecord } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { ProjectAutomationsPanel } from "./ProjectAutomationsPanel";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const clickButton = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  expect(button, `button containing ${label}`).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const automation: ProjectAutomationRecord = {
  id: "automation-1",
  projectId: "project-1",
  name: "Nightly review",
  prompt: "Review the repository",
  attachments: [],
  cronExpression: "0 1 * * *",
  timeZone: "Europe/Berlin",
  modelId: "disabled-model",
  effort: "high",
  executionOptions: { reasoningEffort: "high", serviceTier: "priority" },
  workspaceType: "worktree",
  baseBranch: "main",
  onlyIfPreviousFinished: true,
  enabled: true,
  lastScheduledAt: null,
  nextRunAt: "2026-08-27T01:00:00.000Z",
  lastError: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const project = {
  project: {
    id: "project-1",
    name: "Project",
    repoPath: "/repo",
    baseBranch: "main",
    kind: "git",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    lastOpenedAt: null,
  },
  runs: [],
  forLaterRuns: [],
  orchestratedRuns: [],
  activeRuns: [],
  recentRuns: [],
  tasks: [],
  automations: [{ automation: { ...automation, attachments: undefined, attachmentCount: 0 }, runs: [] }],
  insights: [],
  labThreads: [],
  loops: [],
} as unknown as AppSnapshot["projects"][number];

const enabledModels: AutomationModelOption[] = [{
  id: "enabled-model",
  label: "Enabled model",
  modelId: "gpt-5",
  providerType: "ai-sdk",
  providerFamily: "openai",
}];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("ProjectAutomationsPanel", () => {
  it("preserves stored model settings when an unrelated edit is saved for a disabled model", async () => {
    const updateProjectAutomation = vi.fn(async () => automation);
    const value = {
      client: {
        capabilities: { automationMutations: true },
        getProjectAutomation: vi.fn(async () => automation),
        getProjectBranches: vi.fn(async () => ["main"]),
        updateProjectAutomation,
      } as unknown as BuildWardenClient,
      snapshotStore: { loaded: true, refresh: vi.fn(async () => undefined) },
    } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <ProjectAutomationsPanel project={project} models={enabledModels} onOpenRun={vi.fn()} />
      </MobileAppProvider>,
    ));
    await clickButton(container, "Nightly review");
    await clickButton(container, "Edit");

    const nameInput = container.querySelector("input");
    expect(nameInput).toBeInstanceOf(HTMLInputElement);
    expect(container.querySelector("select")?.value).toBe("disabled-model");
    await act(async () => setInputValue(nameInput as HTMLInputElement, "Renamed review"));
    await clickButton(container, "Save automation");

    expect(updateProjectAutomation).toHaveBeenCalledWith("automation-1", expect.objectContaining({
      name: "Renamed review",
      modelId: "disabled-model",
      effort: "high",
      executionOptions: { reasoningEffort: "high", serviceTier: "priority" },
    }));
  });
});
