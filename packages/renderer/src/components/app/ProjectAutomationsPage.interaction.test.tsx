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
  scheduleKind: "cron",
  cronExpression: "0 9 * * *",
  timeZone: "UTC",
  modelId: "model-1",
  effort: "high",
  executionOptions: { reasoningEffort: "high" },
  workspaceType: "worktree",
  baseBranch: "main",
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
  it("keeps automation history visible without mutation controls in read-only web sessions", async () => {
    const electronClient = createElectronBuildWardenClient({} as DesktopApi);
    const client = {
      ...electronClient,
      capabilities: { ...electronClient.capabilities, platform: "web" as const, automationMutations: false },
    };

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={client}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={[automationItem()]}
          modelOptions={[]}
          defaultModelId="model-1"
          availableBranches={["main"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    expect(container.textContent).toContain("Existing automation");
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).not.toContain("New automation");
    expect(container.textContent).not.toContain("Pause schedule");
    expect(container.textContent).not.toContain("Run now");
  });

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
          availableBranches={["main", "develop"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    expect(container.textContent).toContain("(UTC)");

    const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    await act(async () => button("New automation")?.click());
    await act(async () => container?.querySelector<HTMLButtonElement>('[aria-label="Automation branch"]')?.click());
    const develop = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "develop");
    await act(async () => develop?.click());
    await act(async () => button("Save automation")?.click());

    expect(createProjectAutomation).toHaveBeenCalledOnce();
    expect(createProjectAutomation).toHaveBeenCalledWith("project-1", expect.objectContaining({
      baseBranch: "develop",
      modelId: "model-1",
      workspaceType: "worktree",
    }));
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
          availableBranches={["main", "develop"]}
          projectBaseBranch="main"
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

  it("discards an edit response after another automation is selected", async () => {
    let resolveRecord!: (record: ProjectAutomationRecord) => void;
    const getProjectAutomation = vi.fn(() => new Promise<ProjectAutomationRecord>((resolve) => {
      resolveRecord = resolve;
    }));
    const secondAutomation = { ...existingAutomation, id: "automation-2", name: "Second automation" };
    const secondItem = (): ProjectAutomationListItem => {
      const { attachments, ...automation } = secondAutomation;
      return { automation: { ...automation, attachmentCount: attachments.length }, runs: [] };
    };
    const api = { getProjectAutomation } as unknown as DesktopApi;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={[automationItem(), secondItem()]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5.6",
            modelId: "gpt-5.6-sol",
            providerType: "codex-cli",
            providerFamily: null,
          }]}
          defaultModelId="model-1"
          availableBranches={["main"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const editButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".lucide-pencil"));
    await act(async () => editButton?.click());
    const secondButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Second automation"));
    await act(async () => secondButton?.click());
    await act(async () => resolveRecord(existingAutomation));

    expect(container.textContent).toContain("Second automation");
    expect(container.textContent).not.toContain("Edit automation");
  });

  it("does not restore an automation selected before a pending save", async () => {
    let resolveSave!: (record: ProjectAutomationRecord) => void;
    const updateProjectAutomation = vi.fn(() => new Promise<ProjectAutomationRecord>((resolve) => {
      resolveSave = resolve;
    }));
    const secondAutomation = { ...existingAutomation, id: "automation-2", name: "Second automation" };
    const secondItem = (): ProjectAutomationListItem => {
      const { attachments, ...automation } = secondAutomation;
      return { automation: { ...automation, attachmentCount: attachments.length }, runs: [] };
    };
    const api = {
      getProjectAutomation: vi.fn(async () => existingAutomation),
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
          automations={[automationItem(), secondItem()]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5.6",
            modelId: "gpt-5.6-sol",
            providerType: "codex-cli",
            providerFamily: null,
          }]}
          defaultModelId="model-1"
          availableBranches={["main"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const editButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".lucide-pencil"));
    await act(async () => editButton?.click());
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Save automation");
    await act(async () => saveButton?.click());
    const secondButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Second automation"));
    await act(async () => secondButton?.click());
    await act(async () => resolveSave(existingAutomation));

    expect(updateProjectAutomation).toHaveBeenCalledOnce();
    expect(container.querySelector("h3")?.textContent).toContain("Second automation");
    expect(container.textContent).not.toContain("Edit automation");
  });

  it("preserves a newer selection when deletion completes", async () => {
    let resolveDelete!: () => void;
    const deleteProjectAutomation = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    const secondAutomation = { ...existingAutomation, id: "automation-2", name: "Second automation" };
    const secondItem = (): ProjectAutomationListItem => {
      const { attachments, ...automation } = secondAutomation;
      return { automation: { ...automation, attachmentCount: attachments.length }, runs: [] };
    };
    const api = { deleteProjectAutomation } as unknown as DesktopApi;
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={[automationItem(), secondItem()]}
          modelOptions={[{
            id: "model-1",
            label: "GPT-5.6",
            modelId: "gpt-5.6-sol",
            providerType: "codex-cli",
            providerFamily: null,
          }]}
          defaultModelId="model-1"
          availableBranches={["main"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".lucide-trash-2"));
    await act(async () => deleteButton?.click());
    const secondButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Second automation"));
    await act(async () => secondButton?.click());
    await act(async () => resolveDelete());

    expect(deleteProjectAutomation).toHaveBeenCalledWith(existingAutomation.id);
    expect(container.querySelector("h3")?.textContent).toContain("Second automation");
  });
});

describe("one-time automations", () => {
  const modelOptions = [{
    id: "model-1",
    label: "GPT-5.6",
    modelId: "gpt-5.6-sol",
    providerType: "codex-cli",
    providerFamily: null,
  }] as const;

  const oneTimeRecord = (overrides: Partial<ProjectAutomationRecord>): ProjectAutomationRecord => ({
    ...existingAutomation,
    id: "once-1",
    name: "Release audit",
    scheduleKind: "once",
    cronExpression: "",
    nextRunAt: "2026-11-20T09:00:00.000Z",
    ...overrides,
  });

  const listItem = (record: ProjectAutomationRecord, runs: ProjectAutomationListItem["runs"] = []): ProjectAutomationListItem => {
    const { attachments, ...automation } = record;
    return { automation: { ...automation, attachmentCount: attachments.length }, runs };
  };

  const renderPage = async (api: Partial<DesktopApi>, automations: ProjectAutomationListItem[]) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api as DesktopApi)}>
        <ProjectAutomationsPage
          projectId="project-1"
          projectKind="git"
          automations={automations}
          modelOptions={[...modelOptions]}
          defaultModelId="model-1"
          availableBranches={["main"]}
          projectBaseBranch="main"
          onOpenRun={vi.fn()}
          onChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ));
    return container;
  };

  const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  const fieldInput = (label: string) => [...container!.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.trim().startsWith(label))?.querySelector("input") ?? null;
  const typeInto = async (input: HTMLInputElement | null, value: string) => {
    if (!input) throw new Error("Input not found.");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a one-time automation from the schedule switch and quick picks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const createProjectAutomation = vi.fn(async () => oneTimeRecord({}));
    const page = await renderPage({ createProjectAutomation }, []);

    await act(async () => button("New automation")?.click());
    await typeInto(fieldInput("Time zone"), "UTC");
    await act(async () => button("One time")?.click());

    expect(button("One time")?.getAttribute("aria-pressed")).toBe("true");
    expect(fieldInput("Run at")?.value).toBe("2026-11-18T09:00");
    expect(page.textContent).toContain("in 21 h");
    expect(page.textContent).not.toContain("Wait for previous run");

    await act(async () => button("Next Monday 09:00")?.click());
    expect(fieldInput("Run at")?.value).toBe("2026-11-23T09:00");
    await act(async () => button("Save automation")?.click());

    expect(createProjectAutomation).toHaveBeenCalledWith("project-1", expect.objectContaining({
      scheduleKind: "once",
      runAtLocal: "2026-11-23T09:00",
      cronExpression: "",
      timeZone: "UTC",
    }));
  });

  it("explains a start time that has already passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const page = await renderPage({}, []);

    await act(async () => button("New automation")?.click());
    await typeInto(fieldInput("Time zone"), "UTC");
    await act(async () => button("One time")?.click());
    await typeInto(fieldInput("Run at"), "2026-11-17T08:00");

    expect(page.textContent).toContain("This time has already passed.");
  });

  it("cancels a pending one-time start without deleting it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const updateProjectAutomation = vi.fn(async () => oneTimeRecord({ enabled: false }));
    const page = await renderPage({ updateProjectAutomation }, [listItem(oneTimeRecord({}))]);

    expect(page.textContent).toContain("Once ·");
    expect(page.textContent).toContain("Starts in 2 d 21 h");
    expect(page.textContent).toContain("Scheduled");
    expect(page.textContent).toContain("Runs at");
    expect(button("Pause schedule")).toBeUndefined();

    await act(async () => button("Cancel schedule")?.click());
    expect(updateProjectAutomation).toHaveBeenCalledWith("once-1", { enabled: false });
  });

  it("reschedules a missed one-time automation for the same time tomorrow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const missed = oneTimeRecord({ enabled: false, lastScheduledAt: "2026-11-14T08:00:00.000Z", nextRunAt: "2026-11-14T08:00:00.000Z" });
    const getProjectAutomation = vi.fn(async () => missed);
    const updateProjectAutomation = vi.fn(async () => missed);
    const page = await renderPage({ getProjectAutomation, updateProjectAutomation }, [listItem(missed)]);

    expect(page.textContent).toContain("Missed");
    expect(page.textContent).toContain("was skipped when the app started");
    expect(page.textContent).toContain("Was due");

    await act(async () => button("Reschedule…")?.click());
    expect(fieldInput("Run at")?.value).toBe("2026-11-18T08:00");
    await act(async () => button("Save automation")?.click());

    expect(updateProjectAutomation).toHaveBeenCalledWith("once-1", expect.objectContaining({
      enabled: true,
      scheduleKind: "once",
      runAtLocal: "2026-11-18T08:00",
    }));
  });

  it("shows a one-time automation that started as ran", async () => {
    const fired = oneTimeRecord({ enabled: false, lastScheduledAt: "2026-11-20T09:00:00.000Z" });
    const run = { id: "run-1", status: "completed", createdAt: "2026-11-20T09:00:05.000Z" } as ProjectAutomationListItem["runs"][number];
    const page = await renderPage({}, [listItem(fired, [{ ...run, startedAt: run.createdAt, finishedAt: run.createdAt, updatedAt: run.createdAt, inputTokens: 0, outputTokens: 0, branchName: "bw/once" }])]);

    expect(page.textContent).toContain("Ran at");
    expect(button("Reschedule…")).toBeDefined();
  });
});
