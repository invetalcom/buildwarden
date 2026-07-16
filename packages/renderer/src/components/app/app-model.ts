import type { DragEvent as ReactDragEvent } from "react";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  resolveComposerCommandPrompt,
  type AppLogDirectorySizeInfo,
  type AppSnapshot,
  type HarnessType,
  type KeyboardShortcutId,
  type ProjectSnapshot,
  type ProviderType,
  type RunDetail,
  type RunRecord,
  type RunTokenUsage,
  type RunWorkspaceLayoutPreference,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import { DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE } from "./run-workspace-layout";

export const EMPTY_SNAPSHOT: AppSnapshot = {
  projects: [],
  providerAccounts: [],
  models: [],
  selectedProjectId: null,
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
};

export const EMPTY_APP_LOG_DIRECTORY_SIZE: AppLogDirectorySizeInfo = {
  totalBytes: 0,
  fileCount: 0,
  unreadableEntryCount: 0,
};

export type RunPaneId = "left" | "right";
export type OpenRunPanes = Partial<Record<RunPaneId, string>>;
export type RunDragPayload = {
  type: "buildwarden/run";
  projectId: string;
  runId: string;
};

export interface RunBrowserSessionState {
  draftUrl: string;
  currentUrl: string;
  history: string[];
  historyIndex: number;
  reloadKey: number;
}

export interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "danger";
}

export const RUN_PANE_IDS: RunPaneId[] = ["left", "right"];
export const RUN_DRAG_MIME_TYPE = "application/x-buildwarden-run";

export const DEFAULT_RUN_BROWSER_SESSION: RunBrowserSessionState = {
  draftUrl: "about:blank",
  currentUrl: "about:blank",
  history: ["about:blank"],
  historyIndex: 0,
  reloadKey: 0,
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const readRunTokenUsage = (usage: unknown): Partial<RunTokenUsage> | null => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  return usage as Partial<RunTokenUsage>;
};

const parseRunStepUsage = (metadataJson: string): Partial<RunTokenUsage> | null => {
  const metadata = safeParseMetadata(metadataJson);
  return readRunTokenUsage(metadata.usageTotals);
};

const finiteUsageNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const runUsageForDisplay = (detail: RunDetail, usage: Partial<RunTokenUsage> | null): Partial<RunTokenUsage> => {
  const persistedInputTokens = detail.run.inputTokens;
  const persistedOutputTokens = detail.run.outputTokens;
  const usageInputTokens = finiteUsageNumber(usage?.inputTokens) ?? 0;
  const usageOutputTokens = finiteUsageNumber(usage?.outputTokens) ?? 0;
  const inputTokens = Math.max(persistedInputTokens, usageInputTokens);
  const outputTokens = Math.max(persistedOutputTokens, usageOutputTokens);
  const usageProcessedTotal =
    finiteUsageNumber(usage?.totalProcessedTokens) ?? finiteUsageNumber(usage?.totalTokens) ?? usageInputTokens + usageOutputTokens;
  const totalProcessedTokens = Math.max(persistedInputTokens + persistedOutputTokens, usageProcessedTotal, inputTokens + outputTokens);
  return {
    ...(usage ?? {}),
    inputTokens,
    outputTokens,
    totalProcessedTokens,
  };
};

export const latestRunTokenUsage = (detail: RunDetail, liveUsage?: Partial<RunTokenUsage> | null): Partial<RunTokenUsage> => {
  let persistedUsage: Partial<RunTokenUsage> | null = null;
  for (let index = detail.steps.length - 1; index >= 0; index -= 1) {
    const usage = parseRunStepUsage(detail.steps[index]?.metadataJson ?? "");
    if (usage) {
      persistedUsage = usage;
      break;
    }
  }
  return runUsageForDisplay(detail, liveUsage ? { ...(persistedUsage ?? {}), ...liveUsage } : persistedUsage);
};

export const eventToKeyString = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (key === " ") parts.push("space");
  else if (!["control", "meta", "alt", "shift"].includes(key)) parts.push(key);
  return parts.join("+");
};

export const parseKeyboardShortcuts = (json: string | undefined): Record<KeyboardShortcutId, string> => {
  try {
    const parsed = json ? (JSON.parse(json) as Record<string, string>) : {};
    return { ...DEFAULT_KEYBOARD_SHORTCUTS, ...parsed };
  } catch {
    return { ...DEFAULT_KEYBOARD_SHORTCUTS };
  }
};

const HARNESS_TYPE_BY_PROVIDER: Partial<Record<ProviderType, HarnessType>> = {
  "codex-cli": "codex-app-server",
  "claude-code": "claude-code",
  "cursor-agent": "cursor-acp",
  "azure-legacy": "azure-legacy",
};

export const harnessTypeForProvider = (providerType: ProviderType): HarnessType =>
  HARNESS_TYPE_BY_PROVIDER[providerType] ?? "ai-sdk";

const normalizeOpenAiReasoningEffort = (value: string) => {
  const allowed = new Set(["none", "low", "medium", "high", "xhigh"]);
  return allowed.has(value) ? value : "medium";
};

const normalizeAnthropicEffort = (value: string) => {
  const allowed = new Set(["low", "medium", "high", "xhigh", "max"]);
  return allowed.has(value) ? value : "medium";
};

export const buildRunReasoningInput = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  reasoningEffort: string,
  anthropicEffort: string,
): { reasoningEffort?: string; anthropicEffort?: string } => {
  if (providerType === "codex-cli" || providerType === "cursor-agent" || (providerType === "ai-sdk" && providerFamily === "openai")) {
    return { reasoningEffort: normalizeOpenAiReasoningEffort(reasoningEffort) };
  }
  if (providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic")) {
    return { anthropicEffort: normalizeAnthropicEffort(anthropicEffort) };
  }
  return {};
};

export const resolveProviderComposerPrompt = (
  prompt: string,
  providerType: ProviderType,
  context: "run" | "follow-up",
) => {
  const resolved = resolveComposerCommandPrompt(prompt, providerType, context);
  if (resolved.unsupportedCommand) {
    return { prompt };
  }
  return resolved;
};

export const isRunContinuable = (run: RunRecord) => !["queued", "preparing", "running"].includes(run.status);

const findRunInList = (runs: RunRecord[], runId: string) => {
  for (const run of runs) {
    if (run.id === runId) {
      return run;
    }
  }
  return null;
};

export const findProjectRun = (projects: ProjectSnapshot[], runId: string) => {
  for (const project of projects) {
    const run =
      findRunInList(project.runs, runId) ??
      findRunInList(project.forLaterRuns, runId) ??
      findRunInList(project.activeRuns, runId) ??
      findRunInList(project.recentRuns, runId);

    if (run) {
      return { project, run };
    }

    for (const thread of project.labThreads) {
      if (thread.implementationRun?.id === runId) {
        return { project, run: thread.implementationRun };
      }
    }

    for (const loopItem of project.loops) {
      const loopRun = findRunInList(loopItem.runs, runId);
      if (loopRun) {
        return { project, run: loopRun };
      }
    }
  }

  return null;
};

/** True when the snapshot still references the run anywhere (lists, lab threads, or loop iterations). */
export const snapshotContainsRunId = (projects: ProjectSnapshot[], runId: string): boolean =>
  projects.some(
    (entry) =>
      entry.runs.some((run) => run.id === runId) ||
      entry.forLaterRuns.some((run) => run.id === runId) ||
      entry.labThreads.some((detail) => detail.implementationRun?.id === runId || detail.thread.implementationRunId === runId) ||
      entry.loops.some((item) => item.iterations.some((iteration) => iteration.runId === runId)),
  );

/** Picks the branch to preselect: keep the current choice, fall back to the project base, then the first branch. */
export const pickProjectBranch = (branches: string[], baseBranch: string, current?: string): string => {
  if (current && branches.includes(current)) {
    return current;
  }
  if (branches.includes(baseBranch)) {
    return baseBranch;
  }
  return branches[0] ?? "";
};

export const getOpenRunPaneEntries = (panes: OpenRunPanes) =>
  RUN_PANE_IDS.flatMap((paneId) => {
    const runId = panes[paneId];
    return runId ? [{ paneId, runId }] : [];
  });

export const runIdIsOpenInPanes = (panes: OpenRunPanes, runId: string) =>
  RUN_PANE_IDS.some((paneId) => panes[paneId] === runId);

export const paneForOpenRunId = (panes: OpenRunPanes, runId: string): RunPaneId | null =>
  RUN_PANE_IDS.find((paneId) => panes[paneId] === runId) ?? null;

export const firstOpenRunId = (panes: OpenRunPanes): string | null => getOpenRunPaneEntries(panes)[0]?.runId ?? null;

export const parseRunDragPayload = (event: ReactDragEvent<HTMLElement>): RunDragPayload | null => {
  const raw = event.dataTransfer.getData(RUN_DRAG_MIME_TYPE) || event.dataTransfer.getData("text/plain");
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RunDragPayload>;
    if (parsed.type === "buildwarden/run" && typeof parsed.projectId === "string" && typeof parsed.runId === "string") {
      return {
        type: "buildwarden/run",
        projectId: parsed.projectId,
        runId: parsed.runId,
      };
    }
  } catch {
    return null;
  }

  return null;
};

export const cloneDefaultRunWorkspaceLayoutPreference = (): RunWorkspaceLayoutPreference => ({
  visiblePanels: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.visiblePanels },
  tileOrder: [...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileOrder],
  tileLayout: {
    activity: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.activity },
    diff: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.diff },
    terminal: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.terminal },
    browser: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.browser },
    notes: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.notes },
    chat: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.chat },
  },
  secondaryPanelPosition: DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.secondaryPanelPosition,
});

