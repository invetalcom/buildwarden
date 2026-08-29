import type { DragEvent as ReactDragEvent } from "react";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  getKnownModelExecutionProfile,
  MODEL_CONFIG_EXECUTION_PROFILE_KEY,
  resolveComposerCommandPrompt,
  type AppLogDirectorySizeInfo,
  type AppSnapshot,
  type HarnessType,
  type KeyboardShortcutId,
  type ModelExecutionControl,
  type ModelExecutionControlId,
  type ModelExecutionProfile,
  type ModelRecord,
  type ProjectSnapshot,
  type ProviderExecutionOptions,
  type ProviderType,
  type RunDetail,
  type RunModelConfiguration,
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
};

export const harnessTypeForProvider = (providerType: ProviderType): HarnessType =>
  HARNESS_TYPE_BY_PROVIDER[providerType] ?? "ai-sdk";

const option = (value: string, label: string, description?: string) => ({ value, label, description });
const autoOption = option("auto", "Provider default", "Let the selected provider and model choose its default.");

const control = (
  id: ModelExecutionControlId,
  label: string,
  options: ModelExecutionControl["options"],
  defaultValue = "auto",
): ModelExecutionControl => ({ id, label, options: [autoOption, ...options.filter((entry) => entry.value !== "auto")], defaultValue });

const normalizeExecutionProfile = (value: unknown): ModelExecutionProfile | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawControls = (value as { controls?: unknown }).controls;
  if (!Array.isArray(rawControls)) return null;
  const validIds = new Set<ModelExecutionControlId>([
    "reasoningEffort",
    "serviceTier",
    "speed",
    "thinkingLevel",
    "contextMode",
    "workflowMode",
  ]);
  const controls = rawControls.flatMap((candidate): ModelExecutionControl[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (!validIds.has(entry.id as ModelExecutionControlId) || typeof entry.label !== "string" || !Array.isArray(entry.options)) return [];
    const options = entry.options.flatMap((candidateOption) => {
      if (!candidateOption || typeof candidateOption !== "object" || Array.isArray(candidateOption)) return [];
      const rawOption = candidateOption as Record<string, unknown>;
      if (typeof rawOption.value !== "string" || typeof rawOption.label !== "string") return [];
      return [{
        value: rawOption.value,
        label: rawOption.label,
        ...(typeof rawOption.description === "string" ? { description: rawOption.description } : {}),
      }];
    });
    if (options.length === 0) return [];
    return [{
      id: entry.id as ModelExecutionControlId,
      label: entry.label,
      options: options.some((entryOption) => entryOption.value === "auto") ? options : [autoOption, ...options],
      ...(typeof entry.defaultValue === "string" ? { defaultValue: entry.defaultValue } : {}),
    }];
  });
  const source = (value as { source?: unknown }).source;
  return {
    controls,
    ...(source === "provider" || source === "catalog" ? { source } : {}),
  };
};

const parseModelConfig = (config: ModelRecord["configJson"] | Record<string, unknown> | null | undefined) => {
  if (!config) return {} as Record<string, unknown>;
  if (typeof config !== "string") return config;
  try {
    const parsed = JSON.parse(config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const cursorControlId = (id: string, category: string): ModelExecutionControl["id"] | null => {
  if (/thought|reason|effort/i.test(`${id} ${category}`)) return "reasoningEffort";
  if (/context/i.test(id)) return "contextMode";
  if (/speed|fast/i.test(id)) return "speed";
  return null;
};

const cursorControlLabel = (id: ModelExecutionControl["id"]): string => {
  if (id === "reasoningEffort") return "Effort";
  if (id === "contextMode") return "Context";
  return "Speed";
};

const cursorProfileFromConfig = (config: Record<string, unknown>): ModelExecutionProfile | null => {
  const rawOptions = config.cursorAcpConfigOptions;
  if (!Array.isArray(rawOptions)) return null;
  const controls = rawOptions.flatMap((candidate): ModelExecutionControl[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (entry.type !== "select" || typeof entry.id !== "string" || !Array.isArray(entry.options)) return [];
    const category = typeof entry.category === "string" ? entry.category : "";
    const id = cursorControlId(entry.id, category);
    if (!id) return [];
    const options = entry.options.flatMap((candidateOption) => {
      if (!candidateOption || typeof candidateOption !== "object" || Array.isArray(candidateOption)) return [];
      const rawOption = candidateOption as Record<string, unknown>;
      let value: string | null = null;
      if (typeof rawOption.value === "string") value = rawOption.value;
      else if (typeof rawOption.id === "string") value = rawOption.id;
      if (!value) return [];
      let label = value;
      if (typeof rawOption.name === "string") label = rawOption.name;
      else if (typeof rawOption.label === "string") label = rawOption.label;
      return [option(value, label, typeof rawOption.description === "string" ? rawOption.description : undefined)];
    });
    return options.length > 0 ? [control(id, cursorControlLabel(id), options)] : [];
  });
  return controls.length > 0 ? { controls } : null;
};

/** Returns the controls a configured model actually supports, using discovery metadata when available. */
export const buildModelExecutionProfile = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  modelId: string,
  modelConfig?: ModelRecord["configJson"] | Record<string, unknown> | null,
): ModelExecutionProfile => {
  if (providerType === "azure-legacy") return { controls: [] };
  const config = parseModelConfig(modelConfig);
  const discovered = normalizeExecutionProfile(config[MODEL_CONFIG_EXECUTION_PROFILE_KEY]);
  if (discovered?.source === "provider") return discovered;
  if (providerType === "cursor-agent") {
    return discovered ?? cursorProfileFromConfig(config) ?? { controls: [] };
  }
  const known = getKnownModelExecutionProfile(providerType, providerFamily, modelId);
  if (known.controls.length > 0 || discovered?.source === "catalog") return known;
  // Older Codex discovery rows had no provenance. An unknown model could only
  // receive such a profile from app-server, so it remains safe to trust.
  if (providerType === "codex-cli" && discovered) return discovered;
  return { controls: [] };
};

const selectedControlValue = (controlEntry: ModelExecutionControl | undefined, value: string) => {
  if (!controlEntry || !value || value === "auto") return undefined;
  return controlEntry.options.some((entry) => entry.value === value) ? value : undefined;
};

export interface RunReasoningInput {
  reasoningEffort?: string;
  anthropicEffort?: string;
  executionOptions?: ProviderExecutionOptions;
}

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
  const rawEffort = providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic")
    ? anthropicEffort
    : reasoningEffort;
  const chosenEffort = selectedControlValue(reasoningControl, rawEffort);
  const secondaryControl = profile.controls.find((entry) => entry !== reasoningControl);
  const chosenMode = selectedControlValue(secondaryControl, executionMode);
  const executionOptions: ProviderExecutionOptions = {};
  const result: RunReasoningInput = {};

  if (chosenEffort) {
    if (providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic")) {
      const mappedEffort = chosenEffort === "ultracode" ? "xhigh" : chosenEffort;
      result.anthropicEffort = mappedEffort;
      executionOptions.anthropicEffort = mappedEffort;
      if (chosenEffort === "ultracode") executionOptions.workflowMode = "ultracode";
    } else if (reasoningControl?.id === "thinkingLevel") {
      executionOptions.thinkingLevel = chosenEffort;
    } else {
      result.reasoningEffort = chosenEffort;
      executionOptions.reasoningEffort = chosenEffort;
    }
  } else if (reasoningControl && rawEffort === "auto") {
    if (providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic")) {
      executionOptions.anthropicEffort = "auto";
    } else if (reasoningControl.id === "thinkingLevel") {
      executionOptions.thinkingLevel = "auto";
    } else {
      executionOptions.reasoningEffort = "auto";
    }
  }

  if (chosenMode && secondaryControl) {
    if (secondaryControl.id === "serviceTier") executionOptions.serviceTier = chosenMode;
    if (secondaryControl.id === "speed") executionOptions.speed = chosenMode;
    if (secondaryControl.id === "contextMode") executionOptions.contextMode = chosenMode;
    if (secondaryControl.id === "workflowMode") executionOptions.workflowMode = chosenMode;
  } else if (secondaryControl && executionMode === "auto") {
    if (secondaryControl.id === "serviceTier") executionOptions.serviceTier = "auto";
    if (secondaryControl.id === "speed") executionOptions.speed = "auto";
    if (secondaryControl.id === "contextMode") executionOptions.contextMode = "auto";
    if (secondaryControl.id === "workflowMode") executionOptions.workflowMode = "auto";
  }

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
      findRunInList(project.orchestratedRuns, runId) ??
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

    for (const automationItem of project.automations ?? []) {
      const automationRun = findRunInList(automationItem.runs, runId);
      if (automationRun) return { project, run: automationRun };
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
    diff: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.diff },
    terminal: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.terminal },
    browser: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.browser },
    notes: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.notes },
    chat: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.chat },
    "pull-request": { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout["pull-request"] },
  },
  secondaryPanelPosition: DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.secondaryPanelPosition,
});

