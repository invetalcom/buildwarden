/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BuildWardenClient } from "@buildwarden/renderer";
import type { AppSnapshot, ProjectTaskRecord, ProjectTaskSummary } from "@buildwarden/shared";
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
  it("clears the previous task and preserves edits made while the next task loads", async () => {
    const first = deferred<ProjectTaskRecord>();
    const second = deferred<ProjectTaskRecord>();
    const getProjectTask = vi.fn((taskId: string) => taskId === firstTask.id ? first.promise : second.promise);
    const value = {
      client: { getProjectTask } as unknown as BuildWardenClient,
      snapshot,
      snapshotStore: { loaded: true, refresh: vi.fn(async () => undefined) },
      router: { back: vi.fn() },
    } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <NewRunScreen projectId="project-1" taskId={firstTask.id} />
      </MobileAppProvider>,
    ));
    await act(async () => { first.resolve(taskDetail(firstTask, "a.txt")); });
    expect(container.querySelector("textarea")?.value).toBe("Prompt A");

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <NewRunScreen projectId="project-1" taskId={secondTask.id} />
      </MobileAppProvider>,
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
