export * from "./provider-metadata";
/**
 * The full skills catalog (~3.7 MB of literals) is deliberately NOT re-exported
 * here: a runtime re-export would pull it into the preload and renderer startup
 * bundles. Main-process code imports `@buildwarden/shared/integrated-skills-catalog`
 * directly; the renderer receives lightweight metadata over IPC and fetches a
 * skill's body on demand.
 */
export type {
  IntegratedSkillCategory,
  IntegratedSkillDefinition,
  IntegratedSkillReference,
  IntegratedSkillSource,
} from "./integrated-skills-catalog";
import type { IntegratedSkillDefinition as IntegratedSkillDefinitionType } from "./integrated-skills-catalog";

/** Renderer-facing skill descriptor without the heavy body/reference payloads. */
export type IntegratedSkillMetadata = Omit<IntegratedSkillDefinitionType, "content" | "references">;

export type ProviderType = "ai-sdk" | "azure-legacy" | "codex-cli" | "claude-code" | "cursor-agent";

export type HarnessType = "ai-sdk" | "azure-legacy" | "codex-app-server" | "claude-code" | "cursor-acp";

export type RunMode = "code" | "plan" | "ask";
export type ProjectKind = "git" | "folder";
export type RunWorkspaceType = "worktree" | "local" | "copy";
export type RunWorkspaceVcs = "git" | "folder";
export type RunListVisibility = "default" | "for-later";
export type RunKind = "standard" | "lab-implementation" | "loop-iteration";

export type ComposerCommandContext = "run" | "follow-up" | "chat";
export type ComposerCommandEffect = "set-run-mode" | "set-goal" | "native-prompt";

export interface ComposerCommandDescriptor {
  id: string;
  command: `/${string}`;
  label: string;
  description: string;
  providerType: ProviderType;
  effect: ComposerCommandEffect;
  runMode?: RunMode;
  argumentHint?: string;
  source?: "buildwarden" | "provider";
  supportsRun: boolean;
  supportsFollowUp: boolean;
  supportsChat?: boolean;
}

export interface LeadingComposerCommand {
  command: `/${string}`;
  argument: string;
}

export interface ResolvedComposerCommandPrompt {
  descriptor?: ComposerCommandDescriptor;
  prompt: string;
  mode?: RunMode;
  goalText?: string | null;
  unsupportedCommand?: `/${string}`;
}

export interface ListComposerCommandsInput {
  modelId: string;
  projectId?: string | null;
  context: ComposerCommandContext;
  query?: string | null;
}

export const PROVIDER_COMPOSER_COMMANDS = [
  {
    id: "codex-plan",
    command: "/plan",
    label: "Plan",
    description: "Use Codex plan mode for this prompt.",
    providerType: "codex-cli",
    effect: "set-run-mode",
    runMode: "plan",
    supportsRun: true,
    supportsFollowUp: true,
  },
  {
    id: "codex-goal",
    command: "/goal",
    label: "Goal",
    description: "Set or update the run goal.",
    providerType: "codex-cli",
    effect: "set-goal",
    supportsRun: true,
    supportsFollowUp: true,
  },
  {
    id: "claude-plan",
    command: "/plan",
    label: "Plan",
    description: "Use Claude Code plan mode for this prompt.",
    providerType: "claude-code",
    effect: "set-run-mode",
    runMode: "plan",
    supportsRun: true,
    supportsFollowUp: true,
  },
  {
    id: "cursor-plan",
    command: "/plan",
    label: "Plan",
    description: "Use Cursor Agent plan mode for this prompt.",
    providerType: "cursor-agent",
    effect: "set-run-mode",
    runMode: "plan",
    supportsRun: true,
    supportsFollowUp: true,
  },
] as const satisfies readonly ComposerCommandDescriptor[];

const composerCommandSupportsContext = (command: ComposerCommandDescriptor, context: ComposerCommandContext): boolean => {
  if (context === "run") {
    return command.supportsRun;
  }
  if (context === "follow-up") {
    return command.supportsFollowUp;
  }
  return command.supportsChat === true;
};

export const listComposerCommandsForProvider = (
  providerType: ProviderType | undefined | null,
  context: ComposerCommandContext,
): ComposerCommandDescriptor[] => {
  if (!providerType) {
    return [];
  }
  return PROVIDER_COMPOSER_COMMANDS.filter(
    (command) => command.providerType === providerType && composerCommandSupportsContext(command, context),
  );
};

export const mergeComposerCommandDescriptors = (
  commands: readonly ComposerCommandDescriptor[],
  context: ComposerCommandContext,
): ComposerCommandDescriptor[] => {
  const byCommand = new Map<string, ComposerCommandDescriptor>();

  for (const command of commands) {
    if (!composerCommandSupportsContext(command, context)) {
      continue;
    }
    const key = command.command.toLowerCase();
    const existing = byCommand.get(key);
    if (!existing || existing.effect === "native-prompt") {
      byCommand.set(key, {
        ...command,
        command: key as `/${string}`,
      });
      continue;
    }
    if (!existing.argumentHint && command.argumentHint) {
      byCommand.set(key, { ...existing, argumentHint: command.argumentHint });
    }
  }

  return [...byCommand.values()].sort((left, right) => left.command.localeCompare(right.command));
};

export const filterComposerCommandDescriptors = (
  commands: readonly ComposerCommandDescriptor[],
  query: string | undefined | null,
): ComposerCommandDescriptor[] => {
  const normalized = query?.trim().toLowerCase() ?? "";
  if (!normalized || normalized === "/") {
    return [...commands];
  }
  const queryWithSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const labelQuery = queryWithSlash.slice(1);
  return commands.filter(
    (command) =>
      command.command.toLowerCase().startsWith(queryWithSlash) ||
      command.label.toLowerCase().includes(labelQuery),
  );
};

export const parseLeadingComposerCommand = (value: string): LeadingComposerCommand | null => {
  const trimmedStart = value.trimStart();
  const match = /^\/([A-Za-z][A-Za-z0-9_.:-]*)(?=$|\s)([\s\S]*)$/.exec(trimmedStart);
  if (!match) {
    return null;
  }
  return {
    command: `/${match[1]!.toLowerCase()}`,
    argument: (match[2] ?? "").trimStart(),
  };
};

const splitGoalCommandArgument = (argument: string): { goalText: string | null; prompt: string } => {
  const normalized = argument.trimStart();
  const newlineMatch = /\r?\n/.exec(normalized);
  if (!newlineMatch) {
    const goalText = normalized.trim();
    return { goalText: goalText || null, prompt: "" };
  }

  const goalText = normalized.slice(0, newlineMatch.index).trim();
  const prompt = normalized.slice(newlineMatch.index + newlineMatch[0].length).trimStart();
  return { goalText: goalText || null, prompt };
};

export const resolveComposerCommandPrompt = (
  value: string,
  providerType: ProviderType | undefined | null,
  context: ComposerCommandContext,
): ResolvedComposerCommandPrompt => {
  const parsed = parseLeadingComposerCommand(value);
  if (!parsed) {
    return { prompt: value };
  }

  const descriptor = listComposerCommandsForProvider(providerType, context).find((command) => command.command === parsed.command);
  if (!descriptor) {
    return { prompt: value, unsupportedCommand: parsed.command };
  }

  if (descriptor.effect === "set-run-mode") {
    return {
      descriptor,
      prompt: parsed.argument,
      mode: descriptor.runMode,
    };
  }

  if (descriptor.effect === "native-prompt") {
    return {
      descriptor,
      prompt: value,
    };
  }

  const goal = splitGoalCommandArgument(parsed.argument);
  return {
    descriptor,
    prompt: goal.prompt,
    goalText: goal.goalText,
  };
};

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunEventType =
  | "status"
  | "log"
  | "output"
  | "error"
  | "tool-call"
  | "tool-result"
  | "approval-requested"
  | "approval-resolved"
  | "user-input-requested"
  | "plan-updated"
  | "plan-progress"
  | "diff-updated"
  | "tool-progress"
  | "request"
  | "plan";

export type RunToolName = "read_file" | "write_file" | "edit_file" | "delete_file" | "list_files" | "search_repo" | "run_shell";

const TEXT_LIKE_FILE_EXTENSIONS = new Set([
  "c",
  "cjs",
  "cpp",
  "cs",
  "css",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "log",
  "md",
  "mdx",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

export const isTextLikeFileName = (value: string): boolean => {
  const fileName = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return false;
  }
  return TEXT_LIKE_FILE_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLowerCase());
};

export type RunPlanStepStatus = "pending" | "inProgress" | "completed";

// Provider-specific plan and task updates normalize into this shared contract,
// including Cursor ACP session/update payloads and cursor/update_todos notifications.
export type RunPlanProgressSource = "codex" | "claude" | "ai-sdk" | "cursor-acp";

export interface RunPlanProgressStep {
  title: string;
  status: RunPlanStepStatus;
}

export interface RunPlanProgressPayload {
  explanation?: string | null;
  steps: RunPlanProgressStep[];
  source?: RunPlanProgressSource;
}

export const normalizeRunPlanStepStatus = (value: unknown): RunPlanStepStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (normalized === "completed" || normalized === "done" || normalized === "complete") {
    return "completed";
  }
  if (
    normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "current" ||
    normalized === "progress"
  ) {
    return "inProgress";
  }
  return "pending";
};

const cleanRunPlanStepTitle = (value: string) =>
  value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

const readRunPlanProgressRecord = (value: unknown, index: number): RunPlanProgressStep | null => {
  if (typeof value === "string") {
    const title = cleanRunPlanStepTitle(value);
    return title ? { title, status: "pending" } : null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawTitle = record.title ?? record.step ?? record.content ?? record.text;
  const title = typeof rawTitle === "string" ? cleanRunPlanStepTitle(rawTitle) : "";
  return {
    title: title || `Step ${String(index + 1)}`,
    status: normalizeRunPlanStepStatus(record.status),
  };
};

export const normalizeRunPlanProgressPayload = (
  value: unknown,
  fallbackSource?: RunPlanProgressSource,
): RunPlanProgressPayload | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  let rawSteps: unknown[] = [];
  if (Array.isArray(record.steps)) {
    rawSteps = record.steps;
  } else if (Array.isArray(record.plan)) {
    rawSteps = record.plan;
  }
  const steps = rawSteps
    .map(readRunPlanProgressRecord)
    .filter((step): step is RunPlanProgressStep => step !== null)
    .slice(0, 24);
  if (steps.length === 0) {
    return null;
  }
  let explanation: string | null | undefined;
  if (typeof record.explanation === "string") {
    explanation = record.explanation.trim();
  } else if (record.explanation === null) {
    explanation = null;
  }
  const rawSource = record.source;
  const source =
    rawSource === "codex" || rawSource === "claude" || rawSource === "ai-sdk" || rawSource === "cursor-acp"
      ? rawSource
      : fallbackSource;
  return {
    ...(explanation !== undefined ? { explanation } : {}),
    steps,
    ...(source ? { source } : {}),
  };
};

export const formatRunPlanProgressContent = (progress: RunPlanProgressPayload): string => {
  const lines: string[] = [];
  if (progress.explanation?.trim()) {
    lines.push(progress.explanation.trim(), "");
  }
  for (const [index, step] of progress.steps.entries()) {
    let marker = "[ ]";
    if (step.status === "completed") {
      marker = "[x]";
    } else if (step.status === "inProgress") {
      marker = "[-]";
    }
    lines.push(`${String(index + 1)}. ${marker} ${step.title}`);
  }
  return lines.join("\n").trim();
};

// Provider-specific subagent (sub-thread / collab agent / task tool) activity
// normalizes into this shared contract. Lifecycle updates ride on
// "tool-progress"/"tool-result" chunks carrying `metadata.subagent`; chunks that
// originate inside a subagent carry `metadata.subagentId` so the renderer can
// group them under the owning subagent card.
export type RunSubagentSource = "claude-code" | "codex-cli" | "cursor-acp";

export type RunSubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface RunSubagentUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface RunSubagentInfo {
  /** Provider-scoped stable id: Claude task_id, Codex child threadId, Cursor agentId/toolCallId. */
  id: string;
  source: RunSubagentSource;
  status: RunSubagentStatus;
  /** Subagent type or nickname, e.g. "general-purpose". */
  name?: string;
  model?: string;
  /** Short human label for what was delegated. */
  description?: string;
  /** Full delegation prompt when the provider exposes it. */
  prompt?: string;
  /** Final output text when known. */
  summary?: string;
  /** Live activity label while running (e.g. Claude task_progress description). */
  activity?: string;
  lastToolName?: string;
  isBackground?: boolean;
  usage?: RunSubagentUsage;
  startedAtMs?: number;
  endedAtMs?: number;
}

const COMPLETED_SUBAGENT_STATUSES = new Set(["completed", "complete", "done", "success"]);
const FAILED_SUBAGENT_STATUSES = new Set(["failed", "errored", "error", "failure"]);
const CANCELLED_SUBAGENT_STATUSES = new Set(["cancelled", "canceled", "interrupted", "shutdown"]);
const RUNNING_SUBAGENT_STATUSES = new Set(["running", "inprogress", "active", "started"]);

export const normalizeRunSubagentStatus = (value: unknown): RunSubagentStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
  if (COMPLETED_SUBAGENT_STATUSES.has(normalized)) return "completed";
  if (FAILED_SUBAGENT_STATUSES.has(normalized)) return "failed";
  if (CANCELLED_SUBAGENT_STATUSES.has(normalized)) return "cancelled";
  if (RUNNING_SUBAGENT_STATUSES.has(normalized)) return "running";
  return "pending";
};

const asSharedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asSharedFiniteNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const normalizeRunSubagentUsage = (value: unknown): RunSubagentUsage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const usage: RunSubagentUsage = {};
  const totalTokens = asSharedFiniteNumber(raw.totalTokens ?? raw.total_tokens);
  const toolUses = asSharedFiniteNumber(raw.toolUses ?? raw.tool_uses);
  const durationMs = asSharedFiniteNumber(raw.durationMs ?? raw.duration_ms);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
};

const normalizeRunSubagentSource = (value: unknown): RunSubagentSource => {
  if (value === "claude-code" || value === "codex-cli" || value === "cursor-acp") return value;
  return "claude-code";
};

export const normalizeRunSubagentInfo = (value: unknown): RunSubagentInfo | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asSharedString(record.id);
  if (!id) {
    return null;
  }
  const source = normalizeRunSubagentSource(record.source);
  const usage = normalizeRunSubagentUsage(record.usage);
  const name = asSharedString(record.name);
  const model = asSharedString(record.model);
  const description = asSharedString(record.description);
  const prompt = asSharedString(record.prompt);
  const summary = asSharedString(record.summary);
  const activity = asSharedString(record.activity);
  const lastToolName = asSharedString(record.lastToolName);
  const startedAtMs = asSharedFiniteNumber(record.startedAtMs);
  const endedAtMs = asSharedFiniteNumber(record.endedAtMs);
  return {
    id,
    source,
    status: normalizeRunSubagentStatus(record.status),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(summary ? { summary } : {}),
    ...(activity ? { activity } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(record.isBackground === true ? { isBackground: true } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(endedAtMs !== undefined ? { endedAtMs } : {}),
  };
};

/** Merge a subagent update into prior state, keeping known fields when the update omits them. */
export const mergeRunSubagentInfo = (previous: RunSubagentInfo | undefined, next: RunSubagentInfo): RunSubagentInfo => ({
  ...previous,
  ...next,
  name: next.name ?? previous?.name,
  model: next.model ?? previous?.model,
  description: next.description ?? previous?.description,
  prompt: next.prompt ?? previous?.prompt,
  summary: next.summary ?? previous?.summary,
  activity: next.activity ?? previous?.activity,
  lastToolName: next.lastToolName ?? previous?.lastToolName,
  isBackground: next.isBackground ?? previous?.isBackground,
  // Usage updates are often partial (e.g. a token-count-only refresh), so
  // merge field-by-field instead of replacing the whole object.
  usage: next.usage && previous?.usage ? { ...previous.usage, ...next.usage } : next.usage ?? previous?.usage,
  startedAtMs: next.startedAtMs ?? previous?.startedAtMs,
  endedAtMs: next.endedAtMs ?? previous?.endedAtMs,
});

export const isTerminalRunSubagentStatus = (status: RunSubagentStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

export const runSubagentStreamId = (subagentId: string): string => `subagent:${subagentId}`;

export const formatRunSubagentContent = (subagent: RunSubagentInfo): string => {
  const label = subagent.name ? `${subagent.name}` : "subagent";
  const heading = subagent.description?.trim() || subagent.prompt?.trim().split("\n")[0] || label;
  if (subagent.status === "completed" && subagent.summary?.trim()) {
    return subagent.summary.trim();
  }
  return heading;
};

/**
 * Builds the run chunk that carries a subagent lifecycle update. All updates
 * for one subagent share a stream id and replace the same run step; terminal
 * updates switch to "tool-result" so the step reads as finished.
 */
export const buildRunSubagentChunk = (
  subagent: RunSubagentInfo,
  metadata: Record<string, unknown> = {},
): HarnessRunChunk => ({
  type: isTerminalRunSubagentStatus(subagent.status) ? "tool-result" : "tool-progress",
  title: `Subagent: ${subagent.name ?? "agent"}`,
  value: formatRunSubagentContent(subagent),
  metadata: {
    provider: subagent.source,
    toolName: "subagent",
    callId: subagent.id,
    subagent,
    streamId: runSubagentStreamId(subagent.id),
    replace: true,
    ...(isTerminalRunSubagentStatus(subagent.status) ? { ok: subagent.status === "completed" } : {}),
    ...metadata,
  },
});

export const parseRunPlanProgressStepsFromMarkdown = (
  content: string,
  options: { inferStatus?: boolean; maxSteps?: number } = {},
): RunPlanProgressStep[] => {
  const steps: RunPlanProgressStep[] = [];
  const inferStatus = options.inferStatus === true;
  const maxSteps = options.maxSteps ?? 24;

  const statusFromText = (value: string): RunPlanStepStatus => {
    if (!inferStatus) {
      return "pending";
    }
    const normalized = value.toLowerCase();
    if (normalized.includes("done") || normalized.includes("complete")) {
      return "completed";
    }
    if (normalized.includes("active") || normalized.includes("current") || normalized.includes("progress")) {
      return "inProgress";
    }
    return "pending";
  };

  const statusFromCheckbox = (marker: string | undefined): RunPlanStepStatus => {
    if (!inferStatus) {
      return "pending";
    }
    if (marker === "x" || marker === "X") {
      return "completed";
    }
    return marker === "-" ? "inProgress" : "pending";
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    const tableCells = trimmedLine
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (
      tableCells.length >= 2 &&
      !tableCells.every((cell) => /^:?-+:?$/.test(cell)) &&
      !tableCells.some((cell) => /^#?$|^step$|^status$|^state$|^task$|^description$|^files?$/i.test(cell))
    ) {
      const numericIndex = tableCells.findIndex((cell) => /^\d+[.)]?$/.test(cell));
      const statusCell = tableCells.find((cell) => /pending|active|current|progress|done|complete/i.test(cell));
      const titleCell = tableCells.find((cell, cellIndex) => cellIndex !== numericIndex && cell !== statusCell);
      const title = titleCell ? cleanRunPlanStepTitle(titleCell) : "";
      if (title) {
        steps.push({
          title,
          status: statusCell ? statusFromText(statusCell) : "pending",
        });
      }
      continue;
    }

    const checkbox = /^\s*(?:[-*]|\d{1,6}[.)])\s+\[([ xX-])\]\s+([^\r\n]{1,4000})$/.exec(line);
    if (checkbox) {
      const marker = checkbox[1];
      const title = cleanRunPlanStepTitle(checkbox[2] ?? "");
      if (title) {
        steps.push({
          title,
          status: statusFromCheckbox(marker),
        });
      }
      continue;
    }

    const numbered = /^\s*(?:#{1,6}\s*)?(\d{1,6})[.)]\s+([^\r\n]{1,4000})$/.exec(line);
    if (numbered) {
      const title = cleanRunPlanStepTitle(numbered[2] ?? "");
      if (title) {
        steps.push({
          title,
          status: "pending",
        });
      }
    }

    if (steps.length >= maxSteps) {
      return steps.slice(0, maxSteps);
    }
  }
  return steps.slice(0, maxSteps);
};

/** Activity log stream id for in-place updates while `run_shell` is executing (matches final tool-result chunk). */
export const runShellActivityStreamId = (callId: string) => `shell-stream-${callId}`;

/** Thrown when the project repo is in detached HEAD (`git branch --show-current` is empty). */
export const GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE =
  "The GIT repository is not on a named branch and in a detached state. Please switch to a regular branch.";

/**
 * Previous user-facing wording; still matched by {@link isDetachedHeadProjectErrorMessage} so errors from an older
 * main-process bundle (e.g. dev session before restart) or wrapped IPC strings still trigger recovery UI.
 */
export const LEGACY_GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE =
  "The repository is not currently on a named branch.";

/**
 * True when an error string is (or wraps) the detached-HEAD project message.
 * Electron’s IPC layer often prefixes with `Error invoking remote method '…': Error: …`, so use this instead of `===`.
 * Matches current and {@link LEGACY_GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE} wording.
 */
export function isDetachedHeadProjectErrorMessage(message: string): boolean {
  return (
    message.includes(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE) ||
    message.includes(LEGACY_GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE)
  );
}

export type WorktreeStatus = "ready" | "busy" | "released" | "failed";

export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  /** Project-wide branch used for new worktrees and as the default merge / PR target. */
  baseBranch: string;
  kind: ProjectKind;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface ProviderAccountRecord {
  id: string;
  providerType: ProviderType;
  label: string;
  apiBaseUrl: string | null;
  apiKeyRef: string;
  configJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: string;
  providerAccountId: string;
  modelId: string;
  displayName: string;
  baseUrlOverride: string | null;
  configJson: string;
  capabilitiesJson: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  providerAccountId: string;
  modelId: string;
  harnessType: HarnessType;
  mode: RunMode;
  workspaceType: RunWorkspaceType;
  workspaceVcs: RunWorkspaceVcs;
  prompt: string;
  goalText: string | null;
  /** Derived at read time from initial/follow-up user prompts, run goal text, and submitted user-input answers. */
  userInputSearchText?: string;
  /** Derived at read time from the latest initial/follow-up prompt or submitted user-input answer. */
  lastUserInputAt?: string;
  status: RunStatus;
  branchName: string;
  worktreePath: string;
  summary: string | null;
  errorMessage: string | null;
  lastProviderResponseId: string | null;
  inputTokens: number;
  outputTokens: number;
  listVisibility: RunListVisibility;
  /** Derived at read time from unresolved user-input request steps; not stored in the runs table. */
  pendingUserInputRequest?: boolean | number;
  kind: RunKind;
  labThreadId: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  lineageTitle: string | null;
  /** Project-board task that launched this run, when applicable. */
  projectTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type RunNoteStatus = "open" | "closed";

export interface RunNoteRecord {
  id: string;
  runId: string;
  content: string;
  status: RunNoteStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RunNoteInput {
  content: string;
}

export interface UpdateRunNoteInput {
  content?: string;
  status?: RunNoteStatus;
}

export type ProjectTaskStatus = "open" | "in_progress" | "in_review" | "done";

export interface ProjectTaskRecord {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: ProjectTaskStatus;
  /** Most recent run launched from this task. */
  runId: string | null;
  /** PR/MR created from the linked run, used for merged-state reconciliation. */
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskInput {
  title: string;
  prompt: string;
}

export interface UpdateProjectTaskInput {
  title?: string;
  prompt?: string;
  status?: ProjectTaskStatus;
}

export interface ProjectTaskChangedPayload {
  projectId: string;
  taskId: string;
  status: ProjectTaskStatus;
}

export type ProjectLabThreadKind = "implementation" | "rfc";
export type ProjectLabMode = "new-feature" | "bugfix" | "refactoring" | "rfc-only";
export type ProjectLabThreadStatus =
  | "queued"
  | "running"
  | "reviewing"
  | "cancelled"
  | "completed"
  | "failed";
export type ProjectLabOrigin = "manual" | "idle" | "task";
export type ProjectLabEventRole = "system" | "implementation" | "review" | "rfc";

export interface ProjectLabSettings {
  enabled: boolean;
  maxThreadsPerDay: number;
  maxConcurrentThreads: number;
  implementationModelId: string | null;
  reviewModelId: string | null;
}

export interface ProjectLabThreadRecord {
  id: string;
  projectId: string;
  kind: ProjectLabThreadKind;
  mode: ProjectLabMode;
  status: ProjectLabThreadStatus;
  origin: ProjectLabOrigin;
  title: string;
  summary: string;
  outcome: string | null;
  seedPrompt: string | null;
  implementationPrompt: string | null;
  implementationRunId: string | null;
  implementationModelId: string | null;
  reviewModelId: string | null;
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLabEventRecord {
  id: string;
  threadId: string;
  role: ProjectLabEventRole;
  label: string;
  content: string;
  createdAt: string;
}

export interface ProjectLabThreadDetail {
  thread: ProjectLabThreadRecord;
  events: ProjectLabEventRecord[];
  implementationRun: RunRecord | null;
}

/**
 * Project Loops: fully automated feature/fix pipelines. A loop plans the work,
 * implements it in one or more sequential PR-sized iterations, creates PRs/MRs
 * through the Git hosting API, waits for merges, addresses review comments,
 * and gates UI-affecting changes behind screenshot approval (manual or AI).
 */
export type ProjectLoopMergePolicy = "auto-merge" | "wait-for-approval";
export type ProjectLoopUiChangePolicy = "auto" | "manual-approval" | "ai-review";
/** Whether the loop's review model posts a visible code review on each created PR/MR. */
export type ProjectLoopPrReviewPolicy = "none" | "ai-review";

export type ProjectLoopStatus =
  | "planning"
  | "implementing"
  | "awaiting-ui-approval"
  | "reviewing-ui"
  | "creating-pr"
  | "awaiting-merge"
  | "addressing-comments"
  | "auditing"
  | "completed"
  | "failed"
  | "cancelled";

export type ProjectLoopIterationStatus =
  | "pending"
  | "implementing"
  | "awaiting-ui-approval"
  | "reviewing-ui"
  | "creating-pr"
  | "awaiting-merge"
  | "addressing-comments"
  | "merged"
  | "failed"
  | "cancelled"
  | "skipped";

export type ProjectLoopEventRole = "system" | "planner" | "runner" | "ui-review" | "forge" | "audit" | "user";

export type ProjectLoopUiReviewStatus =
  | "pending"
  | "approved"
  | "changes-requested"
  | "ai-approved"
  | "ai-changes-requested";

/** Provider types whose models can drive a loop (local CLIs with real computer-use / screenshot capabilities). */
export const LOOP_CAPABLE_PROVIDER_TYPES: readonly ProviderType[] = ["codex-cli", "claude-code"];

export const isLoopCapableProviderType = (providerType: ProviderType): boolean =>
  LOOP_CAPABLE_PROVIDER_TYPES.includes(providerType);

/** Active loop statuses that the engine resumes after an app restart. */
export const ACTIVE_PROJECT_LOOP_STATUSES: readonly ProjectLoopStatus[] = [
  "planning",
  "implementing",
  "awaiting-ui-approval",
  "reviewing-ui",
  "creating-pr",
  "awaiting-merge",
  "addressing-comments",
  "auditing",
];

export const isActiveProjectLoopStatus = (status: ProjectLoopStatus): boolean =>
  ACTIVE_PROJECT_LOOP_STATUSES.includes(status);

export interface ProjectLoopRecord {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  runnerModelId: string;
  reviewModelId: string | null;
  mergePolicy: ProjectLoopMergePolicy;
  uiChangePolicy: ProjectLoopUiChangePolicy;
  prReviewPolicy: ProjectLoopPrReviewPolicy;
  /** Optional user-provided extra instructions appended to the screenshot-capture prompt. */
  uiReviewInstructions: string | null;
  baseBranch: string;
  status: ProjectLoopStatus;
  planSummary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProjectLoopIterationRecord {
  id: string;
  loopId: string;
  iterationIndex: number;
  title: string;
  objective: string;
  status: ProjectLoopIterationStatus;
  runId: string | null;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  targetBranch: string | null;
  errorMessage: string | null;
  /** 1 once the loop's AI code review was posted on this iteration's PR/MR (single review pass per PR). */
  aiReviewPosted: number;
  /** JSON string array of forge comment/thread ids that were already addressed by the loop. */
  processedCommentIdsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLoopEventRecord {
  id: string;
  loopId: string;
  iterationId: string | null;
  role: ProjectLoopEventRole;
  label: string;
  content: string;
  createdAt: string;
}

export interface ProjectLoopUiReviewRecord {
  id: string;
  loopId: string;
  iterationId: string;
  /** Review round within the iteration (feedback cycles increment it). */
  round: number;
  pageName: string;
  description: string | null;
  /** Absolute path of the stored screenshot copy (app data dir, survives worktree cleanup). */
  imagePath: string;
  status: ProjectLoopUiReviewStatus;
  feedback: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLoopListItem {
  loop: ProjectLoopRecord;
  iterations: ProjectLoopIterationRecord[];
  /** Implementation runs of the iterations (kind "loop-iteration"; hidden from normal run lists). */
  runs: RunRecord[];
  pendingUiReviewCount: number;
}

export interface ProjectLoopDetail {
  loop: ProjectLoopRecord;
  iterations: ProjectLoopIterationRecord[];
  events: ProjectLoopEventRecord[];
  uiReviews: ProjectLoopUiReviewRecord[];
  /** Implementation runs referenced by the iterations, for provider-output links. */
  runs: RunRecord[];
}

export interface CreateProjectLoopInput {
  projectId: string;
  name: string;
  prompt: string;
  runnerModelId: string;
  reviewModelId?: string | null;
  mergePolicy: ProjectLoopMergePolicy;
  uiChangePolicy: ProjectLoopUiChangePolicy;
  prReviewPolicy?: ProjectLoopPrReviewPolicy;
  uiReviewInstructions?: string | null;
  baseBranch?: string;
}

export interface ProjectLoopUiReviewDecisionInput {
  decision: "approve" | "request-changes";
  feedback?: string;
}

export type ProjectLoopUnavailableReason = "not-git" | "no-remote" | "no-forge-token" | "no-local-models";

export interface ProjectLoopAvailability {
  available: boolean;
  reason?: ProjectLoopUnavailableReason;
  provider?: ProjectForgeProvider;
  repoLabel?: string;
  hasToken: boolean;
  hasLocalModels: boolean;
}

/** Payload sent to the renderer whenever a loop changes (status, events, reviews). */
export interface ProjectLoopChangedPayload {
  loopId: string;
  projectId: string;
}

export type ProjectInsightKind =
  | "architecture-graph"
  | "dependency-gravity"
  | "repo-historian"
  | "codebase-mood"
  | "curiosity-mode"
  | "narrative-branching";

export interface ProjectInsightRecord {
  id: string;
  projectId: string;
  kind: ProjectInsightKind;
  title: string;
  summary: string;
  dataJson: string;
  modelId: string | null;
  generatedAt: string;
  updatedAt: string;
}

export interface ProjectInsightNode {
  id: string;
  label: string;
  path: string;
  group: string;
  metric: number;
  ownerLabel?: string | null;
}

export interface ProjectInsightEdge {
  from: string;
  to: string;
  weight: number;
}

export interface ArchitectureGraphInsightData {
  generatedFromPath: string;
  mermaid: string;
  nodes: ProjectInsightNode[];
  edges: ProjectInsightEdge[];
  hotspots: Array<{
    path: string;
    label: string;
    commitCount: number;
    ownerLabel: string | null;
  }>;
  ownership: Array<{
    ownerLabel: string;
    fileCount: number;
  }>;
}

export interface DependencyGravityInsightData {
  mermaid: string;
  nodes: Array<ProjectInsightNode & { inbound: number; outbound: number; gravityScore: number }>;
  edges: ProjectInsightEdge[];
  summaryStats: {
    totalModules: number;
    totalEdges: number;
    averageInbound: number;
  };
}

export interface InsightToneSection {
  label: string;
  score: number;
  summary: string;
}

export interface RepoHistorianInsightData {
  synopsis: string;
  sections: Array<{
    title: string;
    detail: string;
  }>;
  notableCommits: Array<{
    sha: string;
    title: string;
    author: string;
    date: string;
  }>;
}

export interface CodebaseMoodInsightData {
  overallScore: number;
  posture: string;
  sections: InsightToneSection[];
  findings: Array<{
    title: string;
    detail: string;
    filePath: string | null;
  }>;
  nextMoves: string[];
}

export interface CuriosityModeInsightData {
  themes: Array<{
    title: string;
    whyItMatters: string;
    evidence: string[];
  }>;
  suggestedPrompts: string[];
}

export interface NarrativeBranchingInsightData {
  branches: Array<{
    branchName: string;
    summary: string;
    runCount: number;
    statuses: string[];
    latestRunId: string | null;
    latestUpdatedAt: string | null;
    prompts: string[];
  }>;
  timeline: Array<{
    runId: string;
    branchName: string;
    status: string;
    createdAt: string;
    title: string;
  }>;
}

export type ProjectInsightData =
  | ArchitectureGraphInsightData
  | DependencyGravityInsightData
  | RepoHistorianInsightData
  | CodebaseMoodInsightData
  | CuriosityModeInsightData
  | NarrativeBranchingInsightData;

export interface GenerateProjectInsightInput {
  projectId: string;
  kind: ProjectInsightKind;
  modelId?: string;
}

export interface RunTokenUsage {
  /** Processed input tokens used for persisted run/project totals. */
  inputTokens: number;
  /** Processed output tokens used for persisted run/project totals. */
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Processed total when reported by the provider. */
  totalTokens?: number;
  /** Current context-window usage, when the provider exposes it. */
  usedTokens?: number;
  /** Cumulative tokens processed across provider calls, distinct from current context. */
  totalProcessedTokens?: number;
  /** Provider/model context window size, when known. */
  maxTokens?: number;
  lastUsedTokens?: number;
  lastInputTokens?: number;
  lastCachedInputTokens?: number;
  lastOutputTokens?: number;
  lastReasoningTokens?: number;
}

export interface RunStepRecord {
  id: string;
  runId: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
}

export interface WorktreeRecord {
  id: string;
  projectId: string;
  runId: string;
  branchName: string;
  worktreePath: string;
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettingRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ProviderCapabilityMap {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsCustomBaseUrl: boolean;
}

/**
 * Optional keys in {@link ProviderAccountInput.config} / stored `configJson`:
 * - {@link PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY} — selects the AI SDK provider family.
 * - `defaultHeaders` — forwarded to the OpenAI-compatible AI SDK provider.
 * - {@link PROVIDER_CONFIG_AZURE_API_VERSION_KEY} — Azure OpenAI-style `api-version` query param (Azure Legacy provider).
 */
export const PROVIDER_CONFIG_AZURE_API_VERSION_KEY = "azureApiVersion";
export const PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY = "providerFamily";
export const PROVIDER_CONFIG_DEFAULT_HEADERS_KEY = "defaultHeaders";
export const PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY = "codexBinaryPath";
export const PROVIDER_CONFIG_CODEX_HOME_PATH_KEY = "codexHomePath";
export const PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY = "claudeBinaryPath";
export const PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY = "claudeLaunchArgs";
export const PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY = "cursorBinaryPath";
export const PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY = "cursorApiEndpoint";

export interface ProviderAccountInput {
  providerType: ProviderType;
  label: string;
  apiKey: string;
  apiBaseUrl?: string | null;
  config?: Record<string, unknown>;
}

export interface ModelInput {
  providerAccountId: string;
  modelId: string;
  displayName: string;
  baseUrlOverride?: string | null;
  config?: Record<string, unknown>;
  capabilities?: Partial<ProviderCapabilityMap>;
  enabled?: boolean;
}

export interface ProviderAvailableModel {
  modelId: string;
  displayName: string;
  source: "provider" | "curated";
  capabilities?: Partial<ProviderCapabilityMap>;
  config?: Record<string, unknown>;
  unavailableReason?: string;
}

export interface ListAvailableProviderModelsInput {
  providerAccountId: string;
}

export interface ListAvailableProviderModelsResult {
  models: ProviderAvailableModel[];
  errorMessage?: string;
}

export interface ProviderAvailableModelsContext {
  providerAccountId: string;
  providerType: ProviderType;
  config: Record<string, unknown>;
  apiBaseUrl?: string | null;
  networkProxy?: NetworkProxyRuntimeConfig;
}

export const MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY = "openaiReasoningEffort";
export const MODEL_CONFIG_ANTHROPIC_EFFORT_KEY = "anthropicEffort";
export const MODEL_CONFIG_CODEX_REASONING_EFFORT_KEY = "codexReasoningEffort";

export interface ProjectInput {
  name?: string;
  repoPath: string;
}

export interface HostDirectoryBrowseInput {
  /** Absolute host path. Omit to list filesystem roots. */
  path?: string;
}

export interface HostDirectoryEntry {
  name: string;
  path: string;
}

export interface HostDirectoryListing {
  path: string | null;
  parentPath: string | null;
  entries: HostDirectoryEntry[];
}

export interface ProjectFolderGitStatus {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
}

export interface RunInput {
  projectId: string;
  providerAccountId: string;
  modelId: string;
  harnessType: HarnessType;
  mode: RunMode;
  yoloMode?: boolean;
  workspaceType: RunWorkspaceType;
  workspaceVcs?: RunWorkspaceVcs;
  baseBranch?: string;
  prompt: string;
  goalText?: string | null;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
  kind?: RunKind;
  labThreadId?: string | null;
  projectTaskId?: string | null;
}

export interface ContinueRunInput {
  sourceRunId: string;
  providerAccountId: string;
  modelId: string;
  harnessType: HarnessType;
  mode: RunMode;
  yoloMode?: boolean;
  prompt: string;
  goalText?: string | null;
  includeWorkspaceChanges?: boolean;
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export interface RunFollowUpOptions {
  modelId?: string;
  mode?: RunMode;
  yoloMode?: boolean;
  goalText?: string | null;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export type ShellApprovalDecision = "allow-once" | "allow-for-run" | "allow-always" | "deny";

/** Optional data when responding to a shell approval request (e.g. exact command for `allow-always`). */
export interface ShellApprovalRespondOptions {
  command?: string;
}

export interface RunUserInputOption {
  label: string;
  description?: string;
}

export interface RunUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: RunUserInputOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

export type RunUserInputAnswerValue = string | string[];
export type RunUserInputAnswers = Record<string, RunUserInputAnswerValue>;

export interface RunUserInputRequest {
  requestId?: string;
  title?: string;
  content?: string;
  questions: RunUserInputQuestion[];
  metadata?: Record<string, unknown>;
}

export interface RunEvent {
  runId: string;
  type: RunEventType;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  runs: RunRecord[];
  forLaterRuns: RunRecord[];
  activeRuns: RunRecord[];
  recentRuns: RunRecord[];
  tasks: ProjectTaskRecord[];
  insights: ProjectInsightRecord[];
  labThreads: ProjectLabThreadDetail[];
  loops: ProjectLoopListItem[];
}

export interface RunDetail {
  run: RunRecord;
  steps: RunStepRecord[];
  notes: RunNoteRecord[];
  diff: string;
  /** Effective workspace path for this run detail. May point at the project repo if the worktree was promoted and removed. */
  workspacePath?: string;
  /** True when this run's branch was promoted from a BuildWarden worktree back into the main project repository. */
  branchPromotedToProject?: boolean;
  /** True when the run's worktree no longer exists; diff will be empty and the UI should hide the diff panel. */
  worktreeUnavailable?: boolean;
  /**
   * True while the worktree git diff is still being loaded (see `DesktopApi.getRunWorktreeDiff`).
   * `getRunDetail` returns immediately with an empty diff and this set to true.
   */
  diffPending?: boolean;
  latestCheckpoint?: {
    round: number;
    memo?: string;
  } | null;
  canResumeFromCheckpoint?: boolean;
  interruptedRecovery?: {
    available: boolean;
    kind: "checkpoint" | "provider-session";
    title: string;
    detail: string;
    providerType?: ProviderType;
    checkpointRound?: number;
    providerSessionAvailable?: boolean;
  } | null;
  canRecoverInterruptedSession?: boolean;
  latestPromptRestorePoint?: {
    createdAt: string;
    commandType: "initial" | "follow-up";
  } | null;
}

/** Result of computing the worktree patch for a run (potentially slow; use after `getRunDetail`). */
export interface RunWorktreeDiffResult {
  diff: string;
  worktreeUnavailable: boolean;
  diffUnavailableReason?: string | null;
}

export interface RunWorkspaceFileInput {
  runId: string;
  path: string;
}

export type RunWorkspaceFileUnavailableReason =
  | "empty-path"
  | "outside-workspace"
  | "workspace-unavailable"
  | "not-found"
  | "directory"
  | "binary"
  | "read-error";

export interface RunWorkspaceFileResult {
  path: string;
  requestedPath: string;
  workspacePath: string;
  content: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  line: number | null;
  column: number | null;
  unavailableReason?: RunWorkspaceFileUnavailableReason;
  error?: string;
}

export interface RunWorkspaceFileReference {
  path: string;
  line: number | null;
  column: number | null;
}

const RUN_WORKSPACE_FILE_EXTERNAL_PROTOCOL_RE = /^(?:https?|mailto):/i;

const maybeDecodeFileReference = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeRunWorkspaceFilePath = (value: string): string =>
  value.replace(/^\/([A-Za-z]:[\\/])/, "$1");

export const isExternalRunWorkspaceHref = (href: string): boolean =>
  RUN_WORKSPACE_FILE_EXTERNAL_PROTOCOL_RE.test(href.trim());

export const parseRunWorkspaceFileReference = (value: string): RunWorkspaceFileReference | null => {
  let next = maybeDecodeFileReference(value).trim();
  if (!next || isExternalRunWorkspaceHref(next) || next.startsWith("#")) {
    return null;
  }

  let line: number | null = null;
  let column: number | null = null;

  const hashLineMatch = /#L(\d+)(?:C(\d+))?$/i.exec(next);
  if (hashLineMatch) {
    line = Number(hashLineMatch[1]);
    column = hashLineMatch[2] ? Number(hashLineMatch[2]) : null;
    next = next.slice(0, hashLineMatch.index);
  } else {
    const trailingLineMatch = /:(\d+)(?::(\d+))?$/.exec(next);
    if (trailingLineMatch) {
      line = Number(trailingLineMatch[1]);
      column = trailingLineMatch[2] ? Number(trailingLineMatch[2]) : null;
      next = next.slice(0, trailingLineMatch.index);
    }
  }

  const path = normalizeRunWorkspaceFilePath(next.trim());
  if (!path || (line != null && (!Number.isSafeInteger(line) || line < 1))) {
    return null;
  }
  if (column != null && (!Number.isSafeInteger(column) || column < 1)) {
    return null;
  }

  return {
    path,
    line,
    column,
  };
};

export interface ProjectGitConversionCandidate {
  projectId: string;
  repoPath: string;
  repoName: string;
  baseBranch: string;
  currentBranch: string;
  isWorktree: boolean;
  isDirty: boolean;
}

/** Load a GitHub PR / GitLab MR diff via `git fetch` (no hosting HTTP API). */
export interface FetchProjectPrMrDiffInput {
  prUrl: string;
  /** Optional target branch name (e.g. `main` or `develop`). When omitted, uses `origin/HEAD` or `origin/main`. */
  baseBranch?: string;
  /** Optional commit SHA to review one commit instead of the full PR/MR diff. Requires hosting API support. */
  commitSha?: string;
}

export interface ProjectPrMrDiffResult {
  diff: string;
  provider: "github" | "gitlab";
  number: number;
  baseRef: string;
}

export type ProjectForgeProvider = "github" | "gitlab";
export type ProjectForgeRequestState = "open" | "closed" | "merged" | "all";
export type ProjectForgeReviewEvent = "comment" | "approve";

export interface ProjectForgeAuthStatus {
  provider: ProjectForgeProvider;
  webBaseUrl: string;
  repoLabel: string;
  hasToken: boolean;
}

export type ProjectGitBranchProvider = ProjectForgeProvider | "unknown";

export interface ProjectGitBranchInfo {
  name: string;
  isCurrent: boolean;
  isBase: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  commitSha: string | null;
  updatedAt: string | null;
  subject: string | null;
}

export interface ProjectGitBranchOverview {
  repoPath: string;
  baseBranch: string;
  currentBranch: string;
  provider: ProjectGitBranchProvider;
  webBaseUrl: string | null;
  branches: ProjectGitBranchInfo[];
}

export interface CreateProjectBranchInput {
  branchName: string;
  startPoint: string;
  checkout?: boolean;
}

export interface RenameProjectBranchInput {
  oldName: string;
  newName: string;
}

export interface DeleteProjectBranchInput {
  branchName: string;
  force?: boolean;
}

export interface ProjectBranchLinkedRunSummary {
  id: string;
  prompt: string;
  status: RunStatus;
  workspaceType: RunWorkspaceType;
  branchName: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBranchDeleteImpact {
  branchName: string;
  linkedRuns: ProjectBranchLinkedRunSummary[];
}

export interface PushProjectBranchInput {
  branchName: string;
  setUpstream?: boolean;
}

export interface ProjectForgePrMonitorSettings {
  /** Minutes between background checks. `0` disables polling. */
  intervalMinutes: number;
}

export interface ProjectForgePrMonitorSettingsInput {
  intervalMinutes: number;
}

export interface ProjectForgePrMonitorConfig extends ProjectForgePrMonitorSettings {
  projectId: string;
  projectName: string;
  provider: ProjectForgeProvider;
  repoLabel: string;
}

export interface ProjectForgeRequestOpenPayload {
  projectId: string;
  prUrl: string;
}

export interface ProjectForgeRequestNotificationPayload extends ProjectForgeRequestOpenPayload {
  projectName: string;
  repoLabel: string;
  providerLabel: "PR" | "MR";
  title: string;
  author: string | null;
}

export interface ListProjectForgeRequestsInput {
  state?: ProjectForgeRequestState;
}

export interface ProjectForgeRequestSummary {
  provider: ProjectForgeProvider;
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  author: string | null;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectForgeUserSummary {
  username: string;
  name: string | null;
  avatarUrl: string | null;
  webUrl: string | null;
}

export interface ProjectForgeCommitSummary {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  authorName: string | null;
  authorEmail: string | null;
  authorUser: ProjectForgeUserSummary | null;
  committerName: string | null;
  committedAt: string | null;
  authoredAt: string | null;
  url: string | null;
  commentCount: number | null;
}

export type ProjectForgeChangedFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged"
  | "unknown";

export interface ProjectForgeChangedFileSummary {
  path: string;
  oldPath: string | null;
  status: ProjectForgeChangedFileStatus;
  additions: number | null;
  deletions: number | null;
  patchAvailable: boolean;
  commentCount: number;
}

export interface ProjectForgeReviewThreadComment {
  id: string;
  providerCommentId: string | null;
  body: string;
  author: ProjectForgeUserSummary | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

export interface ProjectForgeReviewThread {
  id: string;
  providerThreadId: string;
  replyToCommentId: string | null;
  provider: ProjectForgeProvider;
  path: string;
  oldPath: string | null;
  side: ProjectPrMrDiffCommentSide;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  commitSha: string | null;
  diffHunk: string | null;
  resolved: boolean | null;
  comments: ProjectForgeReviewThreadComment[];
}

export interface ProjectForgeRequestDetails extends ProjectForgeRequestSummary {
  description: string;
  authorUser: ProjectForgeUserSummary | null;
  labels: string[];
  createdAt: string | null;
  updatedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  commentCount: number | null;
  reviewCommentCount: number | null;
}

export type ProjectForgeActivityKind = "comment" | "review" | "diff-comment" | "state" | "event";

export interface ProjectForgeActivityItem {
  id: string;
  provider: ProjectForgeProvider;
  kind: ProjectForgeActivityKind;
  title: string;
  body: string | null;
  state: string | null;
  path: string | null;
  line: number | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  author: ProjectForgeUserSummary | null;
  commitSha?: string | null;
  resolved?: boolean;
}

export interface GetProjectForgeRequestDetailsInput {
  prUrl: string;
}

export interface ProjectForgeRequestDetailsResult {
  provider: ProjectForgeProvider;
  webBaseUrl: string;
  repoLabel: string;
  request: ProjectForgeRequestDetails;
  activity: ProjectForgeActivityItem[];
  commits: ProjectForgeCommitSummary[];
  files: ProjectForgeChangedFileSummary[];
  reviewThreads: ProjectForgeReviewThread[];
  warnings: string[];
}

export interface ProjectForgeRequestsResult {
  provider: ProjectForgeProvider;
  webBaseUrl: string;
  repoLabel: string;
  items: ProjectForgeRequestSummary[];
}

export interface PostProjectPrMrReviewInput {
  prUrl: string;
  body: string;
  event: ProjectForgeReviewEvent;
}

export interface ProjectForgeReviewActionResult {
  message: string;
  url?: string;
}

export interface ReplyProjectPrMrReviewThreadInput {
  prUrl: string;
  threadId: string;
  replyToCommentId?: string | null;
  body: string;
}

export interface ResolveProjectPrMrReviewThreadInput {
  prUrl: string;
  threadId: string;
  resolved: boolean;
}

export type ProjectPrMrDiffCommentSide = "old" | "new";
export type ProjectPrMrDiffCommentChangeType = "insert" | "delete" | "normal";

export interface ProjectPrMrDiffComment {
  oldPath: string;
  newPath: string;
  side: ProjectPrMrDiffCommentSide;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  changeType: ProjectPrMrDiffCommentChangeType;
  body: string;
}

export interface SubmitProjectPrMrCommentsInput {
  prUrl: string;
  body?: string;
  mode?: "review" | "single";
  comments: ProjectPrMrDiffComment[];
}

export type RunDiffReviewPriority = "high" | "medium" | "low";

export interface RunDiffReviewFinding {
  title: string;
  priority: RunDiffReviewPriority;
  filePath: string | null;
  lineNumber: number | null;
  lineReference: string | null;
  detail: string;
  recommendation: string | null;
}

export interface RunDiffReviewResult {
  headline: string;
  summary: string;
  scoreLabel: string;
  score: number;
  strengths: string[];
  findings: RunDiffReviewFinding[];
  nextSteps: string[];
  generatedAt: string;
}

export interface RunDiffReviewOptions {
  modelId?: string;
}

export interface RunPublishOptions {
  defaultTargetBranch: string;
  defaultSourceBranch: string;
  defaultDescription: string;
  suggestedTitle: string;
  targetBranches: string[];
}

export interface BookmarkSummary {
  id: string;
  originalRunId: string;
}

export interface ChatBookmarkSummary {
  id: string;
  originalChatId: string;
}

export interface BookmarkStepRecord {
  id: string;
  bookmarkId: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
}

export interface BookmarkRecord {
  id: string;
  originalRunId: string;
  projectId: string | null;
  projectName: string;
  prompt: string;
  status: RunStatus;
  branchName: string;
  /** Configured model row id at bookmark time; null for bookmarks created before this field existed. */
  modelId: string | null;
  runCreatedAt: string;
  bookmarkedAt: string;
  steps: BookmarkStepRecord[];
}

export interface ChatBookmarkRecord {
  id: string;
  originalChatId: string;
  prompt: string;
  status: RunStatus;
  /** Configured model row id at bookmark time; null for bookmarks created before this field existed. */
  modelId: string | null;
  chatCreatedAt: string;
  bookmarkedAt: string;
  steps: BookmarkStepRecord[];
}

export interface ChatSummary {
  id: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  /** Set for run-scoped chats; null for standalone chats. */
  runId?: string | null;
}

export interface AppSnapshot {
  projects: ProjectSnapshot[];
  providerAccounts: ProviderAccountRecord[];
  models: ModelRecord[];
  selectedProjectId: string | null;
  selectedRunId: string | null;
  selectedChatId: string | null;
  settings: Record<string, string>;
  bookmarks: BookmarkSummary[];
  chatBookmarks: ChatBookmarkSummary[];
  chats: ChatSummary[];
}

export interface RunProjectLabInput {
  projectId: string;
  mode?: ProjectLabMode;
  baseBranch?: string;
  topic?: string;
  origin?: ProjectLabOrigin;
  implementationModelId?: string | null;
  reviewModelId?: string | null;
}

export const NETWORK_PROXY_PROTOCOL_VALUES = ["http", "https"] as const;
export type NetworkProxyProtocol = (typeof NETWORK_PROXY_PROTOCOL_VALUES)[number];

export interface NetworkProxySettings {
  enabled: boolean;
  protocol: NetworkProxyProtocol;
  host: string;
  port: string;
  username: string;
}

export interface NetworkProxySettingsSnapshot extends NetworkProxySettings {
  hasPassword: boolean;
}

export interface NetworkProxySettingsInput extends NetworkProxySettings {
  password?: string;
  clearSavedPassword?: boolean;
}

export interface NetworkProxyRuntimeConfig {
  protocol: NetworkProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  noProxyHosts: string[];
}

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  enabled: false,
  protocol: "http",
  host: "",
  port: "",
  username: "",
};

export const DEFAULT_NETWORK_PROXY_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export const isNetworkProxyProtocol = (value: unknown): value is NetworkProxyProtocol =>
  typeof value === "string" && (NETWORK_PROXY_PROTOCOL_VALUES as readonly string[]).includes(value);

const normalizeNoProxyHost = (value: string): string => value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

const parseNetworkProxyPort = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim();
  }
  return typeof value === "number" ? String(value) : "";
};

export const parseNetworkProxySettings = (raw: string | undefined | null): NetworkProxySettings => {
  if (raw == null || !String(raw).trim()) {
    return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
    }
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      protocol: isNetworkProxyProtocol(record.protocol) ? record.protocol : DEFAULT_NETWORK_PROXY_SETTINGS.protocol,
      host: typeof record.host === "string" ? record.host.trim() : "",
      port: parseNetworkProxyPort(record.port),
      username: typeof record.username === "string" ? record.username.trim() : "",
    };
  } catch {
    return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
  }
};

export const serializeNetworkProxySettings = (value: NetworkProxySettings): string =>
  JSON.stringify({
    enabled: value.enabled === true,
    protocol: isNetworkProxyProtocol(value.protocol) ? value.protocol : DEFAULT_NETWORK_PROXY_SETTINGS.protocol,
    host: value.host.trim(),
    port: value.port.trim(),
    username: value.username.trim(),
  });

export const buildNetworkProxyRuntimeConfig = (
  value: NetworkProxySettings,
  password: string | undefined,
): NetworkProxyRuntimeConfig | undefined => {
  if (!value.enabled) {
    return undefined;
  }
  const host = value.host.trim();
  const portText = value.port.trim();
  const port = Number(portText);
  if (!host || !portText || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  const username = value.username.trim();
  return {
    protocol: value.protocol,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password?.trim() ? { password: password.trim() } : {}),
    noProxyHosts: [...DEFAULT_NETWORK_PROXY_NO_PROXY_HOSTS],
  };
};

export const buildNetworkProxyUrl = (value: NetworkProxyRuntimeConfig): string => {
  let auth = "";
  if (value.username && value.password !== undefined) {
    auth = `${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@`;
  } else if (value.username) {
    auth = `${encodeURIComponent(value.username)}@`;
  }
  return `${value.protocol}://${auth}${value.host}:${String(value.port)}`;
};

export const shouldBypassNetworkProxyForUrl = (url: string, config: NetworkProxyRuntimeConfig | undefined): boolean => {
  if (!config) {
    return true;
  }
  try {
    const target = new URL(url);
    const hostname = normalizeNoProxyHost(target.hostname);
    return config.noProxyHosts.some((entry) => normalizeNoProxyHost(entry) === hostname);
  } catch {
    return false;
  }
};

export interface GitProjectValidation {
  repoPath: string;
  repoName: string;
  baseBranch: string;
  isGitRepo: boolean;
  isWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeInfo {
  branchName: string;
  worktreePath: string;
  headSha: string | null;
  isLocked: boolean;
}

/** Serializable file chunk for chat IPC (raw base64, no data: prefix). */
export interface ChatAttachmentPayload {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

/** Persisted on chat/run steps so reopened sessions can still render attached or generated files/images. */
export interface StoredAttachmentMetadata {
  attachmentNames?: string[];
  attachments?: ChatAttachmentPayload[];
}

export const CHAT_ATTACHMENT_LIMITS = {
  maxFileCount: 8,
  maxBytesPerFile: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  /** Max UTF-8 characters inlined as text for non-image/PDF attachments. */
  maxEmbeddedTextChars: 200_000,
} as const;

/** Merge incoming files into an attachment list, capped at {@link CHAT_ATTACHMENT_LIMITS.maxFileCount}. */
export function appendChatAttachmentFiles(existing: readonly File[], incoming: readonly File[]): File[] {
  const next = [...existing];
  for (const file of incoming) {
    if (next.length >= CHAT_ATTACHMENT_LIMITS.maxFileCount) {
      break;
    }
    next.push(file);
  }
  return next;
}

/** Approximate decoded byte length of a standard base64 string (no data: URL prefix). */
export function estimateBase64ByteLength(base64: string): number {
  const t = base64.replace(/\s/g, "");
  if (t.length === 0) {
    return 0;
  }
  let pad = 0;
  if (t.endsWith("==")) {
    pad = 2;
  } else if (t.endsWith("=")) {
    pad = 1;
  }
  return Math.floor((t.length * 3) / 4) - pad;
}

export function validateChatAttachmentPayloads(attachments: ChatAttachmentPayload[] | undefined): void {
  if (!attachments?.length) {
    return;
  }
  if (attachments.length > CHAT_ATTACHMENT_LIMITS.maxFileCount) {
    throw new Error(`At most ${String(CHAT_ATTACHMENT_LIMITS.maxFileCount)} files can be attached per message.`);
  }
  let total = 0;
  for (const a of attachments) {
    const n = estimateBase64ByteLength(a.dataBase64);
    if (n > CHAT_ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new Error(
        `"${a.fileName}" is too large (max ${String(CHAT_ATTACHMENT_LIMITS.maxBytesPerFile / (1024 * 1024))} MB per file).`,
      );
    }
    total += n;
  }
  if (total > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
    throw new Error(
      `Attachments exceed the total size limit (${String(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024))} MB).`,
    );
  }
}

export function extractAttachmentNamesFromMetadata(metadata: Record<string, unknown>): string[] {
  const payloads = extractAttachmentPayloadsFromMetadata(metadata);
  if (payloads.length > 0) {
    return payloads.map((attachment) => attachment.fileName);
  }

  if (!Array.isArray(metadata.attachmentNames)) {
    return [];
  }

  return metadata.attachmentNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function extractAttachmentPayloadsFromMetadata(metadata: Record<string, unknown>): ChatAttachmentPayload[] {
  if (!Array.isArray(metadata.attachments)) {
    return [];
  }

  return metadata.attachments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    const attachment = value as Record<string, unknown>;
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const dataBase64 = typeof attachment.dataBase64 === "string" ? attachment.dataBase64.trim() : "";

    if (!fileName || !dataBase64) {
      return [];
    }

    return [
      {
        fileName,
        mimeType: mimeType || "application/octet-stream",
        dataBase64,
      } satisfies ChatAttachmentPayload,
    ];
  });
}

/** Prior turns for Chat Completions (Azure Legacy / Azure-style) chat follow-ups; excludes the current user message in {@link RunExecutionRequest.prompt}. */
export type ChatCompletionHistoryMessage = { role: "user" | "assistant"; content: string };

export type AzureLegacyResumeCheckpointMessage =
  | {
      role: "system" | "user";
      content: string | null;
    }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
      functionCall?: {
        name: string;
        arguments: string;
      };
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
    }
  | {
      role: "function";
      content: string;
      name: string;
    };

export interface RunResumeCheckpoint {
  messages?: Array<Record<string, unknown>>;
  chatMessages?: AzureLegacyResumeCheckpointMessage[];
  round: number;
  memo?: string;
}

export type ProviderSessionRuntimeOwnerKind = "run" | "chat";
export type ProviderSessionRuntimeStatus = "starting" | "running" | "ready" | "stopped" | "error";

export interface ProviderSessionRuntimeRecord {
  ownerId: string;
  ownerKind: ProviderSessionRuntimeOwnerKind;
  providerType: ProviderType;
  harnessType: HarnessType;
  status: ProviderSessionRuntimeStatus;
  cwd: string;
  modelId: string | null;
  runtimeMode: RunMode;
  resumeCursor: Record<string, unknown> | null;
  runtimePayload: Record<string, unknown> | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSessionRuntimeInput {
  ownerId: string;
  ownerKind: ProviderSessionRuntimeOwnerKind;
  providerType: ProviderType;
  harnessType: HarnessType;
  status: ProviderSessionRuntimeStatus;
  cwd: string;
  modelId?: string | null;
  runtimeMode: RunMode;
  resumeCursor?: Record<string, unknown> | null;
  runtimePayload?: Record<string, unknown> | null;
}

export interface RunExecutionRequest {
  runId: string;
  worktreePath: string;
  workspaceVcs?: RunWorkspaceVcs;
  mode: RunMode;
  yoloMode?: boolean;
  prompt: string;
  providerType: ProviderType;
  modelId: string;
  apiKey: string;
  apiBaseUrl?: string | null;
  previousResponseId?: string | null;
  repoContext?: string;
  skillContext?: string;
  config?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  providerOptions?: {
    reasoningEffort?: string;
    anthropicEffort?: string;
  };
  /** When true, runs as pure chat with no tools or repo context. */
  isChat?: boolean;
  /** User-attached files for chat turns (main/worker only). */
  attachments?: ChatAttachmentPayload[];
  /** Provider-agnostic prior messages for unified provider runs/chats. */
  priorMessages?: Array<Record<string, unknown>>;
  /** Extra `run_shell` regex patterns (from settings), merged with built-in allowlist. */
  shellAllowlistExtra?: string[];
  /**
   * Chat history for {@link ProviderType} `azure-legacy` (OpenAI Chat Completions `messages`).
   * Built from persisted chat steps; must not include the active user turn (see {@link buildPriorChatCompletionMessagesFromSteps}).
   */
  priorChatMessages?: ChatCompletionHistoryMessage[];
  /** Durable resume state for interrupted tool-using runs. */
  resumeCheckpoint?: RunResumeCheckpoint;
  /** Durable provider session state for CLI/app-server providers. */
  providerSessionRuntime?: ProviderSessionRuntimeRecord | null;
  /** When present, workers append request/response diagnostics to JSONL files in this directory. */
  devLogging?: {
    logDirPath: string;
  };
  /** Optional outbound proxy for provider network calls. Localhost requests must bypass it. */
  networkProxy?: NetworkProxyRuntimeConfig;
}

export interface ChatRecord {
  id: string;
  providerAccountId: string;
  modelId: string;
  /** Set for run-scoped chats ("chat about this run"); null for standalone chats. */
  runId: string | null;
  prompt: string;
  status: RunStatus;
  lastProviderResponseId: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChatStepRecord {
  id: string;
  chatId: string;
  eventType: RunEventType;
  title: string;
  content: string;
  metadataJson: string;
  createdAt: string;
}

/**
 * Builds ordered user/assistant text turns for Chat Completions. Drops the trailing user turn
 * (the current message is sent via {@link RunExecutionRequest.prompt}).
 */
const parseChatStepMetadata = (metadataJson: string): Record<string, unknown> => {
  try {
    return JSON.parse(metadataJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const priorChatMessageFromStep = (step: ChatStepRecord): ChatCompletionHistoryMessage | null => {
  const metadata = parseChatStepMetadata(step.metadataJson);
  if (typeof metadata.subagentId === "string" && metadata.subagentId) {
    return null;
  }
  if (step.eventType === "log" && (metadata.source === "user" || metadata.source === RUN_CHAT_CONTEXT_SOURCE)) {
    return { role: "user", content: step.content };
  }
  if (step.eventType !== "output" || metadata.assistantKind === "reasoning" || step.title === "Reasoning") {
    return null;
  }
  return { role: "assistant", content: step.content };
};

export const buildPriorChatCompletionMessagesFromSteps = (steps: ChatStepRecord[]): ChatCompletionHistoryMessage[] => {
  const sorted = [...steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: ChatCompletionHistoryMessage[] = [];
  for (const step of sorted) {
    const message = priorChatMessageFromStep(step);
    if (message) {
      out.push(message);
    }
  }
  if (out.length > 0 && out[out.length - 1]!.role === "user") {
    out.pop();
  }
  return out;
};

export interface ChatDetail {
  chat: ChatRecord;
  steps: ChatStepRecord[];
}

export interface ChatInput {
  providerAccountId: string;
  modelId: string;
  prompt: string;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export interface RunChatInput {
  modelId: string;
  prompt: string;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
}

/**
 * Metadata `source` marker for the hidden chat step that seeds a run chat with the
 * run's output and diff. Hidden in transcripts; replayed as a user turn in history.
 */
export const RUN_CHAT_CONTEXT_SOURCE = "run-context";

export interface FollowUpChatOptions {
  modelId?: string;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export interface HarnessRunChunk {
  type:
    | "status"
    | "message"
    | "error"
    | "tool-call"
    | "tool-result"
    | "approval-requested"
    | "approval-resolved"
    | "user-input-requested"
    | "plan-updated"
    | "plan-progress"
    | "diff-updated"
    | "tool-progress"
    | "request"
    | "plan";
  value: string;
  title?: string;
  metadata?: Record<string, unknown> & {
    providerSessionRuntime?: Omit<
      ProviderSessionRuntimeInput,
      "ownerId" | "ownerKind" | "providerType" | "harnessType"
    >;
  };
}

export interface RunToolDefinition {
  name: RunToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RunToolCall {
  id: string;
  name: RunToolName;
  arguments: Record<string, unknown>;
}

export interface RunToolResult {
  toolCallId: string;
  name: RunToolName;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessToolContext {
  tools: RunToolDefinition[];
  executeTool: (call: RunToolCall) => Promise<RunToolResult>;
}

export interface ProviderAdapter {
  readonly providerType: ProviderType;
  listRecommendedModels(): string[];
  listAvailableModels?(
    context: ProviderAvailableModelsContext,
  ): Promise<ProviderAvailableModel[]>;
  validateConfiguration(input: ProviderAccountInput): void;
}

export interface HarnessAdapter {
  readonly harnessType: HarnessType;
  run(
    input: RunExecutionRequest,
    toolContext: HarnessToolContext,
    onChunk: (chunk: HarnessRunChunk) => void,
    signal: AbortSignal,
  ): Promise<{
    summary: string;
    responseId: string | null;
    usage: RunTokenUsage;
    providerSessionRuntime?: Omit<
      ProviderSessionRuntimeInput,
      "ownerId" | "ownerKind" | "providerType" | "harnessType" | "status"
    > & {
      status?: ProviderSessionRuntimeStatus;
    };
  }>;
}

export interface SecretStore {
  saveSecret(key: string, value: string): Promise<void>;
  readSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}

/** Result of opening a path in the OS file manager (Explorer / Finder / etc.). */
export interface OpenPathInFileManagerResult {
  ok: boolean;
  error?: string;
}

export interface AppLogDirectorySizeInfo {
  totalBytes: number;
  fileCount: number;
  unreadableEntryCount: number;
}

export interface AppPathsInfo {
  logDirPath: string;
  logDirectorySize: AppLogDirectorySizeInfo;
}

export interface AppWarning {
  title: string;
  message: string;
  detail?: string;
}

export interface DetectedCodexInstallation {
  binaryPath: string | null;
}

export interface DetectedClaudeInstallation {
  binaryPath: string | null;
}

export interface DetectedCursorInstallation {
  binaryPath: string | null;
  message?: string;
}

export type AppMenuCommand = "go-home" | "new-agent-run" | "new-chat" | "open-settings" | "toggle-dark-mode";
export type AppMenuSection = "file" | "edit" | "view" | "window" | "help";

/** Result of opening a URL in the system browser / default handler (mailto, etc.). */
export interface OpenExternalUrlResult {
  ok: boolean;
  error?: string;
}

export interface RendererLogPayload {
  level: "error" | "warn";
  source: string;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
}

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  getRemoteAccessStatus(): Promise<RemoteAccessStatus>;
  listHostDirectories(input?: HostDirectoryBrowseInput): Promise<HostDirectoryListing>;
  createRemoteAccessPairing(input?: RemoteAccessPairingInput): Promise<RemoteAccessPairingGrant>;
  listRemoteAccessSessions(): Promise<RemoteAccessSession[]>;
  revokeRemoteAccessSession(sessionId: string): Promise<void>;
  getNetworkProxySettings(): Promise<NetworkProxySettingsSnapshot>;
  selectProject(projectId: string): Promise<void>;
  reorderProjects(projectIds: string[]): Promise<void>;
  getProjectBranches(projectId: string): Promise<string[]>;
  getProjectCurrentBranch(projectId: string): Promise<string>;
  getProjectBranchOverview(projectId: string): Promise<ProjectGitBranchOverview>;
  checkProjectGitConversion(projectId: string): Promise<ProjectGitConversionCandidate | null>;
  convertProjectToGit(projectId: string): Promise<ProjectRecord>;
  updateProjectBaseBranch(projectId: string, branchName: string): Promise<ProjectRecord>;
  checkProjectFolderGitStatus(repoPath: string): Promise<ProjectFolderGitStatus>;
  /** Check out a local branch on the project’s main repository (fixes detached HEAD). */
  checkoutProjectBranch(projectId: string, branchName: string): Promise<void>;
  fetchProjectBranches(projectId: string): Promise<ProjectGitBranchOverview>;
  createProjectBranch(projectId: string, input: CreateProjectBranchInput): Promise<ProjectGitBranchOverview>;
  renameProjectBranch(projectId: string, input: RenameProjectBranchInput): Promise<ProjectGitBranchOverview>;
  getProjectBranchDeleteImpact(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectBranchDeleteImpact>;
  deleteProjectBranch(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectGitBranchOverview>;
  pullProjectBranch(projectId: string): Promise<ProjectGitBranchOverview>;
  pushProjectBranch(projectId: string, input: PushProjectBranchInput): Promise<ProjectGitBranchOverview>;
  addProject(input: ProjectInput): Promise<ProjectRecord>;
  addProviderAccount(input: ProviderAccountInput): Promise<ProviderAccountRecord>;
  addModel(input: ModelInput): Promise<ModelRecord>;
  listAvailableProviderModels(input: ListAvailableProviderModelsInput): Promise<ListAvailableProviderModelsResult>;
  listComposerCommands(input: ListComposerCommandsInput): Promise<ComposerCommandDescriptor[]>;
  createProjectTask(projectId: string, input: ProjectTaskInput): Promise<ProjectTaskRecord>;
  updateProjectTask(taskId: string, input: UpdateProjectTaskInput): Promise<ProjectTaskRecord>;
  deleteProjectTask(taskId: string): Promise<void>;
  onProjectTaskChanged(listener: (payload: ProjectTaskChangedPayload) => void): () => void;
  runProjectLab(input: RunProjectLabInput): Promise<ProjectLabThreadRecord[]>;
  deleteProjectLabThread(threadId: string): Promise<void>;
  createProjectLoop(input: CreateProjectLoopInput): Promise<ProjectLoopRecord>;
  getProjectLoopDetail(loopId: string): Promise<ProjectLoopDetail>;
  cancelProjectLoop(loopId: string): Promise<void>;
  resumeProjectLoop(loopId: string): Promise<void>;
  deleteProjectLoop(loopId: string): Promise<void>;
  respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput): Promise<void>;
  /** Base64 data URL of a stored loop UI-review screenshot. */
  getProjectLoopUiReviewImage(reviewId: string): Promise<string | null>;
  getProjectLoopAvailability(projectId: string): Promise<ProjectLoopAvailability>;
  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void): () => void;
  generateProjectTaskRunPrompt(input: { projectId: string; title: string; notes: string; modelId: string }): Promise<string>;
  generateProjectInsight(input: GenerateProjectInsightInput): Promise<ProjectInsightRecord>;
  createRun(input: RunInput): Promise<RunRecord>;
  continueRun(input: ContinueRunInput): Promise<RunRecord>;
  createRunPullRequest(runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string): Promise<string>;
  suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string): Promise<string>;
  createRunLocalBranch(runId: string, branchName: string): Promise<string>;
  publishRunBranch(runId: string, branchName?: string): Promise<string>;
  commitRun(runId: string, message: string): Promise<void>;
  /** Uses the run's model + provider (chat completions) to propose a message from the worktree diff. */
  suggestCommitMessage(runId: string): Promise<string>;
  /** Uses the run's model + provider to simulate reviewer feedback on the current diff before commit / PR. */
  analyzeRunDiff(runId: string, options?: RunDiffReviewOptions): Promise<RunDiffReviewResult>;
  /**
   * Returns a unified PR/MR diff. With a saved hosting token, uses the GitHub/GitLab API snapshot; otherwise falls back
   * to fetching the PR/MR head from `origin` and diffing merge-base vs head. Requires matching `origin` URL.
   * @see FetchProjectPrMrDiffInput
   */
  fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult>;
  /** AI review for an already-loaded PR/MR diff (not persisted; does not post to Git). */
  analyzeProjectPrMrDiff(
    projectId: string,
    input: { prUrl: string; diff: string; modelId?: string },
  ): Promise<RunDiffReviewResult>;
  getProjectForgeAuthStatus(projectId: string): Promise<ProjectForgeAuthStatus>;
  saveProjectForgeAuthToken(projectId: string, token: string): Promise<ProjectForgeAuthStatus>;
  deleteProjectForgeAuthToken(projectId: string): Promise<ProjectForgeAuthStatus>;
  getProjectForgePrMonitorSettings(projectId: string): Promise<ProjectForgePrMonitorSettings>;
  saveProjectForgePrMonitorSettings(projectId: string, input: ProjectForgePrMonitorSettingsInput): Promise<ProjectForgePrMonitorSettings>;
  listProjectForgeRequests(projectId: string, input?: ListProjectForgeRequestsInput): Promise<ProjectForgeRequestsResult>;
  getProjectForgeRequestDetails(projectId: string, input: GetProjectForgeRequestDetailsInput): Promise<ProjectForgeRequestDetailsResult>;
  postProjectPrMrReview(projectId: string, input: PostProjectPrMrReviewInput): Promise<ProjectForgeReviewActionResult>;
  submitProjectPrMrComments(projectId: string, input: SubmitProjectPrMrCommentsInput): Promise<ProjectForgeReviewActionResult>;
  replyProjectPrMrReviewThread(projectId: string, input: ReplyProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult>;
  resolveProjectPrMrReviewThread(projectId: string, input: ResolveProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult>;
  followUpRun(runId: string, prompt: string, options?: RunFollowUpOptions): Promise<RunRecord>;
  getRunPublishOptions(runId: string): Promise<RunPublishOptions>;
  activateRun(runId: string): Promise<void>;
  releaseRun(runId: string): Promise<void>;
  setAppSetting(key: string, value: string): Promise<void>;
  saveNetworkProxySettings(input: NetworkProxySettingsInput): Promise<NetworkProxySettingsSnapshot>;
  deleteProject(projectId: string): Promise<void>;
  deleteProviderAccount(providerAccountId: string): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  getRunDetail(runId: string): Promise<RunDetail>;
  addRunNote(runId: string, input: RunNoteInput): Promise<RunNoteRecord>;
  updateRunNote(noteId: string, input: UpdateRunNoteInput): Promise<RunNoteRecord>;
  deleteRunNote(noteId: string): Promise<void>;
  setRunListVisibility(runId: string, visibility: RunListVisibility): Promise<RunRecord>;
  /** Read one text file inside the run's effective workspace for the sidebar file viewer. */
  getRunWorkspaceFile(input: RunWorkspaceFileInput): Promise<RunWorkspaceFileResult>;
  /** Worktree git diff only; can be slow on large repos. Call after {@link getRunDetail} for progressive loading. */
  getRunWorktreeDiff(runId: string): Promise<RunWorktreeDiffResult>;
  resumeRunFromCheckpoint(runId: string): Promise<void>;
  recoverInterruptedRun(runId: string): Promise<void>;
  undoRunToLastPrompt(runId: string): Promise<void>;
  respondToShellApproval(
    runId: string,
    requestId: string,
    decision: ShellApprovalDecision,
    options?: ShellApprovalRespondOptions,
  ): Promise<void>;
  respondToRunUserInput(runId: string, requestId: string, answers: RunUserInputAnswers): Promise<void>;
  cancelRunShell(runId: string, toolCallId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  refreshSnapshot(): Promise<AppSnapshot>;
  pickProjectDirectory(): Promise<string | null>;
  openPathInFileManager(path: string): Promise<OpenPathInFileManagerResult>;
  getAppPaths(): Promise<AppPathsInfo>;
  getDetectedCodexInstallation(): Promise<DetectedCodexInstallation>;
  getDetectedClaudeInstallation(): Promise<DetectedClaudeInstallation>;
  getDetectedCursorInstallation(): Promise<DetectedCursorInstallation>;
  /** Lightweight skill descriptors (no bodies); deduped by source:name. */
  listIntegratedSkills(): Promise<IntegratedSkillMetadata[]>;
  /** Full markdown body of one skill, loaded on demand (e.g. settings preview). */
  getIntegratedSkillContent(skillId: string): Promise<string | null>;
  /** Open http(s) or mailto URLs outside the Electron window (system browser / mail client). */
  openExternalUrl(url: string): Promise<OpenExternalUrlResult>;
  reportRendererLog(payload: RendererLogPayload): Promise<void>;
  /** Pick an IDE executable (.exe, app bundle, etc.). */
  pickIdeExecutable(): Promise<string | null>;
  /** Open the run worktree folder in the given IDE (must be configured under {@link APP_SETTING_KEYS.idePaths}). */
  openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind): Promise<void>;
  /** Open an arbitrary folder (e.g. a project's repo path) in the given IDE (must be configured under {@link APP_SETTING_KEYS.idePaths}). */
  openFolderInIde(folderPath: string, ideKind: SupportedIdeKind): Promise<void>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
  addBookmark(runId: string): Promise<void>;
  removeBookmark(runId: string): Promise<void>;
  removeBookmarkById(bookmarkId: string): Promise<void>;
  isBookmarked(runId: string): Promise<boolean>;
  getBookmarksWithSteps(): Promise<BookmarkRecord[]>;
  addChatBookmark(chatId: string): Promise<void>;
  removeChatBookmark(chatId: string): Promise<void>;
  removeChatBookmarkById(bookmarkId: string): Promise<void>;
  isChatBookmarked(chatId: string): Promise<boolean>;
  getChatBookmarksWithSteps(): Promise<ChatBookmarkRecord[]>;
  resetDatabase(): Promise<void>;
  createChat(input: ChatInput): Promise<ChatRecord>;
  /** Creates the run-scoped chat for a run, seeding it with run output + diff context. */
  createRunChat(runId: string, input: RunChatInput): Promise<ChatRecord>;
  /** Returns the run-scoped chat for a run, or null when none was started yet. */
  getRunChat(runId: string): Promise<ChatDetail | null>;
  getChatDetail(chatId: string): Promise<ChatDetail>;
  followUpChat(chatId: string, prompt: string, options?: FollowUpChatOptions): Promise<ChatRecord>;
  listChats(): Promise<ChatRecord[]>;
  listChatsWithSteps(): Promise<ChatDetail[]>;
  deleteChat(chatId: string): Promise<void>;
  cancelChat(chatId: string): Promise<void>;
  onChatEvent(listener: (event: RunEvent & { chatId: string }) => void): () => void;

  /** Spawn an embedded PTY in the run worktree (see {@link IPC_CHANNELS.runTerminalData}). */
  runTerminalStart(input: RunTerminalStartInput): Promise<RunTerminalStartResult>;
  runTerminalWrite(input: RunTerminalWriteInput): Promise<void>;
  runTerminalResize(input: RunTerminalResizeInput): Promise<void>;
  runTerminalKill(sessionId: string): Promise<void>;
  onRunTerminalData(listener: (payload: RunTerminalDataPayload) => void): () => void;
  onRunTerminalExit(listener: (payload: RunTerminalExitPayload) => void): () => void;
  /** Opens the OS default terminal app in the given directory (fallback when embedded PTY is unavailable). */
  openSystemTerminalAtPath(dirPath: string): Promise<{ ok: boolean; error?: string }>;
  onAppMenuCommand(listener: (command: AppMenuCommand) => void): () => void;
  onAppWarning(listener: (warning: AppWarning) => void): () => void;
  /** Subscribe when the main process updates persisted app settings (e.g. appearance from the menu bar). */
  onAppSettingsChanged(listener: () => void): () => void;
  onProjectForgeRequestOpen(listener: (payload: ProjectForgeRequestOpenPayload) => void): () => void;
  onProjectForgeRequestNotification(listener: (payload: ProjectForgeRequestNotificationPayload) => void): () => void;
  showAppMenu(section: AppMenuSection, x: number, y: number): Promise<void>;
}

export interface RunTerminalStartInput {
  sessionId: string;
  cwd: string;
}

export interface RunTerminalStartResult {
  ok: boolean;
  error?: string;
  /** True when an existing PTY for this session was reused (e.g. user navigated away and back). */
  reused?: boolean;
}

export interface RunTerminalWriteInput {
  sessionId: string;
  data: string;
}

export interface RunTerminalResizeInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface RunTerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface RunTerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

export const REMOTE_ACCESS_PROTOCOL_VERSION = 1 as const;
export const REMOTE_ACCESS_MIN_PROTOCOL_VERSION = 1 as const;
export const REMOTE_ACCESS_LOOPBACK_HOST = "127.0.0.1" as const;
export const DEFAULT_REMOTE_ACCESS_PORT = 47_831;
export const REMOTE_ACCESS_HEALTH_PATH = "/health" as const;
export const REMOTE_ACCESS_LEGACY_HEALTH_PATH = "/api/v1/health" as const;
export const REMOTE_ACCESS_INFO_PATH = "/api/v1/info" as const;
export const REMOTE_ACCESS_RPC_PATH = "/api/v1/rpc" as const;
export const REMOTE_ACCESS_WEBSOCKET_PATH = "/api/v1/events" as const;
export const REMOTE_ACCESS_PAIRING_PATH = "/api/v1/auth/pair" as const;
export const REMOTE_ACCESS_SESSION_PATH = "/api/v1/auth/session" as const;
export const REMOTE_ACCESS_SESSION_COOKIE = "buildwarden_session" as const;

export const REMOTE_ACCESS_SERVER_CAPABILITIES = [
  "rpc",
  "events:run",
  "events:chat",
  "events:warning",
  "events:loop",
  "events:task",
  "events:terminal",
] as const;

export type RemoteAccessServerCapability = (typeof REMOTE_ACCESS_SERVER_CAPABILITIES)[number];
export type RemoteStreamEventType = "run" | "chat" | "warning" | "loop" | "task" | "terminal-data" | "terminal-exit";

export interface RemoteStreamEventPayloadMap {
  run: RunEvent;
  chat: RunEvent & { chatId: string };
  warning: AppWarning;
  loop: ProjectLoopChangedPayload;
  task: ProjectTaskChangedPayload;
  "terminal-data": RunTerminalDataPayload;
  "terminal-exit": RunTerminalExitPayload;
}

export type RemoteStreamEvent = {
  [Event in RemoteStreamEventType]: { event: Event; payload: RemoteStreamEventPayloadMap[Event] };
}[RemoteStreamEventType];

export const REMOTE_ACCESS_SCOPES = [
  "state:read",
  "run:operate",
  "chat:operate",
  "approval:respond",
  "git:write",
  "terminal:operate",
  "admin",
] as const;

export type RemoteAccessScope = (typeof REMOTE_ACCESS_SCOPES)[number];

export interface RemoteAccessPairingInput {
  label?: string;
  scopes?: RemoteAccessScope[];
}

export interface RemoteAccessPairingGrant {
  id: string;
  code: string;
  scopes: RemoteAccessScope[];
  expiresAt: string;
  createdAt: string;
  /** Browser URL with the one-time code in the fragment so proxies and request logs never receive it. */
  pairingUrl?: string;
}

export type TailscaleServeState =
  | "not-installed"
  | "not-running"
  | "available"
  | "managed"
  | "conflict"
  | "error";

export interface RemoteAccessStatus {
  enabled: boolean;
  loopbackUrl: string | null;
  tailscale: {
    desired: boolean;
    state: TailscaleServeState;
    cliPath: string | null;
    backendState: string | null;
    dnsName: string | null;
    endpoint: string | null;
    managed: boolean;
    verified: boolean;
    message: string;
    enableCommand: string | null;
  };
}

export interface RemoteAccessPairingGrantRecord extends Omit<RemoteAccessPairingGrant, "code" | "pairingUrl"> {
  tokenHash: string;
  usedAt: string | null;
}

export interface RemoteAccessSession {
  id: string;
  label: string;
  scopes: RemoteAccessScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

export interface RemoteAccessSessionRecord extends RemoteAccessSession {
  tokenHash: string;
}

export interface RemoteCommandIdempotencyRecord {
  sessionId: string;
  idempotencyKey: string;
  method: string;
  requestHash: string;
  responseJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type RemoteAccessAuditEvent =
  | "pairing-created"
  | "pairing-failed"
  | "pairing-consumed"
  | "session-authenticated"
  | "session-authentication-failed"
  | "session-revoked";

export interface RemoteAccessAuditRecord {
  id: string;
  event: RemoteAccessAuditEvent;
  outcome: "success" | "failure";
  sessionId: string | null;
  pairingGrantId: string | null;
  remoteAddress: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface RemoteAccessPairingExchangeRequest {
  code: string;
  label?: string;
}

export interface RemoteAccessPairingExchangeResponse {
  session: RemoteAccessSession;
}

/** Explicit transport contract. Desktop methods are not remotely callable unless listed here. */
export type RemoteOperationMap = {
  getSnapshot: DesktopApi["getSnapshot"];
  refreshSnapshot: DesktopApi["refreshSnapshot"];
  getNetworkProxySettings: DesktopApi["getNetworkProxySettings"];
  getProjectBranches: DesktopApi["getProjectBranches"];
  getProjectCurrentBranch: DesktopApi["getProjectCurrentBranch"];
  checkProjectFolderGitStatus: DesktopApi["checkProjectFolderGitStatus"];
  getRunDetail: DesktopApi["getRunDetail"];
  getRunWorktreeDiff: DesktopApi["getRunWorktreeDiff"];
  getRunWorkspaceFile: DesktopApi["getRunWorkspaceFile"];
  getProjectLoopUiReviewImage: DesktopApi["getProjectLoopUiReviewImage"];
  getProjectLoopDetail: DesktopApi["getProjectLoopDetail"];
  getProjectLoopAvailability: DesktopApi["getProjectLoopAvailability"];
  getChatDetail: DesktopApi["getChatDetail"];
  listChatsWithSteps: DesktopApi["listChatsWithSteps"];
  getBookmarksWithSteps: DesktopApi["getBookmarksWithSteps"];
  getChatBookmarksWithSteps: DesktopApi["getChatBookmarksWithSteps"];
  getRunPublishOptions: DesktopApi["getRunPublishOptions"];
  getProjectBranchOverview: DesktopApi["getProjectBranchOverview"];
  getProjectForgeAuthStatus: DesktopApi["getProjectForgeAuthStatus"];
  getProjectForgePrMonitorSettings: DesktopApi["getProjectForgePrMonitorSettings"];
  listProjectForgeRequests: DesktopApi["listProjectForgeRequests"];
  getProjectForgeRequestDetails: DesktopApi["getProjectForgeRequestDetails"];
  fetchProjectPrMrDiff: DesktopApi["fetchProjectPrMrDiff"];
  checkProjectGitConversion: DesktopApi["checkProjectGitConversion"];
  getProjectBranchDeleteImpact: DesktopApi["getProjectBranchDeleteImpact"];
  listHostDirectories: DesktopApi["listHostDirectories"];
  listAvailableProviderModels: DesktopApi["listAvailableProviderModels"];
  getAppPaths: DesktopApi["getAppPaths"];
  getDetectedCodexInstallation: DesktopApi["getDetectedCodexInstallation"];
  getDetectedClaudeInstallation: DesktopApi["getDetectedClaudeInstallation"];
  getDetectedCursorInstallation: DesktopApi["getDetectedCursorInstallation"];
  listIntegratedSkills: DesktopApi["listIntegratedSkills"];
  getIntegratedSkillContent: DesktopApi["getIntegratedSkillContent"];
  createRun: DesktopApi["createRun"];
  continueRun: DesktopApi["continueRun"];
  followUpRun: DesktopApi["followUpRun"];
  cancelRun: DesktopApi["cancelRun"];
  cancelRunShell: DesktopApi["cancelRunShell"];
  resumeRunFromCheckpoint: DesktopApi["resumeRunFromCheckpoint"];
  recoverInterruptedRun: DesktopApi["recoverInterruptedRun"];
  undoRunToLastPrompt: DesktopApi["undoRunToLastPrompt"];
  deleteRun: DesktopApi["deleteRun"];
  setRunListVisibility: DesktopApi["setRunListVisibility"];
  addBookmark: DesktopApi["addBookmark"];
  removeBookmark: DesktopApi["removeBookmark"];
  removeBookmarkById: DesktopApi["removeBookmarkById"];
  respondToShellApproval: DesktopApi["respondToShellApproval"];
  respondToRunUserInput: DesktopApi["respondToRunUserInput"];
  createChat: DesktopApi["createChat"];
  followUpChat: DesktopApi["followUpChat"];
  cancelChat: DesktopApi["cancelChat"];
  deleteChat: DesktopApi["deleteChat"];
  addChatBookmark: DesktopApi["addChatBookmark"];
  removeChatBookmark: DesktopApi["removeChatBookmark"];
  removeChatBookmarkById: DesktopApi["removeChatBookmarkById"];
  createProjectTask: DesktopApi["createProjectTask"];
  updateProjectTask: DesktopApi["updateProjectTask"];
  deleteProjectTask: DesktopApi["deleteProjectTask"];
  generateProjectTaskRunPrompt: DesktopApi["generateProjectTaskRunPrompt"];
  generateProjectInsight: DesktopApi["generateProjectInsight"];
  runProjectLab: DesktopApi["runProjectLab"];
  deleteProjectLabThread: DesktopApi["deleteProjectLabThread"];
  createProjectLoop: DesktopApi["createProjectLoop"];
  cancelProjectLoop: DesktopApi["cancelProjectLoop"];
  resumeProjectLoop: DesktopApi["resumeProjectLoop"];
  deleteProjectLoop: DesktopApi["deleteProjectLoop"];
  respondToProjectLoopUiReview: DesktopApi["respondToProjectLoopUiReview"];
  analyzeProjectPrMrDiff: DesktopApi["analyzeProjectPrMrDiff"];
  postProjectPrMrReview: DesktopApi["postProjectPrMrReview"];
  submitProjectPrMrComments: DesktopApi["submitProjectPrMrComments"];
  replyProjectPrMrReviewThread: DesktopApi["replyProjectPrMrReviewThread"];
  resolveProjectPrMrReviewThread: DesktopApi["resolveProjectPrMrReviewThread"];
  commitRun: DesktopApi["commitRun"];
  createRunLocalBranch: DesktopApi["createRunLocalBranch"];
  publishRunBranch: DesktopApi["publishRunBranch"];
  createRunPullRequest: DesktopApi["createRunPullRequest"];
  checkoutProjectBranch: DesktopApi["checkoutProjectBranch"];
  fetchProjectBranches: DesktopApi["fetchProjectBranches"];
  createProjectBranch: DesktopApi["createProjectBranch"];
  renameProjectBranch: DesktopApi["renameProjectBranch"];
  deleteProjectBranch: DesktopApi["deleteProjectBranch"];
  pullProjectBranch: DesktopApi["pullProjectBranch"];
  pushProjectBranch: DesktopApi["pushProjectBranch"];
  convertProjectToGit: DesktopApi["convertProjectToGit"];
  updateProjectBaseBranch: DesktopApi["updateProjectBaseBranch"];
  addProject: DesktopApi["addProject"];
  reorderProjects: DesktopApi["reorderProjects"];
  addProviderAccount: DesktopApi["addProviderAccount"];
  addModel: DesktopApi["addModel"];
  deleteProject: DesktopApi["deleteProject"];
  deleteProviderAccount: DesktopApi["deleteProviderAccount"];
  deleteModel: DesktopApi["deleteModel"];
  setAppSetting: DesktopApi["setAppSetting"];
  saveNetworkProxySettings: DesktopApi["saveNetworkProxySettings"];
  saveProjectForgeAuthToken: DesktopApi["saveProjectForgeAuthToken"];
  deleteProjectForgeAuthToken: DesktopApi["deleteProjectForgeAuthToken"];
  saveProjectForgePrMonitorSettings: DesktopApi["saveProjectForgePrMonitorSettings"];
  runTerminalStart: DesktopApi["runTerminalStart"];
  runTerminalWrite: DesktopApi["runTerminalWrite"];
  runTerminalResize: DesktopApi["runTerminalResize"];
  runTerminalKill: DesktopApi["runTerminalKill"];
};

export type RemoteApiMethod = keyof RemoteOperationMap;

export type RemoteApiMethodArgs<Method extends RemoteApiMethod> =
  RemoteOperationMap[Method] extends (...args: infer Args) => Promise<unknown> ? Args : never;

export type RemoteApiMethodResult<Method extends RemoteApiMethod> =
  RemoteOperationMap[Method] extends (...args: never[]) => Promise<infer Result> ? Result : never;

export interface RemoteRpcRequest {
  protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
  requestId: string;
  method: RemoteApiMethod;
  args: unknown[];
  idempotencyKey?: string;
}

export type RemoteRpcErrorCode =
  | "invalid-request"
  | "protocol-mismatch"
  | "method-not-found"
  | "forbidden"
  | "idempotency-required"
  | "idempotency-conflict"
  | "command-in-progress"
  | "operation-failed";

export type RemoteRpcResponse =
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: {
        code: RemoteRpcErrorCode;
        message: string;
      };
    };

export interface RemoteAccessHealth {
  status: "ok";
  app: "buildwarden";
  appVersion: string;
  protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
  scope: "loopback";
  authentication: "not-configured" | "session";
  startedAt: string;
}

export interface RemoteAccessInfo {
  app: "buildwarden";
  appVersion: string;
  apiVersion: "v1";
  protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
  minProtocolVersion: typeof REMOTE_ACCESS_MIN_PROTOCOL_VERSION;
  maxProtocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
  scope: "loopback";
  authentication: RemoteAccessHealth["authentication"];
  capabilities: RemoteAccessServerCapability[];
  endpoints: {
    health: typeof REMOTE_ACCESS_HEALTH_PATH;
    info: typeof REMOTE_ACCESS_INFO_PATH;
    rpc: typeof REMOTE_ACCESS_RPC_PATH;
    events: typeof REMOTE_ACCESS_WEBSOCKET_PATH;
  };
  startedAt: string;
}

export type RemoteWebSocketClientMessage =
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "subscribe";
      requestId: string;
      events: RemoteStreamEventType[];
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "ping";
      requestId: string;
    };

export type RemoteWebSocketServerMessage =
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "hello";
      info: RemoteAccessInfo;
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "subscribed";
      requestId: string;
      events: RemoteStreamEventType[];
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "event";
      sequence: number;
      event: RemoteStreamEventType;
      payload: RemoteStreamEventPayloadMap[RemoteStreamEventType];
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "pong";
      requestId: string;
    }
  | {
      protocolVersion: typeof REMOTE_ACCESS_PROTOCOL_VERSION;
      type: "error";
      requestId: string;
      code: "invalid-message" | "protocol-mismatch" | "forbidden";
      message: string;
    };

export const IPC_CHANNELS = {
  activateRun: "buildwarden:activate-run",
  addModel: "buildwarden:add-model",
  listAvailableProviderModels: "buildwarden:list-available-provider-models",
  createProjectTask: "buildwarden:create-project-task",
  updateProjectTask: "buildwarden:update-project-task",
  deleteProjectTask: "buildwarden:delete-project-task",
  projectTaskChanged: "buildwarden:project-task-changed",
  runProjectLab: "buildwarden:run-project-lab",
  deleteProjectLabThread: "buildwarden:delete-project-lab-thread",
  createProjectLoop: "buildwarden:create-project-loop",
  getProjectLoopDetail: "buildwarden:get-project-loop-detail",
  cancelProjectLoop: "buildwarden:cancel-project-loop",
  resumeProjectLoop: "buildwarden:resume-project-loop",
  deleteProjectLoop: "buildwarden:delete-project-loop",
  respondToProjectLoopUiReview: "buildwarden:respond-to-project-loop-ui-review",
  getProjectLoopUiReviewImage: "buildwarden:get-project-loop-ui-review-image",
  getProjectLoopAvailability: "buildwarden:get-project-loop-availability",
  projectLoopChanged: "buildwarden:project-loop-changed",
  generateProjectTaskRunPrompt: "buildwarden:generate-project-task-run-prompt",
  generateProjectInsight: "buildwarden:generate-project-insight",
  addProject: "buildwarden:add-project",
  addProviderAccount: "buildwarden:add-provider-account",
  listComposerCommands: "buildwarden:list-composer-commands",
  cancelRunShell: "buildwarden:cancel-run-shell",
  cancelRun: "buildwarden:cancel-run",
  commitRun: "buildwarden:commit-run",
  suggestCommitMessage: "buildwarden:suggest-commit-message",
  analyzeRunDiff: "buildwarden:analyze-run-diff",
  fetchProjectPrMrDiff: "buildwarden:fetch-project-pr-mr-diff",
  analyzeProjectPrMrDiff: "buildwarden:analyze-project-pr-mr-diff",
  getProjectForgeAuthStatus: "buildwarden:get-project-forge-auth-status",
  saveProjectForgeAuthToken: "buildwarden:save-project-forge-auth-token",
  deleteProjectForgeAuthToken: "buildwarden:delete-project-forge-auth-token",
  getProjectForgePrMonitorSettings: "buildwarden:get-project-forge-pr-monitor-settings",
  saveProjectForgePrMonitorSettings: "buildwarden:save-project-forge-pr-monitor-settings",
  listProjectForgeRequests: "buildwarden:list-project-forge-requests",
  getProjectForgeRequestDetails: "buildwarden:get-project-forge-request-details",
  postProjectPrMrReview: "buildwarden:post-project-pr-mr-review",
  submitProjectPrMrComments: "buildwarden:submit-project-pr-mr-comments",
  replyProjectPrMrReviewThread: "buildwarden:reply-project-pr-mr-review-thread",
  resolveProjectPrMrReviewThread: "buildwarden:resolve-project-pr-mr-review-thread",
  createRunPullRequest: "buildwarden:create-run-pull-request",
  suggestRunPullRequestDescription: "buildwarden:suggest-run-pull-request-description",
  createRunLocalBranch: "buildwarden:create-run-local-branch",
  createRun: "buildwarden:create-run",
  continueRun: "buildwarden:continue-run",
  publishRunBranch: "buildwarden:publish-run-branch",
  followUpRun: "buildwarden:follow-up-run",
  deleteProject: "buildwarden:delete-project",
  deleteProviderAccount: "buildwarden:delete-provider-account",
  deleteRun: "buildwarden:delete-run",
  deleteModel: "buildwarden:delete-model",
  getRunDetail: "buildwarden:get-run-detail",
  addRunNote: "buildwarden:add-run-note",
  updateRunNote: "buildwarden:update-run-note",
  deleteRunNote: "buildwarden:delete-run-note",
  setRunListVisibility: "buildwarden:set-run-list-visibility",
  getRunWorkspaceFile: "buildwarden:get-run-workspace-file",
  getRunWorktreeDiff: "buildwarden:get-run-worktree-diff",
  resumeRunFromCheckpoint: "buildwarden:resume-run-from-checkpoint",
  recoverInterruptedRun: "buildwarden:recover-interrupted-run",
  undoRunToLastPrompt: "buildwarden:undo-run-to-last-prompt",
  getRunPublishOptions: "buildwarden:get-run-publish-options",
  getProjectBranches: "buildwarden:get-project-branches",
  getProjectCurrentBranch: "buildwarden:get-project-current-branch",
  getProjectBranchOverview: "buildwarden:get-project-branch-overview",
  checkProjectGitConversion: "buildwarden:check-project-git-conversion",
  convertProjectToGit: "buildwarden:convert-project-to-git",
  updateProjectBaseBranch: "buildwarden:update-project-base-branch",
  checkProjectFolderGitStatus: "buildwarden:check-project-folder-git-status",
  checkoutProjectBranch: "buildwarden:checkout-project-branch",
  fetchProjectBranches: "buildwarden:fetch-project-branches",
  createProjectBranch: "buildwarden:create-project-branch",
  renameProjectBranch: "buildwarden:rename-project-branch",
  getProjectBranchDeleteImpact: "buildwarden:get-project-branch-delete-impact",
  deleteProjectBranch: "buildwarden:delete-project-branch",
  pullProjectBranch: "buildwarden:pull-project-branch",
  pushProjectBranch: "buildwarden:push-project-branch",
  getSnapshot: "buildwarden:get-snapshot",
  getRemoteAccessStatus: "buildwarden:get-remote-access-status",
  listHostDirectories: "buildwarden:list-host-directories",
  createRemoteAccessPairing: "buildwarden:create-remote-access-pairing",
  listRemoteAccessSessions: "buildwarden:list-remote-access-sessions",
  revokeRemoteAccessSession: "buildwarden:revoke-remote-access-session",
  getNetworkProxySettings: "buildwarden:get-network-proxy-settings",
  selectProject: "buildwarden:select-project",
  reorderProjects: "buildwarden:reorder-projects",
  pickProjectDirectory: "buildwarden:pick-project-directory",
  openPathInFileManager: "buildwarden:open-path-in-file-manager",
  getAppPaths: "buildwarden:get-app-paths",
  getDetectedCodexInstallation: "buildwarden:get-detected-codex-installation",
  getDetectedClaudeInstallation: "buildwarden:get-detected-claude-installation",
  getDetectedCursorInstallation: "buildwarden:get-detected-cursor-installation",
  listIntegratedSkills: "buildwarden:list-integrated-skills",
  getIntegratedSkillContent: "buildwarden:get-integrated-skill-content",
  openExternalUrl: "buildwarden:open-external-url",
  reportRendererLog: "buildwarden:report-renderer-log",
  pickIdeExecutable: "buildwarden:pick-ide-executable",
  openRunWorktreeInIde: "buildwarden:open-run-worktree-in-ide",
  openFolderInIde: "buildwarden:open-folder-in-ide",
  releaseRun: "buildwarden:release-run",
  respondToShellApproval: "buildwarden:respond-to-shell-approval",
  respondToRunUserInput: "buildwarden:respond-to-run-user-input",
  refreshSnapshot: "buildwarden:refresh-snapshot",
  runEvent: "buildwarden:run-event",
  setAppSetting: "buildwarden:set-app-setting",
  saveNetworkProxySettings: "buildwarden:save-network-proxy-settings",
  addBookmark: "buildwarden:add-bookmark",
  removeBookmark: "buildwarden:remove-bookmark",
  removeBookmarkById: "buildwarden:remove-bookmark-by-id",
  isBookmarked: "buildwarden:is-bookmarked",
  getBookmarksWithSteps: "buildwarden:get-bookmarks-with-steps",
  addChatBookmark: "buildwarden:add-chat-bookmark",
  removeChatBookmark: "buildwarden:remove-chat-bookmark",
  removeChatBookmarkById: "buildwarden:remove-chat-bookmark-by-id",
  isChatBookmarked: "buildwarden:is-chat-bookmarked",
  getChatBookmarksWithSteps: "buildwarden:get-chat-bookmarks-with-steps",
  resetDatabase: "buildwarden:reset-database",
  createChat: "buildwarden:create-chat",
  createRunChat: "buildwarden:create-run-chat",
  getRunChat: "buildwarden:get-run-chat",
  getChatDetail: "buildwarden:get-chat-detail",
  followUpChat: "buildwarden:follow-up-chat",
  listChats: "buildwarden:list-chats",
  listChatsWithSteps: "buildwarden:list-chats-with-steps",
  deleteChat: "buildwarden:delete-chat",
  cancelChat: "buildwarden:cancel-chat",
  chatEvent: "buildwarden:chat-event",
  runTerminalStart: "buildwarden:run-terminal-start",
  runTerminalWrite: "buildwarden:run-terminal-write",
  runTerminalResize: "buildwarden:run-terminal-resize",
  runTerminalKill: "buildwarden:run-terminal-kill",
  runTerminalData: "buildwarden:run-terminal-data",
  runTerminalExit: "buildwarden:run-terminal-exit",
  openSystemTerminalAtPath: "buildwarden:open-system-terminal-at-path",
  appMenuCommand: "buildwarden:app-menu-command",
  appWarning: "buildwarden:app-warning",
  /** Main notifies renderer after settings changed outside the renderer (e.g. theme from the app menu). */
  appSettingsChanged: "buildwarden:app-settings-changed",
  projectForgeRequestOpen: "buildwarden:project-forge-request-open",
  projectForgeRequestNotification: "buildwarden:project-forge-request-notification",
  showAppMenu: "buildwarden:show-app-menu",
} as const;

export const APP_SETTING_KEYS = {
  darkMode: "darkMode",
  /**
   * `"dark"` | `"light"`. When unset, {@link parseUiTheme} falls back to legacy {@link APP_SETTING_KEYS.darkMode}.
   */
  uiTheme: "uiTheme",
  /** `"true"` gives the app sidebar a distinct theme-aware surface color. */
  sidebarContrast: "sidebarContrast",
  /** Persisted app sidebar width in CSS pixels. */
  sidebarWidth: "sidebarWidth",
  /** Number of days shown in the sidebar Recent Runs section. */
  recentRunDays: "recentRunDays",
  autoCheckoutRunBranchOnOpen: "autoCheckoutRunBranchOnOpen",
  autoReleaseRunBranchOnLeave: "autoReleaseRunBranchOnLeave",
  /** Optional absolute directory used as the parent root for app-managed worktrees. Blank = default sibling-folder logic. */
  worktreeRootOverride: "worktreeRootOverride",
  enableDevMode: "enableDevMode",
  lastUsedRunModelId: "lastUsedRunModelId",
  keyboardShortcuts: "keyboardShortcuts",
  /** JSON string array of extra regex sources for `run_shell` (merged with built-ins). */
  shellAllowlistExtra: "shellAllowlistExtra",
  /** JSON object: optional `vscode`, `cursor`, `intellij` executable paths. */
  idePaths: "idePaths",
  /** JSON object keyed by run id for persisted run-detail tile visibility/order/size. */
  runWorkspaceLayouts: "runWorkspaceLayouts",
  /** Preferred visual density for agent run timelines. */
  runTimelineDensity: "runTimelineDensity",
  /** JSON string array of project ids representing the custom sidebar order. */
  projectOrder: "projectOrder",
  /** JSON string array of integrated skill ids disabled globally in Settings -> Skills. */
  integratedSkillsDisabled: "integratedSkillsDisabled",
  /** JSON object keyed by project id with string-array skill ids enabled for that project. */
  projectActiveSkills: "projectActiveSkills",
  /** JSON object keyed by project id containing Project Lab automation settings. */
  projectLabSettings: "projectLabSettings",
  /** JSON object keyed by project id with persisted run defaults (mode, workspace, models, efforts, full access). */
  projectRunDefaults: "projectRunDefaults",
  /** Internal one-time migration marker for consolidating the former run-base setting into each project. */
  projectBaseBranchMigrationVersion: "projectBaseBranchMigrationVersion",
  /** JSON object keyed by project id with PR/MR background polling intervals. */
  projectForgePrMonitorSettings: "projectForgePrMonitorSettings",
  /** JSON object with app-wide outbound proxy host/port/user settings (password stored in secure storage). */
  networkProxyConfig: "networkProxyConfig",
  /** Optional remote-access host. Absent or any value other than `"true"` keeps it disabled. */
  remoteAccessEnabled: "remoteAccess.enabled",
  /** User opt-in for a BuildWarden-owned Tailscale Serve root handler. */
  remoteAccessTailscaleEnabled: "remoteAccess.tailscaleEnabled",
  /** Internal ownership marker; only exact matching handlers are removed. */
  remoteAccessTailscaleManagedHost: "remoteAccess.tailscaleManagedHost",
  /** Internal ownership marker for the loopback proxy target. */
  remoteAccessTailscaleManagedTarget: "remoteAccess.tailscaleManagedTarget",
  /** JSON string array of welcome/onboarding check ids that have been satisfied at least once. */
  welcomeCompletedCheckIds: "welcomeCompletedCheckIds",
} as const;

export const DEFAULT_REMOTE_ACCESS_ENABLED = false;

/** Remote access is opt-in: legacy databases and malformed values always remain disabled. */
export const parseRemoteAccessEnabledSetting = (raw: string | undefined | null): boolean =>
  raw === "true";

export const DEFAULT_RECENT_RUN_DAYS = 2;
export const MIN_RECENT_RUN_DAYS = 1;
export const MAX_RECENT_RUN_DAYS = 365;

export type RunTimelineDensity = "compact" | "comfortable" | "detailed";

export const RUN_TIMELINE_DENSITIES = ["compact", "comfortable", "detailed"] as const satisfies readonly RunTimelineDensity[];

export const parseWelcomeCompletedCheckIdsSetting = (raw: string | undefined | null): string[] => {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return Array.from(
      new Set(parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)),
    );
  } catch {
    return [];
  }
};

export const serializeWelcomeCompletedCheckIdsSetting = (ids: Iterable<string>): string =>
  JSON.stringify(
    Array.from(new Set(Array.from(ids).map((id) => id.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
  );

export const parseRunTimelineDensitySetting = (raw: string | undefined): RunTimelineDensity => {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "compact" || normalized === "detailed" ? normalized : "comfortable";
};

export const parseRecentRunDaysSetting = (raw: string | number | undefined | null): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RECENT_RUN_DAYS;
  }
  return Math.min(MAX_RECENT_RUN_DAYS, Math.max(MIN_RECENT_RUN_DAYS, Math.round(parsed)));
};

export const DEFAULT_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES = 0;
export const MIN_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES = 0;
export const MAX_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES = 24 * 60;

export type ProjectForgePrMonitorSettingsByProjectId = Record<string, ProjectForgePrMonitorSettings>;

export const parseProjectForgePrMonitorIntervalMinutes = (raw: string | number | undefined | null): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES;
  }
  return Math.min(
    MAX_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES,
    Math.max(MIN_PROJECT_FORGE_PR_MONITOR_INTERVAL_MINUTES, Math.round(parsed)),
  );
};

export const parseProjectForgePrMonitorSettingsSetting = (
  raw: string | undefined | null,
): ProjectForgePrMonitorSettingsByProjectId => {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ProjectForgePrMonitorSettingsByProjectId = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (!projectId || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const intervalMinutes = parseProjectForgePrMonitorIntervalMinutes(
        (value as Partial<ProjectForgePrMonitorSettings>).intervalMinutes,
      );
      if (intervalMinutes > 0) {
        result[projectId] = { intervalMinutes };
      }
    }
    return result;
  } catch {
    return {};
  }
};

export const serializeProjectForgePrMonitorSettingsSetting = (value: ProjectForgePrMonitorSettingsByProjectId): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .map(([projectId, settings]) => [projectId, { intervalMinutes: parseProjectForgePrMonitorIntervalMinutes(settings.intervalMinutes) }] as const)
        .filter(([, settings]) => settings.intervalMinutes > 0),
    ),
  );

export const buildDefaultProjectLabSettings = (): ProjectLabSettings => ({
  enabled: false,
  maxThreadsPerDay: 3,
  maxConcurrentThreads: 1,
  implementationModelId: null,
  reviewModelId: null,
});

export type ProjectLabSettingsByProjectId = Record<string, ProjectLabSettings>;

export const parseProjectLabSettingsSetting = (raw: string | undefined | null): ProjectLabSettingsByProjectId => {
  if (raw == null || !String(raw).trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ProjectLabSettingsByProjectId = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const defaults = buildDefaultProjectLabSettings();
      result[projectId] = {
        enabled: record.enabled === true,
        maxThreadsPerDay: Math.min(20, Math.max(1, Number(record.maxThreadsPerDay ?? defaults.maxThreadsPerDay) || defaults.maxThreadsPerDay)),
        maxConcurrentThreads: Math.min(6, Math.max(1, Number(record.maxConcurrentThreads ?? defaults.maxConcurrentThreads) || defaults.maxConcurrentThreads)),
        implementationModelId:
          typeof record.implementationModelId === "string" && record.implementationModelId.trim()
            ? record.implementationModelId.trim()
            : null,
        reviewModelId: typeof record.reviewModelId === "string" && record.reviewModelId.trim() ? record.reviewModelId.trim() : null,
      };
    }
    return result;
  } catch {
    return {};
  }
};

export const serializeProjectLabSettingsSetting = (value: ProjectLabSettingsByProjectId): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).map(([projectId, settings]) => [
        projectId,
        {
          enabled: settings.enabled === true,
          maxThreadsPerDay: Math.min(20, Math.max(1, settings.maxThreadsPerDay || 3)),
          maxConcurrentThreads: Math.min(6, Math.max(1, settings.maxConcurrentThreads || 1)),
          implementationModelId: settings.implementationModelId?.trim() || null,
          reviewModelId: settings.reviewModelId?.trim() || null,
        },
      ]),
    ),
  );

/** Per-project defaults applied to new agent runs, persisted across app restarts. */
export interface ProjectRunDefaults {
  mode: RunMode;
  workspaceType: RunWorkspaceType;
  /** Default model for direct (local) workspace runs. Empty string = last used / first available. */
  modelId: string;
  /** Models used for isolated workspace (worktree/copy) runs. Empty = fall back to {@link modelId}. */
  worktreeModelIds: string[];
  reasoningEffort: string;
  anthropicEffort: string;
  /** Full Access: skip per-tool approvals for new runs. */
  yoloMode: boolean;
}

export type ProjectRunDefaultsByProjectId = Record<string, ProjectRunDefaults>;

export const buildDefaultProjectRunDefaults = (): ProjectRunDefaults => ({
  mode: "code",
  workspaceType: "worktree",
  modelId: "",
  worktreeModelIds: [],
  reasoningEffort: "medium",
  anthropicEffort: "medium",
  yoloMode: false,
});

const RUN_DEFAULT_MODES: readonly RunMode[] = ["code", "plan", "ask"];
const RUN_DEFAULT_WORKSPACE_TYPES: readonly RunWorkspaceType[] = ["worktree", "local", "copy"];
const RUN_DEFAULT_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];

const parseProjectRunDefaultsRecord = (value: unknown): ProjectRunDefaults | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const defaults = buildDefaultProjectRunDefaults();
  return {
    mode: RUN_DEFAULT_MODES.includes(record.mode as RunMode) ? (record.mode as RunMode) : defaults.mode,
    workspaceType: RUN_DEFAULT_WORKSPACE_TYPES.includes(record.workspaceType as RunWorkspaceType)
      ? (record.workspaceType as RunWorkspaceType)
      : defaults.workspaceType,
    modelId: typeof record.modelId === "string" ? record.modelId.trim() : defaults.modelId,
    worktreeModelIds: Array.isArray(record.worktreeModelIds)
      ? [...new Set(record.worktreeModelIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
      : defaults.worktreeModelIds,
    reasoningEffort: RUN_DEFAULT_EFFORTS.includes(record.reasoningEffort as string) ? (record.reasoningEffort as string) : defaults.reasoningEffort,
    anthropicEffort: RUN_DEFAULT_EFFORTS.includes(record.anthropicEffort as string) ? (record.anthropicEffort as string) : defaults.anthropicEffort,
    yoloMode: record.yoloMode === true,
  };
};

export const parseProjectRunDefaultsSetting = (raw: string | undefined | null): ProjectRunDefaultsByProjectId => {
  if (raw == null || !String(raw).trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ProjectRunDefaultsByProjectId = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const defaults = parseProjectRunDefaultsRecord(value);
      if (projectId.trim() && defaults) result[projectId] = defaults;
    }
    return result;
  } catch {
    return {};
  }
};

/** Visual theme: liquid-glass dark or liquid-glass light. */
export const UI_THEME_VALUES = ["dark", "light"] as const;
export type UiTheme = (typeof UI_THEME_VALUES)[number];

export const isUiTheme = (value: unknown): value is UiTheme =>
  typeof value === "string" && (UI_THEME_VALUES as readonly string[]).includes(value);

/**
 * Resolve UI theme from persisted settings. Uses `uiTheme` when valid; otherwise maps legacy `darkMode`.
 */
export const parseUiTheme = (settings: Record<string, string | undefined>): UiTheme => {
  const raw = settings[APP_SETTING_KEYS.uiTheme]?.trim().toLowerCase();
  if (isUiTheme(raw)) {
    return raw;
  }
  return settings[APP_SETTING_KEYS.darkMode] === "false" ? "light" : "dark";
};

/** Legacy key used by native chrome: only bright mode is “not dark”. */
export const uiThemeToLegacyDarkMode = (theme: UiTheme): "true" | "false" => (theme === "light" ? "false" : "true");

export const cycleUiTheme = (current: UiTheme): UiTheme => (current === "dark" ? "light" : "dark");

/**
 * Windows frameless windows: Electron `titleBarOverlay.color` fills the minimize/maximize/close region.
 * Keep these in sync with the renderer's `--ec-titlebar` tokens so the native caption buttons blend into AppTitleBar.
 * The overlay is one pixel shorter than the renderer title bar so AppTitleBar's bottom border stays visible beneath it.
 */
export const WINDOWS_TITLEBAR_HEIGHT = 40;
export const WINDOWS_TITLEBAR_OVERLAY_HEIGHT = WINDOWS_TITLEBAR_HEIGHT - 1;

export const WINDOWS_TITLEBAR_OVERLAY_BACKGROUND: Record<UiTheme, string> = {
  dark: "#101417",
  light: "#e7eef6",
};

export type RunWorkspacePanelId = "activity" | "diff" | "terminal" | "browser" | "notes" | "chat";

export interface RunWorkspaceTileSize {
  colSpan: number;
  rowSpan: number;
}

export interface RunWorkspaceLayoutPreference {
  visiblePanels: Record<RunWorkspacePanelId, boolean>;
  tileOrder: RunWorkspacePanelId[];
  tileLayout: Record<RunWorkspacePanelId, RunWorkspaceTileSize>;
  /** Whether the secondary panel (diff/terminal/browser) is docked to the right or bottom. */
  secondaryPanelPosition: "right" | "bottom";
}

export type RunWorkspaceLayoutPreferencesByRunId = Record<string, RunWorkspaceLayoutPreference>;

const RUN_WORKSPACE_PANEL_IDS: readonly RunWorkspacePanelId[] = ["activity", "diff", "terminal", "browser", "notes", "chat"];

const RUN_WORKSPACE_PANEL_DEFAULTS: Record<
  RunWorkspacePanelId,
  { visible: boolean; size: RunWorkspaceTileSize }
> = {
  activity: { visible: true, size: { colSpan: 7, rowSpan: 4 } },
  diff: { visible: false, size: { colSpan: 5, rowSpan: 4 } },
  terminal: { visible: false, size: { colSpan: 5, rowSpan: 3 } },
  browser: { visible: false, size: { colSpan: 7, rowSpan: 3 } },
  notes: { visible: false, size: { colSpan: 5, rowSpan: 3 } },
  chat: { visible: false, size: { colSpan: 5, rowSpan: 3 } },
};

const isRunWorkspacePanelId = (value: unknown): value is RunWorkspacePanelId =>
  typeof value === "string" && (RUN_WORKSPACE_PANEL_IDS as readonly string[]).includes(value);

export const parseRunWorkspaceLayoutsSetting = (raw: string | undefined | null): RunWorkspaceLayoutPreferencesByRunId => {
  if (raw == null || !String(raw).trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const out: RunWorkspaceLayoutPreferencesByRunId = {};
    for (const [runId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const visiblePanelsRaw = entry.visiblePanels;
      const tileOrderRaw = entry.tileOrder;
      const tileLayoutRaw = entry.tileLayout;
      if (
        !visiblePanelsRaw ||
        typeof visiblePanelsRaw !== "object" ||
        Array.isArray(visiblePanelsRaw) ||
        !Array.isArray(tileOrderRaw) ||
        !tileLayoutRaw ||
        typeof tileLayoutRaw !== "object" ||
        Array.isArray(tileLayoutRaw)
      ) {
        continue;
      }

      const visiblePanels = {} as Record<RunWorkspacePanelId, boolean>;
      const tileLayout = {} as Record<RunWorkspacePanelId, RunWorkspaceTileSize>;
      let valid = true;

      for (const panelId of RUN_WORKSPACE_PANEL_IDS) {
        const visibleValue = (visiblePanelsRaw as Record<string, unknown>)[panelId];
        const tileValue = (tileLayoutRaw as Record<string, unknown>)[panelId];
        visiblePanels[panelId] = typeof visibleValue === "boolean" ? visibleValue : RUN_WORKSPACE_PANEL_DEFAULTS[panelId].visible;

        if (tileValue && typeof tileValue === "object" && !Array.isArray(tileValue)) {
          const colSpan = (tileValue as Record<string, unknown>).colSpan;
          const rowSpan = (tileValue as Record<string, unknown>).rowSpan;
          if (typeof colSpan === "number" && typeof rowSpan === "number") {
            tileLayout[panelId] = {
              colSpan,
              rowSpan,
            };
            continue;
          }
        }

        tileLayout[panelId] = { ...RUN_WORKSPACE_PANEL_DEFAULTS[panelId].size };
      }

      const normalizedOrder = tileOrderRaw.filter(isRunWorkspacePanelId);
      for (const panelId of RUN_WORKSPACE_PANEL_IDS) {
        if (!normalizedOrder.includes(panelId)) {
          normalizedOrder.push(panelId);
        }
      }
      if (!valid || normalizedOrder.length !== RUN_WORKSPACE_PANEL_IDS.length) {
        continue;
      }

      out[runId] = {
        visiblePanels,
        tileOrder: normalizedOrder,
        tileLayout,
        secondaryPanelPosition: entry.secondaryPanelPosition === "bottom" ? "bottom" : "right",
      };
    }

    return out;
  } catch {
    return {};
  }
};

/** IDEs the user can configure for “open run workspace” actions. */
export const SUPPORTED_IDE_KINDS = ["vscode", "cursor", "intellij"] as const;
export type SupportedIdeKind = (typeof SUPPORTED_IDE_KINDS)[number];

export const IDE_KIND_LABELS: Record<SupportedIdeKind, string> = {
  vscode: "Visual Studio Code",
  cursor: "Cursor",
  intellij: "IntelliJ IDEA",
};

/** Parsed {@link APP_SETTING_KEYS.idePaths} value. */
export type IdePathConfig = Partial<Record<SupportedIdeKind, string>>;

export const parseIdePathConfig = (raw: string | undefined | null): IdePathConfig => {
  if (raw == null || !String(raw).trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const o = parsed as Record<string, unknown>;
    const out: IdePathConfig = {};
    for (const k of SUPPORTED_IDE_KINDS) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        out[k] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
};

export const serializeIdePathConfig = (config: IdePathConfig): string => {
  const o: Record<string, string> = {};
  for (const k of SUPPORTED_IDE_KINDS) {
    const v = config[k]?.trim();
    if (v) {
      o[k] = v;
    }
  }
  return JSON.stringify(o);
};

const isSupportedIdeKind = (value: string): value is SupportedIdeKind =>
  (SUPPORTED_IDE_KINDS as readonly string[]).includes(value);

/** Validates IPC payload for opening a run folder in an IDE. */
export const parseSupportedIdeKind = (value: unknown): SupportedIdeKind => {
  if (typeof value !== "string" || !isSupportedIdeKind(value)) {
    throw new Error("Invalid IDE kind.");
  }
  return value;
};

/**
 * Built-in safe shell patterns (case-insensitive). User settings append {@link APP_SETTING_KEYS.shellAllowlistExtra}.
 */
export const DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES: readonly string[] = [
  "^pwd$",
  "^ls(?:\\s+-[alh]+)*(?:\\s+.+)?$",
  "^cat(?:\\s+.+)+$",
  "^Get-Content(?:\\s+.+)+$",
  "^Select-String(?:\\s+.+)+$",
  "^dir$",
  "^git status(?:\\s+--short|\\s+--porcelain|\\s+-sb)?$",
  "^git diff(?:\\s+[-\\w./:@~^]+)*$",
  "^git branch(?:\\s+--show-current|\\s+--all)?$",
  "^git ls-files$",
  "^git log\\s+-1(?:\\s+--oneline|\\s+--stat)?$",
  "^git rev-parse\\s+--show-toplevel$",
  "^rg\\s+[^\\n]+$",
  "^(?:\\.\\/gradlew|\\.\\\\gradlew(?:\\.bat)?)(?:\\s+(?:test|build|check)(?:\\s+.+)?)$",
  "^pnpm(?:\\s+(?:install|i|ci|add|remove|rm|update|up|dedupe|prune|rebuild|audit|outdated|list|ls|why|test|lint|typecheck|check|build|format|format:check|format:write|eslint|exec\\s+eslint|dlx\\s+eslint)(?:\\s+[^\\n]+)?)?$",
  "^pnpm\\s+(?:run\\s+)?[\\w:.-]+(?:\\s+[^\\n]+)?$",
  "^bun(?:\\s+(?:install|i|ci|add|remove|rm|update|outdated|pm\\s+(?:ls|why|cache)|test|lint|typecheck|check|build|run|x\\s+eslint|eslint)(?:\\s+[^\\n]+)?)?$",
  "^bun\\s+run\\s+[\\w:.-]+(?:\\s+[^\\n]+)?$",
  "^bunx\\s+eslint(?:\\s+[^\\n]+)?$",
  "^eslint(?:\\s+[^\\n]+)?$",
  "^(?:mvn|mvnw|\\.\\/mvnw|\\.\\\\mvnw(?:\\.cmd)?)(?:\\s+(?:-[\\w.:-]+(?:=[^\\s]+)?|clean|validate|compile|test-compile|test|package|verify|install|checkstyle:check|spotless:check|spotless:apply|formatter:format|formatter:validate|fmt:format|fmt:check|dependency:tree|dependency:analyze|surefire:test|failsafe:integration-test|spotbugs:check|pmd:check|jacoco:report))*$",
  "^npm (?:test|run test|run lint|run typecheck)(?:\\s+--\\s+[\\w:-]+)?$",
  "^npm run(?:\\s+.+)+$",
  "^npm view(?:\\s+.+)?$",
  "^npm install(?:\\s+.+)?$",
];

/** Parse persisted JSON array of regex pattern strings; invalid JSON yields `[]`. */
export const parseShellAllowlistExtraSetting = (raw: string | undefined | null): string[] => {
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
};

/** Parse persisted JSON array of integrated skill ids; invalid JSON yields `[]`. */
export const parseIntegratedSkillsDisabledSetting = (raw: string | undefined | null): string[] => {
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0))];
  } catch {
    return [];
  }
};

export const serializeIntegratedSkillsDisabledSetting = (skillIds: readonly string[]): string =>
  JSON.stringify(
    [...new Set(skillIds.map((id) => id.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
  );

export type ProjectActiveSkillsByProjectId = Record<string, string[]>;

/** Parse persisted JSON object keyed by project id; invalid JSON yields `{}`. */
export const parseProjectActiveSkillsSetting = (raw: string | undefined | null): ProjectActiveSkillsByProjectId => {
  if (raw == null || !String(raw).trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const output: ProjectActiveSkillsByProjectId = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!projectId.trim() || !Array.isArray(value)) {
        continue;
      }
      const skillIds = [...new Set(value.filter((x): x is string => typeof x === "string" && x.trim().length > 0))];
      if (skillIds.length > 0) {
        output[projectId] = skillIds;
      }
    }
    return output;
  } catch {
    return {};
  }
};

export const serializeProjectActiveSkillsSetting = (value: ProjectActiveSkillsByProjectId): string => {
  const normalized: ProjectActiveSkillsByProjectId = {};
  for (const [projectId, skillIds] of Object.entries(value)) {
    const normalizedSkillIds = [...new Set(skillIds.map((id) => id.trim()).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (projectId.trim() && normalizedSkillIds.length > 0) {
      normalized[projectId] = normalizedSkillIds;
    }
  }
  return JSON.stringify(normalized);
};

/** Escape a string for use inside a RegExp source. */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source that matches a command exactly (trimmed), case-insensitive when compiled with `i`. */
export const commandToExactShellPatternSource = (command: string): string => `^${escapeRegExp(command.trim())}$`;

export const KEYBOARD_SHORTCUT_IDS = [
  "goHome",
  "toggleSidebar",
  "openCommandPalette",
  "submitComposer",
  "newAgentRun",
  "switchToRecentRun1",
  "switchToRecentRun2",
  "switchToRecentRun3",
  "switchToRecentRun4",
  "switchToRecentRun5",
  "deleteRun",
  "cancelRun",
  "backToProject",
  "openSettings",
  "closeSettings",
] as const;

export type KeyboardShortcutId = (typeof KEYBOARD_SHORTCUT_IDS)[number];

export const DEFAULT_KEYBOARD_SHORTCUTS: Record<KeyboardShortcutId, string> = {
  goHome: "ctrl+h",
  toggleSidebar: "ctrl+m",
  openCommandPalette: "ctrl+k",
  submitComposer: "ctrl+enter",
  newAgentRun: "ctrl+t",
  switchToRecentRun1: "ctrl+1",
  switchToRecentRun2: "ctrl+2",
  switchToRecentRun3: "ctrl+3",
  switchToRecentRun4: "ctrl+4",
  switchToRecentRun5: "ctrl+5",
  deleteRun: "ctrl+d",
  cancelRun: "escape",
  backToProject: "ctrl+[",
  openSettings: "ctrl+,",
  closeSettings: "escape",
};
