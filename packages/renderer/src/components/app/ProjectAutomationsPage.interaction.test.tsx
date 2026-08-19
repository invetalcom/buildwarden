/** @vitest-environment happy-dom */

import type {
  DesktopApi,
  ProjectAutomationListItem,
  ProjectAutomationRecord,
} from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProjectAutomationsPage } from "./ProjectAutomationsPage";

const existingAutomation: ProjectAutomationRecord = {
  id: "automation-1",
  projectId: "project-1",
  name: "Existing automation",
  prompt: "Review the project",
  attachments: [],
  cronExpression: "0 9 * * *",
  timeZone: "UTC",
  modelId: "model-1",
  effort: "high",
  executionOptions: { reasoningEffort: "high" },
  workspaceType: "worktree",
  onlyIfPreviousFinished: true,
  enabled: true,
  lastScheduledAt: null,
  nextRunAt: "2026-08-20T09:00:00.000Z",
  lastError: null,
  createdAt: "2026-08-19T09:00:00.000Z",
  updatedAt: "2026-08-19T09:00:00.000Z",
};

const automationItem = (): ProjectAutomationListItem => {
  const { attachments, ...automation } = existingAutomation;
  return { automation: { ...automation, attachmentCount: attachments.length }, runs: [] };
};

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

describe("project automations create flow", () => {
  it("creates a second automation instead of updating the selected one", async () => {
    const createdAutomation = { ...existingAutomation, id: "automation-2", name: "" };
    const createProjectAutomation = vi.fn(async () => createdAutomation);
    const updateProjectAutomation = vi.fn(async () => existingAutomation);
    const api = {
      createProjectAutomation,
      updateProjectAutomation,
    } as unknown as DesktopApi;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={[automationItem()]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5.6",
            modelId: "gpt-5.6-sol",
            providerType: "codex-cli",
            providerFamily: null,
            executionProfile: {
              controls: [{
                id: "reasoningEffort",
                label: "Effort",
                defaultValue: "auto",
                options: [{ value: "auto", label: "Provider default" }, { value: "high", label: "High" }],
              }],
            },
          }]}
          defaultModelId="model-1"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    await act(async () => button("New automation")?.click());
    await act(async () => button("Save automation")?.click());

    expect(createProjectAutomation).toHaveBeenCalledOnce();
    expect(createProjectAutomation).toHaveBeenCalledWith("project-1", expect.objectContaining({ modelId: "model-1" }));
    expect(updateProjectAutomation).not.toHaveBeenCalled();
  });

  it("pauses a saved automation without deleting it", async () => {
    const updateProjectAutomation = vi.fn(async () => ({ ...existingAutomation, enabled: false }));
    const api = { updateProjectAutomation } as unknown as DesktopApi;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={[automationItem()]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5.6",
            modelId: "gpt-5.6-sol",
            providerType: "codex-cli",
            providerFamily: null,
          }]}
          defaultModelId="model-1"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const pause = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Pause schedule");
    await act(async () => pause?.click());

    expect(updateProjectAutomation).toHaveBeenCalledOnce();
    expect(updateProjectAutomation).toHaveBeenCalledWith("automation-1", { enabled: false });
  });
});
