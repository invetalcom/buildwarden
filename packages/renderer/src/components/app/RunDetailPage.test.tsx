/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import type { DesktopApi } from "@buildwarden/shared";
import type { KeyboardShortcutId, OrchestrationDetail, RunDetail, RunRecord, RunWorkspacePanelId } from "@buildwarden/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RunDetailPage, type RunDetailPageProps } from "./RunDetailPage";
import { RunNotesPanel } from "./RunNoteCard";
import { OrchestrationAgentsPanel } from "./OrchestrationAgentsPanel";

// Exercise the page's draft ownership without the composer's unrelated model menus and token work.
vi.mock("./RunComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./RunComposer")>();
  return { ...actual, RunComposer: (props: ComponentProps<typeof actual.RunComposer>) => (
    <div>
      <textarea aria-label="Follow-up draft" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)} />
      <button onClick={() => props.onAddAttachmentFiles?.([new File(["context"], "context.txt", { type: "text/plain" })])}>Attach context</button>
      <span data-attachment-count>{props.contextAttachmentFiles?.length ?? 0}</span>
      <button onClick={() => props.onModeChange("plan")}>Use plan mode</button>
      <span data-mode>{props.selectedMode}</span>
      <button aria-label="Submit follow-up" disabled={props.submitDisabled} onClick={props.onSubmit}>Send</button>
    </div>
  ) };
});

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "ai-sdk",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Improve quality",
  goalText: "Reach a quality score of 80",
  status: "completed",
  branchName: "feat/quality",
  worktreePath: "C:/repo/worktree",
  summary: "Quality improved",
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 1000,
  outputTokens: 500,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  lineageTitle: null,
  projectTaskId: null,
  delegationEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  startedAt: "2026-01-01T00:00:10.000Z",
  finishedAt: "2026-01-01T00:04:00.000Z",
  ...overrides,
});

const detail = (overrides: Partial<RunDetail> = {}): RunDetail => ({
  run: run(),
  steps: [
    { id: "prompt", runId: "run-1", eventType: "log", title: "Prompt", content: "Improve quality", metadataJson: JSON.stringify({ source: "user", mode: "code" }), createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "answer", runId: "run-1", eventType: "output", title: "Answer", content: "Quality improved", metadataJson: "{}", createdAt: "2026-01-01T00:04:00.000Z" },
  ],
  notes: [{ id: "note-1", runId: "run-1", content: "Verify coverage", status: "open", closedAt: null, createdAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" }],
  diff: "diff --git a/src/App.tsx b/src/App.tsx\n+change",
  diffLoaded: true,
  workspacePath: "C:/repo/worktree",
  latestPromptRestorePoint: { createdAt: "2026-01-01T00:00:00.000Z", commandType: "initial" },
  ...overrides,
});

const panels: RunWorkspacePanelId[] = ["activity", "agents", "diff", "terminal", "browser", "notes", "chat"];
const baseProps = (runDetail: RunDetail): RunDetailPageProps => ({
  runDetail,
  busy: false,
  modelOptions: [{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }],
  keyboardShortcuts: {} as Record<KeyboardShortcutId, string>,
  pendingShellApproval: null,
  timelineDensity: "comfortable",
  showActivity: true,
  showAgents: false,
  showDiff: false,
  showTerminal: false,
  showBrowser: false,
  showNotes: false,
  showChat: false,
  onRequestDiff: vi.fn(),
  onTogglePanel: vi.fn(),
  secondaryPanelPosition: "right",
  onSecondaryPanelPositionChange: vi.fn(),
  tileOrder: panels,
  tileLayout: Object.fromEntries(panels.map((panel) => [panel, { colSpan: panel === "activity" ? 7 : 5, rowSpan: 4 }])) as RunDetailPageProps["tileLayout"],
  onTileOrderChange: vi.fn(),
  onTileLayoutChange: vi.fn(),
  browserSession: { draftUrl: "", currentUrl: "", history: [], historyIndex: -1, reloadKey: 0 },
  terminalOpenLinksInApp: true,
  onTerminalOpenLinksInAppChange: vi.fn(),
  onBrowserSessionChange: vi.fn(),
  onOpenBrowserUrl: vi.fn(),
  onRespondToShellApproval: vi.fn(),
  onCancelRunShell: vi.fn(),
  onCancelRun: vi.fn(),
  onUndoRunToLastPrompt: vi.fn(),
  onRecoverInterruptedRun: vi.fn(),
  onCreateProjectTask: vi.fn(),
  onOpenChildRun: vi.fn(),
  onReviewChildRun: vi.fn(),
  onFollowUpRun: vi.fn(async () => undefined),
});

const changeText = async (element: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const clickText = async (container: ParentNode, text: string) => {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text);
  expect(button, `Button: ${text}`).toBeDefined();
  await act(async () => button!.click());
};
const mountDraftPage = async (overrides: Partial<RunDetailPageProps> = {}, api: Partial<DesktopApi> = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const electronClient = createElectronBuildWardenClient({
    getRunVerification: vi.fn(async () => null),
    onRunEvent: () => () => undefined,
    onRunForgeRequestChanged: () => () => undefined,
    ...api,
  } as DesktopApi);
  const client = { ...electronClient, capabilities: { ...electronClient.capabilities, browserControl: false } };
  const render = async (next: RunDetail) => {
    await act(async () => root.render(<BuildWardenClientProvider client={client}>
      <RunDetailPage {...baseProps(next)} showActivity={false} {...overrides} />
    </BuildWardenClientProvider>));
  };
  await render(detail());
  return { container, render, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
};

describe("RunDetailPage draft preservation", () => {
  it("refreshes saved notes without clearing new or edited text, and clears edits when a note is removed", async () => {
    const page = await mountDraftPage({ showNotes: true });
    try {
      const draft = page.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Add a note for this run"]')!;
      await changeText(draft, "Unsaved new note");
      await act(async () => page.container.querySelector<HTMLButtonElement>('[aria-label="Edit note"]')!.click());
      const editor = [...page.container.querySelectorAll("textarea")].find((entry) => entry.value === "Verify coverage")!;
      await changeText(editor, "Unsaved edit");
      const refreshed = detail();
      refreshed.notes = [...refreshed.notes.map((note) => ({ ...note })), { ...refreshed.notes[0]!, id: "note-2", content: "Added elsewhere" }];
      await page.render(refreshed);
      expect(draft.value).toBe("Unsaved new note");
      expect(editor.isConnected).toBe(true);
      expect(editor.value).toBe("Unsaved edit");
      expect(page.container.textContent).toContain("Added elsewhere");
      await page.render({ ...refreshed, notes: refreshed.notes.filter((note) => note.id !== "note-1") });
      expect(editor.isConnected).toBe(false);
      expect(draft.value).toBe("Unsaved new note");
      await page.render(detail({ run: run({ id: "run-2" }), notes: [] }));
      expect(draft.value).toBe("");
    } finally { await page.cleanup(); }
  });

  it("clears note drafts and edits after successful saves", async () => {
    const addRunNote = vi.fn<DesktopApi["addRunNote"]>().mockResolvedValue({ ...detail().notes[0]!, id: "new-note", content: "New note" });
    const updateRunNote = vi.fn<DesktopApi["updateRunNote"]>().mockResolvedValue({ ...detail().notes[0]!, content: "Saved edit" });
    const page = await mountDraftPage({ showNotes: true }, { addRunNote, updateRunNote });
    try {
      const draft = page.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Add a note for this run"]')!;
      await changeText(draft, "New note");
      await clickText(page.container, "Add note");
      expect(addRunNote).toHaveBeenCalledWith("run-1", { content: "New note" });
      expect(draft.value).toBe("");
      await act(async () => page.container.querySelectorAll<HTMLButtonElement>('[aria-label="Edit note"]')[1]!.click());
      const editor = [...page.container.querySelectorAll("textarea")].find((entry) => entry.value === "Verify coverage")!;
      await changeText(editor, "Saved edit");
      await clickText(page.container, "Save");
      expect(updateRunNote).toHaveBeenCalledWith("note-1", { content: "Saved edit" });
      expect(editor.isConnected).toBe(false);
      expect(page.container.textContent).toContain("Saved edit");
    } finally { await page.cleanup(); }
  });

  it("preserves follow-up text, attachments, and mode across run refreshes and clears them on run change", async () => {
    const page = await mountDraftPage();
    try {
      const draft = page.container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up draft"]')!;
      await changeText(draft, "My next request");
      await clickText(page.container, "Attach context");
      await clickText(page.container, "Use plan mode");
      await page.render(detail({ run: run({ updatedAt: "2026-01-01T00:06:00.000Z", status: "running" }) }));
      expect(draft.value).toBe("My next request");
      expect(page.container.querySelector("[data-attachment-count]")?.textContent).toBe("1");
      expect(page.container.querySelector("[data-mode]")?.textContent).toBe("plan");
      await page.render(detail({ run: run({ id: "run-2" }) }));
      expect(draft.value).toBe("");
      expect(page.container.querySelector("[data-attachment-count]")?.textContent).toBe("0");
      expect(page.container.querySelector("[data-mode]")?.textContent).toBe("code");
    } finally { await page.cleanup(); }
  });

  it("keeps a failed follow-up draft and clears it after a successful submission", async () => {
    const submit = vi.fn<RunDetailPageProps["onFollowUpRun"]>().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(undefined);
    const page = await mountDraftPage({ onFollowUpRun: submit });
    try {
      const draft = page.container.querySelector<HTMLTextAreaElement>('[aria-label="Follow-up draft"]')!;
      await changeText(draft, "My next request");
      await clickText(page.container, "Send");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(draft.value).toBe("My next request");
      await clickText(page.container, "Send");
      expect(submit).toHaveBeenCalledTimes(2);
      expect(draft.value).toBe("");
    } finally { await page.cleanup(); }
  });
});

const makeOrchestration = (): OrchestrationDetail => ({
      orchestration: {
        id: "orchestration-1",
        projectId: "project-1",
        coordinatorRunId: "run-1",
        status: "waiting",
        teamSnapshot: {
          version: 1,
          maxConcurrentTasks: 3,
          maxTasksPerOrchestration: 12,
          models: [{ modelId: "model-1", enabled: true, maxConcurrent: 2 }],
          roles: [{
            id: "implementer",
            name: "Implementer",
            description: "Implements isolated changes.",
            eligibleModelIds: ["model-1"],
            preferredModelId: "model-1",
            maxConcurrent: 2,
          }],
        },
        wakeMode: "all-terminal",
        wakeTaskIds: ["task-1"],
        lastEventSequence: 1,
        lastDeliveredSequence: 0,
        errorMessage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        finishedAt: null,
      },
      waves: [],
      tasks: [{
        id: "task-1",
        orchestrationId: "orchestration-1",
        waveId: "wave-1",
        clientTaskId: "client-1",
        title: "Implement durable scheduler",
        prompt: "**Implement** scheduling.",
        roleId: "implementer",
        modelId: "model-1",
        intent: "implement",
        status: "completed",
        childRunId: "child-1",
        retryOfTaskId: null,
        summary: "## Summary\n\n- Scheduler implemented and tested.",
        errorMessage: null,
        attentionReason: null,
        adoptionStatus: "proposed",
        inputTokens: 1200,
        outputTokens: 400,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        startedAt: "2026-01-01T00:00:10.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
      }],
      events: [],
      messages: [],
      activeTaskCount: 0,
      queuedTaskCount: 0,
      attentionTaskCount: 0,
      totalInputTokens: 1200,
      totalOutputTokens: 400,
});

describe("OrchestrationAgentsPanel", () => {
  it("preserves the selected agent and adoption preview on refresh, with fallback for removal and run changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const getRunDetail = vi.fn<DesktopApi["getRunDetail"]>().mockImplementation(async (id) => detail({ run: run({ id }), steps: [] }));
    const getOrchestrationAdoptionPreview = vi.fn<DesktopApi["getOrchestrationAdoptionPreview"]>().mockImplementation(async (taskId) => ({
      taskId, status: "proposed", diff: "", changedFiles: ["preserved-preview.ts"], conflicts: [], unsupportedPaths: [],
    }));
    const client = createElectronBuildWardenClient({
      getRunDetail, getOrchestrationAdoptionPreview,
      onOrchestrationChanged: () => () => undefined,
      onRunEvent: () => () => undefined,
    } as unknown as DesktopApi);
    const original = makeOrchestration();
    original.tasks.push({ ...original.tasks[0]!, id: "task-2", childRunId: "child-2", title: "Second agent" });
    const render = async (next: OrchestrationDetail, coordinatorRunId = "run-1") => {
      await act(async () => root.render(<BuildWardenClientProvider client={client}>
        <OrchestrationAgentsPanel coordinatorRunId={coordinatorRunId} initialDetail={next}
          modelLabels={new Map()} onOpenChildRun={vi.fn()} onReviewChildRun={vi.fn()} />
      </BuildWardenClientProvider>));
    };
    const selectSecond = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select agent"]')!.click());
      const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((entry) => entry.textContent?.includes("Second agent"))!;
      await act(async () => option.click());
    };
    try {
      await render(original);
      await selectSecond();
      await clickText(container, "Adoption preview");
      expect(getOrchestrationAdoptionPreview).toHaveBeenLastCalledWith("task-2");
      expect(container.textContent).toContain("preserved-preview.ts");
      getRunDetail.mockClear();
      const refreshed = structuredClone(original);
      refreshed.tasks[1]!.summary = "New result from the second agent";
      await render(refreshed);
      expect(container.querySelector("h3")?.textContent).toBe("Second agent");
      expect(container.textContent).toContain("New result from the second agent");
      expect(container.textContent).toContain("preserved-preview.ts");
      expect(getRunDetail).not.toHaveBeenCalled();

      await render({ ...refreshed, tasks: [refreshed.tasks[0]!] });
      expect(container.querySelector("h3")?.textContent).toBe("Implement durable scheduler");
      expect(container.textContent).not.toContain("preserved-preview.ts");
      expect(getRunDetail).toHaveBeenLastCalledWith("child-1");

      await render(refreshed);
      await selectSecond();
      await clickText(container, "Adoption preview");
      await render({ ...refreshed, orchestration: { ...refreshed.orchestration, coordinatorRunId: "run-2" } }, "run-2");
      expect(container.querySelector("h3")?.textContent).toBe("Implement durable scheduler");
      expect(container.textContent).not.toContain("preserved-preview.ts");
      await render({ ...refreshed, tasks: [] }, "run-2");
      expect(container.querySelector("h3")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders durable task status, role/model, usage, result, and scoped actions in the shared Agents panel", () => {
    const orchestration = makeOrchestration();
    const markup = renderToStaticMarkup(
      <OrchestrationAgentsPanel
        coordinatorRunId="run-1"
        initialDetail={orchestration}
        modelLabels={new Map([["model-1", "Claude Sonnet"]])}
        onOpenChildRun={vi.fn()}
        onReviewChildRun={vi.fn()}
      />,
    );

    expect(markup).toContain("Implement durable scheduler");
    expect(markup).toContain('aria-label="Select agent"');
    expect(markup).toContain("1 agent");
    expect(markup).toContain("<strong");
    expect(markup).toContain("<li");
    expect(markup).toContain(">Result</h4>");
    expect(markup).toContain(">Messages</h4>");
    expect(markup).toContain(">Activity</h4>");
    expect(markup).toContain("Claude Sonnet");
    expect(markup).toContain("1,600 tokens");
    expect(markup).toContain("Scheduler implemented and tested.");
    expect(markup).toContain("Open full run");
    expect(markup).toContain("Adoption preview");
    expect(markup).not.toContain("Finish orchestration");
  });
});

describe("RunDetailPage workflows", () => {
  it("replaces the previous transcript when switching directly between cached runs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const electronClient = createElectronBuildWardenClient({
      getRunVerification: vi.fn(async () => null),
      onRunEvent: () => () => undefined,
      onRunForgeRequestChanged: () => () => undefined,
    } as unknown as DesktopApi);
    const client = {
      ...electronClient,
      capabilities: { ...electronClient.capabilities, runMutations: false },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const id of ["run-1", "run-2", "run-3", "run-1", "run-2"]) {
        const nextDetail = detail({ run: run({ id }), steps: [], notes: [] });
        await act(async () => root.render(
          <BuildWardenClientProvider client={client}>
            <RunDetailPage {...baseProps(nextDetail)} />
          </BuildWardenClientProvider>,
        ));
        expect(container.querySelectorAll(".agent-worklog")).toHaveLength(1);
      }
      expect(consoleError.mock.calls.filter((args) => args.some((arg) =>
        typeof arg === "string" && arg.includes("same key"),
      ))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      consoleError.mockRestore();
    }
  });

  it("renders open, closed, and editing run-note workflows", () => {
    const openNote = detail().notes[0]!;
    const closedNote = { ...openNote, id: "note-2", status: "closed" as const, closedAt: "2026-01-01T00:03:00.000Z" };
    const common = {
      notes: [openNote, closedNote],
      openNotes: [openNote],
      closedNotes: [closedNote],
      draft: "New note",
      editDraft: "Edited note",
      busyNoteId: null,
      editingNoteId: null,
      onDraftChange: vi.fn(),
      onEditDraftChange: vi.fn(),
      onAdd: vi.fn(),
      onStartEditing: vi.fn(),
      onCancelEditing: vi.fn(),
      onSave: vi.fn(),
      onStatusChange: vi.fn(),
      onDelete: vi.fn(),
    };
    const markup = renderToStaticMarkup(<RunNotesPanel {...common} />);
    expect(markup).toContain("Verify coverage");
    expect(markup).toContain("Closed");
    const editing = renderToStaticMarkup(<RunNotesPanel {...common} editingNoteId={openNote.id} busyNoteId={openNote.id} />);
    expect(editing).toContain("Edited note");
    expect(editing).toContain("Save");
  });

  it("renders a completed run with activity, goal, modified files, and follow-up composer", () => {
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(detail())} />);
    expect(markup).toContain("Reach a quality score of 80");
    expect(markup).toContain("1 file changed");
    expect(markup).toContain('aria-label="Scroll to top"');
    expect(markup).toContain('aria-label="Scroll to bottom"');
  });

  it("renders active approval and interrupted recovery states", () => {
    const interrupted = detail({
      run: run({ status: "running", finishedAt: null }),
      interruptedRecovery: {
        available: true,
        kind: "checkpoint",
        title: "Recovery path available",
        detail: "Resume from the latest checkpoint.",
        providerSessionAvailable: false,
      },
    });
    const markup = renderToStaticMarkup(
      <RunDetailPage
        {...baseProps(interrupted)}
        pendingShellApproval={{ command: "pnpm test", secondsRemaining: 30 }}
        showDiff
        showNotes
      />,
    );
    expect(markup).toContain("pnpm test");
    expect(markup).toContain("Recovery path available");
  });

  it("renders an unavailable worktree without crashing", () => {
    const unavailable = detail({ worktreeUnavailable: true, diffPending: true, run: run({ status: "failed", errorMessage: "Worktree missing" }) });
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(unavailable)} showActivity={false} showBrowser showChat />);
    expect(markup).toContain("Git worktree no longer available");
  });

  it("shows summary file rows while the full patch is loading", () => {
    const pending = detail({ diff: "", diffLoaded: false, diffPending: true, diffSummary: {
      files: [{ path: "src/loading.ts", previousPath: null, additions: 2, deletions: 1 }],
      totalFiles: 1, totalAdditions: 2, totalDeletions: 1,
    } });
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(pending)} showDiff />);
    expect(markup).toContain("src/loading.ts");
    expect(markup).toContain("Loading file diffs");
  });

  it("keeps the previous patch visible during a refresh", () => {
    const pending = detail({ diffLoaded: false, diffPending: true });
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(pending)} showDiff />);
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain("Refreshing changes");
  });

  it("offers retry and disables review while displaying a failed refresh's stale patch", () => {
    const failed = detail({ diffLoadError: "Disconnected", diffRevision: null });
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(failed)} showDiff />);
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain("Showing outdated changes. Refresh failed.");
    expect(markup).toContain(">Retry</button>");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*title="Run reviewer simulator"/);
  });

  it("allows reviewing a freshly loaded patch without verification fingerprinting", () => {
    const loaded = detail({ diffRevision: null, diffLoadError: null });
    const markup = renderToStaticMarkup(<RunDetailPage {...baseProps(loaded)} showDiff />);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*title="Run reviewer simulator"/);
    expect(markup).not.toContain("Showing outdated changes");
  });
});
