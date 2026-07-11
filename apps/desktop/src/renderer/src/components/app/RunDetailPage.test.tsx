import { renderToStaticMarkup } from "react-dom/server";
import type { KeyboardShortcutId, RunDetail, RunRecord, RunWorkspacePanelId } from "@buildwarden/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RunDetailPage, type RunDetailPageProps } from "./RunDetailPage";
import { RunNotesPanel } from "./RunNoteCard";

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      buildwarden: new Proxy({}, { get: () => vi.fn(async () => null) }),
      setTimeout,
      clearTimeout,
    },
  });
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
  workspacePath: "C:/repo/worktree",
  latestPromptRestorePoint: { createdAt: "2026-01-01T00:00:00.000Z", commandType: "initial" },
  ...overrides,
});

const panels: RunWorkspacePanelId[] = ["activity", "diff", "terminal", "browser", "notes", "chat"];
const baseProps = (runDetail: RunDetail): RunDetailPageProps => ({
  runDetail,
  busy: false,
  modelOptions: [{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }],
  keyboardShortcuts: {} as Record<KeyboardShortcutId, string>,
  pendingShellApproval: null,
  timelineDensity: "comfortable",
  showActivity: true,
  showDiff: false,
  showTerminal: false,
  showBrowser: false,
  showNotes: false,
  showChat: false,
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
  onFollowUpRun: vi.fn(async () => undefined),
});

describe("RunDetailPage workflows", () => {
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
});
