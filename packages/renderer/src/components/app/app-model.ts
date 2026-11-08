import type { DragEvent as ReactDragEvent } from "react";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  resolveModelExecutionProfile,
  resolveComposerCommandPrompt,
  type AppLogDirectorySizeInfo,
  type AppSnapshot,
  type HarnessType,
  type KeyboardShortcutId,
  type ModelExecutionControl,
  type ProjectSnapshot,
  type ProviderExecutionOptions,
  type ProviderType,
  type RunDetail,
  type RunModelConfiguration,
  type RunListItem,
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
  impactItems?: Array<{ label: string; count: number }>;
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
  openrouter: "ai-sdk",
  "codex-cli": "codex-app-server",
  "claude-code": "claude-code",
  "cursor-agent": "cursor-acp",
  "azure-legacy": "azure-legacy",
  acp: "acp",
};

export const harnessTypeForProvider = (providerType: ProviderType): HarnessType =>
  HARNESS_TYPE_BY_PROVIDER[providerType] ?? "ai-sdk";

/** Returns the controls a configured model actually supports, using discovery metadata when available. */
export const buildModelExecutionProfile = resolveModelExecutionProfile;

const selectedControlValue = (controlEntry: ModelExecutionControl | undefined, value: string) => {
  if (!controlEntry || !value || value === "auto") return undefined;
  return controlEntry.options.some((entry) => entry.value === value) ? value : undefined;
};

export interface RunReasoningInput {
  reasoningEffort?: string;
  anthropicEffort?: string;
  executionOptions?: ProviderExecutionOptions;
}

const usesAnthropicEffort = (providerType: ProviderType, providerFamily: UnifiedProviderFamily | null): boolean =>
  providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic");

const applyReasoningExecutionOption = (
  result: RunReasoningInput,
  executionOptions: ProviderExecutionOptions,
  reasoningControl: ModelExecutionControl | undefined,
  chosenEffort: string | undefined,
  rawEffort: string,
  anthropic: boolean,
): void => {
  if (!chosenEffort) {
    if (!reasoningControl || rawEffort !== "auto") {
      return;
    }
    if (anthropic) {
      executionOptions.anthropicEffort = "auto";
    } else if (reasoningControl.id === "thinkingLevel") {
      executionOptions.thinkingLevel = "auto";
    } else {
      executionOptions.reasoningEffort = "auto";
    }
    return;
  }

  if (anthropic) {
    const mappedEffort = chosenEffort === "ultracode" ? "xhigh" : chosenEffort;
    result.anthropicEffort = mappedEffort;
    executionOptions.anthropicEffort = mappedEffort;
    if (chosenEffort === "ultracode") {
      executionOptions.workflowMode = "ultracode";
    }
  } else if (reasoningControl?.id === "thinkingLevel") {
    executionOptions.thinkingLevel = chosenEffort;
  } else {
    result.reasoningEffort = chosenEffort;
    executionOptions.reasoningEffort = chosenEffort;
  }
};

const applySecondaryExecutionOption = (
  executionOptions: ProviderExecutionOptions,
  control: ModelExecutionControl | undefined,
  chosenValue: string | undefined,
  rawValue: string,
): void => {
  if (!control) {
    return;
  }
  const value = chosenValue ?? (rawValue === "auto" ? "auto" : undefined);
  if (!value) {
    return;
  }
  switch (control.id) {
    case "serviceTier": executionOptions.serviceTier = value; break;
    case "speed": executionOptions.speed = value; break;
    case "contextMode": executionOptions.contextMode = value; break;
    case "workflowMode": executionOptions.workflowMode = value; break;
  }
};

export const resolveRunModelConfiguration = (
  modelId: string,
  configurations: Readonly<Record<string, RunModelConfiguration>>,
  reasoningEffort: string,
  anthropicEffort: string,
  executionMode: string,
  isAnthropic: boolean,
): RunModelConfiguration => configurations[modelId] ?? {
  effort: isAnthropic ? anthropicEffort : reasoningEffort,
  executionMode,
};

export const buildRunReasoningInput = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  reasoningEffort: string,
  anthropicEffort: string,
  profile = buildModelExecutionProfile(providerType, providerFamily, ""),
  executionMode = "auto",
): RunReasoningInput => {
  // Azure Legacy deliberately remains on its established request contract.
  if (providerType === "azure-legacy") return {};

  const reasoningControl = profile.controls.find((entry) => entry.id === "reasoningEffort" || entry.id === "thinkingLevel");
  const anthropic = usesAnthropicEffort(providerType, providerFamily);
  const rawEffort = anthropic ? anthropicEffort : reasoningEffort;
  const chosenEffort = selectedControlValue(reasoningControl, rawEffort);
  const secondaryControl = profile.controls.find((entry) => entry !== reasoningControl);
  const chosenMode = selectedControlValue(secondaryControl, executionMode);
  const executionOptions: ProviderExecutionOptions = {};
  const result: RunReasoningInput = {};

  applyReasoningExecutionOption(result, executionOptions, reasoningControl, chosenEffort, rawEffort, anthropic);
  applySecondaryExecutionOption(executionOptions, secondaryControl, chosenMode, executionMode);

  if (Object.keys(executionOptions).length > 0) result.executionOptions = executionOptions;
  return result;
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

export const isRunContinuable = (run: RunListItem) => !["queued", "preparing", "running"].includes(run.status);

const projectRunCandidates = (project: ProjectSnapshot): RunListItem[] => [
  ...project.runs,
  ...project.forLaterRuns,
  ...project.orchestratedRuns,
  ...project.activeRuns,
  ...project.recentRuns,
  ...project.labThreads.flatMap((thread) => thread.implementationRun ? [thread.implementationRun] : []),
  ...project.loops.flatMap((loopItem) => loopItem.runs),
  ...(project.automations ?? []).flatMap((automationItem) => automationItem.runs),
];

export const findProjectRun = (projects: ProjectSnapshot[], runId: string) => {
  for (const project of projects) {
    const run = projectRunCandidates(project).find((candidate) => candidate.id === runId);
    if (run) {
      return { project, run };
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
      entry.orchestratedRuns.some((run) => run.id === runId) ||
      entry.labThreads.some((detail) => detail.implementationRun?.id === runId || detail.thread.implementationRunId === runId) ||
      entry.loops.some((item) => item.iterations.some((iteration) => iteration.runId === runId)) ||
      (entry.automations ?? []).some((item) => item.runs.some((run) => run.id === runId)),
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

export const removeRunIdsFromOpenPanes = (
  panes: OpenRunPanes,
  runIds: ReadonlySet<string>,
): OpenRunPanes => Object.fromEntries(
  Object.entries(panes).filter(([, runId]) => !runIds.has(runId)),
) as OpenRunPanes;

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
    agents: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.agents },
    validation: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.validation },
    diff: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.diff },
    terminal: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.terminal },
    browser: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.browser },
    notes: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.notes },
    chat: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.chat },
    "pull-request": { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout["pull-request"] },
  },
  secondaryPanelPosition: DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.secondaryPanelPosition,
});

