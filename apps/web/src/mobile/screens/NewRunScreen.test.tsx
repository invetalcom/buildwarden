/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BuildWardenClientProvider, type BuildWardenClient } from "@buildwarden/renderer";
import { APP_SETTING_KEYS, buildDefaultProjectRunDefaults, type AppSnapshot, type ProjectTaskRecord, type ProjectTaskSummary, type RunInput } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../data/mobile-app-context";
import { NewRunScreen } from "./NewRunScreen";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

const taskSummary = (id: string, title: string, prompt: string): ProjectTaskSummary => ({
  id,
  projectId: "project-1",
  title,
  prompt,
  attachmentCount: 1,
  status: "open",
  runId: null,
  pullRequestUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const taskDetail = (summary: ProjectTaskSummary, fileName: string): ProjectTaskRecord => {
  return {
    id: summary.id,
    projectId: summary.projectId,
    title: summary.title,
    prompt: summary.prompt,
    attachments: [{ fileName, mimeType: "text/plain", dataBase64: "SGVsbG8=" }],
    status: summary.status,
    runId: summary.runId,
    pullRequestUrl: summary.pullRequestUrl,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
};

const firstTask = taskSummary("task-a", "Task A", "Prompt A");
const secondTask = taskSummary("task-b", "Task B", "Prompt B");

const snapshot = {
  projects: [{
    project: {
      id: "project-1",
      name: "Project",
      repoPath: "/repo",
      baseBranch: "main",
      kind: "git",
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: null,
    },
    runs: [],
    forLaterRuns: [],
    orchestratedRuns: [],
    activeRuns: [],
    recentRuns: [],
    tasks: [firstTask, secondTask],
    insights: [],
    labThreads: [],
    loops: [],
  }],
  providerAccounts: [{
    id: "provider-1",
    providerType: "ai-sdk",
    label: "Provider",
    apiBaseUrl: null,
    apiKeyRef: "secret-1",
    configJson: "{}",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  models: [{
    id: "model-1",
    providerAccountId: "provider-1",
    modelId: "gpt-5",
    displayName: "GPT-5",
    baseUrlOverride: null,
    configJson: "{}",
    capabilitiesJson: "{}",
    enabled: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  selectedProjectId: "project-1",
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
} satisfies AppSnapshot;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("NewRunScreen task loading", () => {
  it("keeps partial batch drafts across remounts and retries only models that failed", async () => {
    let failSecond = true;
    const createRun = vi.fn(async (input: RunInput) => {
      if (input.modelId === "model-2" && failSecond) throw new Error("Provider offline");
      return { id: `run-${input.modelId}`, modelId: input.modelId };
    });
    const client = { draftScopeId: crypto.randomUUID(), createRun, selectProject: vi.fn(async () => undefined), setAppSetting: vi.fn(async () => undefined) } as unknown as BuildWardenClient;
    const batchSnapshot = {
      ...snapshot, models: [...snapshot.models, { ...snapshot.models[0], id: "model-2", displayName: "Second model" }],
      settings: { [APP_SETTING_KEYS.projectRunDefaults]: JSON.stringify({ "project-1": { ...buildDefaultProjectRunDefaults(), workspaceType: "worktree", worktreeModelIds: ["model-1", "model-2"] } }) },
    };
    const replace = vi.fn();
    const value = { client, snapshot: batchSnapshot, snapshotStore: { loaded: true, refresh: vi.fn(async () => undefined) }, router: { back: vi.fn(), replace } } as unknown as MobileAppValue;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); mountedRoots.push({ root, container });
    const render = () => root.render(<BuildWardenClientProvider client={client}><MobileAppProvider value={value}><NewRunScreen projectId="project-1" /></MobileAppProvider></BuildWardenClientProvider>);
    const start = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Start run"))!;
    await act(render);
    await act(() => setTextareaValue(container.querySelector("textarea")!, "Keep this batch"));
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["notes"], "notes.txt", { type: "text/plain" })] });
    await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => {
      start().click();
      await vi.waitFor(() => expect(container.textContent).toContain("Retry will start only the remaining models"));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe("Keep this batch");
    expect(container.textContent).toContain("notes.txt");
    const draftKey = 'buildwarden.composer-draft.v1:' + JSON.stringify([client.draftScopeId, "project", "project-1"]);
    expect(JSON.parse(localStorage.getItem(draftKey)!).runBatch.acceptedModelIds).toEqual(["model-1"]);
    await act(() => root.render(null));
    await act(render);
    failSecond = false;
    await act(async () => { start().click(); await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce()); });
    expect(createRun.mock.calls.map(([input]) => input.modelId)).toEqual(["model-1", "model-2", "model-2"]);
    expect(createRun.mock.calls[2]![0]).toMatchObject({ prompt: "Keep this batch", attachments: [{ fileName: "notes.txt" }] });
    expect(localStorage.getItem(draftKey)).toBeNull();
  });
  it("retries failed task loading without losing edits or enabling an unsafe launch", async () => {
    const task = deferred<ProjectTaskRecord>();
    const getProjectTask = vi.fn().mockRejectedValueOnce(new Error("Host offline")).mockReturnValueOnce(task.promise);
    const client = { draftScopeId: crypto.randomUUID(), getProjectTask, selectProject: vi.fn(async () => undefined) } as unknown as BuildWardenClient;
    const value = { client, snapshot, snapshotStore: { loaded: true }, router: { back: vi.fn() } } as unknown as MobileAppValue;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); mountedRoots.push({ root, container });
    await act(() => root.render(<BuildWardenClientProvider client={client}><MobileAppProvider value={value}><NewRunScreen projectId="project-1" taskId={firstTask.id} /></MobileAppProvider></BuildWardenClientProvider>));
    const start = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Start run"))!;
    await act(() => setTextareaValue(container.querySelector("textarea")!, "Keep my edits"));
    expect(container.textContent).toContain("Host offline");
    expect(start().disabled).toBe(true);
    await act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Try again"))!.click());
    expect(getProjectTask).toHaveBeenCalledTimes(2);
    expect(start().disabled).toBe(true);
    await act(() => task.resolve(taskDetail(firstTask, "task.txt")));
    expect(container.textContent).not.toContain("Host offline");
    expect(container.querySelector("textarea")!.value).toBe("Keep my edits");
    expect(start().disabled).toBe(false);
  });
  it("blocks launch until task attachments load and excess draft files are removed", async () => {
    const task = deferred<ProjectTaskRecord>();
    const client = { draftScopeId: crypto.randomUUID(), getProjectTask: () => task.promise, selectProject: vi.fn(async () => undefined), createRun: vi.fn() } as unknown as BuildWardenClient;
    const value = { client, snapshot, snapshotStore: { loaded: true }, router: { back: vi.fn() } } as unknown as MobileAppValue;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); mountedRoots.push({ root, container });
    await act(() => root.render(<BuildWardenClientProvider client={client}><MobileAppProvider value={value}><NewRunScreen projectId="project-1" taskId={firstTask.id} /></MobileAppProvider></BuildWardenClientProvider>));
    const start = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Start run"))!;
    await act(() => setTextareaValue(container.querySelector("textarea")!, "Prompt"));
    expect(start().disabled).toBe(true);
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: Array.from({ length: 8 }, (_, index) => new File(["data"], `draft-${index}.txt`, { type: "text/plain" })) });
    await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await act(() => task.resolve(taskDetail(firstTask, "task.txt")));
    expect(container.textContent).toContain("Task and draft contain 9 files");
    expect(start().disabled).toBe(true);
    expect(container.querySelectorAll('button[aria-label^="Remove draft-"]')).toHaveLength(8);
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove draft-0.txt"]')!.click());
    expect(start().disabled).toBe(false);
    expect(client.createRun).not.toHaveBeenCalled();
  });
  it("waits for a real project and restores separate project drafts after snapshot hydration", async () => {
    const secondProject = { ...snapshot.projects[0], project: { ...snapshot.projects[0].project, id: "project-2", name: "Second" } };
    const loaded = { ...snapshot, projects: [...snapshot.projects, secondProject] };
    const client = { draftScopeId: crypto.randomUUID(), selectProject: vi.fn(async () => undefined) } as unknown as BuildWardenClient;
    const value = { client, snapshot: { ...snapshot, projects: [], selectedProjectId: null }, snapshotStore: { loaded: false }, router: { back: vi.fn() } } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    const render = () => root.render(<BuildWardenClientProvider client={client}><MobileAppProvider value={{ ...value }}><NewRunScreen /></MobileAppProvider></BuildWardenClientProvider>);
    await act(render);
    expect(container.querySelector("textarea")).toBeNull();
    value.snapshot = loaded;
    await act(render);
    await act(() => setTextareaValue(container.querySelector("textarea")!, "First project draft"));
    const select = container.querySelector("select")!;
    await act(() => { select.value = "project-2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("textarea")?.value).toBe("");
    await act(() => setTextareaValue(container.querySelector("textarea")!, "Second project draft"));
    await act(() => { select.value = "project-1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("textarea")?.value).toBe("First project draft");
    expect(localStorage.getItem('buildwarden.composer-draft.v1:' + JSON.stringify([client.draftScopeId, "project", ""]))).toBeNull();
    await act(() => root.render(null));
    await act(render);
    expect(container.querySelector("textarea")?.value).toBe("First project draft");
  });
  it("does not reseed a cleared task prompt after remounting", async () => {
    const value = {
      client: { draftScopeId: crypto.randomUUID(), getProjectTask: vi.fn(async () => taskDetail(firstTask, "a.txt")), selectProject: vi.fn(async () => undefined) } as unknown as BuildWardenClient,
      snapshot, snapshotStore: { loaded: true, refresh: vi.fn() }, router: { back: vi.fn() },
    } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    const render = () => root.render(<BuildWardenClientProvider client={value.client}><MobileAppProvider value={value}>
      <NewRunScreen projectId="project-1" taskId={firstTask.id} />
    </MobileAppProvider></BuildWardenClientProvider>);
    await act(render);
    expect(container.querySelector("textarea")?.value).toBe("Prompt A");
    await act(() => setTextareaValue(container.querySelector("textarea")!, ""));
    await act(() => root.render(null));
    await act(render);
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("clears the previous task and preserves edits made while the next task loads", async () => {
    const first = deferred<ProjectTaskRecord>();
    const second = deferred<ProjectTaskRecord>();
    const getProjectTask = vi.fn((taskId: string) => taskId === firstTask.id ? first.promise : second.promise);
    const value = {
      client: { draftScopeId: crypto.randomUUID(), getProjectTask, selectProject: vi.fn(async () => undefined) } as unknown as BuildWardenClient,
      snapshot,
      snapshotStore: { loaded: true, refresh: vi.fn(async () => undefined) },
      router: { back: vi.fn() },
    } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(
      <BuildWardenClientProvider client={value.client}><MobileAppProvider value={value}>
        <NewRunScreen projectId="project-1" taskId={firstTask.id} />
      </MobileAppProvider></BuildWardenClientProvider>,
    ));
    await act(async () => { first.resolve(taskDetail(firstTask, "a.txt")); });
    expect(container.querySelector("textarea")?.value).toBe("Prompt A");

    await act(async () => root.render(
      <BuildWardenClientProvider client={value.client}><MobileAppProvider value={value}>
        <NewRunScreen projectId="project-1" taskId={secondTask.id} />
      </MobileAppProvider></BuildWardenClientProvider>,
    ));
    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe("");
    expect(container.textContent).not.toContain("a.txt");

    await act(async () => {
      if (textarea) setTextareaValue(textarea, "Draft for task B");
    });
    await act(async () => { second.resolve(taskDetail(secondTask, "b.txt")); });

    expect(container.querySelector("textarea")?.value).toBe("Draft for task B");
    expect(container.textContent).toContain("b.txt");
  });
});
