/** @vitest-environment happy-dom */

import type { DesktopApi, ProjectTaskRecord, ProjectTaskSummary } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProjectTasksTab } from "./ProjectTasksTab";

const inProgressTask: ProjectTaskRecord = {
  id: "task-2",
  projectId: "project-1",
  title: "Improve runtime",
  prompt: "Reduce startup time",
  attachments: [{ fileName: "design.png", mimeType: "image/png", dataBase64: "AA==" }],
  status: "in_progress",
  runId: "run-2",
  pullRequestUrl: null,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const toTaskSummary = ({ attachments, ...task }: ProjectTaskRecord): ProjectTaskSummary => ({
  ...task,
  attachmentCount: attachments.length,
});
const inProgressTaskSummary = toTaskSummary(inProgressTask);

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

describe("project task run actions", () => {
  it("opens a linked run without exposing Edit for a non-open task", async () => {
    const onOpenRun = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient({ getProjectTask: vi.fn(async () => inProgressTask) } as unknown as DesktopApi)}>
        <ProjectTasksTab
          projectId="project-1"
          tasks={[inProgressTaskSummary]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5",
            modelId: "gpt-5",
            providerType: "ai-sdk",
            providerFamily: "openai",
          }]}
          defaultTaskModelId="model-1"
          busy={false}
          onCreateTask={vi.fn()}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onStartTask={vi.fn()}
          onOpenRun={onOpenRun}
        />
      </BuildWardenClientProvider>,
    ));

    await act(async () => container?.querySelector<HTMLButtonElement>('[aria-label="View Improve runtime"]')?.click());

    const taskDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="view-task-title"]');
    const dialogButtons = [...(taskDialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    expect(dialogButtons.some((button) => button.textContent?.trim() === "Edit")).toBe(false);
    expect(taskDialog?.textContent).toContain("design.png");

    await act(async () => dialogButtons.find((button) => button.textContent?.trim() === "Open run")?.click());
    expect(onOpenRun).toHaveBeenCalledOnce();
    expect(onOpenRun).toHaveBeenCalledWith("run-2");
  });

  it("keeps the latest launch when an earlier full-prompt lookup finishes last", async () => {
    const openTask = (id: string, title: string): ProjectTaskRecord => ({
      ...inProgressTask, id, title, prompt: `Full prompt for ${title}`, attachments: [], status: "open", runId: null,
    });
    const first = openTask("task-a", "First task");
    const second = openTask("task-b", "Second task");
    const lookups = new Map<string, (task: ProjectTaskRecord) => void>();
    const getProjectTask = vi.fn((taskId: string) => new Promise<ProjectTaskRecord>((resolve) => lookups.set(taskId, resolve)));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient({ getProjectTask } as unknown as DesktopApi)}>
        <ProjectTasksTab
          projectId="project-1"
          tasks={[first, second].map((task) => ({ ...toTaskSummary(task), prompt: "Preview", promptTruncated: true }))}
          modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
          defaultTaskModelId="model-1"
          busy={false}
          onCreateTask={vi.fn()}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onStartTask={vi.fn()}
          onOpenRun={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const startButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Start run");
    expect(startButtons).toHaveLength(2);
    await act(async () => startButtons[0]?.click());
    await act(async () => startButtons[1]?.click());
    await act(async () => lookups.get("task-b")?.(second));
    await act(async () => lookups.get("task-a")?.(first));

    const launchDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="launch-task-title"]');
    expect(launchDialog?.querySelector("#launch-task-title")?.textContent).toBe("Second task");
    expect(launchDialog?.querySelector("textarea")?.value).toBe("Full prompt for Second task");
  });
});
