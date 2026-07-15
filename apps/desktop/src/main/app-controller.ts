import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  buildDependencyGraphSnapshotForProjectGraph,
  listDependencySourceFilesForProjectGraph,
  normalizeProjectInsightRepoPath,
  shouldIgnoreProjectInsightPath,
} from "./project-graph-utils";
import { runWorktreeDiffInWorker } from "./run-worktree-diff-worker";
import { readRunWorkspaceFileForPreview } from "./run-workspace-file";
import { normalizeJsonResponse } from "./json-response";
import { createFolderSnapshot, deleteFolderSnapshot, diffFolderAgainstSnapshot, getFolderSnapshotRoot } from "./folder-diff";
import { createFolderWorkspaceCopy, removeFolderWorkspaceCopy } from "./folder-workspace";
import { getHarnessTypeForProvider } from "./harness-adapters";
import { createProjectPrReviewProvider } from "./pr-review/pr-review-provider-factory";
import { resolveProjectPrReviewRemoteContext } from "./pr-review/pr-review-remote-context";
import type { ProjectPrReviewProvider, ProjectPrReviewRemoteContext } from "./pr-review/pr-review-types";
import { ProjectLoopRunner } from "./loop/loop-runner";
import { BuildWardenDatabase } from "@buildwarden/db";
import { computePrMrDiffViaFetch, GitService, readRecentCommitLog } from "@buildwarden/git-service";
import { AiSdkProviderAdapter, generateAskTextResultWithAiSdk, suggestCommitMessageWithAiSdk } from "@buildwarden/provider-ai-sdk";
import {
  ClaudeCodeProviderAdapter,
  assertClaudeCodeAvailable,
  generateAskTextResultWithClaudeCode,
  listClaudeCodeSlashCommands,
  suggestCommitMessageWithClaudeCode,
} from "@buildwarden/provider-claude-code";
import { CodexCliProviderAdapter, assertCodexCliAvailable, generateAskTextResultWithCodexCli, suggestCommitMessageWithCodexCli } from "@buildwarden/provider-codex-cli";
import {
  CursorAgentProviderAdapter,
  assertCursorAgentAvailable,
  generateAskTextResultWithCursorAgent,
  getCursorAgentBinaryPathCandidates,
  suggestCommitMessageWithCursorAgent,
} from "@buildwarden/provider-cursor-agent";
import { AzureLegacyProviderAdapter, createAzureLegacyClientFromParts, createAzureLegacyDevLogger } from "@buildwarden/provider-azure-legacy";
import { INTEGRATED_SKILLS_BY_ID, INTEGRATED_SKILLS_CATALOG } from "@buildwarden/shared/integrated-skills-catalog";
import {
  APP_SETTING_KEYS,
  buildNetworkProxyRuntimeConfig,
  buildDefaultProjectLabSettings,
  filterComposerCommandDescriptors,
  getModelPresetsForProvider,
  isDetachedHeadProjectErrorMessage,
  listComposerCommandsForProvider,
  mergeComposerCommandDescriptors,
  type AppPathsInfo,
  type AppLogDirectorySizeInfo,
  type ComposerCommandDescriptor,
  type ComposerCommandContext,
  type IntegratedSkillMetadata,
  type NetworkProxyRuntimeConfig,
  type NetworkProxySettingsInput,
  type NetworkProxySettingsSnapshot,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  buildPriorChatCompletionMessagesFromSteps,
  commandToExactShellPatternSource,
  getDefaultProviderCapabilities,
  IDE_KIND_LABELS,
  parseNetworkProxySettings,
  parseIdePathConfig,
  parseIntegratedSkillsDisabledSetting,
  parseProjectForgePrMonitorIntervalMinutes,
  parseProjectForgePrMonitorSettingsSetting,
  parseProjectLabSettingsSetting,
  parseProjectActiveSkillsSetting,
  parseShellAllowlistExtraSetting,
  serializeProjectForgePrMonitorSettingsSetting,
  validateChatAttachmentPayloads,
  type UnifiedProviderFamily,
  type StoredAttachmentMetadata,
  type AppSnapshot,
  type BookmarkRecord,
  type ChatBookmarkRecord,
  type ChatDetail,
  type ChatAttachmentPayload,
  type ChatInput,
  type ChatRecord,
  RUN_CHAT_CONTEXT_SOURCE,
  type RunChatInput,
  type ContinueRunInput,
  type CreateProjectBranchInput,
  type DeleteProjectBranchInput,
  type DesktopApi,
  type FetchProjectPrMrDiffInput,
  type GetProjectForgeRequestDetailsInput,
  type ListProjectForgeRequestsInput,
  type ListAvailableProviderModelsInput,
  type ListAvailableProviderModelsResult,
  type ListComposerCommandsInput,
  type ModelInput,
  type ModelRecord,
  type OpenPathInFileManagerResult,
  type ProjectInput,
  type ProjectBranchDeleteImpact,
  type ProjectFolderGitStatus,
  type ProjectGitBranchOverview,
  type ProjectGitConversionCandidate,
  type ProjectForgeAuthStatus,
  type ProjectForgePrMonitorConfig,
  type ProjectForgePrMonitorSettings,
  type ProjectForgePrMonitorSettingsInput,
  type ProjectForgeRequestsResult,
  type ProjectForgeRequestDetailsResult,
  type ProjectForgeReviewActionResult,
  type GenerateProjectInsightInput,
  type ArchitectureGraphInsightData,
  type DependencyGravityInsightData,
  type NarrativeBranchingInsightData,
  type ProjectInsightNode,
  type ProjectInsightEdge,
  type ProjectInsightKind,
  type ProjectLabMode,
  type ProjectLabSettings,
  type ProjectLabThreadRecord,
  type CreateProjectLoopInput,
  type ProjectLoopAvailability,
  type ProjectLoopChangedPayload,
  type ProjectLoopDetail,
  type ProjectLoopRecord,
  type ProjectLoopUiReviewDecisionInput,
  isLoopCapableProviderType,
  type RunProjectLabInput,
  type RunRecord,
  type RunWorkspaceFileInput,
  type RunWorkspaceFileResult,
  type ProjectPrMrDiffResult,
  type PostProjectPrMrReviewInput,
  type ReplyProjectPrMrReviewThreadInput,
  type ResolveProjectPrMrReviewThreadInput,
  type SubmitProjectPrMrCommentsInput,
  type ProjectInsightRecord,
  type ProjectInsightData,
  type ProjectRecord,
  type ProjectTaskInput,
  type ProjectTaskRecord,
  type ProviderAccountInput,
  type ProviderAdapter,
  type ProviderAvailableModel,
  type ProviderAccountRecord,
  type ProviderSessionRuntimeInput,
  type PushProjectBranchInput,
  type RendererLogPayload,
  type RenameProjectBranchInput,
  type RunResumeCheckpoint,
  type RunDetail,
  type RunDiffReviewFinding,
  type RunDiffReviewOptions,
  type RunDiffReviewResult,
  type RunEvent,
  type AppWarning,
  type RunWorktreeDiffResult,
  type RunFollowUpOptions,
  type RunInput,
  type RunListVisibility,
  type RunNoteRecord,
  type RunWorkspaceVcs,
  type UpdateProjectTaskInput,
  type UpdateRunNoteInput,
  type RunTokenUsage,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
  type ShellApprovalDecision,
  type ShellApprovalRespondOptions,
  type SecretStore,
  type SupportedIdeKind,
  type WorktreeStatus,
} from "@buildwarden/shared";
import { logError, logInfo, logWarn } from "./logger";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { HostEventBus } from "./host-events";
import type { HostTerminal } from "./host-terminal-service";
import { buildIntegratedSkillContext } from "./integrated-skill-context";
import {
  buildRunChatContext,
  buildRunChatFirstTurnPrompt,
  buildRunChatUpdateTurnPrompt,
  providerReplaysChatHistory,
} from "./run-chat-context";

const MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST = 100_000;
const MAX_DIFF_CHARS_FOR_REVIEW = 140_000;
const MAX_PROJECT_INSIGHT_PROMPT_CHARS = 20_000;
const normalizeAssistantOutputText = (value: string) => value.replace(/\s+/g, " ").trim();
const normalizeRunGoalText = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
};
const buildPromptWithRunGoal = (prompt: string, goalText: string | null | undefined): string => {
  const goal = normalizeRunGoalText(goalText);
  if (!goal) {
    return prompt;
  }
  return ["Run goal:", goal, "", "User request:", prompt.trim() || "(no additional request text)"].join("\n");
};
const CANONICAL_RUN_CHUNK_TYPES = new Set<string>([
  "tool-call",
  "tool-result",
  "approval-requested",
  "approval-resolved",
  "user-input-requested",
  "plan-updated",
  "plan-progress",
  "diff-updated",
  "tool-progress",
  "request",
  "plan",
]);

const isCanonicalRunChunkType = (value: string): value is RunEvent["type"] => CANONICAL_RUN_CHUNK_TYPES.has(value);

/** Maps a provider chunk type onto the persisted run step event type. */
const runChunkEventType = (chunkType: string): RunEvent["type"] | "output" | "error" | "status" => {
  if (chunkType === "message") {
    return "output";
  }
  if (isCanonicalRunChunkType(chunkType)) {
    return chunkType;
  }
  return chunkType === "error" ? "error" : "status";
};

const isDuplicateFinalSummaryStep = (
  step: {
    eventType: string;
    title: string;
    content: string;
    metadataJson: string;
  },
  previousAssistantContent: string | null,
) => {
  if (step.eventType !== "output") {
    return false;
  }
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
  } catch {
    /* ignore malformed legacy metadata */
  }
  if (metadata.assistantKind !== "final-summary") {
    return false;
  }
  const normalizedContent = normalizeAssistantOutputText(step.content);
  return Boolean(previousAssistantContent) && normalizedContent.length > 0 && normalizedContent === previousAssistantContent;
};

const PROJECT_INSIGHT_AI_KINDS = new Set<ProjectInsightKind>([
  "repo-historian",
  "codebase-mood",
  "curiosity-mode",
]);

type ModelInvocationContext = {
  model: ModelRecord;
  provider: ProviderAccountRecord;
  apiKey: string;
  providerConfig: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
  networkProxy: NetworkProxyRuntimeConfig | undefined;
};

type RepoCommitInfo = {
  sha: string;
  author: string;
  date: string;
  title: string;
  files: string[];
};

const parseRecentCommitLog = (output: string): RepoCommitInfo[] => {
  const commits: RepoCommitInfo[] = [];
  let current: RepoCommitInfo | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("__EC__")) {
      if (current) commits.push(current);
      const [, sha = "", author = "", date = "", title = ""] = line.split("\t");
      current = { sha: sha.replace(/^__EC__/, ""), author: author.trim(), date: date.trim(), title: title.trim(), files: [] };
      continue;
    }
    if (current) {
      const normalized = normalizeProjectInsightRepoPath(line);
      if (!shouldIgnoreProjectInsightPath(normalized)) current.files.push(normalized);
    }
  }
  if (current) commits.push(current);
  return commits;
};

const parseMetadataRecord = (metadataJson: string): Record<string, unknown> => {
  try {
    return JSON.parse(metadataJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const findInterruptionTimestamps = (steps: RunDetail["steps"]): { latestInterruptedAt: string; latestRecoveryAt: string } => {
  let latestInterruptedAt = "";
  let latestRecoveryAt = "";
  for (const step of steps) {
    const metadata = parseMetadataRecord(step.metadataJson);
    if (metadata.sessionInterrupted === true && step.createdAt > latestInterruptedAt) latestInterruptedAt = step.createdAt;
    const recovered = metadata.recoveredInterruptedSession === true || metadata.resumedFromCheckpoint === true;
    if (recovered && step.createdAt > latestRecoveryAt) latestRecoveryAt = step.createdAt;
  }
  return { latestInterruptedAt, latestRecoveryAt };
};

const measureDirectoryEntry = (currentDir: string, entry: Dirent, pendingDirs: string[]): { bytes: number; files: number; unreadable: number } => {
  if (entry.isSymbolicLink()) return { bytes: 0, files: 0, unreadable: 0 };
  const entryPath = join(currentDir, entry.name);
  if (entry.isDirectory()) {
    pendingDirs.push(entryPath);
    return { bytes: 0, files: 0, unreadable: 0 };
  }
  if (!entry.isFile()) return { bytes: 0, files: 0, unreadable: 0 };
  try {
    return { bytes: lstatSync(entryPath).size, files: 1, unreadable: 0 };
  } catch {
    return { bytes: 0, files: 0, unreadable: 1 };
  }
};

type RepoFileHotspot = {
  path: string;
  commitCount: number;
  ownerLabel: string | null;
};

type DependencyGraphSnapshot = {
  modules: Array<{
    source: string;
    dependencies: Array<{
      resolved: string | null;
    }>;
  }>;
};

const PROJECT_LAB_MODES: ProjectLabMode[] = ["new-feature", "bugfix", "refactoring", "rfc-only"];
const PROJECT_LAB_MODE_LABELS: Record<ProjectLabMode, string> = {
  "new-feature": "New feature",
  bugfix: "Bugfix",
  refactoring: "Refactoring",
  "rfc-only": "RFC only",
};

const normalizeSuggestedCommitMessage = (raw: string): string => {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[\w-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return t;
};

const extractChatCompletionText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return [];
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") {
        return [record.text];
      }
      const nestedText = record.text;
      if (nestedText && typeof nestedText === "object" && !Array.isArray(nestedText)) {
        const value = (nestedText as Record<string, unknown>).value;
        if (typeof value === "string") {
          return [value];
        }
      }
      return [];
    })
    .join("")
    .trim();
};

const usageFromChatCompletion = (usage: unknown): RunTokenUsage => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const raw = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  const inputTokens = Number(raw.prompt_tokens ?? raw.promptTokens ?? 0);
  const outputTokens = Number(raw.completion_tokens ?? raw.completionTokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? inputTokens + outputTokens);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(totalTokens) && totalTokens > 0 ? { totalTokens } : {}),
  };
};

const AZURE_LEGACY_REASONING_ASK_TEXT_MIN_COMPLETION_TOKENS = 24_000;

const isReasoningCompletionModelId = (modelId: string): boolean => /^(?:o\d|gpt-5)(?:$|[.\-_])/i.test(modelId.trim());

const resolveAzureLegacyAskTextCompletionTokenLimit = (modelId: string, requestedMaxTokens: number): number => {
  if (!isReasoningCompletionModelId(modelId)) {
    return requestedMaxTokens;
  }
  return Math.max(requestedMaxTokens, AZURE_LEGACY_REASONING_ASK_TEXT_MIN_COMPLETION_TOKENS);
};

const clampReviewScore = (value: unknown): number => {
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
};

const resolveRecoveryKind = (
  providerRecoverySupported: boolean,
  hasCheckpoint: boolean,
  hasResumeCursor: boolean,
): "checkpoint" | "provider-session" | null => {
  if (!providerRecoverySupported) {
    return null;
  }
  if (hasCheckpoint) {
    return "checkpoint";
  }
  return hasResumeCursor ? "provider-session" : null;
};

const firstNonEmptyLine = (output: string): string | null => {
  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
};

const describeInterruptedRecoveryDetail = (hasCheckpoint: boolean, providerSessionAvailable: boolean): string => {
  if (hasCheckpoint) {
    return "BuildWarden saved a checkpoint from the last completed tool round and can start a deliberate recovery turn.";
  }
  if (providerSessionAvailable) {
    return "BuildWarden saved the provider session cursor and can continue from the current workspace state.";
  }
  return "No checkpoint or provider session cursor was saved before the application closed.";
};

const SHELL_APPROVAL_DECISION_MESSAGES: Record<string, { title: string; content: string }> = {
  deny: { title: "Shell command denied", content: "The requested shell command was denied." },
  "allow-for-run": {
    title: "Shell command allowed for run",
    content: "The requested shell command was allowed and will stay allowed for this run.",
  },
  "allow-always": {
    title: "Shell command allowed and saved to settings",
    content:
      "The requested shell command was allowed. An exact-match pattern was added to Settings > Projects & Workspace > Shell allowlist.",
  },
  "allow-once": { title: "Shell command allowed once", content: "The requested shell command was allowed once." },
};

/** Human-readable lab kickoff message; `baseBranch` is null for plain folder projects. */
const describeLabStart = (modeLabel: string, baseBranch: string | null, topic: string | null): string => {
  const origin = baseBranch ? `Started ${modeLabel} mode from base branch \`${baseBranch}\`` : `Started ${modeLabel} mode for this project folder`;
  return topic ? `${origin} with user direction: ${topic}` : `${origin}.`;
};

const parseReviewLineNumber = (value: unknown, fallbackReference: unknown): number | null => {
  let numericValue = Number.NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string") {
    numericValue = Number.parseInt(value.trim(), 10);
  }
  if (Number.isInteger(numericValue) && numericValue > 0) {
    return numericValue;
  }

  if (typeof fallbackReference !== "string") {
    return null;
  }

  const match = /\b(?:line|lines|L)?\s*(\d{1,7})\b/i.exec(fallbackReference);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const getAiSdkProviderFamilyFromConfig = (configJson: string): UnifiedProviderFamily => {
  try {
    const config = JSON.parse(configJson || "{}") as Record<string, unknown>;
    const raw = config[PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY];
    if (
      raw === "openai" ||
      raw === "anthropic" ||
      raw === "google" ||
      raw === "xai" ||
      raw === "openai-compatible"
    ) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "openai";
};

const parseProviderConfigJson = (configJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const dedupeAvailableProviderModels = (models: readonly ProviderAvailableModel[]): ProviderAvailableModel[] => {
  const seen = new Set<string>();
  const deduped: ProviderAvailableModel[] = [];
  for (const model of models) {
    const modelId = model.modelId.trim();
    if (!modelId) {
      continue;
    }
    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...model,
      modelId,
      displayName: model.displayName.trim() || modelId,
    });
  }
  return deduped;
};

const getCuratedAvailableModelsForProvider = (provider: ProviderAccountRecord): ProviderAvailableModel[] => {
  const providerFamily =
    provider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfig(provider.configJson) : undefined;
  return getModelPresetsForProvider(provider.providerType, providerFamily).map((preset) => ({
    modelId: preset.modelId,
    displayName: preset.displayName,
    source: "curated" as const,
  }));
};

const providerAllowsMissingApiKey = (provider: ProviderAccountRecord): boolean =>
  provider.providerType === "codex-cli" ||
  provider.providerType === "claude-code" ||
  provider.providerType === "cursor-agent" ||
  (provider.providerType === "ai-sdk" && getAiSdkProviderFamilyFromConfig(provider.configJson) === "openai-compatible");

const providerSupportsInterruptedRunRecovery = (providerType: ProviderAccountRecord["providerType"]): boolean =>
  providerType === "codex-cli" || providerType === "claude-code" || providerType === "cursor-agent";

const makeNativeComposerCommand = (
  providerType: ProviderAccountRecord["providerType"],
  command: `/${string}`,
  description: string,
  argumentHint?: string,
): ComposerCommandDescriptor => ({
  id: `${providerType}:${command.slice(1).replace(/[^a-z0-9_.:-]+/gi, "-")}`,
  command: command.toLowerCase() as `/${string}`,
  label: command.slice(1),
  description,
  providerType,
  effect: "native-prompt",
  ...(argumentHint ? { argumentHint } : {}),
  source: "provider",
  supportsRun: true,
  supportsFollowUp: true,
});

const CODEX_NATIVE_COMPOSER_COMMANDS: readonly ComposerCommandDescriptor[] = [
  makeNativeComposerCommand("codex-cli", "/agent", "Manage or switch Codex agents."),
  makeNativeComposerCommand("codex-cli", "/apps", "Manage Codex apps and connectors."),
  makeNativeComposerCommand("codex-cli", "/approve", "Review pending approvals."),
  makeNativeComposerCommand("codex-cli", "/clear", "Clear the current conversation context."),
  makeNativeComposerCommand("codex-cli", "/compact", "Compact the conversation context."),
  makeNativeComposerCommand("codex-cli", "/copy", "Copy the latest assistant response."),
  makeNativeComposerCommand("codex-cli", "/debug-config", "Show Codex debug configuration."),
  makeNativeComposerCommand("codex-cli", "/diff", "Show current code changes."),
  makeNativeComposerCommand("codex-cli", "/exit", "Exit the session."),
  makeNativeComposerCommand("codex-cli", "/experimental", "Open experimental Codex features."),
  makeNativeComposerCommand("codex-cli", "/fast", "Switch to a faster model or effort profile."),
  makeNativeComposerCommand("codex-cli", "/feedback", "Send feedback."),
  makeNativeComposerCommand("codex-cli", "/fork", "Fork the current conversation."),
  makeNativeComposerCommand("codex-cli", "/hooks", "Manage Codex hooks."),
  makeNativeComposerCommand("codex-cli", "/ide", "Manage IDE integration."),
  makeNativeComposerCommand("codex-cli", "/init", "Create or update repository instructions."),
  makeNativeComposerCommand("codex-cli", "/keymap", "Change keyboard shortcuts."),
  makeNativeComposerCommand("codex-cli", "/logout", "Sign out of Codex."),
  makeNativeComposerCommand("codex-cli", "/mcp", "Manage MCP servers and tools."),
  makeNativeComposerCommand("codex-cli", "/memories", "Manage saved memories."),
  makeNativeComposerCommand("codex-cli", "/mention", "Mention a file, symbol, or resource.", "<target>"),
  makeNativeComposerCommand("codex-cli", "/model", "Change the active model."),
  makeNativeComposerCommand("codex-cli", "/new", "Start a new session."),
  makeNativeComposerCommand("codex-cli", "/permissions", "Review or update permissions."),
  makeNativeComposerCommand("codex-cli", "/personality", "Adjust the assistant personality."),
  makeNativeComposerCommand("codex-cli", "/plugins", "Manage Codex plugins."),
  makeNativeComposerCommand("codex-cli", "/ps", "Show active Codex sessions."),
  makeNativeComposerCommand("codex-cli", "/quit", "Quit the session."),
  makeNativeComposerCommand("codex-cli", "/raw", "Send raw text without command interpretation."),
  makeNativeComposerCommand("codex-cli", "/resume", "Resume a previous session."),
  makeNativeComposerCommand("codex-cli", "/review", "Review current code changes."),
  makeNativeComposerCommand("codex-cli", "/sandbox-add-read-dir", "Allow Codex to read another directory.", "<path>"),
  makeNativeComposerCommand("codex-cli", "/side", "Open side-by-side mode."),
  makeNativeComposerCommand("codex-cli", "/skills", "List or manage Codex skills."),
  makeNativeComposerCommand("codex-cli", "/status", "Show session status."),
  makeNativeComposerCommand("codex-cli", "/statusline", "Configure the status line."),
  makeNativeComposerCommand("codex-cli", "/stop", "Stop the current response."),
  makeNativeComposerCommand("codex-cli", "/theme", "Change the theme."),
  makeNativeComposerCommand("codex-cli", "/title", "Set the session title.", "<title>"),
  makeNativeComposerCommand("codex-cli", "/vim", "Toggle Vim keybindings."),
];

type ClaudeSlashCommand = Awaited<ReturnType<typeof listClaudeCodeSlashCommands>>[number];

const normalizeProviderSlashCommandName = (value: string): `/${string}` | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return /^\/[A-Za-z][A-Za-z0-9_.:-]*$/.test(withSlash) ? (withSlash.toLowerCase() as `/${string}`) : null;
};

const readLegacyProjectRunBaseBranches = (
  raw: string | undefined,
): { branchesByProjectId: Record<string, string>; cleaned: string | null } => {
  if (!raw?.trim()) {
    return { branchesByProjectId: {}, cleaned: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { branchesByProjectId: {}, cleaned: null };
    }
    const records = parsed as Record<string, unknown>;
    const branchesByProjectId: Record<string, string> = {};
    let changed = false;
    for (const [projectId, value] of Object.entries(records)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      if (!("baseBranch" in record)) {
        continue;
      }
      const baseBranch = typeof record.baseBranch === "string" ? record.baseBranch.trim() : "";
      if (baseBranch) {
        branchesByProjectId[projectId] = baseBranch;
      }
      const remaining = { ...record };
      delete remaining.baseBranch;
      records[projectId] = remaining;
      changed = true;
    }
    return { branchesByProjectId, cleaned: changed ? JSON.stringify(records) : null };
  } catch {
    return { branchesByProjectId: {}, cleaned: null };
  }
};

const buildClaudeComposerCommandDescriptors = (
  commands: ClaudeSlashCommand[],
  providerType: ProviderAccountRecord["providerType"],
): ComposerCommandDescriptor[] => commands.flatMap((command) =>
  [command.name, ...(command.aliases ?? [])].flatMap((name) => {
    const normalized = normalizeProviderSlashCommandName(name);
    if (!normalized) {
      return [];
    }
    return [{
      id: `${providerType}:${normalized.slice(1)}`,
      command: normalized,
      label: normalized.slice(1),
      description: command.description || command.argumentHint || "Run this Claude Code slash command.",
      providerType,
      effect: "native-prompt" as const,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      source: "provider" as const,
      supportsRun: true,
      supportsFollowUp: true,
    }];
  }),
);

const SELECTED_PROJECT_KEY = "selectedProjectId";
const SELECTED_RUN_KEY = "selectedRunId";
const SELECTED_CHAT_KEY = "selectedChatId";
const NETWORK_PROXY_SECRET_KEY = "app:network-proxy-password";
const PROJECT_FORGE_TOKEN_SECRET_PREFIX = "project:forge-token:";
const ACTIVE_RUN_STATUSES = new Set<RunRecord["status"]>(["queued", "preparing", "running"]);
const runCheckpointSettingKey = (runId: string) => `runCheckpoint:${runId}`;
const runPromptRestorePointSettingKey = (runId: string) => `runPromptRestorePoint:${runId}`;
const projectForgeTokenSecretKey = (projectId: string) => `${PROJECT_FORGE_TOKEN_SECRET_PREFIX}${projectId}`;

/** Shown when the app restarts while a run or chat was still marked active in the DB. */
const SESSION_INTERRUPTED_MESSAGE =
  "This session was interrupted because the app closed before it finished. You can start a new run or send a follow-up.";
const AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE = "The run exceeded the maximum number of tool rounds (Azure Legacy).";
const AZURE_LEGACY_AUTO_RECOVERY_PROMPT =
  "Go ahead. The last session was interrupted. Trigger a full build or test first to see if you are done or not. If it fails, go ahead and fix the issues.";
const AZURE_LEGACY_AUTO_RECOVERY_KIND = "Azure Legacy-max-tool-rounds";

interface ActiveWorker {
  worker: Worker;
  cancelled: boolean;
}

type WorkerDoneResult = {
  summary: string;
  responseId: string | null;
  usage: RunTokenUsage;
  providerSessionRuntime?: Omit<
    ProviderSessionRuntimeInput,
    "ownerId" | "ownerKind" | "providerType" | "harnessType" | "status"
  > & {
    status?: ProviderSessionRuntimeInput["status"];
  };
};

type ChatWorkerChunkPayload = {
  type: "chunk";
  chunk: { type: string; value: string; title?: string; metadata?: Record<string, unknown> };
};

type ChatWorkerPayload = ChatWorkerChunkPayload | { type: "done"; result: WorkerDoneResult } | { type: "error"; error: string };

const parseProjectOrderSetting = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
  } catch {
    return [];
  }
};

export class AppController
  implements
    Omit<
      DesktopApi,
      | "getRemoteAccessStatus"
      | "listHostDirectories"
      | "createRemoteAccessPairing"
      | "listRemoteAccessSessions"
      | "revokeRemoteAccessSession"
      | "onRunEvent"
      | "runTerminalStart"
      | "runTerminalWrite"
      | "runTerminalResize"
      | "runTerminalKill"
      | "onRunTerminalData"
      | "onRunTerminalExit"
      | "onAppMenuCommand"
      | "onAppSettingsChanged"
      | "onProjectForgeRequestOpen"
      | "onProjectForgeRequestNotification"
      | "onProjectTaskChanged"
      | "showAppMenu"
      | "openSystemTerminalAtPath"
      | "openExternalUrl"
    >
{
  private readonly gitService = new GitService();
  private readonly providerAdapters: Record<ProviderAccountInput["providerType"], ProviderAdapter> = {
    "ai-sdk": new AiSdkProviderAdapter(),
    "azure-legacy": new AzureLegacyProviderAdapter(),
    "codex-cli": new CodexCliProviderAdapter(),
    "claude-code": new ClaudeCodeProviderAdapter(),
    "cursor-agent": new CursorAgentProviderAdapter(),
  };
  private readonly runWorkers = new Map<string, ActiveWorker>();
  private readonly runShellApprovalStepIds = new Map<string, string>();
  private readonly runUserInputStepIds = new Map<string, string>();
  private readonly chatWorkers = new Map<string, ActiveWorker>();
  /** In-flight run-chat creations by run id; serializes concurrent first sends for the same run. */
  private readonly runChatCreations = new Map<string, Promise<ChatRecord>>();
  /** Serializes Git branch mutations per project while allowing different projects to proceed independently. */
  private readonly projectBranchMutations = new Map<string, Promise<unknown>>();
  private readonly cancelledProjectLabThreadIds = new Set<string>();
  private loopRunnerInstance: ProjectLoopRunner | null = null;
  private readonly composerCommandCache = new Map<string, { expiresAt: number; commands: ComposerCommandDescriptor[] }>();
  private readonly composerCommandInflight = new Map<string, Promise<ComposerCommandDescriptor[]>>();
  constructor(
    private readonly db: BuildWardenDatabase,
    private readonly secrets: SecretStore,
    private readonly logDirPath: string,
    private readonly desktop: AppControllerDesktopServices,
    private readonly terminal: Pick<HostTerminal, "killForRunId">,
    private readonly events: HostEventBus,
  ) {}

  private logControllerError(message: string, error: unknown, metadata?: Record<string, unknown>) {
    logError(message, {
      ...(metadata ?? {}),
      error,
    });
  }

  private logControllerWarn(message: string, metadata?: Record<string, unknown>) {
    logWarn(message, metadata);
  }

  private getFolderSnapshotRoot(): string {
    return getFolderSnapshotRoot(this.db.getFilePath());
  }

  private requireGitProject(project: ProjectRecord, featureLabel: string): void {
    if (project.kind !== "git") {
      throw new Error(`${featureLabel} is only available for Git projects.`);
    }
  }

  private serializeProjectBranchMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.projectBranchMutations.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    this.projectBranchMutations.set(projectId, current);
    return current.finally(() => {
      if (this.projectBranchMutations.get(projectId) === current) {
        this.projectBranchMutations.delete(projectId);
      }
    });
  }

  private requireGitRun(run: RunRecord, featureLabel: string): void {
    if (run.workspaceVcs !== "git") {
      throw new Error(`${featureLabel} is only available for Git-backed runs.`);
    }
  }

  private markLinkedRunTaskInReview(run: RunRecord, pullRequestUrl?: string): ProjectTaskRecord | null {
    if (!run.projectTaskId) {
      return null;
    }
    return this.db.markProjectTaskInReview(run.projectTaskId, pullRequestUrl);
  }

  private getRunWorkspaceLabel(run: RunRecord): string {
    if (run.workspaceVcs === "folder") {
      return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
    }
    return run.workspaceType === "local" ? `Local repository on ${run.branchName}` : `Worktree ${run.branchName}`;
  }

  private getEffectiveRunWorkspacePath(run: RunRecord, project?: ProjectRecord): string {
    const owningProject = project ?? this.db.getProject(run.projectId);
    const branchPromotedToProject = this.wasRunPromotedToProject(run.id);
    return run.workspaceType === "worktree" && !existsSync(run.worktreePath) && branchPromotedToProject
      ? owningProject.repoPath
      : run.worktreePath;
  }

  private async captureFolderBaselineSnapshot(run: RunRecord): Promise<void> {
    if (run.workspaceVcs !== "folder") {
      return;
    }
    await createFolderSnapshot({
      runId: run.id,
      workspacePath: run.worktreePath,
      snapshotsRoot: this.getFolderSnapshotRoot(),
    });
  }

  private async captureFolderBaselineSnapshotOrFail(run: RunRecord, project: ProjectRecord): Promise<void> {
    try {
      await this.captureFolderBaselineSnapshot(run);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Could not prepare the folder baseline snapshot for this run. ${detail}`;
      this.db.updateRunStatus(run.id, "failed", { errorMessage: message });
      await this.appendRunEvent(run.id, "error", "Folder snapshot failed", message);
      this.emitEvent({
        runId: run.id,
        type: "error",
        title: "Folder snapshot failed",
        content: message,
        createdAt: new Date().toISOString(),
      });
      try {
        await this.deleteRunResources(project.repoPath, run, "run");
      } catch (cleanupError) {
        logWarn("Failed to clean up folder run resources after snapshot creation failed.", {
          runId: run.id,
          worktreePath: run.worktreePath,
          error: cleanupError,
        });
      }
      throw error;
    }
  }

  private getProjectActiveIntegratedSkills(projectId: string) {
    const settings = this.db.getSettings();
    const disabledSkillIds = new Set(
      parseIntegratedSkillsDisabledSetting(settings[APP_SETTING_KEYS.integratedSkillsDisabled]),
    );
    const projectSkillsById = parseProjectActiveSkillsSetting(settings[APP_SETTING_KEYS.projectActiveSkills]);
    const selectedSkillIds = projectSkillsById[projectId] ?? [];
    return selectedSkillIds
      .map((skillId) => INTEGRATED_SKILLS_BY_ID[skillId])
      .filter((skill): skill is (typeof INTEGRATED_SKILLS_CATALOG)[number] => Boolean(skill) && !disabledSkillIds.has(skill.id));
  }

  private buildIntegratedSkillContext(projectId: string): string | undefined {
    return buildIntegratedSkillContext(this.getProjectActiveIntegratedSkills(projectId));
  }

  private getProjectLabSettings(projectId: string): ProjectLabSettings {
    const settingsByProjectId = parseProjectLabSettingsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectLabSettings]);
    return settingsByProjectId[projectId] ?? buildDefaultProjectLabSettings();
  }

  private setProjectForgePrMonitorInterval(projectId: string, intervalMinutes: number): void {
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    const normalized = parseProjectForgePrMonitorIntervalMinutes(intervalMinutes);
    if (normalized > 0) {
      settings[projectId] = { intervalMinutes: normalized };
    } else {
      delete settings[projectId];
    }
    const serialized = serializeProjectForgePrMonitorSettingsSetting(settings);
    if (serialized === "{}") {
      this.db.deleteSetting(APP_SETTING_KEYS.projectForgePrMonitorSettings);
      return;
    }
    this.db.setSetting(APP_SETTING_KEYS.projectForgePrMonitorSettings, serialized);
  }

  private async buildProjectLabRepoBrief(project: ProjectRecord): Promise<string> {
    const tasks = this.db.listProjectTasks(project.id).slice(0, 5);
    const insights = this.db.listProjectInsights(project.id).slice(0, 4);
    const recentRuns = this.db
      .listRunsForProject(project.id)
      .filter((run) => run.kind === "standard")
      .slice(0, 6);
    const recentCommits = (await this.readRecentCommitInfo(project.repoPath, 18)).slice(0, 8);

    return [
      `Repository path: ${project.repoPath}`,
      `Base branch: ${project.baseBranch}`,
      "",
      "Recent tasks:",
      tasks.length ? tasks.map((task) => `- ${task.title}: ${task.prompt}`).join("\n") : "- none",
      "",
      "Recent project insights:",
      insights.length ? insights.map((insight) => `- ${insight.title}: ${insight.summary}`).join("\n") : "- none",
      "",
      "Recent standard runs:",
      recentRuns.length ? recentRuns.map((run) => `- [${run.status}] ${run.prompt}`).join("\n") : "- none",
      "",
      "Recent commits:",
      recentCommits.length ? recentCommits.map((commit) => `- ${commit.date} ${commit.title}`).join("\n") : "- none",
    ].join("\n");
  }

  private buildProjectLabAvoidanceBrief(projectId: string, excludedThreadId?: string): string {
    const priorThreads = this.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.status !== "failed")
      .slice(0, 20);

    if (priorThreads.length === 0) {
      return "No prior Project Lab topics yet.";
    }

    return [
      "Avoid repeating or lightly rephrasing these existing Project Lab topics unless the user explicitly asked to revisit one:",
      ...priorThreads.map((thread) => {
        const summary = thread.summary.trim() ? ` - ${thread.summary.trim()}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 280)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Implementation: ${thread.implementationPrompt.trim().slice(0, 280)}`
          : "";
        return `- [${thread.status}] ${thread.title}${summary}${outcome}${implementation}`;
      }),
      "",
      "Choose a substantially different code area, risk, feature, or refactoring angle. If no distinct idea is worth pursuing, say so instead of duplicating prior work.",
    ].join("\n");
  }

  private buildProjectLabSameModePriorWorkBrief(projectId: string, mode: ProjectLabMode, excludedThreadId?: string): string {
    const priorThreads = this.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.mode === mode)
      .slice(0, 12);

    if (priorThreads.length === 0) {
      return `No previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs yet.`;
    }

    return [
      `Previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs. Treat these as already explored or worked on:`,
      ...priorThreads.map((thread) => {
        const topic = thread.title.trim() || `${PROJECT_LAB_MODE_LABELS[thread.mode]} Project Lab run`;
        const summary = thread.summary.trim() ? ` Summary: ${thread.summary.trim().slice(0, 320)}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 320)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Worked-on implementation: ${thread.implementationPrompt.trim().slice(0, 520)}`
          : "";
        return `- [${thread.status}] Topic: ${topic}.${summary}${outcome}${implementation}`;
      }),
      "",
      "Do not implement, fix, refactor, or lightly rephrase any topic listed above. Pick a genuinely different area and value/risk, or explicitly conclude that there is no distinct same-mode opportunity worth starting.",
    ].join("\n");
  }

  private chooseProjectLabMode(): ProjectLabMode {
    return PROJECT_LAB_MODES[randomInt(PROJECT_LAB_MODES.length)] ?? "new-feature";
  }

  private normalizeProjectLabMode(value: ProjectLabMode | undefined): ProjectLabMode {
    return value && PROJECT_LAB_MODES.includes(value) ? value : this.chooseProjectLabMode();
  }

  private buildProjectLabOpportunityInstruction(input: RunProjectLabInput, mode: ProjectLabMode): string {
    const userDirection = input.topic?.trim() ? `User direction: ${input.topic.trim()}` : null;
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    if (input.topic?.trim()) {
      return [
        `Chosen Project Lab mode: ${modeLabel}.`,
        userDirection,
        "Honor the user direction, but frame the work through the chosen mode unless the user explicitly asked for a different kind of outcome.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (mode === "new-feature") {
      return [
        "Chosen Project Lab mode: New feature.",
        "Find one concrete new user-facing product feature or workflow capability, then implement the smallest useful slice.",
        "Do not default to internal cleanup unless it directly enables the feature.",
      ].join(" ");
    }
    if (mode === "bugfix") {
      return [
        "Chosen Project Lab mode: Bugfix.",
        "Look for one concrete bug or vulnerability supported by repository evidence, with priority on security issues, authorization/authentication mistakes, null/undefined/null-pointer failures, data-loss risks, race conditions, invalid state handling, and reliability failures.",
        "Do not make a change just to produce output. Do not implement cosmetic cleanup, broad refactoring, dependency upgrades, naming changes, or speculative improvements.",
        "If the inspected code looks sound and you cannot identify a defensible bug, make no code changes and explain what you inspected.",
      ].join(" ");
    }
    if (mode === "refactoring") {
      return [
        "Chosen Project Lab mode: Refactoring.",
        "Find one focused refactor that reduces complexity, coupling, duplication, or maintenance cost, then implement it with a clear safety check.",
      ].join(" ");
    }
    return [
      "Chosen Project Lab mode: RFC only.",
      "Find one larger opportunity and write an RFC only. Do not edit code.",
      "The RFC should include motivation, proposal, alternatives, risks, rollout, and open questions.",
    ].join(" ");
  }

  private buildProjectLabModeBrief(mode: ProjectLabMode): string {
    if (mode === "new-feature") {
      return [
        "Mode requirements:",
        "- Prioritize a new capability that a developer using BuildWarden would notice.",
        "- Keep the implementation small enough for one worktree.",
        "- Update relevant UI, wiring, tests, and docs when needed.",
      ].join("\n");
    }
    if (mode === "bugfix") {
      return [
        "Mode requirements:",
        "- Prioritize security defects, auth/permission mistakes, null/undefined/null-pointer risks, data corruption/loss, race conditions, invalid state transitions, broken error handling, or reliability failures.",
        "- Require concrete evidence from the code path before changing files.",
        "- State the suspected failure mode before implementing.",
        "- Prefer a regression test or targeted validation that would catch the bug.",
        "- If no defensible bug is found, leave the worktree unchanged and summarize the inspected areas.",
      ].join("\n");
    }
    if (mode === "refactoring") {
      return [
        "Mode requirements:",
        "- Prioritize code health, architecture, cohesion, or simplification.",
        "- Avoid sweeping rewrites; choose a bounded refactor with a clear safety net.",
        "- Preserve behavior unless the user direction says otherwise.",
      ].join("\n");
    }
    return [
      "Mode requirements:",
      "- Produce an RFC only.",
      "- Do not edit files.",
      "- Include concrete next implementation steps, but leave execution for a future run.",
    ].join("\n");
  }

  private async buildProjectLabImplementationPrompt(input: RunProjectLabInput, project: ProjectRecord, mode: ProjectLabMode, threadId: string): Promise<string> {
    const repoBrief = await this.buildProjectLabRepoBrief(project);
    const avoidanceBrief = this.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
    const opportunityInstruction = this.buildProjectLabOpportunityInstruction(input, mode);
    const modeBrief = this.buildProjectLabModeBrief(mode);
    const agentObjective =
      mode === "bugfix"
        ? "Your job is to inspect this project, identify exactly one concrete bug or vulnerability for the selected mode, and implement a narrowly scoped fix only when the evidence supports it."
        : "Your job is to inspect this project, identify exactly one worthwhile improvement for the selected mode, and implement it directly in this workspace.";

    return [
      "You are BuildWarden Project Lab's implementation agent.",
      agentObjective,
      "Do not ask for a discussion round or wait for approval. Make a small, reviewable change.",
      "If the project evidence shows there is no safe distinct change worth making, make no code changes and explain why in the final answer.",
      "",
      `Project: ${project.name}`,
      opportunityInstruction,
      "",
      "Repository brief:",
      repoBrief,
      "",
      modeBrief,
      "",
      "Existing Project Lab topics to avoid:",
      avoidanceBrief,
      "",
      "Previous same-mode Project Lab work to avoid:",
      sameModePriorWorkBrief,
      "",
      "Execution requirements:",
      "- Start by inspecting the relevant code before choosing the exact change.",
      "- State the opportunity you selected in the run output before or while implementing.",
      "- Keep changes tightly scoped to one feature, bugfix, or refactor.",
      "- Run appropriate validation when available, or inspect changed files carefully when validation is not practical.",
      "- Finish with a concise summary of what changed, why it was worth doing, and how it was checked.",
    ].join("\n");
  }

  private async createProjectLabImplementationRun(
    projectId: string,
    threadId: string,
    modelId: string,
    prompt: string,
    baseBranch?: string | null,
  ): Promise<RunRecord> {
    const project = this.db.getProject(projectId);
    const selectedBaseBranch = baseBranch?.trim() || project.baseBranch;
    if (project.kind === "git") {
      const availableBranches = await this.getProjectBranches(projectId);
      if (!availableBranches.includes(selectedBaseBranch)) {
        throw new Error(`Base branch "${selectedBaseBranch}" is not available for this project. Choose an existing Project Lab base branch and start a new thread.`);
      }
    }
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const harnessType = getHarnessTypeForProvider(provider.providerType);
    const run = await this.createRun({
      projectId,
      providerAccountId: model.providerAccountId,
      modelId,
      harnessType,
      mode: "code",
      workspaceType: project.kind === "folder" ? "copy" : "worktree",
      baseBranch: project.kind === "git" ? selectedBaseBranch : undefined,
      prompt,
      kind: "lab-implementation",
      labThreadId: threadId,
    });
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.setSetting(SELECTED_PROJECT_KEY, projectId);
    return run;
  }

  private async reviewCompletedProjectLabImplementation(run: RunRecord): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    const thread = this.db.getProjectLabThread(run.labThreadId);
    const project = this.db.getProject(run.projectId);
    const reviewModelId = thread.reviewModelId?.trim();

    if (!reviewModelId) {
      this.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: "Implementation completed, but no review model was stored on this Project Lab thread.",
      });
      this.db.updateProjectLabThread(thread.id, {
        status: "completed",
        summary: run.summary?.trim() || thread.summary,
        outcome: run.summary?.trim() || thread.outcome,
      });
      return;
    }

    this.db.updateProjectLabThread(thread.id, { status: "reviewing" });
    const diff = (await this.getRunWorktreeDiff(run.id)).diff.trim();
    const context = await this.resolveModelInvocationContext(reviewModelId);
    const content = await this.askModelForText(run.worktreePath, context, {
      prompt: [
        `Project: ${project.name}`,
        `Project Lab mode: ${PROJECT_LAB_MODE_LABELS[thread.mode]}`,
        `Implementation thread: ${thread.title}`,
        `Implementation run summary: ${run.summary ?? "(none)"}`,
        "",
        "Review the implementation as a second agent.",
        "Focus on correctness, scope control, regressions, missing validation, and whether the change matches the Project Lab mode.",
        "Do not rewrite the implementation. Return concise Markdown with sections: Verdict, Findings, Follow-up.",
        "",
        "Diff:",
        diff || "(No remaining diff found. Review the run summary and note that there was no diff to inspect.)",
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Be direct, concrete, and practical.",
      maxTokens: 900,
      temperature: 0.2,
      usageProjectId: project.id,
    });

    const review = content.trim() || "Review completed without comments.";
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "review",
      label: "Review agent",
      content: review,
    });
    this.db.updateProjectLabThread(thread.id, {
      status: "completed",
      summary: run.summary?.trim() || thread.summary,
      outcome: review,
    });
  }

  private async failProjectLabImplementation(run: RunRecord, message: string): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    const thread = this.db.getProjectLabThread(run.labThreadId);
    if (thread.status === "cancelled") {
      return;
    }
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "System",
      content: `Implementation ended without success: ${message}`,
    });
    this.db.updateProjectLabThread(thread.id, {
      status: "failed",
      outcome: message,
    });
  }

  private cancelProjectLabImplementation(run: RunRecord, message: string): void {
    if (!run.labThreadId) {
      return;
    }
    try {
      const thread = this.db.getProjectLabThread(run.labThreadId);
      if (thread.status === "cancelled") {
        return;
      }
      this.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: message,
      });
      this.db.updateProjectLabThread(thread.id, {
        status: "cancelled",
        outcome: message,
      });
    } catch {
      /* The Project Lab thread may have been deleted while its run was still stopping. */
    }
  }

  private isProjectLabThreadCancelled(threadId: string): boolean {
    return this.cancelledProjectLabThreadIds.has(threadId);
  }

  private projectLabTitleFromMarkdown(markdown: string, fallback: string): string {
    const heading = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#{1,3}\s+/.test(line));
    return heading?.replace(/^#{1,3}\s+/, "").trim().slice(0, 140) || fallback;
  }

  private projectLabSummaryFromMarkdown(markdown: string, fallback: string): string {
    const paragraph = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))[0];
    return paragraph?.slice(0, 320) || fallback;
  }

  private async executeProjectLabRfcThread(
    threadId: string,
    input: RunProjectLabInput,
    project: ProjectRecord,
    mode: ProjectLabMode,
    implementationModelId: string,
    reviewModelId: string,
  ): Promise<void> {
    const repoBrief = await this.buildProjectLabRepoBrief(project);
    const avoidanceBrief = this.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
    const implementationContext = await this.resolveModelInvocationContext(implementationModelId);
    const rfc = await this.askModelForText(project.repoPath, implementationContext, {
      prompt: [
        "You are BuildWarden Project Lab's RFC agent.",
        "Inspect the repository context below and write one useful RFC. Do not modify files.",
        "",
        `Project: ${project.name}`,
        this.buildProjectLabOpportunityInstruction(input, mode),
        "",
        "Repository brief:",
        repoBrief,
        "",
        this.buildProjectLabModeBrief(mode),
        "",
        "Existing Project Lab topics to avoid:",
        avoidanceBrief,
        "",
        "Previous same-mode Project Lab work to avoid:",
        sameModePriorWorkBrief,
        "",
        "Return concise Markdown with sections: Title, Motivation, Proposal, Alternatives, Risks, Rollout, Open Questions.",
      ].join("\n"),
      systemPrompt: "You write practical engineering RFCs grounded in repository evidence.",
      maxTokens: 1400,
      temperature: 0.35,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    const rfcContent = rfc.trim() || "No RFC content returned.";
    this.db.appendProjectLabEvent({
      threadId,
      role: "rfc",
      label: "RFC agent",
      content: rfcContent,
    });
    this.db.updateProjectLabThread(threadId, {
      title: this.projectLabTitleFromMarkdown(rfcContent, "Project Lab RFC"),
      summary: this.projectLabSummaryFromMarkdown(rfcContent, "Project Lab drafted an RFC."),
      outcome: rfcContent,
      status: "reviewing",
    });

    const reviewContext = await this.resolveModelInvocationContext(reviewModelId);
    const review = await this.askModelForText(project.repoPath, reviewContext, {
      prompt: [
        `Project: ${project.name}`,
        "Review this Project Lab RFC as a second agent.",
        "Check whether the proposal is useful, scoped, risky, missing alternatives, or ready for a future implementation run.",
        "Return concise Markdown with sections: Verdict, Gaps, Suggested next step.",
        "",
        "RFC:",
        rfcContent,
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Review RFC quality and practicality.",
      maxTokens: 800,
      temperature: 0.25,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    this.db.appendProjectLabEvent({
      threadId,
      role: "review",
      label: "Review agent",
      content: review.trim() || "RFC review completed without comments.",
    });
    this.db.updateProjectLabThread(threadId, {
      status: "completed",
    });
  }
  private applyProjectOrder(snapshot: AppSnapshot): AppSnapshot {
    const order = parseProjectOrderSetting(snapshot.settings[APP_SETTING_KEYS.projectOrder]);
    if (order.length === 0 || snapshot.projects.length <= 1) {
      return snapshot;
    }
    const priorityById = new Map(order.map((projectId, index) => [projectId, index]));
    const projects = [...snapshot.projects].sort((left, right) => {
      const leftPriority = priorityById.get(left.project.id);
      const rightPriority = priorityById.get(right.project.id);
      if (leftPriority != null && rightPriority != null) {
        return leftPriority - rightPriority;
      }
      if (leftPriority != null) {
        return -1;
      }
      if (rightPriority != null) {
        return 1;
      }
      return 0;
    });
    return { ...snapshot, projects };
  }

  /** Consolidates the former per-run base setting into the single editable project base branch. */
  async migrateProjectBaseBranches(): Promise<void> {
    const settings = this.db.getSettings();
    if (settings[APP_SETTING_KEYS.projectBaseBranchMigrationVersion] === "1") {
      return;
    }

    const legacy = readLegacyProjectRunBaseBranches(settings[APP_SETTING_KEYS.projectRunDefaults]);
    let failedProjectCount = 0;
    for (const project of this.db.listProjects()) {
      if (project.kind !== "git") {
        continue;
      }
      try {
        const detected = legacy.branchesByProjectId[project.id]
          ? null
          : await this.gitService.validateProject(project.repoPath);
        const baseBranch = legacy.branchesByProjectId[project.id] || (detected?.isGitRepo ? detected.baseBranch : "");
        if (baseBranch && baseBranch !== project.baseBranch) {
          this.db.updateProjectBaseBranch(project.id, baseBranch);
        }
      } catch (error) {
        failedProjectCount += 1;
        this.logControllerError("Could not migrate a project's base branch; retaining its previous value.", error, {
          projectId: project.id,
          repoPath: project.repoPath,
        });
      }
    }

    if (failedProjectCount > 0) {
      throw new Error(`Could not migrate the base branch for ${failedProjectCount} project${failedProjectCount === 1 ? "" : "s"}.`);
    }
    if (legacy.cleaned !== null) {
      this.db.setSetting(APP_SETTING_KEYS.projectRunDefaults, legacy.cleaned);
    }
    this.db.setSetting(APP_SETTING_KEYS.projectBaseBranchMigrationVersion, "1");
  }

  /**
   * Workers live only in memory; after a cold start the DB may still list runs/chats as queued/running.
   * Mark those rows terminal, reset worktree bookkeeping, and append an explanatory step.
   */
  async reconcileOrphanedActiveSessions(): Promise<void> {
    const activeStatuses: RunRecord["status"][] = ["queued", "preparing", "running"];

    const staleRuns = this.db.listRunsWithStatuses(activeStatuses).filter((run) => !this.runWorkers.has(run.id));
    for (const run of staleRuns) {
      const checkpoint = this.getRunCheckpoint(run.id);
      const providerRuntime = this.db.getProviderSessionRuntime(run.id, "run");
      const model = this.db.getModel(run.modelId);
      const provider = this.db.getProviderAccount(model.providerAccountId);
      const providerRecoverySupported = providerSupportsInterruptedRunRecovery(provider.providerType);
      this.db.updateRunStatus(run.id, "cancelled", { errorMessage: SESSION_INTERRUPTED_MESSAGE });
      this.updateWorktreeStatus(run, "ready");
      await this.appendRunEvent(
        run.id,
        "status",
        "Session interrupted",
        SESSION_INTERRUPTED_MESSAGE,
        {
          sessionInterrupted: true,
          canRecoverInterruptedSession: providerRecoverySupported && Boolean(checkpoint || providerRuntime?.resumeCursor),
          recoveryKind: resolveRecoveryKind(providerRecoverySupported, Boolean(checkpoint), Boolean(providerRuntime?.resumeCursor)),
        },
      );
    }

    const staleChats = this.db.listChatsWithStatuses(activeStatuses).filter((chat) => !this.chatWorkers.has(chat.id));
    for (const chat of staleChats) {
      this.db.updateChatStatus(chat.id, "cancelled", { finishedAt: new Date().toISOString() });
      await this.appendChatEvent(chat.id, "status", "Session interrupted", SESSION_INTERRUPTED_MESSAGE, {
        sessionInterrupted: true,
      });
    }
  }

  addBookmark(runId: string): Promise<void> {
    this.db.addBookmark(runId);
    return Promise.resolve();
  }

  removeBookmark(runId: string): Promise<void> {
    this.db.removeBookmark(runId);
    return Promise.resolve();
  }

  removeBookmarkById(bookmarkId: string): Promise<void> {
    this.db.removeBookmarkById(bookmarkId);
    return Promise.resolve();
  }

  getBookmarksWithSteps(): Promise<BookmarkRecord[]> {
    return Promise.resolve(this.db.getBookmarksWithSteps());
  }

  addChatBookmark(chatId: string): Promise<void> {
    this.db.addChatBookmark(chatId);
    return Promise.resolve();
  }

  removeChatBookmark(chatId: string): Promise<void> {
    this.db.removeChatBookmark(chatId);
    return Promise.resolve();
  }

  removeChatBookmarkById(bookmarkId: string): Promise<void> {
    this.db.removeChatBookmarkById(bookmarkId);
    return Promise.resolve();
  }

  reportRendererLog(payload: RendererLogPayload): Promise<void> {
    const metadata = {
      source: payload.source,
      stack: payload.stack,
      ...(payload.metadata ? { rendererMetadata: payload.metadata } : {}),
    };
    if (payload.level === "warn") {
      this.logControllerWarn(payload.message, metadata);
    } else {
      this.logControllerError(payload.message, undefined, metadata);
    }
    return Promise.resolve();
  }

  isChatBookmarked(chatId: string): Promise<boolean> {
    return Promise.resolve(this.db.isChatBookmarked(chatId));
  }

  getChatBookmarksWithSteps(): Promise<ChatBookmarkRecord[]> {
    return Promise.resolve(this.db.getChatBookmarksWithSteps());
  }

  isBookmarked(runId: string): Promise<boolean> {
    return Promise.resolve(this.db.isBookmarked(runId));
  }

  async resetDatabase(): Promise<void> {
    await this.db.resetAndReinit();
  }

  async createChat(input: ChatInput): Promise<ChatRecord> {
    const provider = this.db.getProviderAccount(input.providerAccountId);
    const model = this.db.getModel(input.modelId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const displayPrompt =
      userText ||
      (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    const chat = this.db.createChat(input.providerAccountId, input.modelId, displayPrompt);
    this.db.setSetting(SELECTED_CHAT_KEY, chat.id);

    const logContent = [
      userText || "(no text)",
      attachmentNames.length ? `\nAttachments: ${attachmentNames.join(", ")}` : "",
    ].join("");

    await this.appendChatEvent(chat.id, "log", "Initial message", logContent, {
      source: "user",
      commandType: "initial",
      modelId: chat.modelId,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      ...this.buildStoredAttachmentMetadata(input.attachments),
    });
    this.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });
    this.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat starting",
      content: "Starting chat...",
      createdAt: new Date().toISOString(),
    });

    const worker = this.startChatWorker(chat, provider, model, apiKey ?? "", await this.resolveNetworkProxyRuntimeConfig(), userText, input.attachments, {
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
    });
    this.chatWorkers.set(chat.id, { worker, cancelled: false });

    return this.db.getChat(chat.id);
  }

  async getChatDetail(chatId: string): Promise<ChatDetail> {
    return this.db.getChatDetail(chatId);
  }

  async getRunChat(runId: string): Promise<ChatDetail | null> {
    const chat = this.db.getLatestChatForRun(runId);
    return chat ? this.db.getChatDetail(chat.id) : null;
  }

  private async buildRunChatContextForRun(runId: string): Promise<string> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const diffResult = await this.getRunWorktreeDiff(runId);
    return buildRunChatContext({
      run,
      steps: this.db.getRunSteps(runId),
      projectName: project.name,
      diff: diffResult.diff,
      diffUnavailableReason: diffResult.diffUnavailableReason ?? null,
    });
  }

  /**
   * Syncs the hidden run-context step with the run's latest steps and diff before a
   * follow-up turn. History-replaying providers pick the new content up automatically
   * on the next turn; for session-based providers the caller re-sends the context in
   * the prompt when it changed. Returns null when the refresh failed (the chat then
   * continues with the previous context).
   */
  private async refreshRunChatContext(chat: ChatRecord): Promise<{ context: string; changed: boolean } | null> {
    if (!chat.runId) {
      return null;
    }
    try {
      const context = await this.buildRunChatContextForRun(chat.runId);
      const contextStep = this.db.getChatSteps(chat.id).find((step) => {
        try {
          return (JSON.parse(step.metadataJson || "{}") as Record<string, unknown>).source === RUN_CHAT_CONTEXT_SOURCE;
        } catch {
          return false;
        }
      });
      if (!contextStep) {
        await this.appendChatEvent(chat.id, "log", "Run context", context, {
          source: RUN_CHAT_CONTEXT_SOURCE,
          hidden: true,
          runId: chat.runId,
        });
        return { context, changed: true };
      }
      if (contextStep.content === context) {
        return { context, changed: false };
      }
      this.db.updateChatStep(contextStep.id, { content: context });
      return { context, changed: true };
    } catch (error) {
      this.logControllerWarn("Could not refresh the run chat context; continuing with the previous context.", {
        chatId: chat.id,
        runId: chat.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Starts (or continues) the run-scoped Q&A chat for a run. The first turn seeds the
   * conversation with a hidden context step holding the run's prompts, output, and diff.
   */
  async createRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    // Creation awaits the worktree diff, which can take seconds; serialize with any
    // in-flight creation for the same run so a concurrent send cannot slip past the
    // existence check and create a duplicate chat.
    const pending = this.runChatCreations.get(runId);
    if (pending) {
      await pending.catch(() => undefined);
    }

    const existing = this.db.getLatestChatForRun(runId);
    if (existing) {
      return this.followUpChat(existing.id, input.prompt, {
        modelId: input.modelId !== existing.modelId ? input.modelId : undefined,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
        anthropicEffort: input.anthropicEffort,
      });
    }

    const creation = this.startNewRunChat(runId, input);
    this.runChatCreations.set(runId, creation);
    try {
      return await creation;
    } finally {
      this.runChatCreations.delete(runId);
    }
  }

  private async startNewRunChat(runId: string, input: RunChatInput): Promise<ChatRecord> {
    this.db.getRun(runId); // validate the run exists before creating the chat
    const model = this.db.getModel(input.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);

    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    const contextBlock = await this.buildRunChatContextForRun(runId);

    const displayPrompt =
      userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : "");

    // Run chats intentionally skip SELECTED_CHAT_KEY: they live in the run detail
    // panel and must not hijack the Chats page selection.
    const chat = this.db.createChat(provider.id, model.id, displayPrompt, runId);

    await this.appendChatEvent(chat.id, "log", "Run context", contextBlock, {
      source: RUN_CHAT_CONTEXT_SOURCE,
      hidden: true,
      runId,
    });

    const logContent = [
      userText || "(no text)",
      attachmentNames.length ? `\nAttachments: ${attachmentNames.join(", ")}` : "",
    ].join("");

    await this.appendChatEvent(chat.id, "log", "Initial message", logContent, {
      source: "user",
      commandType: "initial",
      modelId: chat.modelId,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      ...this.buildStoredAttachmentMetadata(input.attachments),
    });
    this.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });
    this.emitChatEvent(chat.id, {
      runId: chat.id,
      type: "status",
      title: "Chat starting",
      content: "Starting chat...",
      createdAt: new Date().toISOString(),
    });

    // History-replaying providers receive the context through prior messages (the hidden
    // step maps to a user turn); session-based CLI providers only see what is in the
    // prompt, so the context must ride along on the first turn.
    const firstTurnPrompt = providerReplaysChatHistory(provider.providerType)
      ? userText
      : buildRunChatFirstTurnPrompt(contextBlock, userText);

    const worker = this.startChatWorker(chat, provider, model, apiKey ?? "", await this.resolveNetworkProxyRuntimeConfig(), firstTurnPrompt, input.attachments, {
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
    });
    this.chatWorkers.set(chat.id, { worker, cancelled: false });

    return this.db.getChat(chat.id);
  }

  async followUpChat(
    chatId: string,
    prompt: string,
    options?: { modelId?: string; attachments?: ChatAttachmentPayload[]; reasoningEffort?: string; anthropicEffort?: string },
  ): Promise<ChatRecord> {
    let chat = this.db.getChat(chatId);
    const model = this.db.getModel(options?.modelId ?? chat.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a message or attach at least one file.");
    }

    if (this.chatWorkers.has(chatId)) {
      throw new Error("This chat is already active. Wait for it to finish before sending a follow-up.");
    }

    if (!chat.runId) {
      this.db.setSetting(SELECTED_CHAT_KEY, chatId);
    }
    if (options?.modelId) {
      this.db.updateChatConfiguration(chatId, options.modelId);
      chat = this.db.getChat(chatId);
    }

    // Run chats see the run's latest steps and diff on every turn: the hidden context
    // step is refreshed in place, and session-based providers get the updated context
    // re-sent with the prompt (their session still holds the stale version).
    let workerPrompt = userText;
    if (chat.runId) {
      const refreshed = await this.refreshRunChatContext(chat);
      if (refreshed?.changed && !providerReplaysChatHistory(provider.providerType)) {
        workerPrompt = buildRunChatUpdateTurnPrompt(refreshed.context, userText);
      }
    }

    const logContent = [
      userText || "(no text)",
      attachmentNames.length ? `\nAttachments: ${attachmentNames.join(", ")}` : "",
    ].join("");

    await this.appendChatEvent(chat.id, "log", "Follow-up", logContent, {
      source: "user",
      commandType: "follow-up",
      modelId: model.id,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      ...this.buildStoredAttachmentMetadata(options?.attachments),
    });
    this.db.updateChatStatus(chat.id, "preparing", { startedAt: new Date().toISOString() });

    const worker = this.startChatWorker(chat, provider, model, apiKey ?? "", await this.resolveNetworkProxyRuntimeConfig(), workerPrompt, options?.attachments, {
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
    });
    this.chatWorkers.set(chat.id, { worker, cancelled: false });

    return this.db.getChat(chat.id);
  }

  async listChats(): Promise<ChatRecord[]> {
    return this.db.listChats().map((s) => this.db.getChat(s.id));
  }

  async listChatsWithSteps(): Promise<ChatDetail[]> {
    return this.db.listChatsWithSteps();
  }

  async deleteChat(chatId: string): Promise<void> {
    const active = this.chatWorkers.get(chatId);
    if (active) {
      active.cancelled = true;
      active.worker.postMessage({ type: "cancel" });
      this.chatWorkers.delete(chatId);
      await active.worker.terminate();
    }
    const isRunChat = Boolean(this.db.getChat(chatId).runId);
    this.db.deleteProviderSessionRuntime(chatId, "chat");
    this.db.deleteChat(chatId);
    if (!isRunChat) {
      this.db.deleteSetting(SELECTED_CHAT_KEY);
    }
  }

  async cancelChat(chatId: string): Promise<void> {
    const active = this.chatWorkers.get(chatId);
    if (!active) return;
    active.cancelled = true;
    active.worker.postMessage({ type: "cancel" });
    this.db.updateChatStatus(chatId, "cancelled", {
      errorMessage: "Chat cancelled by user.",
      finishedAt: new Date().toISOString(),
    });
    await this.appendChatEvent(chatId, "status", "Chat cancelled", "Cancellation requested.");
    this.emitChatEvent(chatId, {
      runId: chatId,
      type: "status",
      title: "Chat cancelled",
      content: "Cancellation requested.",
      createdAt: new Date().toISOString(),
    });
    this.chatWorkers.delete(chatId);
    await active.worker.terminate();
  }

  onChatEvent(listener: (event: RunEvent & { chatId: string }) => void): () => void {
    return this.events.subscribe("chat", listener);
  }

  async getSnapshot(): Promise<AppSnapshot> {
    const settings = this.db.getSettings();
    return this.applyProjectOrder(this.db.getSnapshot(
      settings[SELECTED_PROJECT_KEY] ?? null,
      settings[SELECTED_RUN_KEY] ?? null,
      settings[SELECTED_CHAT_KEY] ?? null,
    ));
  }

  async getNetworkProxySettings(): Promise<NetworkProxySettingsSnapshot> {
    const settings = parseNetworkProxySettings(this.db.getSettings()[APP_SETTING_KEYS.networkProxyConfig]);
    const hasPassword = (await this.secrets.readSecret(NETWORK_PROXY_SECRET_KEY)) != null;
    return {
      ...settings,
      hasPassword,
    };
  }

  async saveNetworkProxySettings(input: NetworkProxySettingsInput): Promise<NetworkProxySettingsSnapshot> {
    const host = input.host.trim();
    const port = input.port.trim();
    const username = input.username.trim();
    const enabled = input.enabled === true;
    const protocol = input.protocol;

    if (enabled) {
      if (!host) {
        throw new Error("Proxy host is required when the network proxy is enabled.");
      }
      if (!port) {
        throw new Error("Proxy port is required when the network proxy is enabled.");
      }
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        throw new Error("Proxy port must be a whole number between 1 and 65535.");
      }
      if (/\s/.test(host)) {
        throw new Error("Proxy host cannot contain spaces.");
      }
      if (username.includes("\n") || username.includes("\r")) {
        throw new Error("Proxy username cannot contain line breaks.");
      }
    }

    this.db.setSetting(
      APP_SETTING_KEYS.networkProxyConfig,
      JSON.stringify({
        enabled,
        protocol,
        host,
        port,
        username,
      }),
    );

    if (input.clearSavedPassword === true) {
      await this.secrets.deleteSecret(NETWORK_PROXY_SECRET_KEY);
    } else if (typeof input.password === "string") {
      if (input.password.length > 0) {
        await this.secrets.saveSecret(NETWORK_PROXY_SECRET_KEY, input.password);
      }
    }

    return this.getNetworkProxySettings();
  }

  async refreshSnapshot(): Promise<AppSnapshot> {
    return this.getSnapshot();
  }

  async selectProject(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId);
    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.deleteSetting(SELECTED_CHAT_KEY);
  }

  async reorderProjects(projectIds: string[]): Promise<void> {
    const knownProjectIds = new Set(this.db.listProjects().map((project) => project.id));
    const normalized = projectIds.filter((projectId, index) => knownProjectIds.has(projectId) && projectIds.indexOf(projectId) === index);
    if (normalized.length === 0) {
      throw new Error("Project order update did not include any valid projects.");
    }
    this.db.setSetting(APP_SETTING_KEYS.projectOrder, JSON.stringify(normalized));
    logInfo("Updated custom sidebar project order.", {
      projectCount: normalized.length,
      projectIds: normalized,
    });
  }

  async getProjectBranches(projectId: string): Promise<string[]> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Branch management");
    const branches = await this.gitService.listTargetBranches(project.repoPath);
    return branches.length > 0 ? branches : [project.baseBranch];
  }

  async getProjectCurrentBranch(projectId: string): Promise<string> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Branch management");
    try {
      return await this.gitService.getCurrentBranch(project.repoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDetachedHeadProjectErrorMessage(message)) {
        return "";
      }
      throw error;
    }
  }

  async getProjectBranchOverview(projectId: string): Promise<ProjectGitBranchOverview> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Branch management");
    return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
  }

  async checkProjectGitConversion(projectId: string): Promise<ProjectGitConversionCandidate | null> {
    const project = this.db.getProject(projectId);
    if (project.kind !== "folder") {
      return null;
    }
    const validation = await this.gitService.validateProject(project.repoPath);
    if (!validation.isGitRepo) {
      return null;
    }
    const currentBranch = await this.gitService.getCurrentBranch(project.repoPath).catch(() => validation.baseBranch);
    return {
      projectId: project.id,
      repoPath: validation.repoPath,
      repoName: validation.repoName,
      baseBranch: validation.baseBranch,
      currentBranch,
      isWorktree: validation.isWorktree,
      isDirty: validation.isDirty,
    };
  }

  async convertProjectToGit(projectId: string): Promise<ProjectRecord> {
    const project = this.db.getProject(projectId);
    if (project.kind === "git") {
      return project;
    }
    const validation = await this.gitService.validateProject(project.repoPath);
    if (!validation.isGitRepo) {
      throw new Error("This project folder is not a Git repository yet.");
    }
    const converted = this.db.updateProjectKind(project.id, "git", validation.baseBranch);
    this.db.touchProject(converted.id);
    return converted;
  }

  async updateProjectBaseBranch(projectId: string, branchName: string): Promise<ProjectRecord> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Base branch selection");
      const baseBranch = branchName.trim();
      if (!baseBranch) {
        throw new Error("Select a base branch.");
      }
      const availableBranches = await this.gitService.listTargetBranches(project.repoPath);
      if (!availableBranches.includes(baseBranch)) {
        throw new Error(`Base branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
      return this.db.updateProjectBaseBranch(projectId, baseBranch);
    });
  }

  async checkProjectFolderGitStatus(repoPath: string): Promise<ProjectFolderGitStatus> {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      return { path: "", exists: false, isDirectory: false, isGitRepo: false };
    }
    try {
      if (!existsSync(trimmed)) {
        return { path: trimmed, exists: false, isDirectory: false, isGitRepo: false };
      }
      if (!statSync(trimmed).isDirectory()) {
        return { path: trimmed, exists: true, isDirectory: false, isGitRepo: false };
      }
      const validation = await this.gitService.validateProject(trimmed);
      return { path: trimmed, exists: true, isDirectory: true, isGitRepo: validation.isGitRepo };
    } catch {
      return { path: trimmed, exists: false, isDirectory: false, isGitRepo: false };
    }
  }

  async getProjectBranchDeleteImpact(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectBranchDeleteImpact> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Branch management");
    const branchName = input.branchName.trim();
    if (!branchName) {
      throw new Error("Select a branch.");
    }

    return {
      branchName,
      linkedRuns: this.listRunsLinkedToProjectBranch(projectId, branchName).map((run) => ({
        id: run.id,
        prompt: run.prompt,
        status: run.status,
        workspaceType: run.workspaceType,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
    };
  }

  async checkoutProjectBranch(projectId: string, branchName: string): Promise<void> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Branch checkout");
      await this.gitService.checkoutProjectBranch(project.repoPath, branchName);
    });
  }

  async fetchProjectBranches(projectId: string): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Branch fetching");
      await this.gitService.fetchProjectBranches(project.repoPath);
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  async createProjectBranch(projectId: string, input: CreateProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Branch creation");
      await this.gitService.createProjectBranch(project.repoPath, input.branchName, input.startPoint, input.checkout !== false);
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  async renameProjectBranch(projectId: string, input: RenameProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Branch renaming");
      if (input.oldName.trim() === project.baseBranch) {
        throw new Error("Choose a different project base branch before renaming this branch.");
      }
      await this.gitService.renameProjectBranch(project.repoPath, input.oldName, input.newName);
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  async deleteProjectBranch(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Branch deletion");
      const branchName = input.branchName.trim();
      if (!branchName) {
        throw new Error("Select a branch.");
      }
      if (branchName === project.baseBranch) {
        throw new Error("Choose a different project base branch before deleting this branch.");
      }
      const currentBranch = await this.gitService.getCurrentBranch(project.repoPath).catch(() => "");
      if (branchName === currentBranch) {
        throw new Error("You cannot delete the currently checked out branch.");
      }

      const linkedRuns = this.listRunsLinkedToProjectBranch(projectId, branchName);
      for (const run of linkedRuns) {
        await this.deleteRun(run.id);
      }

      if (await this.gitService.hasLocalBranch(project.repoPath, branchName)) {
        await this.gitService.deleteProjectBranch(project.repoPath, branchName, input.force === true);
      }
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  async pullProjectBranch(projectId: string): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Git pull");
      await this.gitService.pullProjectBranch(project.repoPath);
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  async pushProjectBranch(projectId: string, input: PushProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.requireGitProject(project, "Git push");
      await this.gitService.pushProjectBranch(project.repoPath, input.branchName, input.setUpstream !== false);
      return this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    });
  }

  private listRunsLinkedToProjectBranch(projectId: string, branchName: string): RunRecord[] {
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) {
      return [];
    }
    return this.db.listRunsForProject(projectId).filter((run) => {
      if (run.workspaceVcs !== "git") {
        return false;
      }
      if (run.branchName.trim() === normalizedBranchName) {
        return true;
      }
      if (run.workspaceType !== "worktree") {
        return false;
      }
      return basename(run.worktreePath) === normalizedBranchName;
    });
  }

  async addProject(input: ProjectInput): Promise<ProjectRecord> {
    const repoPath = input.repoPath.trim();
    if (!repoPath) {
      throw new Error("Choose a project folder.");
    }
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      throw new Error("The selected path is not a folder.");
    }
    const validation = await this.gitService.validateProject(repoPath);
    const kind: ProjectRecord["kind"] = validation.isGitRepo ? "git" : "folder";

    const project = this.db.addProject({
      ...input,
      repoPath,
      kind,
      baseBranch: validation.isGitRepo ? validation.baseBranch : "",
      resolvedName: input.name?.trim() || validation.repoName,
    });
    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    return project;
  }

  async addProviderAccount(input: ProviderAccountInput): Promise<ProviderAccountRecord> {
    this.providerAdapters[input.providerType].validateConfiguration(input);
    if (input.providerType === "codex-cli") {
      assertCodexCliAvailable(input.config);
    } else if (input.providerType === "claude-code") {
      assertClaudeCodeAvailable(input.config);
    } else if (input.providerType === "cursor-agent") {
      await assertCursorAgentAvailable(input.config);
    }

    const keyRef = `provider:${crypto.randomUUID()}`;
    await this.secrets.saveSecret(keyRef, input.apiKey);

    return this.db.addProviderAccount({
      providerType: input.providerType,
      label: input.label.trim(),
      apiBaseUrl: input.apiBaseUrl?.trim() || null,
      apiKeyRef: keyRef,
      configJson: JSON.stringify(input.config ?? {}),
    });
  }

  async addModel(input: ModelInput): Promise<ModelRecord> {
    const provider = this.db.getProviderAccount(input.providerAccountId);
    return this.db.addModel({
      ...input,
      capabilities: {
        ...getDefaultProviderCapabilities(provider.providerType),
        ...input.capabilities,
      },
      config: input.config,
    });
  }

  async listAvailableProviderModels(
    input: ListAvailableProviderModelsInput,
  ): Promise<ListAvailableProviderModelsResult> {
    const provider = this.db.getProviderAccount(input.providerAccountId);
    const fallbackModels = dedupeAvailableProviderModels(getCuratedAvailableModelsForProvider(provider));
    const adapter = this.providerAdapters[provider.providerType];
    if (!adapter.listAvailableModels) {
      return { models: fallbackModels };
    }

    try {
      const networkProxy = await this.resolveNetworkProxyRuntimeConfig();
      const models = await adapter.listAvailableModels({
        providerAccountId: provider.id,
        providerType: provider.providerType,
        config: parseProviderConfigJson(provider.configJson),
        apiBaseUrl: provider.apiBaseUrl,
        ...(networkProxy ? { networkProxy } : {}),
      });
      return { models: dedupeAvailableProviderModels(models) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Available models could not be loaded.";
      return {
        models: fallbackModels,
        errorMessage: detail,
      };
    }
  }

  async listComposerCommands(input: ListComposerCommandsInput): Promise<ComposerCommandDescriptor[]> {
    const modelId = input.modelId.trim();
    if (!modelId) {
      return [];
    }

    let model: ModelRecord;
    let provider: ProviderAccountRecord;
    let projectPath: string | undefined;
    try {
      model = this.db.getModel(modelId);
      provider = this.db.getProviderAccount(model.providerAccountId);
      if (input.projectId?.trim()) {
        projectPath = this.db.getProject(input.projectId).repoPath;
      }
    } catch {
      return [];
    }

    const context: ComposerCommandContext = input.context;
    const cacheKey = [provider.id, provider.providerType, model.id, projectPath ?? "", context].join("|");
    const now = Date.now();
    const cached = this.composerCommandCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return filterComposerCommandDescriptors(cached.commands, input.query);
    }

    const existing = this.composerCommandInflight.get(cacheKey);
    const pending = existing ?? this.loadComposerCommandsForProvider(provider, projectPath, context);
    this.composerCommandInflight.set(cacheKey, pending);

    try {
      const commands = await pending;
      this.composerCommandCache.set(cacheKey, {
        commands,
        expiresAt: Date.now() + 30_000,
      });
      return filterComposerCommandDescriptors(commands, input.query);
    } finally {
      if (this.composerCommandInflight.get(cacheKey) === pending) {
        this.composerCommandInflight.delete(cacheKey);
      }
    }
  }

  private async loadComposerCommandsForProvider(
    provider: ProviderAccountRecord,
    projectPath: string | undefined,
    context: ComposerCommandContext,
  ): Promise<ComposerCommandDescriptor[]> {
    const staticCommands = listComposerCommandsForProvider(provider.providerType, context);
    const providerCommands = await this.loadNativeComposerCommands(provider, projectPath);

    return mergeComposerCommandDescriptors([...staticCommands, ...providerCommands], context);
  }

  private async loadNativeComposerCommands(
    provider: ProviderAccountRecord,
    projectPath: string | undefined,
  ): Promise<ComposerCommandDescriptor[]> {
    if (provider.providerType === "codex-cli") {
      return [...CODEX_NATIVE_COMPOSER_COMMANDS];
    }
    if (provider.providerType !== "claude-code") {
      return [];
    }
    try {
      const commands = await listClaudeCodeSlashCommands({
        cwd: projectPath,
        config: parseProviderConfigJson(provider.configJson),
        networkProxy: await this.resolveNetworkProxyRuntimeConfig(),
      });
      return buildClaudeComposerCommandDescriptors(commands, provider.providerType);
    } catch (error) {
      this.logControllerWarn("Failed to probe Claude Code slash commands.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async deleteProviderAccount(providerAccountId: string): Promise<void> {
    const provider = this.db.getProviderAccount(providerAccountId);
    const runCount = this.db.countRunsForProviderAccount(providerAccountId);

    if (runCount > 0) {
      throw new Error("This provider cannot be deleted because existing runs reference it.");
    }

    await this.secrets.deleteSecret(provider.apiKeyRef);
    this.db.deleteProviderAccount(providerAccountId);
  }

  async deleteModel(modelId: string): Promise<void> {
    const runCount = this.db.countRunsForModel(modelId);

    if (runCount > 0) {
      throw new Error("This model cannot be deleted because existing runs reference it.");
    }

    this.db.deleteModel(modelId);
  }

  async createRun(input: RunInput): Promise<RunRecord> {
    const project = this.db.getProject(input.projectId);
    if (input.projectTaskId) {
      const task = this.db.getProjectTask(input.projectTaskId);
      if (task.projectId !== project.id) {
        throw new Error("The selected task does not belong to this project.");
      }
    }
    const provider = this.db.getProviderAccount(input.providerAccountId);
    const model = this.db.getModel(input.modelId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    validateChatAttachmentPayloads(input.attachments);
    const userText = input.prompt.trim();
    const attachmentNames = input.attachments?.map((a) => a.fileName) ?? [];
    if (!userText && attachmentNames.length === 0) {
      throw new Error("Enter a task description or attach at least one file.");
    }
    const displayPrompt =
      userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : input.prompt);
    const goalText = normalizeRunGoalText(input.goalText);
    const initialPromptForHarness = buildPromptWithRunGoal(displayPrompt, goalText);

    const { attachments: initialAttachments, ...runInsertInput } = input;

    const workspaceType = input.workspaceType ?? (project.kind === "folder" ? "copy" : "worktree");
    const workspaceVcs: RunWorkspaceVcs = project.kind === "folder" ? "folder" : "git";
    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    let branchName: string;
    let worktreePath: string;

    if (project.kind === "folder") {
      if (workspaceType === "worktree") {
        throw new Error("Git worktrees are only available for Git projects.");
      }
      if (workspaceType === "copy") {
        const folderWorkspace = await createFolderWorkspaceCopy({
          sourcePath: project.repoPath,
          projectName: project.name,
          runId: crypto.randomUUID(),
          configuredWorkspaceRoot: configuredWorktreeRoot,
        });
        branchName = folderWorkspace.branchName;
        worktreePath = folderWorkspace.worktreePath;
      } else {
        branchName = "project-folder";
        worktreePath = project.repoPath;
      }
    } else {
      if (workspaceType === "copy") {
        throw new Error("Folder copy runs are only available for non-Git folder projects.");
      }
      if (workspaceType === "local") {
        branchName = await this.gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
      } else {
        const gitWorkspace = await this.gitService.createWorktreeForRun(
          project.repoPath,
          project.name,
          crypto.randomUUID(),
          input.baseBranch?.trim() || project.baseBranch,
          configuredWorktreeRoot,
        );
        branchName = gitWorkspace.branchName;
        worktreePath = gitWorkspace.worktreePath;
      }
    }

    let run = this.db.createRun({
      ...runInsertInput,
      prompt: displayPrompt,
      goalText,
      workspaceType,
      workspaceVcs,
      branchName,
      worktreePath,
    });

    if (run.projectTaskId) {
      this.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }

    if (workspaceType === "worktree" || workspaceType === "copy") {
      this.db.upsertWorktree({
        id: run.id,
        projectId: run.projectId,
        runId: run.id,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        status: "ready",
      });
    }

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);

    const initialLogContent = [
      userText || "(no text)",
      attachmentNames.length ? `\nAttachments: ${attachmentNames.join(", ")}` : "",
    ].join("");

    await this.appendRunEvent(run.id, "log", "Initial command", initialLogContent, {
      source: "user",
      commandType: "initial",
      mode: run.mode,
      modelId: run.modelId,
      goalText: run.goalText,
      yoloMode: input.yoloMode === true,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      ...this.buildStoredAttachmentMetadata(initialAttachments),
    });
    if (run.goalText) {
      await this.appendRunEvent(run.id, "status", "Goal set", run.goalText, { goalText: run.goalText });
    }
    await this.appendRunEvent(
      run.id,
      "status",
      "Run queued",
      workspaceType === "local" ? `Using ${this.getRunWorkspaceLabel(run)}` : `Preparing workspace ${worktreePath}`,
    );
    run = this.db.updateRunStatus(run.id, "preparing");
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run preparing",
      content: workspaceType === "local" ? `Using workspace ${worktreePath}` : `Created workspace ${worktreePath}`,
      createdAt: new Date().toISOString(),
    });

    await this.captureFolderBaselineSnapshotOrFail(run, project);
    await this.capturePromptRestorePoint(run.id, "initial");
    const worker = this.startWorker(
      run,
      provider,
      model,
      apiKey ?? "",
      await this.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: initialPromptForHarness || undefined,
        attachments: initialAttachments,
        skillContext: this.buildIntegratedSkillContext(project.id),
        providerOptions: {
          reasoningEffort: input.reasoningEffort,
          anthropicEffort: input.anthropicEffort,
        },
        yoloMode: input.yoloMode === true,
      },
    );
    this.runWorkers.set(run.id, { worker, cancelled: false });

    return this.db.getRun(run.id);
  }

  async continueRun(input: ContinueRunInput): Promise<RunRecord> {
    const sourceRun = this.db.getRun(input.sourceRunId);
    if (ACTIVE_RUN_STATUSES.has(sourceRun.status)) {
      throw new Error("Wait for this run to finish before starting a continuation.");
    }
    if (!existsSync(sourceRun.worktreePath) || !statSync(sourceRun.worktreePath).isDirectory()) {
      throw new Error("The source run workspace is no longer available.");
    }

    const project = this.db.getProject(sourceRun.projectId);
    const provider = this.db.getProviderAccount(input.providerAccountId);
    const model = this.db.getModel(input.modelId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const userText = input.prompt.trim();
    if (!userText) {
      throw new Error("Enter a continuation prompt.");
    }

    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    const { workspaceType, workspaceVcs, branchName, worktreePath } = await this.prepareContinuationWorkspace(
      sourceRun,
      project,
      input.includeWorkspaceChanges !== false,
      configuredWorktreeRoot,
    );

    const goalText = input.goalText === undefined ? sourceRun.goalText : normalizeRunGoalText(input.goalText);
    const promptForHarness = buildPromptWithRunGoal(userText, goalText);

    let run = this.db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: input.harnessType,
      mode: input.mode,
      workspaceType,
      workspaceVcs,
      prompt: userText,
      goalText,
      branchName,
      worktreePath,
      parentRunId: sourceRun.id,
      rootRunId: sourceRun.rootRunId ?? sourceRun.id,
      lineageTitle: sourceRun.prompt || sourceRun.branchName,
      projectTaskId: sourceRun.projectTaskId,
    });

    if (run.projectTaskId) {
      this.db.linkProjectTaskToRun(run.projectTaskId, run.id);
    }

    this.db.upsertWorktree({
      id: run.id,
      projectId: run.projectId,
      runId: run.id,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      status: "ready",
    });

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);

    await this.appendRunEvent(run.id, "log", "Initial command", userText, {
      source: "user",
      commandType: "initial",
      mode: run.mode,
      modelId: run.modelId,
      goalText: run.goalText,
      yoloMode: input.yoloMode === true,
      reasoningEffort: input.reasoningEffort,
      anthropicEffort: input.anthropicEffort,
      continuedFromRunId: sourceRun.id,
      continuedFromBranch: sourceRun.branchName,
      includeWorkspaceChanges: input.includeWorkspaceChanges !== false,
    });
    await this.appendRunEvent(
      run.id,
      "status",
      "Continuation queued",
      `Preparing workspace ${worktreePath} from ${this.getRunWorkspaceLabel(sourceRun)}`,
      {
        continuedFromRunId: sourceRun.id,
        continuedFromBranch: sourceRun.branchName,
      },
    );
    run = this.db.updateRunStatus(run.id, "preparing");
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: "Run preparing",
      content: `Created continuation workspace ${worktreePath}`,
      metadata: {
        continuedFromRunId: sourceRun.id,
        continuedFromBranch: sourceRun.branchName,
      },
      createdAt: new Date().toISOString(),
    });

    await this.captureFolderBaselineSnapshotOrFail(run, project);
    await this.capturePromptRestorePoint(run.id, "initial");
    const worker = this.startWorker(
      run,
      provider,
      model,
      apiKey ?? "",
      await this.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: promptForHarness,
        skillContext: this.buildIntegratedSkillContext(project.id),
        providerOptions: {
          reasoningEffort: input.reasoningEffort,
          anthropicEffort: input.anthropicEffort,
        },
        yoloMode: input.yoloMode === true,
      },
    );
    this.runWorkers.set(run.id, { worker, cancelled: false });

    return this.db.getRun(run.id);
  }

  private async prepareContinuationWorkspace(
    sourceRun: RunRecord,
    project: ProjectRecord,
    includeWorkspaceChanges: boolean,
    configuredWorkspaceRoot: string | undefined,
  ): Promise<Pick<RunRecord, "workspaceType" | "workspaceVcs" | "branchName" | "worktreePath">> {
    if (sourceRun.workspaceVcs === "folder") {
      if (sourceRun.workspaceType === "local" && !includeWorkspaceChanges) {
        throw new Error("Folder continuations from the project folder cannot exclude workspace changes yet.");
      }
      const sourcePath = includeWorkspaceChanges ? sourceRun.worktreePath : project.repoPath;
      const workspace = await createFolderWorkspaceCopy({
        sourcePath,
        projectName: project.name,
        runId: crypto.randomUUID(),
        configuredWorkspaceRoot,
      });
      return { workspaceType: "copy", workspaceVcs: "folder", ...workspace };
    }

    if (sourceRun.workspaceType === "local" && includeWorkspaceChanges) {
      const currentBranch = await this.gitService.getCurrentBranch(project.repoPath);
      if (currentBranch !== sourceRun.branchName) {
        throw new Error(
          `The project repository is currently on "${currentBranch}", but this run is tied to "${sourceRun.branchName}". Check out the run branch or turn off workspace changes before continuing.`,
        );
      }
    }

    const workspace = await this.gitService.createWorktreeForContinuation(
      project.repoPath,
      project.name,
      crypto.randomUUID(),
      sourceRun.branchName,
      configuredWorkspaceRoot,
    );
    if (includeWorkspaceChanges) {
      await this.gitService.cloneWorkspaceChanges(sourceRun.worktreePath, workspace.worktreePath);
    }
    return { workspaceType: "worktree", workspaceVcs: "git", ...workspace };
  }

  async followUpRun(runId: string, prompt: string, options?: RunFollowUpOptions): Promise<RunRecord> {
    return this.followUpRunInternal(runId, prompt, options);
  }

  private async followUpRunInternal(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    extraLogMetadata?: Record<string, unknown>,
  ): Promise<RunRecord> {
    let run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const model = this.db.getModel(options?.modelId ?? run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);

    if (this.runWorkers.has(runId)) {
      throw new Error("This run is already active. Wait for it to finish before sending a follow-up.");
    }

    validateChatAttachmentPayloads(options?.attachments);

    const userText = prompt.trim();
    const attachmentNames = options?.attachments?.map((a) => a.fileName) ?? [];
    const hasGoalUpdate = options ? Object.prototype.hasOwnProperty.call(options, "goalText") : false;
    const nextGoalText = hasGoalUpdate ? normalizeRunGoalText(options?.goalText) : run.goalText;
    if (!userText && attachmentNames.length === 0 && !hasGoalUpdate) {
      throw new Error("Enter a follow-up command or attach at least one file.");
    }

    const followUpLogContent = [
      userText || "(no text)",
      attachmentNames.length ? `\nAttachments: ${attachmentNames.join(", ")}` : "",
    ].join("");

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
    run = this.db.updateRunConfiguration(run.id, {
      providerAccountId: provider.id,
      modelId: model.id,
      mode: options?.mode ?? run.mode,
      ...(hasGoalUpdate ? { goalText: nextGoalText } : {}),
    });
    if (hasGoalUpdate && !userText && attachmentNames.length === 0) {
      await this.appendRunEvent(run.id, "log", "Run goal updated", run.goalText ?? "No run goal set.", {
        source: "user",
        commandType: "goal",
        mode: run.mode,
        modelId: run.modelId,
        goalText: run.goalText,
      });
      return this.db.getRun(run.id);
    }

    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const followUpPromptForHarness =
      [
        buildPromptWithRunGoal(userText || (attachmentNames.length ? `Attached: ${attachmentNames.join(", ")}` : ""), run.goalText),
        this.buildRunFollowUpMemo(run.id),
      ]
        .filter(Boolean)
        .join("\n\n");
    await this.appendRunEvent(run.id, "log", "Follow-up command", followUpLogContent, {
      source: "user",
      commandType: "follow-up",
      mode: run.mode,
      modelId: run.modelId,
      goalText: run.goalText,
      yoloMode: options?.yoloMode === true,
      reasoningEffort: options?.reasoningEffort,
      anthropicEffort: options?.anthropicEffort,
      ...extraLogMetadata,
      ...this.buildStoredAttachmentMetadata(options?.attachments),
    });
    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    this.clearRunCheckpoint(run.id);
    await this.capturePromptRestorePoint(run.id, "follow-up");

    const worker = this.startWorker(
      run,
      provider,
      model,
      apiKey ?? "",
      await this.resolveNetworkProxyRuntimeConfig(),
      {
        promptOverride: followUpPromptForHarness,
        attachments: options?.attachments,
        skillContext: this.buildIntegratedSkillContext(project.id),
        providerOptions: {
          reasoningEffort: options?.reasoningEffort,
          anthropicEffort: options?.anthropicEffort,
        },
        yoloMode: options?.yoloMode === true,
      },
    );
    this.runWorkers.set(run.id, { worker, cancelled: false });

    return this.db.getRun(run.id);
  }

  private shouldAutoCheckoutRunBranch(run: RunRecord): boolean {
    return run.workspaceVcs === "git" && run.workspaceType === "worktree" &&
      this.isSettingEnabled(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, true);
  }

  private async canCheckoutRunWorktree(run: RunRecord): Promise<boolean> {
    return this.shouldAutoCheckoutRunBranch(run) && existsSync(run.worktreePath) &&
      await this.gitService.hasWorktreeGitMetadata(run.worktreePath);
  }

  async activateRun(runId: string): Promise<void> {
    let run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const branchPromotedToProject = this.wasRunPromotedToProject(run.id);
    const autoCheckoutWorktree = this.shouldAutoCheckoutRunBranch(run);

    if (await this.canCheckoutRunWorktree(run)) {
      try {
        await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
        this.updateWorktreeStatus(run, ACTIVE_RUN_STATUSES.has(run.status) ? "busy" : "ready");
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the run branch "${run.branchName}" in its worktree.`,
            "It may already be checked out in another IDE, repository, or worktree.",
            "Release it from the other source or open the run worktree folder directly instead.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    } else if (
      autoCheckoutWorktree &&
      branchPromotedToProject
    ) {
      try {
        await this.gitService.checkoutProjectBranch(project.repoPath, run.branchName);
        run = this.db.updateRunWorkspace(run.id, "local", project.repoPath);
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the promoted branch "${run.branchName}" in the project repository.`,
            "It may be blocked by local changes or another checkout state in the main repository.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    }

    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
  }

  async commitRun(runId: string, message: string): Promise<void> {
    const run = this.db.getRun(runId);
    this.requireGitRun(run, "Committing");

    if (run.status !== "completed") {
      throw new Error("Only completed runs can be committed.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to commit for this run.");
    }

    const commitMessage = message.trim() || this.buildRunCommitMessage(run.prompt);
    const result = await this.gitService.commitAllChanges(run.worktreePath, commitMessage);

    await this.appendRunEvent(run.id, "status", "Commit created", `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`, {
      commitHash: result.commitHash,
      commitMessage: commitMessage,
    });
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: "Commit created",
      content: `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`,
      metadata: {
        commitHash: result.commitHash,
        commitMessage: commitMessage,
      },
      createdAt: new Date().toISOString(),
    });
    this.markLinkedRunTaskInReview(run);
  }

  async suggestCommitMessage(runId: string): Promise<string> {
    const run = this.db.getRun(runId);
    this.requireGitRun(run, "Commit message suggestions");

    if (run.status !== "completed") {
      throw new Error("Only completed runs can use AI commit suggestions.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to describe for this run.");
    }

    const diffOutcome = await runWorktreeDiffInWorker(run.worktreePath);
    if (!diffOutcome.ok) {
      throw new Error("Could not read the worktree diff.");
    }
    let diff = diffOutcome.diff;
    if (diff.length > MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) {
      diff =
        diff.slice(0, MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) +
        "\n\n[Diff truncated for commit message generation - review before committing.]";
    }

    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    const providerConfig = JSON.parse(provider.configJson || "{}") as Record<string, unknown>;
    const networkProxy = await this.resolveNetworkProxyRuntimeConfig();
    const commitMessagePrompt = [
      "Task the agent was given:",
      run.prompt,
      "",
      "Git diff of current uncommitted changes in the run workspace (staged + unstaged + untracked as patches):",
      diff || "(empty diff)",
      "",
      "Write a concise git commit message for these changes.",
      "Use an imperative mood subject line, at most about 72 characters.",
      "Optionally add a blank line and a short body if needed.",
      "Output only the commit message text - no quotes, markdown fences, or commentary.",
    ].join("\n");

    if (provider.providerType === "codex-cli") {
      const text = normalizeSuggestedCommitMessage(
        await suggestCommitMessageWithCodexCli({
          cwd: run.worktreePath,
          modelId: model.modelId,
          config: providerConfig,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          diffPrompt: commitMessagePrompt,
          networkProxy,
        }),
      );
      if (!text) {
        throw new Error("Codex CLI returned an empty commit message.");
      }
      return text;
    }

    if (provider.providerType === "claude-code") {
      const text = normalizeSuggestedCommitMessage(
        await suggestCommitMessageWithClaudeCode({
          cwd: run.worktreePath,
          modelId: model.modelId,
          config: providerConfig,
          diffPrompt: commitMessagePrompt,
          networkProxy,
        }),
      );
      if (!text) {
        throw new Error("Claude Code returned an empty commit message.");
      }
      return text;
    }

    if (provider.providerType === "cursor-agent") {
      const text = normalizeSuggestedCommitMessage(
        await suggestCommitMessageWithCursorAgent({
          cwd: run.worktreePath,
          modelId: model.modelId,
          config: providerConfig,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          diffPrompt: commitMessagePrompt,
        }),
      );
      if (!text) {
        throw new Error("Cursor Agent returned an empty commit message.");
      }
      return text;
    }

    const baseURL = (model.baseUrlOverride ?? provider.apiBaseUrl)?.trim();

    try {
      if (provider.providerType === "azure-legacy") {
        if (!baseURL) {
          throw new Error("Azure Legacy requires a deployment base URL on the provider or model.");
        }
        const client = createAzureLegacyClientFromParts(baseURL, apiKey ?? "", providerConfig, undefined, networkProxy);
        const completion = await client.chat.completions.create({
          model: model.modelId,
          messages: [
            {
              role: "system",
              content:
                "You write clear, conventional git commit messages from diffs. Output only the commit message, nothing else.",
            },
            { role: "user", content: commitMessagePrompt },
          ],
          max_completion_tokens: 500,
          temperature: 0.3,
        });
        const raw = extractChatCompletionText(completion.choices[0]?.message?.content);
        const text = normalizeSuggestedCommitMessage(raw ?? "");
        if (!text) {
          throw new Error("The model returned an empty commit message.");
        }
        return text;
      }

      const raw = await suggestCommitMessageWithAiSdk({
        modelId: model.modelId,
        apiKey: apiKey ?? "",
        apiBaseUrl: baseURL,
        config: providerConfig,
        modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
        prompt: commitMessagePrompt,
        networkProxy,
      });
      const text = normalizeSuggestedCommitMessage(raw ?? "");
      if (!text) {
        throw new Error("The model returned an empty commit message.");
      }
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          "Could not generate a commit message via the configured provider.",
          "Write the message manually or switch to a supported model.",
          `Detail: ${msg}`,
        ].join(" "),
      );
    }
  }

  async createProjectTask(projectId: string, input: ProjectTaskInput): Promise<ProjectTaskRecord> {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title) {
      throw new Error("Enter a task title.");
    }
    if (!prompt) {
      throw new Error("Enter a task prompt.");
    }
    this.db.getProject(projectId);
    return this.db.createProjectTask(projectId, { title, prompt });
  }

  async updateProjectTask(taskId: string, input: UpdateProjectTaskInput): Promise<ProjectTaskRecord> {
    const existing = this.db.getProjectTask(taskId);
    const title = input.title === undefined ? existing.title : input.title.trim();
    const prompt = input.prompt === undefined ? existing.prompt : input.prompt.trim();
    if (!title) {
      throw new Error("Enter a task title.");
    }
    if (!prompt) {
      throw new Error("Enter a task prompt.");
    }
    const status = input.status ?? existing.status;
    if (!(status === "open" || status === "in_progress" || status === "in_review" || status === "done")) {
      throw new Error(`Unsupported project task status: ${String(status)}`);
    }
    return this.db.updateProjectTask(taskId, { title, prompt, status });
  }

  async syncProjectTaskPullRequestStatuses(projectId: string): Promise<ProjectTaskRecord[]> {
    const tasks = this.db
      .listProjectTasks(projectId)
      .filter((task) => task.status === "in_review" && Boolean(task.pullRequestUrl));
    if (tasks.length === 0) {
      return [];
    }

    const provider = await this.createProjectPrReviewProvider(projectId);
    const changed: ProjectTaskRecord[] = [];
    for (const task of tasks) {
      try {
        const details = await provider.getRequestDetails({ prUrl: task.pullRequestUrl! });
        if (details.request.state === "merged") {
          changed.push(this.db.updateProjectTask(task.id, { status: "done" }));
        }
      } catch (error) {
        logWarn("Failed to reconcile a project task with its linked PR/MR.", {
          projectId,
          taskId: task.id,
          pullRequestUrl: task.pullRequestUrl,
          error,
        });
      }
    }
    return changed;
  }

  async deleteProjectTask(taskId: string): Promise<void> {
    this.db.deleteProjectTask(taskId);
  }

  async runProjectLab(input: RunProjectLabInput): Promise<ProjectLabThreadRecord[]> {
    const project = this.db.getProject(input.projectId);
    const settings = this.getProjectLabSettings(project.id);
    if (!settings.enabled) {
      throw new Error("Enable Project Lab on this project before starting it.");
    }

    const implementationModelId = input.implementationModelId?.trim() || settings.implementationModelId?.trim() || "";
    const reviewModelId = input.reviewModelId?.trim() || settings.reviewModelId?.trim() || "";
    if (!implementationModelId) {
      throw new Error("Choose an implementation model before running Project Lab.");
    }
    if (!reviewModelId) {
      throw new Error("Choose a review model before running Project Lab.");
    }
    this.db.getModel(implementationModelId);
    this.db.getModel(reviewModelId);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = this.db
      .listProjectLabThreads(project.id)
      .filter((thread) => new Date(thread.createdAt).getTime() >= todayStart.getTime()).length;
    if (todayCount >= settings.maxThreadsPerDay) {
      throw new Error(`Project Lab reached the daily cap of ${String(settings.maxThreadsPerDay)} thread(s) for this project.`);
    }

    const activeCount = this.db
      .listProjectLabThreads(project.id)
      .filter((thread) => thread.status === "queued" || thread.status === "running" || thread.status === "reviewing").length;
    if (activeCount >= settings.maxConcurrentThreads) {
      throw new Error(`Project Lab already has ${String(settings.maxConcurrentThreads)} active thread(s) on this project.`);
    }

    const mode = this.normalizeProjectLabMode(input.mode);
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    const baseBranch = project.kind === "git" ? input.baseBranch?.trim() || project.baseBranch : "project-folder";
    if (project.kind === "git") {
      const availableBranches = await this.getProjectBranches(project.id);
      if (!availableBranches.includes(baseBranch)) {
        throw new Error(`Base branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
    }

    const thread = this.db.createProjectLabThread({
      projectId: project.id,
      kind: mode === "rfc-only" ? "rfc" : "implementation",
      mode,
      status: "queued",
      origin: input.origin ?? "manual",
      title: input.topic?.trim() || `${modeLabel} Project Lab run`,
      summary: mode === "rfc-only" ? "Project Lab is drafting an RFC." : `Project Lab is finding and implementing one ${modeLabel.toLowerCase()} opportunity.`,
      seedPrompt: input.topic?.trim() || null,
      implementationModelId,
      reviewModelId,
      baseBranch,
    });

    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "Project Lab",
      content: describeLabStart(modeLabel, project.kind === "git" ? baseBranch : null, input.topic?.trim() || null),
    });

    if (mode === "rfc-only") {
      this.db.updateProjectLabThread(thread.id, { status: "running" });
      void this.executeProjectLabRfcThread(thread.id, input, project, mode, implementationModelId, reviewModelId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.isProjectLabThreadCancelled(thread.id)) {
          try {
            this.db.appendProjectLabEvent({
              threadId: thread.id,
              role: "system",
              label: "Project Lab",
              content: `Project Lab RFC failed: ${message}`,
            });
            this.db.updateProjectLabThread(thread.id, {
              status: "failed",
              outcome: message,
            });
          } catch {
            /* thread may have been deleted */
          }
        }
        this.logControllerError("Project Lab RFC execution failed.", error, { projectId: project.id, threadId: thread.id });
      });
      return [this.db.getProjectLabThread(thread.id)];
    }

    const implementationPrompt = await this.buildProjectLabImplementationPrompt(input, project, mode, thread.id);
    const implementationRun = await this.createProjectLabImplementationRun(
      project.id,
      thread.id,
      implementationModelId,
      implementationPrompt,
      baseBranch,
    );
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "implementation",
      label: "Implementation agent",
      content:
        implementationRun.workspaceVcs === "folder"
          ? `Implementation started in a copied folder workspace. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`
          : `Implementation started in worktree \`${implementationRun.branchName}\`. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`,
    });

    return [
      this.db.updateProjectLabThread(thread.id, {
        status: "running",
        implementationPrompt,
        implementationRunId: implementationRun.id,
      }),
    ];
  }
  async deleteProjectLabThread(threadId: string): Promise<void> {
    this.cancelledProjectLabThreadIds.add(threadId);
    const thread = this.db.getProjectLabThread(threadId);
    if (thread.implementationRunId) {
      const run = this.db.getRun(thread.implementationRunId);
      const project = this.db.getProject(run.projectId);
      this.terminal.killForRunId(run.id);
      this.clearRunCheckpoint(run.id);
      this.clearRunPromptRestorePoint(run.id);
      this.db.deleteProviderSessionRuntime(run.id, "run");
      await this.deleteRunResources(project.repoPath, run, "run");
      this.db.deleteRun(run.id);
    }
    this.db.deleteProjectLabThread(threadId);
  }

  /**
   * Runs a background loop action that internally moves the renderer's project/run
   * selection (createRun / followUpRunInternal do) and restores the previous
   * selection afterwards, including on failure.
   */
  private async withPreservedRunSelection<T>(action: () => Promise<T>): Promise<T> {
    const settings = this.db.getSettings();
    const previousProjectId = settings[SELECTED_PROJECT_KEY];
    const previousRunId = settings[SELECTED_RUN_KEY];
    try {
      return await action();
    } finally {
      if (previousRunId) {
        this.db.setSetting(SELECTED_RUN_KEY, previousRunId);
      } else {
        this.db.deleteSetting(SELECTED_RUN_KEY);
      }
      if (previousProjectId) {
        this.db.setSetting(SELECTED_PROJECT_KEY, previousProjectId);
      } else {
        this.db.deleteSetting(SELECTED_PROJECT_KEY);
      }
    }
  }

  private get loopRunner(): ProjectLoopRunner {
    if (!this.loopRunnerInstance) {
      this.loopRunnerInstance = new ProjectLoopRunner({
        db: this.db,
        gitService: this.gitService,
        uiReviewImageRoot: join(dirname(this.db.getFilePath()), "loop-ui-reviews"),
        createIterationRun: (input) => this.withPreservedRunSelection(() => this.createRun(input)),
        followUpRun: (runId, prompt, options) =>
          this.withPreservedRunSelection(() => this.followUpRunInternal(runId, prompt, options, { loopFollowUp: true })),
        cancelRun: (runId) => this.cancelRun(runId),
        deleteRun: (runId) => this.deleteRun(runId),
        askModelForText: async (cwd, modelId, input) => {
          const context = await this.resolveModelInvocationContext(modelId);
          return this.askModelForText(cwd, context, input);
        },
        createForgeProvider: (projectId) => this.createProjectPrReviewProvider(projectId),
        emitLoopChanged: (payload) => this.events.publish("loop", payload),
        logError: (message, error, metadata) => this.logControllerError(message, error, metadata),
        logWarn: (message, metadata) => this.logControllerWarn(message, metadata),
      });
    }
    return this.loopRunnerInstance;
  }

  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void): () => void {
    return this.events.subscribe("loop", listener);
  }

  /** Re-enters all active loops after an app restart (call after {@link reconcileOrphanedActiveSessions}). */
  resumeActiveProjectLoops(): void {
    try {
      this.loopRunner.resumeActiveLoops();
    } catch (error) {
      this.logControllerError("Could not resume active project loops on startup.", error);
    }
  }

  async createProjectLoop(input: CreateProjectLoopInput): Promise<ProjectLoopRecord> {
    const project = this.db.getProject(input.projectId);
    this.requireGitProject(project, "Loops");
    return this.loopRunner.startLoop(input);
  }

  async getProjectLoopDetail(loopId: string): Promise<ProjectLoopDetail> {
    return this.db.getProjectLoopDetail(loopId);
  }

  async cancelProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.cancelLoop(loopId);
  }

  async resumeProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.resumeLoop(loopId);
  }

  async deleteProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.deleteLoop(loopId);
  }

  async respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput): Promise<void> {
    await this.loopRunner.respondToUiReview(reviewId, input);
  }

  async getProjectLoopUiReviewImage(reviewId: string): Promise<string | null> {
    return this.loopRunner.getUiReviewImageDataUrl(reviewId);
  }

  async getProjectLoopAvailability(projectId: string): Promise<ProjectLoopAvailability> {
    const project = this.db.getProject(projectId);
    const enabledModels = this.db.listModels().filter((model) => model.enabled);
    const providersById = new Map(this.db.listProviderAccounts().map((provider) => [provider.id, provider]));
    const hasLocalModels = enabledModels.some((model) => {
      const provider = providersById.get(model.providerAccountId);
      return provider ? isLoopCapableProviderType(provider.providerType) : false;
    });

    if (project.kind !== "git") {
      return { available: false, reason: "not-git", hasToken: false, hasLocalModels };
    }

    let context: ProjectPrReviewRemoteContext;
    try {
      context = await this.resolveProjectPrReviewRemoteContext(projectId);
    } catch {
      return { available: false, reason: "no-remote", hasToken: false, hasLocalModels };
    }

    const hasToken = Boolean((await this.secrets.readSecret(projectForgeTokenSecretKey(projectId)))?.trim());
    if (!hasToken) {
      return {
        available: false,
        reason: "no-forge-token",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    if (!hasLocalModels) {
      return {
        available: false,
        reason: "no-local-models",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    return { available: true, provider: context.provider, repoLabel: context.repoLabel, hasToken, hasLocalModels };
  }

  async generateProjectTaskRunPrompt(input: { projectId: string; title: string; notes: string; modelId: string }): Promise<string> {
    const project = this.db.getProject(input.projectId);
    const context = await this.resolveModelInvocationContext(input.modelId);

    const title = input.title.trim();
    const notes = input.notes.trim();
    if (!title && !notes) {
      throw new Error("Enter task notes before generating a prompt.");
    }

    const prompt = [
      "Rewrite the following project task notes into a strong coding-agent run prompt.",
      "Keep it concrete, implementation-focused, and easy for an agent to act on.",
      "If the notes are vague, preserve the intent and state reasonable assumptions explicitly.",
      "Output only the final run prompt text. No markdown fences, no bullets unless they help clarity.",
      "",
      `Project: ${project.name}`,
      `Task title: ${title || "(untitled task)"}`,
      "Task notes:",
      notes || "(no notes provided)",
    ].join("\n");

    try {
      const text = await this.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You rewrite rough software task notes into crisp prompts for a coding agent. Output only the final prompt text.",
        maxTokens: 900,
        temperature: 0.3,
        usageProjectId: project.id,
      });
      if (!text) {
        throw new Error("The model returned an empty prompt.");
      }
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a run prompt for this task. Detail: ${msg}`);
    }
  }

  async generateProjectInsight(input: GenerateProjectInsightInput): Promise<ProjectInsightRecord> {
    const project = this.db.getProject(input.projectId);
    const kind = input.kind;
    logInfo("Starting project insight generation.", {
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      kind,
      modelId: input.modelId ?? null,
    });

    try {
      if (kind === "architecture-graph") {
        const dependencyGraph = this.readDependencyGraphSnapshot(project.repoPath);
        const commits = await this.readRecentCommitInfo(project.repoPath, 120);
        const insight = this.buildArchitectureGraphInsight(project.repoPath, dependencyGraph, commits);
        if (insight.nodes.length === 0) {
          this.logControllerWarn("Architecture graph generated with zero nodes.", {
            projectId: project.id,
            repoPath: project.repoPath,
          });
        }
        logInfo("Architecture graph insight built.", {
          projectId: project.id,
          moduleCount: dependencyGraph.modules.length,
          commitCount: commits.length,
          nodeCount: insight.nodes.length,
          edgeCount: insight.edges.length,
          mermaidLength: insight.mermaid.length,
        });
        return this.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Architecture graph",
          summary: `Mapped ${String(insight.nodes.length)} modules and ${String(insight.edges.length)} dependency edges across the repo.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (kind === "dependency-gravity") {
        const dependencyGraph = this.readDependencyGraphSnapshot(project.repoPath);
        const commits = await this.readRecentCommitInfo(project.repoPath, 120);
        const insight = this.buildDependencyGravityInsight(dependencyGraph, commits);
        if (insight.nodes.length === 0) {
          this.logControllerWarn("Dependency gravity graph generated with zero nodes.", {
            projectId: project.id,
            repoPath: project.repoPath,
          });
        }
        logInfo("Dependency gravity insight built.", {
          projectId: project.id,
          moduleCount: dependencyGraph.modules.length,
          nodeCount: insight.nodes.length,
          edgeCount: insight.edges.length,
          totalModules: insight.summaryStats.totalModules,
          totalEdges: insight.summaryStats.totalEdges,
          mermaidLength: insight.mermaid.length,
        });
        return this.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Dependency gravity map",
          summary: `Scored ${String(insight.nodes.length)} dependency hotspots from ${String(insight.summaryStats.totalModules)} analyzed modules.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (kind === "narrative-branching") {
        const insight = this.buildNarrativeBranchingInsight(project.id);
        logInfo("Narrative branching insight built.", {
          projectId: project.id,
          branchCount: insight.branches.length,
          timelineCount: insight.timeline.length,
        });
        return this.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Narrative branching",
          summary: `Grouped ${String(insight.timeline.length)} runs into ${String(insight.branches.length)} active story branches.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (!PROJECT_INSIGHT_AI_KINDS.has(kind)) {
        throw new Error("Unsupported project insight kind.");
      }

      const modelId = input.modelId?.trim();
      if (!modelId) {
        throw new Error("Select a model before generating this project insight.");
      }

      const context = await this.resolveModelInvocationContext(modelId);
      const dependencyGraph = this.readDependencyGraphSnapshot(project.repoPath);
      const commits = await this.readRecentCommitInfo(project.repoPath, 120);
      const runs = this.db.listRunsForProject(project.id);
      const prompt = this.buildProjectInsightPrompt(project, kind, {
        dependencyGraph,
        commits,
        runs,
      });
      logInfo("Submitting AI-backed project insight request.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        moduleCount: dependencyGraph.modules.length,
        commitCount: commits.length,
        runCount: runs.length,
        promptLength: prompt.length,
      });
      const raw = await this.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You analyze software repositories and return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_600,
        temperature: 0.2,
        usageProjectId: project.id,
      });
      const parsed = this.parseProjectInsightAiResponse(kind, raw);
      logInfo("AI-backed project insight parsed successfully.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        title: parsed.title,
        summaryLength: parsed.summary.length,
        rawLength: raw.length,
      });
      return this.db.upsertProjectInsight({
        projectId: project.id,
        kind,
        title: parsed.title,
        summary: parsed.summary,
        dataJson: JSON.stringify(parsed.data),
        modelId: context.model.id,
      });
    } catch (error) {
      this.logControllerError("Project insight generation failed.", error, {
        projectId: project.id,
        kind,
        modelId: input.modelId ?? null,
        repoPath: project.repoPath,
      });
      throw error;
    }
  }

  async analyzeRunDiff(runId: string, options?: RunDiffReviewOptions): Promise<RunDiffReviewResult> {
    const run = this.db.getRun(runId);

    if (run.status !== "completed") {
      throw new Error("Only completed runs can use AI diff reviews.");
    }

    if (run.workspaceVcs === "git" && run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (run.workspaceVcs === "git" && !(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to review for this run.");
    }

    const diffOutcome = await this.getRunWorktreeDiff(run.id);
    if (diffOutcome.worktreeUnavailable) {
      throw new Error(diffOutcome.diffUnavailableReason || "Could not read the workspace diff.");
    }

    let diff = diffOutcome.diff;
    if (!diff.trim()) {
      throw new Error("There are no changes to review for this run.");
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for AI review - focus on highest-risk changes.]`;
    }

    const targetModelId = options?.modelId?.trim() || run.modelId;
    const context = await this.resolveModelInvocationContext(targetModelId);
    const prompt = this.buildRunDiffReviewPrompt(run, diff);

    try {
      const raw = await this.askModelForText(run.worktreePath, context, {
        prompt,
        systemPrompt: "You are a meticulous code reviewer. Return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_400,
        temperature: 0.2,
        usageProjectId: run.projectId,
      });

      return this.parseRunDiffReviewResult(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          "Could not review the run diff via the configured provider.",
          "Try again, switch models, or review the diff manually.",
          `Detail: ${msg}`,
        ].join(" "),
      );
    }
  }

  async fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Pull and merge request review");
    const prUrl = input.prUrl?.trim() ?? "";
    if (!prUrl) {
      throw new Error("Enter a pull request or merge request URL.");
    }
    const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
    if (token?.trim()) {
      try {
        const context = await this.resolveProjectPrReviewRemoteContext(projectId);
        const provider = createProjectPrReviewProvider(context, token.trim());
        const result = await provider.getRequestDiff(input);
        if (!result.diff.trim()) {
          throw new Error("The hosting API returned an empty diff for this PR/MR.");
        }
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not load the PR/MR diff via hosting API. ${msg}`);
      }
    }
    if (input.commitSha?.trim()) {
      throw new Error("Commit-specific PR/MR diffs require a Git hosting access token in Project Settings.");
    }
    try {
      const result = await computePrMrDiffViaFetch(project.repoPath, {
        prMrUrl: prUrl,
        baseBranch: input.baseBranch?.trim() || undefined,
      });
      if (!result.diff.trim()) {
        throw new Error(
          "The local git diff is empty. If this PR/MR is already merged, add a Git hosting access token in Project Settings and load it from the hosting API to read the historical diff.",
        );
      }
      return {
        diff: result.diff,
        provider: result.provider,
        number: result.number,
        baseRef: result.baseRef,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load the PR/MR diff via git fetch. ${msg}`);
    }
  }

  async getProjectForgeAuthStatus(projectId: string): Promise<ProjectForgeAuthStatus> {
    const context = await this.resolveProjectPrReviewRemoteContext(projectId);
    return {
      provider: context.provider,
      webBaseUrl: context.webBaseUrl,
      repoLabel: context.repoLabel,
      hasToken: (await this.secrets.readSecret(projectForgeTokenSecretKey(projectId))) !== null,
    };
  }

  async saveProjectForgeAuthToken(projectId: string, token: string): Promise<ProjectForgeAuthStatus> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Enter an access token before saving.");
    }
    await this.resolveProjectPrReviewRemoteContext(projectId);
    await this.secrets.saveSecret(projectForgeTokenSecretKey(projectId), trimmed);
    return this.getProjectForgeAuthStatus(projectId);
  }

  async deleteProjectForgeAuthToken(projectId: string): Promise<ProjectForgeAuthStatus> {
    await this.resolveProjectPrReviewRemoteContext(projectId);
    await this.secrets.deleteSecret(projectForgeTokenSecretKey(projectId));
    this.setProjectForgePrMonitorInterval(projectId, 0);
    return this.getProjectForgeAuthStatus(projectId);
  }

  async getProjectForgePrMonitorSettings(projectId: string): Promise<ProjectForgePrMonitorSettings> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "PR/MR monitoring");
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    return settings[projectId] ?? { intervalMinutes: 0 };
  }

  async saveProjectForgePrMonitorSettings(
    projectId: string,
    input: ProjectForgePrMonitorSettingsInput,
  ): Promise<ProjectForgePrMonitorSettings> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "PR/MR monitoring");
    const intervalMinutes = parseProjectForgePrMonitorIntervalMinutes(input.intervalMinutes);
    if (intervalMinutes > 0) {
      const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
      if (!token?.trim()) {
        throw new Error("Save a Git hosting access token before enabling PR/MR background checks.");
      }
    }
    this.setProjectForgePrMonitorInterval(projectId, intervalMinutes);
    return { intervalMinutes };
  }

  async listProjectForgePrMonitorConfigs(): Promise<ProjectForgePrMonitorConfig[]> {
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    const configs: ProjectForgePrMonitorConfig[] = [];

    for (const project of this.db.listProjects()) {
      if (project.kind !== "git") {
        continue;
      }
      const intervalMinutes = settings[project.id]?.intervalMinutes ?? 0;
      if (intervalMinutes <= 0) {
        continue;
      }
      const token = await this.secrets.readSecret(projectForgeTokenSecretKey(project.id));
      if (!token?.trim()) {
        continue;
      }
      try {
        const context = await this.resolveProjectPrReviewRemoteContext(project.id);
        configs.push({
          projectId: project.id,
          projectName: project.name,
          provider: context.provider,
          repoLabel: context.repoLabel,
          intervalMinutes,
        });
      } catch (error) {
        logWarn("Skipping PR/MR monitor for project with unresolved Git hosting context.", {
          projectId: project.id,
          projectName: project.name,
          error,
        });
      }
    }

    return configs;
  }

  async listProjectForgeRequests(
    projectId: string,
    input?: ListProjectForgeRequestsInput,
  ): Promise<ProjectForgeRequestsResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.listRequests(input);
  }

  async getProjectForgeRequestDetails(
    projectId: string,
    input: GetProjectForgeRequestDetailsInput,
  ): Promise<ProjectForgeRequestDetailsResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.getRequestDetails(input);
  }

  async postProjectPrMrReview(
    projectId: string,
    input: PostProjectPrMrReviewInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.postReview(input);
  }

  async submitProjectPrMrComments(
    projectId: string,
    input: SubmitProjectPrMrCommentsInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.submitComments(input);
  }

  async replyProjectPrMrReviewThread(
    projectId: string,
    input: ReplyProjectPrMrReviewThreadInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.replyToThread(input);
  }

  async resolveProjectPrMrReviewThread(
    projectId: string,
    input: ResolveProjectPrMrReviewThreadInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.resolveThread(input);
  }

  async analyzeProjectPrMrDiff(
    projectId: string,
    input: { prUrl: string; diff: string; modelId?: string },
  ): Promise<RunDiffReviewResult> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Pull and merge request review");
    let diff = input.diff.trim();
    if (!diff) {
      throw new Error("Load a PR/MR diff before running AI review.");
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for AI review - focus on highest-risk changes.]`;
    }
    const targetModelId = input.modelId?.trim();
    if (!targetModelId) {
      throw new Error("Select a model for PR/MR review.");
    }
    const context = await this.resolveModelInvocationContext(targetModelId);
    const prompt = this.buildPrMrDiffReviewPrompt(input.prUrl.trim() || "(unknown)", diff);

    try {
      const raw = await this.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You are a meticulous code reviewer. Return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_400,
        temperature: 0.2,
        usageProjectId: project.id,
      });

      return this.parseRunDiffReviewResult(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(["Could not review the PR/MR diff via the configured provider.", "Try again or switch models.", `Detail: ${msg}`].join(" "));
    }
  }

  private async resolveProjectPrReviewRemoteContext(projectId: string): Promise<ProjectPrReviewRemoteContext> {
    const project = this.db.getProject(projectId);
    this.requireGitProject(project, "Pull and merge request review");
    return resolveProjectPrReviewRemoteContext(project, this.gitService);
  }

  private async createProjectPrReviewProvider(projectId: string): Promise<ProjectPrReviewProvider> {
    const context = await this.resolveProjectPrReviewRemoteContext(projectId);
    const token = await this.requireProjectForgeToken(projectId);
    return createProjectPrReviewProvider(context, token);
  }

  private async requireProjectForgeToken(projectId: string): Promise<string> {
    const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
    if (!token?.trim()) {
      throw new Error("Add a Git hosting access token in Project Settings before fetching PRs/MRs.");
    }
    return token.trim();
  }

  private buildRunDiffReviewPrompt(run: RunRecord, diff: string): string {
    const goal =
      "Simulate a demanding teammate reviewing this diff before PR. Focus on the comments they would likely leave on correctness, maintainability, missing tests, and surprising design choices.";
    const scoreLabel = "PR readiness";
    return [
      goal,
      "",
      "Return JSON only with exactly this shape:",
      '{',
      '  "headline": "short sentence",',
      '  "summary": "2-4 sentence review summary",',
      `  "scoreLabel": "${scoreLabel}",`,
      '  "score": 0,',
      '  "strengths": ["short bullet"],',
      '  "findings": [',
      '    {',
      '      "title": "short finding title",',
      '      "priority": "high|medium|low",',
      '      "filePath": "relative/path/or/null",',
      '      "lineNumber": 123,',
      '      "lineReference": "optional line/hunk reference or null",',
      '      "detail": "why this matters",',
      '      "recommendation": "specific next step or null"',
      "    }",
      "  ],",
      '  "nextSteps": ["short actionable suggestion"]',
      "}",
      "",
      "Rules:",
      "- Prefer concrete, code-review style findings over vague advice.",
      "- Mention missing tests when appropriate.",
      "- Keep strengths honest and short.",
      "- Use relative repo paths when you can infer them from the diff.",
      "- Set lineNumber to the exact changed new-file line number when the finding points at a specific added/modified line. For deletion-only findings, use the old-file line number. Use null only for whole-file or class-level findings.",
      "- Keep lineReference human-readable, such as \"line 88\" or \"lines 88-91\".",
      "- Score 100 = reviewer is likely happy to approve; 70 = some comments but probably acceptable; 40 = likely change request territory; 0 = major blockers.",
      "",
      "Original task:",
      run.prompt || "(no prompt available)",
      "",
      "Git diff of current uncommitted changes in the run workspace (staged + unstaged + untracked as patches):",
      diff || "(empty diff)",
    ].join("\n");
  }

  private buildPrMrDiffReviewPrompt(prUrl: string, diff: string): string {
    const goal =
      "Simulate a demanding reviewer: list the comments they would likely leave on this PR/MR (correctness, maintainability, tests, API/design surprises).";
    const scoreLabel = "PR readiness";
    return [
      goal,
      "",
      "Return JSON only with exactly this shape:",
      "{",
      '  "headline": "short sentence",',
      '  "summary": "2-4 sentence review summary",',
      `  "scoreLabel": "${scoreLabel}",`,
      '  "score": 0,',
      '  "strengths": ["short bullet"],',
      '  "findings": [',
      "    {",
      '      "title": "short finding title",',
      '      "priority": "high|medium|low",',
      '      "filePath": "relative/path/or/null",',
      '      "lineNumber": 123,',
      '      "lineReference": "optional line/hunk reference or null",',
      '      "detail": "why this matters",',
      '      "recommendation": "specific next step or null"',
      "    }",
      "  ],",
      '  "nextSteps": ["short actionable suggestion"]',
      "}",
      "",
      "Rules:",
      "- Prefer concrete, code-review style findings over vague advice.",
      "- Mention missing tests when appropriate.",
      "- Keep strengths honest and short.",
      "- Use relative repo paths when you can infer them from the diff.",
      "- Set lineNumber to the exact changed new-file line number when the finding points at a specific added/modified line. For deletion-only findings, use the old-file line number. Use null only for whole-file or class-level findings.",
      "- Keep lineReference human-readable, such as \"line 88\" or \"lines 88-91\".",
      "- Score 100 = reviewer is likely happy to approve; 70 = some comments but probably acceptable; 40 = likely change request territory; 0 = major blockers.",
      "",
      "PR/MR URL:",
      prUrl || "(unknown)",
      "",
      "Git diff (merge base to PR/MR head, produced locally via git fetch):",
      diff || "(empty diff)",
    ].join("\n");
  }

  private parseRunDiffReviewResult(raw: string): RunDiffReviewResult {
    const normalized = normalizeJsonResponse(raw);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings: RunDiffReviewFinding[] = findingsRaw.map((entry) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      const priority = record.priority === "high" || record.priority === "medium" || record.priority === "low" ? record.priority : "medium";
      return {
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Review finding",
        priority,
        filePath: typeof record.filePath === "string" && record.filePath.trim() ? record.filePath.trim() : null,
        lineNumber: parseReviewLineNumber(record.lineNumber, record.lineReference),
        lineReference: typeof record.lineReference === "string" && record.lineReference.trim() ? record.lineReference.trim() : null,
        detail: typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : "The model did not provide details.",
        recommendation: typeof record.recommendation === "string" && record.recommendation.trim() ? record.recommendation.trim() : null,
      };
    });

    const strengths = Array.isArray(parsed.strengths)
      ? parsed.strengths.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const nextSteps = Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];

    const fallbackHeadline = "Reviewer simulation ready";
    let fallbackSummary = "No concrete findings were returned. Review the diff manually before committing.";
    if (findings.length > 0) {
      fallbackSummary = `Generated ${String(findings.length)} review finding${findings.length === 1 ? "" : "s"} from the current diff.`;
    }

    return {
      headline: typeof parsed.headline === "string" && parsed.headline.trim() ? parsed.headline.trim() : fallbackHeadline,
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallbackSummary,
      scoreLabel:
        typeof parsed.scoreLabel === "string" && parsed.scoreLabel.trim()
          ? parsed.scoreLabel.trim()
          : "PR readiness",
      score: clampReviewScore(parsed.score),
      strengths,
      findings,
      nextSteps,
      generatedAt: new Date().toISOString(),
    };
  }

  private async resolveModelInvocationContext(modelId: string): Promise<ModelInvocationContext> {
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);

    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider API key could not be resolved from secure storage.");
    }

    return {
      model,
      provider,
      apiKey: apiKey ?? "",
      providerConfig: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
      modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
      networkProxy: await this.resolveNetworkProxyRuntimeConfig(),
    };
  }

  private async askModelForText(
    cwd: string,
    context: ModelInvocationContext,
    input: {
      prompt: string;
      systemPrompt: string;
      maxTokens: number;
      temperature: number;
      usageProjectId?: string;
    },
  ): Promise<string> {
    const { model, provider, apiKey, providerConfig, modelConfig, networkProxy } = context;
    const settings = this.db.getSettings();
    const devLogging =
      settings[APP_SETTING_KEYS.enableDevMode] === "true"
        ? {
            logDirPath: this.logDirPath,
            runId: "ask-text",
            sessionType: "run" as const,
          }
        : undefined;
    if (devLogging) {
      mkdirSync(this.logDirPath, { recursive: true });
    }
    if (provider.providerType === "codex-cli") {
      const result = await generateAskTextResultWithCodexCli({
        cwd,
        prompt: input.prompt,
        modelId: model.modelId,
        config: providerConfig,
        modelConfig,
        networkProxy,
        devLogging,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "claude-code") {
      const result = await generateAskTextResultWithClaudeCode({
        cwd,
        prompt: [input.systemPrompt, input.prompt].filter((part) => part.trim()).join("\n\n"),
        modelId: model.modelId,
        config: providerConfig,
        networkProxy,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "cursor-agent") {
      const result = await generateAskTextResultWithCursorAgent({
        cwd,
        prompt: [input.systemPrompt, input.prompt].filter((part) => part.trim()).join("\n\n"),
        modelId: model.modelId,
        config: providerConfig,
        modelConfig,
        devLogging,
      });
      this.recordStandaloneModelUsage(input.usageProjectId, result.usage);
      return result.text.trim();
    }

    if (provider.providerType === "azure-legacy") {
      const baseURL = (model.baseUrlOverride ?? provider.apiBaseUrl)?.trim();
      if (!baseURL) {
        throw new Error("Azure Legacy requires a deployment base URL on the provider or model.");
      }
      const devLogger = createAzureLegacyDevLogger({
        logDirPath: devLogging?.logDirPath,
        runId: devLogging?.runId ?? "ask-text",
        providerType: provider.providerType,
        modelId: model.modelId,
        sessionType: devLogging?.sessionType ?? "run",
      });
      const client = createAzureLegacyClientFromParts(
        baseURL,
        apiKey,
        providerConfig,
        devLogger.enabled ? devLogger.createLoggedFetch() : undefined,
        networkProxy,
      );
      const completion = await client.chat.completions.create({
        model: model.modelId,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.prompt },
        ],
        max_completion_tokens: resolveAzureLegacyAskTextCompletionTokenLimit(model.modelId, input.maxTokens),
        temperature: input.temperature,
      });
      const choice = completion.choices[0];
      const text = extractChatCompletionText(choice?.message?.content);
      if (!text && choice?.finish_reason === "length") {
        throw new Error(
          "Azure Legacy returned an empty response after exhausting the completion token budget. Try a smaller diff or a model with lower reasoning effort.",
        );
      }
      this.recordStandaloneModelUsage(input.usageProjectId, usageFromChatCompletion(completion.usage));
      return text;
    }

    const result = await generateAskTextResultWithAiSdk({
      modelId: model.modelId,
      apiKey,
      apiBaseUrl: (model.baseUrlOverride ?? provider.apiBaseUrl)?.trim(),
      config: providerConfig,
      modelConfig,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      networkProxy,
      devLogging,
    });
    this.recordStandaloneModelUsage(input.usageProjectId, result.usage);
    return result.text.trim();
  }

  private recordStandaloneModelUsage(projectId: string | undefined, usage: RunTokenUsage): void {
    if (!projectId || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
      return;
    }
    this.db.incrementProjectTokenUsage(projectId, usage.inputTokens, usage.outputTokens);
  }

  private readDependencyGraphSnapshot(repoPath: string): DependencyGraphSnapshot {
    const sourceFiles = listDependencySourceFilesForProjectGraph(repoPath);
    logInfo("Collected dependency graph source files.", {
      repoPath,
      sourceFileCount: sourceFiles.length,
    });
    if (sourceFiles.length === 0) {
      this.logControllerWarn("No source files were found for dependency graph generation.", { repoPath });
    }
    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);
    logInfo("Built dependency graph snapshot.", {
      repoPath,
      moduleCount: snapshot.modules.length,
      dependencyEdgeCount: snapshot.modules.reduce((sum, module) => sum + module.dependencies.length, 0),
    });
    return snapshot;
  }

  private async readRecentCommitInfo(repoPath: string, limit: number): Promise<RepoCommitInfo[]> {
    let output: string;
    try {
      output = await readRecentCommitLog(repoPath, limit);
    } catch (error) {
      this.logControllerWarn("git log failed while collecting project insight commit history.", {
        repoPath,
        limit,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const commits = parseRecentCommitLog(output);
    logInfo("Collected recent commit info for project insight generation.", {
      repoPath,
      limit,
      commitCount: commits.length,
    });
    return commits;
  }

  private buildArchitectureGraphInsight(
    repoPath: string,
    dependencyGraph: DependencyGraphSnapshot,
    commits: RepoCommitInfo[],
  ): ArchitectureGraphInsightData {
    const moduleMetrics = this.buildModuleMetrics(dependencyGraph, commits);
    const topNodes = [...moduleMetrics.values()]
      .sort((left, right) => right.totalConnections - left.totalConnections || right.hotspotCommits - left.hotspotCommits)
      .slice(0, 14);
    const selectedIds = new Set(topNodes.map((node) => node.id));
    const nodes: ProjectInsightNode[] = topNodes.map((node) => ({
      id: node.id,
      label: node.label,
      path: node.path,
      group: node.group,
      metric: node.totalConnections,
      ownerLabel: node.ownerLabel,
    }));
    const edges: ProjectInsightEdge[] = [];
    for (const node of topNodes) {
      for (const [targetId, weight] of node.outbound.entries()) {
        if (selectedIds.has(targetId) && node.id !== targetId) {
          edges.push({ from: node.id, to: targetId, weight });
        }
      }
    }
    const mermaid = this.buildMermaidGraph("flowchart LR", nodes, edges, (node) => `${node.label}\\n${node.group}`);
    const hotspotMap = this.buildHotspotMap(commits);
    const hottest = [...hotspotMap.entries()]
      .sort((left, right) => right[1].commitCount - left[1].commitCount)
      .slice(0, 8)
      .map(([path, hotspot]) => ({
        path,
        label: this.compactLabel(path),
        commitCount: hotspot.commitCount,
        ownerLabel: hotspot.ownerLabel,
      }));
    const ownershipCounts = new Map<string, number>();
    for (const node of topNodes) {
      const owner = node.ownerLabel || "Unknown";
      ownershipCounts.set(owner, (ownershipCounts.get(owner) ?? 0) + 1);
    }
    return {
      generatedFromPath: repoPath,
      mermaid,
      nodes,
      edges,
      hotspots: hottest,
      ownership: [...ownershipCounts.entries()]
        .map(([ownerLabel, fileCount]) => ({ ownerLabel, fileCount }))
        .sort((left, right) => right.fileCount - left.fileCount),
    };
  }

  private buildDependencyGravityInsight(
    dependencyGraph: DependencyGraphSnapshot,
    commits: RepoCommitInfo[],
  ): DependencyGravityInsightData {
    const moduleMetrics = this.buildModuleMetrics(dependencyGraph, commits);
    const ranked = [...moduleMetrics.values()]
      .sort((left, right) => right.gravityScore - left.gravityScore || right.inbound - left.inbound)
      .slice(0, 12);
    const selectedIds = new Set(ranked.map((node) => node.id));
    const nodes = ranked.map((node) => ({
      id: node.id,
      label: node.label,
      path: node.path,
      group: node.group,
      metric: node.gravityScore,
      ownerLabel: node.ownerLabel,
      inbound: node.inbound,
      outbound: node.outbound.size,
      gravityScore: node.gravityScore,
    }));
    const edges: ProjectInsightEdge[] = [];
    for (const node of ranked) {
      for (const [targetId, weight] of node.outbound.entries()) {
        if (selectedIds.has(targetId) && node.id !== targetId) {
          edges.push({ from: node.id, to: targetId, weight });
        }
      }
    }
    const mermaid = this.buildMermaidGraph("flowchart TB", nodes, edges, (node) => `${node.label}\\nG:${String(node.metric)}`);
    const averageInbound =
      moduleMetrics.size === 0 ? 0 : Math.round(([...moduleMetrics.values()].reduce((sum, entry) => sum + entry.inbound, 0) / moduleMetrics.size) * 10) / 10;
    return {
      mermaid,
      nodes,
      edges,
      summaryStats: {
        totalModules: moduleMetrics.size,
        totalEdges: [...moduleMetrics.values()].reduce((sum, entry) => sum + entry.outbound.size, 0),
        averageInbound,
      },
    };
  }

  private buildNarrativeBranchingInsight(projectId: string): NarrativeBranchingInsightData {
    const runs = this.db.listRunsForProject(projectId);
    const branchMap = new Map<
      string,
      {
        branchName: string;
        runCount: number;
        statuses: Set<string>;
        latestRunId: string | null;
        latestUpdatedAt: string | null;
        prompts: string[];
      }
    >();

    const timeline = runs
      .map((run) => ({
        runId: run.id,
        branchName: run.branchName,
        status: run.status,
        createdAt: run.createdAt,
        title: run.prompt,
      }))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    for (const run of runs) {
      const existing =
        branchMap.get(run.branchName) ??
        {
          branchName: run.branchName,
          runCount: 0,
          statuses: new Set<string>(),
          latestRunId: null,
          latestUpdatedAt: null,
          prompts: [],
        };
      existing.runCount += 1;
      existing.statuses.add(run.status);
      if (!existing.latestUpdatedAt || new Date(run.updatedAt).getTime() > new Date(existing.latestUpdatedAt).getTime()) {
        existing.latestUpdatedAt = run.updatedAt;
        existing.latestRunId = run.id;
      }
      if (run.prompt.trim()) {
        existing.prompts.push(run.prompt.trim());
      }
      branchMap.set(run.branchName, existing);
    }

    return {
      branches: [...branchMap.values()]
        .map((branch) => ({
          branchName: branch.branchName,
          summary:
            branch.prompts[0] ??
            `Run branch ${branch.branchName} with ${String(branch.runCount)} recorded agent runs.`,
          runCount: branch.runCount,
          statuses: [...branch.statuses],
          latestRunId: branch.latestRunId,
          latestUpdatedAt: branch.latestUpdatedAt,
          prompts: branch.prompts.slice(0, 5),
        }))
        .sort((left, right) =>
          new Date(right.latestUpdatedAt ?? 0).getTime() - new Date(left.latestUpdatedAt ?? 0).getTime(),
        ),
      timeline,
    };
  }

  private buildProjectInsightPrompt(
    project: ProjectRecord,
    kind: ProjectInsightKind,
    context: {
      dependencyGraph: DependencyGraphSnapshot;
      commits: RepoCommitInfo[];
      runs: RunRecord[];
    },
  ): string {
    const dependencySummary = this.buildDependencySummaryText(project.repoPath, context.dependencyGraph, context.commits);
    const commitSummary = context.commits
      .slice(0, 18)
      .map((commit) => `- ${commit.date} ${commit.sha.slice(0, 7)} ${commit.author}: ${commit.title} (${commit.files.slice(0, 4).join(", ") || "no files"})`)
      .join("\n");
    const runSummary = context.runs
      .slice(0, 16)
      .map((run) => `- ${run.createdAt} [${run.status}] ${run.branchName}: ${run.prompt}`)
      .join("\n");

    if (kind === "repo-historian") {
      return [
        "Return JSON only with this exact shape:",
        '{ "title": "Repo historian", "summary": "short summary", "synopsis": "2-4 sentences", "sections": [{"title":"string","detail":"string"}], "notableCommits": [{"sha":"string","title":"string","author":"string","date":"string"}] }',
        "",
        "Task: explain why this subsystem/repo likely looks the way it does by reading the recent history and structural signals.",
        "Focus on architectural drift, repeated themes, and how the current shape may have emerged.",
        "",
        `Project: ${project.name}`,
        "Dependency summary:",
        dependencySummary,
        "",
        "Recent commits:",
        commitSummary || "(no recent commits found)",
        "",
        "Recent BuildWarden runs:",
        runSummary || "(no runs found)",
      ].join("\n");
    }

    if (kind === "codebase-mood") {
      return [
        "Return JSON only with this exact shape:",
        '{ "title": "Codebase mood", "summary": "short summary", "overallScore": 0, "posture": "string", "sections": [{"label":"string","score":0,"summary":"string"}], "findings": [{"title":"string","detail":"string","filePath":"string|null"}], "nextMoves": ["string"] }',
        "",
        "Task: assess whether this codebase feels brittle, overabstracted, under-tested, or inconsistent, and explain why.",
        "Use the provided dependency and history evidence. Be concrete and opinionated.",
        "",
        `Project: ${project.name}`,
        "Dependency summary:",
        dependencySummary,
        "",
        "Recent commits:",
        commitSummary || "(no recent commits found)",
      ].join("\n");
    }

    return [
      "Return JSON only with this exact shape:",
      '{ "title": "Curiosity mode", "summary": "short summary", "themes": [{"title":"string","whyItMatters":"string","evidence":["string"]}], "suggestedPrompts": ["string"] }',
      "",
      "Task: identify confusing, interesting, or potentially high-leverage areas worth exploring next in this repository.",
      "Surface surprising themes, hidden coupling, or unexplained design pockets.",
      "",
      `Project: ${project.name}`,
      "Dependency summary:",
      dependencySummary,
      "",
      "Recent commits:",
      commitSummary || "(no recent commits found)",
      "",
      "Recent BuildWarden runs:",
      runSummary || "(no runs found)",
    ].join("\n");
  }

  private parseProjectInsightAiResponse(
    kind: ProjectInsightKind,
    raw: string,
  ): { title: string; summary: string; data: ProjectInsightData } {
    const normalized = normalizeJsonResponse(raw).slice(0, MAX_PROJECT_INSIGHT_PROMPT_CHARS * 2);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (kind === "repo-historian") {
      const sections = Array.isArray(parsed.sections)
        ? parsed.sections.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }
            const record = entry as Record<string, unknown>;
            const title = typeof record.title === "string" ? record.title.trim() : "";
            const detail = typeof record.detail === "string" ? record.detail.trim() : "";
            return title && detail ? [{ title, detail }] : [];
          })
        : [];
      const notableCommits = Array.isArray(parsed.notableCommits)
        ? parsed.notableCommits.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }
            const record = entry as Record<string, unknown>;
            return [
              {
                sha: typeof record.sha === "string" ? record.sha.trim() : "",
                title: typeof record.title === "string" ? record.title.trim() : "",
                author: typeof record.author === "string" ? record.author.trim() : "",
                date: typeof record.date === "string" ? record.date.trim() : "",
              },
            ].filter((commit) => commit.sha && commit.title);
          })
        : [];
      return {
        title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Repo historian",
        summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "Repository history summary generated.",
        data: {
          synopsis: typeof parsed.synopsis === "string" && parsed.synopsis.trim() ? parsed.synopsis.trim() : "No synopsis returned.",
          sections,
          notableCommits,
        },
      };
    }

    if (kind === "codebase-mood") {
      const sections = Array.isArray(parsed.sections)
        ? parsed.sections.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }
            const record = entry as Record<string, unknown>;
            const label = typeof record.label === "string" ? record.label.trim() : "";
            const summary = typeof record.summary === "string" ? record.summary.trim() : "";
            return label && summary
              ? [{ label, score: clampReviewScore(record.score), summary }]
              : [];
          })
        : [];
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }
            const record = entry as Record<string, unknown>;
            const title = typeof record.title === "string" ? record.title.trim() : "";
            const detail = typeof record.detail === "string" ? record.detail.trim() : "";
            if (!title || !detail) {
              return [];
            }
            return [
              {
                title,
                detail,
                filePath: typeof record.filePath === "string" && record.filePath.trim() ? record.filePath.trim() : null,
              },
            ];
          })
        : [];
      const nextMoves = Array.isArray(parsed.nextMoves)
        ? parsed.nextMoves.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
        : [];
      return {
        title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Codebase mood",
        summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "Codebase mood generated.",
        data: {
          overallScore: clampReviewScore(parsed.overallScore),
          posture: typeof parsed.posture === "string" && parsed.posture.trim() ? parsed.posture.trim() : "Mixed",
          sections,
          findings,
          nextMoves,
        },
      };
    }

    const themes = Array.isArray(parsed.themes)
      ? parsed.themes.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }
          const record = entry as Record<string, unknown>;
          const title = typeof record.title === "string" ? record.title.trim() : "";
          const whyItMatters = typeof record.whyItMatters === "string" ? record.whyItMatters.trim() : "";
          const evidence = Array.isArray(record.evidence)
            ? record.evidence.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
            : [];
          return title && whyItMatters ? [{ title, whyItMatters, evidence }] : [];
        })
      : [];
    const suggestedPrompts = Array.isArray(parsed.suggestedPrompts)
      ? parsed.suggestedPrompts.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [];
    return {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Curiosity mode",
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "Curiosity scan generated.",
      data: {
        themes,
        suggestedPrompts,
      },
    };
  }

  private buildDependencySummaryText(repoPath: string, dependencyGraph: DependencyGraphSnapshot, commits: RepoCommitInfo[]): string {
    const gravity = this.buildDependencyGravityInsight(dependencyGraph, commits);
    const architecture = this.buildArchitectureGraphInsight(repoPath, dependencyGraph, commits);
    const topGravity = gravity.nodes
      .slice(0, 6)
      .map((node) => `- ${node.path} (gravity ${String(node.gravityScore)}, inbound ${String(node.inbound)}, outbound ${String(node.outbound)})`)
      .join("\n");
    const hotspots = architecture.hotspots
      .slice(0, 5)
      .map((item) => {
        const ownerSuffix = item.ownerLabel ? `, owner ${item.ownerLabel}` : "";
        return `- ${item.path} (${String(item.commitCount)} recent commits${ownerSuffix})`;
      })
      .join("\n");
    return [
      `Total modules: ${String(gravity.summaryStats.totalModules)}`,
      `Total edges: ${String(gravity.summaryStats.totalEdges)}`,
      `Average inbound references: ${String(gravity.summaryStats.averageInbound)}`,
      "Top dependency gravity:",
      topGravity || "- none",
      "Recent hotspots:",
      hotspots || "- none",
    ]
      .join("\n")
      .slice(0, MAX_PROJECT_INSIGHT_PROMPT_CHARS);
  }

  private buildModuleMetrics(dependencyGraph: DependencyGraphSnapshot, commits: RepoCommitInfo[]) {
    const hotspotMap = this.buildHotspotMap(commits);
    const metrics = new Map<
      string,
      {
        id: string;
        path: string;
        label: string;
        group: string;
        inbound: number;
        outbound: Map<string, number>;
        totalConnections: number;
        gravityScore: number;
        hotspotCommits: number;
        ownerLabel: string | null;
      }
    >();
    const ensureMetric = (path: string) => {
      const normalizedPath = normalizeProjectInsightRepoPath(path);
      const existing = metrics.get(normalizedPath);
      if (existing) {
        return existing;
      }
      const hotspot = hotspotMap.get(normalizedPath);
      const created = {
        id: normalizedPath.replace(/[^a-zA-Z0-9_-]/g, "_"),
        path: normalizedPath,
        label: this.compactLabel(normalizedPath),
        group: this.pathGroup(normalizedPath),
        inbound: 0,
        outbound: new Map<string, number>(),
        totalConnections: 0,
        gravityScore: 0,
        hotspotCommits: hotspot?.commitCount ?? 0,
        ownerLabel: hotspot?.ownerLabel ?? null,
      };
      metrics.set(normalizedPath, created);
      return created;
    };

    for (const module of dependencyGraph.modules) {
      const source = ensureMetric(module.source);
      for (const dependency of module.dependencies) {
        const resolved = dependency.resolved ? ensureMetric(dependency.resolved) : null;
        if (!resolved || resolved.path === source.path) {
          continue;
        }
        source.outbound.set(resolved.id, (source.outbound.get(resolved.id) ?? 0) + 1);
        resolved.inbound += 1;
      }
    }

    for (const metric of metrics.values()) {
      metric.totalConnections = metric.inbound + metric.outbound.size;
      metric.gravityScore = metric.inbound * 3 + metric.outbound.size + Math.min(metric.hotspotCommits, 12);
    }
    return metrics;
  }

  private buildHotspotMap(commits: RepoCommitInfo[]): Map<string, RepoFileHotspot> {
    const byFile = new Map<string, RepoFileHotspot & { ownerCounts: Map<string, number> }>();
    for (const commit of commits) {
      for (const file of commit.files) {
        const existing =
          byFile.get(file) ??
          {
            path: file,
            commitCount: 0,
            ownerLabel: null,
            ownerCounts: new Map<string, number>(),
          };
        existing.commitCount += 1;
        existing.ownerCounts.set(commit.author, (existing.ownerCounts.get(commit.author) ?? 0) + 1);
        byFile.set(file, existing);
      }
    }
    for (const entry of byFile.values()) {
      entry.ownerLabel =
        [...entry.ownerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
    }
    return new Map(
      [...byFile.entries()].map(([path, value]) => [
        path,
        {
          path,
          commitCount: value.commitCount,
          ownerLabel: value.ownerLabel,
        },
      ]),
    );
  }

  private buildMermaidGraph(
    direction: string,
    nodes: Array<{ id: string; label: string; group: string }>,
    edges: ProjectInsightEdge[],
    labelFactory: (node: { id: string; label: string; group: string; metric?: number }) => string,
  ): string {
    if (nodes.length === 0) {
      this.logControllerWarn("Mermaid graph generation received zero nodes.", {
        direction,
        edgeCount: edges.length,
      });
    }
    const lines = [direction];
    for (const node of nodes) {
      const safeLabel = labelFactory(node).replace(/"/g, "'");
      lines.push(`  ${node.id}["${safeLabel}"]`);
    }
    for (const edge of edges.slice(0, 28)) {
      const weightLabel = edge.weight > 1 ? `|${String(edge.weight)}|` : "";
      lines.push(`  ${edge.from} -->${weightLabel} ${edge.to}`);
    }
    return lines.join("\n");
  }

  private compactLabel(path: string): string {
    const normalized = normalizeProjectInsightRepoPath(path);
    const segments = normalized.split("/");
    return segments.length <= 2 ? normalized : `${segments[0]}/${segments[segments.length - 1]}`;
  }

  private pathGroup(path: string): string {
    const normalized = normalizeProjectInsightRepoPath(path);
    return normalized.split("/")[0] || "root";
  }

  async getRunPublishOptions(runId: string): Promise<{ defaultTargetBranch: string; defaultSourceBranch: string; defaultDescription: string; suggestedTitle: string; targetBranches: string[] }> {
    const run = this.db.getRun(runId);
    this.requireGitRun(run, "Publishing");
    const project = this.db.getProject(run.projectId);
    this.requireGitProject(project, "Publishing");

    const targetBranches = await this.gitService.listTargetBranches(run.worktreePath);
    const defaultTargetBranch =
      targetBranches.includes(project.baseBranch) ? project.baseBranch : (targetBranches[0] ?? project.baseBranch);
    const suggestedTitle = (await this.gitService.getLatestCommitMessage(run.worktreePath, run.branchName)) || this.buildRunCommitMessage(run.prompt);

    return {
      defaultTargetBranch,
      defaultSourceBranch: run.branchName,
      defaultDescription: this.buildRunPullRequestBody(project.name, run.prompt, defaultTargetBranch),
      suggestedTitle,
      targetBranches,
    };
  }

  async createRunPullRequest(
    runId: string,
    targetBranch: string,
    title: string,
    sourceBranchName?: string,
    description?: string,
  ): Promise<string> {
    let run = this.db.getRun(runId);
    this.requireGitRun(run, "Pull and merge request creation");
    const project = this.db.getProject(run.projectId);
    this.requireGitProject(project, "Pull and merge request creation");
    const trimmedTitle = title.trim();
    const trimmedTargetBranch = targetBranch.trim();
    const trimmedSourceBranch = sourceBranchName?.trim() || run.branchName;
    const createdCustomSourceBranch = trimmedSourceBranch !== run.branchName;
    const trimmedDescription = description?.trim() || this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch);

    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title.");
    }

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch.");
    }

    if (await this.gitService.hasChanges(run.worktreePath)) {
      throw new Error("Commit or discard open changes before creating a merge request or pull request.");
    }

    if (createdCustomSourceBranch) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedSourceBranch);
      run = this.db.updateRunBranchName(run.id, trimmedSourceBranch);
    }

    const result = await this.gitService.createPullRequest(
      run.worktreePath,
      trimmedSourceBranch,
      trimmedTargetBranch,
      trimmedTitle,
      trimmedDescription,
    );
    const url = result.url;
    const requestLabel = result.requestKind === "merge-request" ? "Merge request" : "Pull request";
    const eventTitle = result.mode === "created" ? `${requestLabel} created` : `${requestLabel} draft opened`;

    await this.appendRunEvent(run.id, "status", eventTitle, url, {
      targetBranch: trimmedTargetBranch,
      sourceBranch: trimmedSourceBranch,
      title: trimmedTitle,
      descriptionLength: trimmedDescription.length,
      url,
      mode: result.mode,
      promotedToProject: createdCustomSourceBranch,
    });
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: eventTitle,
      content: url,
      metadata: {
        targetBranch: trimmedTargetBranch,
        sourceBranch: trimmedSourceBranch,
        title: trimmedTitle,
        descriptionLength: trimmedDescription.length,
        url,
        mode: result.mode,
        promotedToProject: createdCustomSourceBranch,
      },
      createdAt: new Date().toISOString(),
    });
    this.markLinkedRunTaskInReview(run, url);

    if (createdCustomSourceBranch) {
      await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedSourceBranch);
    }

    const openResult = await this.desktop.openExternalUrl(url);
    if (!openResult.ok) {
      throw new Error(openResult.error ?? "Could not open the pull request URL.");
    }

    return url;
  }

  async suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string): Promise<string> {
    const run = this.db.getRun(runId);
    this.requireGitRun(run, "Pull and merge request description generation");
    const project = this.db.getProject(run.projectId);
    this.requireGitProject(project, "Pull and merge request description generation");
    const trimmedTargetBranch = targetBranch.trim();
    const trimmedTitle = title.trim();

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch before generating a description.");
    }

    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title before generating a description.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const diffOutcome = await runWorktreeDiffInWorker(run.worktreePath);
    if (!diffOutcome.ok) {
      throw new Error("Could not read the worktree diff.");
    }
    let diff = diffOutcome.diff;
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for MR/PR description generation.]`;
    }

    const context = await this.resolveModelInvocationContext(run.modelId);
    const defaultDescription = this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch);
    const prompt = [
      "Write a concise merge request / pull request description for these code changes.",
      "Use plain markdown only.",
      "Keep it practical and scannable.",
      "Prefer these sections when useful:",
      "## Summary",
      "## What Changed",
      "## Validation",
      "If validation is unknown, say so briefly instead of inventing it.",
      "Output only the final description body.",
      "",
      `Project: ${project.name}`,
      `Source branch: ${run.branchName}`,
      `Target branch: ${trimmedTargetBranch}`,
      `Title: ${trimmedTitle}`,
      "",
      "Original run prompt:",
      run.prompt || "(no prompt available)",
      "",
      "Current default description:",
      defaultDescription,
      "",
      "Git diff of current changes:",
      diff || "(empty diff)",
    ].join("\n");

    try {
      const text = await this.askModelForText(run.worktreePath, context, {
        prompt,
        systemPrompt: "You write strong engineering pull request descriptions. Output only the final markdown body.",
        maxTokens: 1_000,
        temperature: 0.2,
        usageProjectId: run.projectId,
      });
      const normalized = text.trim();
      if (!normalized) {
        throw new Error("The model returned an empty description.");
      }
      return normalized;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a merge request or pull request description. Detail: ${msg}`);
    }
  }

  async publishRunBranch(runId: string, branchName?: string): Promise<string> {
    let run = this.db.getRun(runId);
    this.requireGitRun(run, "Publishing");
    const project = this.db.getProject(run.projectId);
    this.requireGitProject(project, "Publishing");
    const trimmedBranchName = branchName?.trim() || run.branchName;
    const createdCustomBranch = trimmedBranchName !== run.branchName;

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }

    if (await this.gitService.hasChanges(run.worktreePath)) {
      throw new Error("Commit or discard open changes before publishing the branch.");
    }

    if (trimmedBranchName !== run.branchName) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
      run = this.db.updateRunBranchName(run.id, trimmedBranchName);
    }

    const result = await this.gitService.publishBranch(run.worktreePath, trimmedBranchName);
    if (createdCustomBranch) {
      await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName);
    }

    const content = createdCustomBranch
      ? `Published branch ${result.branchName} to ${result.remoteName}, checked it out in the project repository, and removed the run worktree.`
      : `Published branch ${result.branchName} to ${result.remoteName}.`;

    await this.appendRunEvent(run.id, "status", "Branch published", content, {
      branchName: result.branchName,
      remoteName: result.remoteName,
      promotedToProject: createdCustomBranch,
    });
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: "Branch published",
      content,
      metadata: {
        branchName: result.branchName,
        remoteName: result.remoteName,
        promotedToProject: createdCustomBranch,
      },
      createdAt: new Date().toISOString(),
    });
    this.markLinkedRunTaskInReview(run);

    return content;
  }

  async createRunLocalBranch(runId: string, branchName: string): Promise<string> {
    let run = this.db.getRun(runId);
    this.requireGitRun(run, "Local branch creation");
    const project = this.db.getProject(run.projectId);
    this.requireGitProject(project, "Local branch creation");
    const originalRunBranchName = run.branchName;
    const trimmedBranchName = branchName.trim();

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }

    const createsNewBranch = trimmedBranchName !== run.branchName;
    if (!createsNewBranch && run.workspaceType !== "worktree") {
      throw new Error("The new local branch must differ from the current worktree branch.");
    }

    const hasOpenChanges = await this.gitService.hasChanges(run.worktreePath);

    if (createsNewBranch) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
      run = this.db.updateRunBranchName(run.id, trimmedBranchName);
    }
    await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName, {
      transferOpenChanges: hasOpenChanges,
      deleteReleasedBranchName: createsNewBranch ? originalRunBranchName : undefined,
    });

    const content = hasOpenChanges
      ? `Created local branch ${trimmedBranchName}, moved the open changes to it in the project repository, and removed the run worktree.`
      : `Created local branch ${trimmedBranchName}, checked it out in the project repository, and removed the run worktree.`;
    await this.appendRunEvent(run.id, "status", "Local branch created", content, {
      branchName: trimmedBranchName,
      promotedToProject: true,
      transferredOpenChanges: hasOpenChanges,
    });
    this.emitEvent({
      runId: run.id,
      type: "status",
      title: "Local branch created",
      content,
      metadata: {
        branchName: trimmedBranchName,
        promotedToProject: true,
        transferredOpenChanges: hasOpenChanges,
      },
      createdAt: new Date().toISOString(),
    });

    return content;
  }

  async releaseRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);

    if (
      run.workspaceType === "worktree" &&
      this.isSettingEnabled(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, true) &&
      !ACTIVE_RUN_STATUSES.has(run.status)
    ) {
      if (existsSync(run.worktreePath) && (await this.gitService.hasWorktreeGitMetadata(run.worktreePath))) {
        try {
          await this.gitService.releaseWorktreeBranch(run.worktreePath, run.branchName);
          this.updateWorktreeStatus(run, "released");
        } catch (error) {
          throw new Error(
            [
              `BuildWarden could not release the run branch "${run.branchName}" from its worktree.`,
              "Close file locks in other tools or open the run worktree folder directly instead.",
              "",
              `Original error: ${error instanceof Error ? error.message : String(error)}`,
            ].join("\n"),
          );
        }
      } else {
        this.updateWorktreeStatus(run, "released");
      }
    }

    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.deleteSetting(SELECTED_RUN_KEY);
  }

  async setAppSetting(key: string, value: string): Promise<void> {
    if (key === APP_SETTING_KEYS.worktreeRootOverride) {
      const trimmed = value.trim();
      if (!trimmed) {
        this.db.setSetting(key, "");
        return;
      }
      if (!isAbsolute(trimmed)) {
        throw new Error("Custom managed workspace folder must be an absolute path.");
      }
      if (existsSync(trimmed) && !statSync(trimmed).isDirectory()) {
        throw new Error("Custom managed workspace folder must point to a directory.");
      }
      this.db.setSetting(key, trimmed);
      return;
    }
    this.db.setSetting(key, value);
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId);

    // Loops first: this cancels their timers/runs and removes loop rows, runs, and stored screenshots.
    for (const loop of this.db.listProjectLoops(projectId)) {
      try {
        await this.loopRunner.deleteLoop(loop.id);
      } catch (loopError) {
        this.logControllerWarn("Could not delete a project loop while deleting the project.", { projectId, loopId: loop.id, error: loopError });
      }
    }

    const runs = this.db.listRunsForProject(projectId);
    for (const run of runs) {
      this.terminal.killForRunId(run.id);
      this.clearRunCheckpoint(run.id);
      this.clearRunPromptRestorePoint(run.id);
      this.db.deleteProviderSessionRuntime(run.id, "run");
      await this.deleteRunResources(project.repoPath, run, "project");
    }

    await this.secrets.deleteSecret(projectForgeTokenSecretKey(projectId));
    this.setProjectForgePrMonitorInterval(projectId, 0);
    this.db.deleteProject(projectId);

    const remainingProjects = this.db.listProjects();
    if (remainingProjects.length > 0) {
      this.db.setSetting(SELECTED_PROJECT_KEY, remainingProjects[0].id);
    } else {
      this.db.deleteSetting(SELECTED_PROJECT_KEY);
    }
    this.db.deleteSetting(SELECTED_RUN_KEY);
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const providerRecoverySupported = providerSupportsInterruptedRunRecovery(provider.providerType);
    const branchPromotedToProject = this.wasRunPromotedToProject(runId);
    const workspacePath = this.getEffectiveRunWorkspacePath(run, project);
    const checkpoint = this.getRunCheckpoint(runId);
    const promptRestorePoint = this.getRunPromptRestorePoint(runId);
    const detail = this.db.getRunDetail(runId, "");
    const providerRuntime = this.db.getProviderSessionRuntime(runId, "run");
    const { latestInterruptedAt, latestRecoveryAt } = findInterruptionTimestamps(detail.steps);
    const sessionInterrupted = Boolean(latestInterruptedAt) && latestInterruptedAt > latestRecoveryAt;
    const providerSessionAvailable = Boolean(providerRuntime?.resumeCursor);
    const canRecoverInterruptedSession =
      providerRecoverySupported && sessionInterrupted && !this.runWorkers.has(runId) && (Boolean(checkpoint) || providerSessionAvailable);
    const recoveryKind = resolveRecoveryKind(true, Boolean(checkpoint), providerSessionAvailable);
    return {
      ...detail,
      workspacePath,
      branchPromotedToProject,
      diffPending: true,
      worktreeUnavailable: false,
      latestCheckpoint: checkpoint ? { round: checkpoint.round, memo: checkpoint.memo } : null,
      canResumeFromCheckpoint: Boolean(checkpoint) && !this.runWorkers.has(runId),
      canRecoverInterruptedSession,
      interruptedRecovery: sessionInterrupted && providerRecoverySupported
        ? {
            available: canRecoverInterruptedSession,
            kind: recoveryKind ?? "provider-session",
            title: canRecoverInterruptedSession ? "Recovery path available" : "Session interrupted",
            detail: describeInterruptedRecoveryDetail(Boolean(checkpoint), providerSessionAvailable),
            providerType: providerRuntime?.providerType,
            checkpointRound: checkpoint?.round,
            providerSessionAvailable,
          }
        : null,
      latestPromptRestorePoint: promptRestorePoint
        ? { createdAt: promptRestorePoint.createdAt, commandType: promptRestorePoint.commandType }
        : null,
    };
  }

  async addRunNote(runId: string, input: { content: string }): Promise<RunNoteRecord> {
    return this.db.addRunNote(runId, input.content);
  }

  async updateRunNote(noteId: string, input: UpdateRunNoteInput): Promise<RunNoteRecord> {
    return this.db.updateRunNote(noteId, input);
  }

  async deleteRunNote(noteId: string): Promise<void> {
    this.db.deleteRunNote(noteId);
  }

  async getRunWorkspaceFile(input: RunWorkspaceFileInput): Promise<RunWorkspaceFileResult> {
    const run = this.db.getRun(input.runId);
    const project = this.db.getProject(run.projectId);
    const workspacePath = this.getEffectiveRunWorkspacePath(run, project);
    const requestedPath = typeof input.path === "string" ? input.path : "";

    try {
      return await readRunWorkspaceFileForPreview({ workspacePath, requestedPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read file.";
      this.logControllerWarn("Could not read run workspace file.", { runId: run.id, path: requestedPath, error: message });
      return {
        path: requestedPath,
        requestedPath,
        workspacePath,
        content: null,
        sizeBytes: null,
        truncated: false,
        line: null,
        column: null,
        unavailableReason: "read-error",
        error: message,
      };
    }
  }

  async getRunWorktreeDiff(runId: string): Promise<RunWorktreeDiffResult> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    if (run.workspaceVcs === "folder") {
      if (!existsSync(run.worktreePath) || !statSync(run.worktreePath).isDirectory()) {
        return {
          diff: "",
          worktreeUnavailable: true,
          diffUnavailableReason: "The folder workspace is no longer available.",
        };
      }
      const outcome = await diffFolderAgainstSnapshot({
        runId: run.id,
        workspacePath: run.worktreePath,
        snapshotsRoot: this.getFolderSnapshotRoot(),
      });
      return {
        diff: outcome.diff,
        worktreeUnavailable: outcome.missingSnapshot,
        diffUnavailableReason: outcome.missingSnapshot ? "No folder baseline snapshot is available for this run." : null,
      };
    }

    const diffPath = this.getEffectiveRunWorkspacePath(run, project);
    const outcome = await runWorktreeDiffInWorker(diffPath);
    if (!outcome.ok) {
      return { diff: "", worktreeUnavailable: true, diffUnavailableReason: "The Git workspace is no longer available." };
    }
    return { diff: outcome.diff, worktreeUnavailable: false };
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.runWorkers.get(runId);

    if (!active) {
      return;
    }

    active.cancelled = true;
    active.worker.postMessage({ type: "cancel" });
    this.db.updateRunStatus(runId, "cancelled", { errorMessage: "Run cancelled by user." });
    await this.appendRunEvent(runId, "status", "Run cancelled", "Cancellation requested.");
    const run = this.db.getRun(runId);
    if (run.kind === "lab-implementation") {
      this.cancelProjectLabImplementation(run, "The implementation run was cancelled by the user.");
    }
    if (run.kind === "loop-iteration") {
      const iteration = this.db.getProjectLoopIterationByRunId(runId);
      if (iteration) {
        // Cancelling a loop's implementation run means stopping the whole loop.
        await this.loopRunner.cancelLoop(iteration.loopId).catch((error) => {
          this.logControllerError("Could not cancel the loop after its run was cancelled.", error, { runId, loopId: iteration.loopId });
        });
      }
    }
    this.emitEvent({
      runId,
      type: "status",
      title: "Run cancelled",
      content: "Cancellation requested.",
      createdAt: new Date().toISOString(),
    });
  }

  async cancelRunShell(runId: string, toolCallId: string): Promise<void> {
    const active = this.runWorkers.get(runId);
    if (!active) {
      return;
    }

    active.worker.postMessage({ type: "cancel-shell", callId: toolCallId });
  }

  async deleteRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);

    this.terminal.killForRunId(runId);
    this.clearRunCheckpoint(runId);
    this.clearRunPromptRestorePoint(runId);
    this.db.deleteProviderSessionRuntime(runId, "run");
    for (const runChat of this.db.getChatsForRun(runId)) {
      const activeChat = this.chatWorkers.get(runChat.id);
      if (activeChat) {
        activeChat.cancelled = true;
        activeChat.worker.postMessage({ type: "cancel" });
        this.chatWorkers.delete(runChat.id);
        await activeChat.worker.terminate();
      }
      this.db.deleteProviderSessionRuntime(runChat.id, "chat");
    }
    await this.deleteRunResources(project.repoPath, run, "run");
    this.db.deleteRun(runId);
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
  }

  async pickProjectDirectory(): Promise<string | null> {
    return this.desktop.pickProjectDirectory();
  }

  async openPathInFileManager(dirPath: string): Promise<OpenPathInFileManagerResult> {
    return this.desktop.openPathInFileManager(dirPath);
  }

  async resumeRunFromCheckpoint(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (this.runWorkers.has(runId)) {
      throw new Error("This run is already active.");
    }
    const resumed = await this.resumeInterruptedRunFromCheckpoint(run);
    if (!resumed) {
      throw new Error("No resumable checkpoint is available for this run.");
    }
  }

  async recoverInterruptedRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (this.runWorkers.has(runId)) {
      throw new Error("This run is already active.");
    }

    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    if (!providerSupportsInterruptedRunRecovery(provider.providerType)) {
      throw new Error("Interrupted-session recovery is only available for Codex CLI, Claude Code, and Cursor Agent runs.");
    }

    if (await this.resumeInterruptedRunFromCheckpoint(run, "manual")) {
      return;
    }

    const providerRuntime = this.db.getProviderSessionRuntime(run.id, "run");
    if (!providerRuntime?.resumeCursor) {
      throw new Error("No provider session or checkpoint is available for this interrupted run.");
    }

    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      throw new Error("The provider credentials are not available.");
    }

    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.appendRunEvent(
      run.id,
      "status",
      "Recovery confirmed",
      "Starting a new turn with the saved provider session and current workspace state.",
      { recoveredInterruptedSession: true, recoveryKind: "provider-session" },
    );

    const worker = this.startWorker(run, provider, model, apiKey ?? "", await this.resolveNetworkProxyRuntimeConfig(), {
      promptOverride: this.buildInterruptedRunRecoveryPrompt(run),
      skillContext: this.buildIntegratedSkillContext(run.projectId),
    });
    this.runWorkers.set(run.id, { worker, cancelled: false });
  }

  async undoRunToLastPrompt(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    this.requireGitRun(run, "Undo to last prompt");
    if (this.runWorkers.has(runId)) {
      throw new Error("Wait for the active run to finish before undoing changes.");
    }
    const restorePoint = this.getRunPromptRestorePoint(runId);
    if (!restorePoint) {
      throw new Error("No prompt restore point is available for this run.");
    }
    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    await this.gitService.restorePromptRestorePatch(run.worktreePath, restorePoint.patch);
    this.clearRunCheckpoint(runId);

    const description =
      restorePoint.commandType === "follow-up"
        ? "Restored the run worktree to the state before the latest follow-up prompt."
        : "Restored the run worktree to the state before the initial prompt.";
    await this.appendRunEvent(runId, "status", "Changes undone to last prompt", description, {
      undoneToLastPrompt: true,
      commandType: restorePoint.commandType,
      restorePointCreatedAt: restorePoint.createdAt,
    });
    this.emitEvent({
      runId,
      type: "status",
      title: "Changes undone to last prompt",
      content: description,
      metadata: {
        undoneToLastPrompt: true,
        commandType: restorePoint.commandType,
        restorePointCreatedAt: restorePoint.createdAt,
      },
      createdAt: new Date().toISOString(),
    });
  }

  async getAppPaths(): Promise<AppPathsInfo> {
    mkdirSync(this.logDirPath, { recursive: true });
    return {
      logDirPath: this.logDirPath,
      logDirectorySize: this.calculateDirectorySize(this.logDirPath),
    };
  }

  private calculateDirectorySize(dirPath: string): AppLogDirectorySizeInfo {
    let totalBytes = 0;
    let fileCount = 0;
    let unreadableEntryCount = 0;
    const pendingDirs = [dirPath];

    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        unreadableEntryCount += 1;
        continue;
      }

      for (const entry of entries) {
        const measured = measureDirectoryEntry(currentDir, entry, pendingDirs);
        totalBytes += measured.bytes;
        fileCount += measured.files;
        unreadableEntryCount += measured.unreadable;
      }
    }

    return { totalBytes, fileCount, unreadableEntryCount };
  }

  /**
   * Resolve a binary on PATH without blocking the main-process event loop.
   * PATH misses on Windows (`where.exe`) can take hundreds of milliseconds,
   * and the renderer triggers these lookups right at startup.
   */
  private lookupBinaryOnPath(commands: Array<{ file: string; args: string[] }>, label: string): Promise<string | null> {
    const tryCommand = (command: { file: string; args: string[] }): Promise<string | null> =>
      new Promise((resolve) => {
        try {
          const child = spawn(command.file, command.args, { windowsHide: true, timeout: 3_000 });
          let stdout = "";
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.on("error", () => resolve(null));
          child.on("close", (code) => {
            if (code !== 0) {
              resolve(null);
              return;
            }
            resolve(firstNonEmptyLine(stdout));
          });
        } catch {
          this.logControllerWarn(`${label} detection strategy failed; continuing to next lookup.`, {
            command: command.file,
            args: command.args,
          });
          resolve(null);
        }
      });

    return commands.reduce<Promise<string | null>>(
      (previous, command) => previous.then((found) => (found ? found : tryCommand(command))),
      Promise.resolve(null),
    );
  }

  private detectedCodexInstallation: Promise<{ binaryPath: string | null }> | null = null;
  private detectedClaudeInstallation: Promise<{ binaryPath: string | null }> | null = null;
  private detectedCursorInstallation: Promise<{ binaryPath: string | null; message?: string }> | null = null;

  getDetectedCodexInstallation(): Promise<{ binaryPath: string | null }> {
    this.detectedCodexInstallation ??= (async () => {
      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["codex.cmd"] },
              { file: "where.exe", args: ["codex.exe"] },
              { file: "where.exe", args: ["codex"] },
            ]
          : [{ file: "which", args: ["codex"] }];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Codex");
      if (binaryPath === null) {
        // Do not cache misses; the user may install the CLI while the app runs.
        this.detectedCodexInstallation = null;
      }
      return { binaryPath };
    })();
    return this.detectedCodexInstallation ?? Promise.resolve({ binaryPath: null });
  }

  getDetectedClaudeInstallation(): Promise<{ binaryPath: string | null }> {
    this.detectedClaudeInstallation ??= (async () => {
      if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE;
        const nativeInstallerPath = userProfile ? join(userProfile, ".local", "bin", "claude.exe") : null;
        if (nativeInstallerPath && existsSync(nativeInstallerPath)) {
          return { binaryPath: nativeInstallerPath };
        }
      }

      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["claude.cmd"] },
              { file: "where.exe", args: ["claude.exe"] },
              { file: "where.exe", args: ["claude"] },
            ]
          : [{ file: "which", args: ["claude"] }];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Claude Code");
      if (binaryPath === null) {
        this.detectedClaudeInstallation = null;
      }
      return { binaryPath };
    })();
    return this.detectedClaudeInstallation ?? Promise.resolve({ binaryPath: null });
  }

  getDetectedCursorInstallation(): Promise<{ binaryPath: string | null; message?: string }> {
    this.detectedCursorInstallation ??= (async () => {
      const nativePath = getCursorAgentBinaryPathCandidates().find((candidate) => existsSync(candidate));
      if (nativePath) {
        return { binaryPath: nativePath };
      }

      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["agent.cmd"] },
              { file: "where.exe", args: ["agent.exe"] },
              { file: "where.exe", args: ["agent"] },
              { file: "where.exe", args: ["cursor-agent.cmd"] },
              { file: "where.exe", args: ["cursor-agent.exe"] },
              { file: "where.exe", args: ["cursor-agent"] },
            ]
          : [
              { file: "which", args: ["agent"] },
              { file: "which", args: ["cursor-agent"] },
            ];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Cursor Agent");
      if (binaryPath === null) {
        this.detectedCursorInstallation = null;
      }
      if (binaryPath) {
        return { binaryPath };
      }

      const cursorDesktopPath =
        process.platform === "win32" && process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")
          : null;
      if (cursorDesktopPath && existsSync(cursorDesktopPath)) {
        return {
          binaryPath: null,
          message:
            "Cursor desktop is installed, but the Cursor Agent CLI was not found. Install or expose `agent`/`cursor-agent` on PATH, then run `agent login` and `agent about`.",
        };
      }
      return {
        binaryPath: null,
        message: "Cursor Agent CLI was not found. Install Cursor CLI and ensure `agent about` or `cursor-agent about` works.",
      };
    })();
    return this.detectedCursorInstallation ?? Promise.resolve({ binaryPath: null });
  }

  listIntegratedSkills(): Promise<IntegratedSkillMetadata[]> {
    const seen = new Set<string>();
    const metadata = INTEGRATED_SKILLS_CATALOG.filter((skill) => {
      const dedupeKey = `${skill.source}:${skill.name}`;
      if (seen.has(dedupeKey)) {
        return false;
      }
      seen.add(dedupeKey);
      return true;
    }).map((skill) => ({
      id: skill.id,
      source: skill.source,
      category: skill.category,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      license: skill.license,
      relativeDir: skill.relativeDir,
      sourceUrl: skill.sourceUrl,
    }));
    return Promise.resolve(metadata);
  }

  getIntegratedSkillContent(skillId: string): Promise<string | null> {
    return Promise.resolve(INTEGRATED_SKILLS_BY_ID[skillId]?.content ?? null);
  }

  async pickIdeExecutable(): Promise<string | null> {
    return this.desktop.pickIdeExecutable();
  }

  async openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind): Promise<void> {
    const run = this.db.getRun(runId);
    const folderPath = run.worktreePath?.trim() ?? "";
    if (!folderPath) {
      throw new Error("This run has no workspace path.");
    }
    await this.openFolderInIde(folderPath, ideKind);
  }

  async openFolderInIde(folderPath: string, ideKind: SupportedIdeKind): Promise<void> {
    const trimmedPath = folderPath.trim();
    if (!trimmedPath) {
      throw new Error("No folder path was provided.");
    }
    try {
      if (!existsSync(trimmedPath) || !statSync(trimmedPath).isDirectory()) {
        throw new Error("The folder is not available on disk.");
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Could not access the folder.");
    }

    const settings = this.db.getSettings();
    const raw = settings[APP_SETTING_KEYS.idePaths];
    const config = parseIdePathConfig(typeof raw === "string" ? raw : undefined);
    const exe = config[ideKind]?.trim();
    if (!exe) {
      throw new Error(`${IDE_KIND_LABELS[ideKind]} is not configured. Add its path in Settings > User Settings.`);
    }

    await this.desktop.launchIdeWithFolder(exe, trimmedPath);
  }

  async respondToShellApproval(
    runId: string,
    requestId: string,
    decision: ShellApprovalDecision,
    options?: ShellApprovalRespondOptions,
  ): Promise<void> {
    const active = this.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    if (decision === "allow-always") {
      const cmd = options?.command?.trim();
      if (!cmd) {
        throw new Error('A command is required when choosing "always allow" (save to settings).');
      }
      const pattern = commandToExactShellPatternSource(cmd);
      const list = parseShellAllowlistExtraSetting(this.db.getSettings()[APP_SETTING_KEYS.shellAllowlistExtra]);
      if (!list.includes(pattern)) {
        list.push(pattern);
        this.db.setSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(list));
      }
    }

    active.worker.postMessage({
      type: "shell-approval-response",
      requestId,
      decision,
    });

    const { title, content } = SHELL_APPROVAL_DECISION_MESSAGES[decision] ?? SHELL_APPROVAL_DECISION_MESSAGES["allow-once"];

    const metadata = {
      requestKind: "approval",
      requestStatus: "resolved",
      shellApprovalDecision: decision,
      approvalRequestId: requestId,
      approvalResolutionMessage: content,
    };
    const approvalStepId = this.runShellApprovalStepIds.get(this.shellApprovalStepKey(runId, requestId));
    if (approvalStepId) {
      this.db.updateRunStep(approvalStepId, {
        title,
        metadataJson: JSON.stringify(metadata),
      });
      this.runShellApprovalStepIds.delete(this.shellApprovalStepKey(runId, requestId));
    } else {
      await this.appendRunEvent(runId, "approval-resolved", title, content, metadata);
    }
    this.emitEvent({
      runId,
      type: "approval-resolved",
      title,
      content,
      metadata: {
        requestKind: "approval",
        requestStatus: "resolved",
        shellApprovalDecision: decision,
        approvalRequestId: requestId,
        approvalResolutionMessage: content,
      },
      createdAt: new Date().toISOString(),
    });
  }

  async respondToRunUserInput(runId: string, requestId: string, answers: RunUserInputAnswers): Promise<void> {
    const active = this.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    active.worker.postMessage({
      type: "user-input-response",
      requestId,
      answers,
    });

    const content = this.formatRunUserInputAnswers(answers);
    const metadata = {
      requestKind: "user-input",
      requestStatus: "resolved",
      userInputRequestId: requestId,
      userInputAnswers: answers,
    };
    const stepKey = this.userInputStepKey(runId, requestId);
    const stepId = this.runUserInputStepIds.get(stepKey);
    if (stepId) {
      let existingMetadata: Record<string, unknown> = {};
      try {
        existingMetadata = JSON.parse(this.db.getRunSteps(runId).find((step) => step.id === stepId)?.metadataJson || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        /* keep response metadata even if the stored request metadata is malformed */
      }
      this.db.updateRunStep(stepId, {
        title: "User input submitted",
        metadataJson: JSON.stringify({
          ...existingMetadata,
          ...metadata,
        }),
      });
      this.runUserInputStepIds.delete(stepKey);
    } else {
      await this.appendRunEvent(runId, "user-input-requested", "User input submitted", content, metadata);
    }
    this.emitEvent({
      runId,
      type: "user-input-requested",
      title: "User input submitted",
      content,
      metadata,
      createdAt: new Date().toISOString(),
    });
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    return this.events.subscribe("run", listener);
  }

  onAppWarning(listener: (warning: AppWarning) => void): () => void {
    return this.events.subscribe("warning", listener);
  }

  private startWorker(
    run: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    options?: {
      promptOverride?: string;
      attachments?: ChatAttachmentPayload[];
      skillContext?: string;
      providerOptions?: { reasoningEffort?: string; anthropicEffort?: string };
      yoloMode?: boolean;
    },
  ): Worker {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
    const streamingStepIds = new Map<string, string>();
    const streamingStepKinds = new Map<string, "assistant" | "reasoning" | "tool-result" | "tool-progress">();
    const resetNarrationStreams = () => {
      for (const [streamId, kind] of streamingStepKinds.entries()) {
        if (kind === "assistant" || kind === "reasoning") {
          streamingStepKinds.delete(streamId);
          streamingStepIds.delete(streamId);
        }
      }
    };
    const settings = this.db.getSettings();
    const shellAllowlistExtra = parseShellAllowlistExtraSetting(settings[APP_SETTING_KEYS.shellAllowlistExtra]);
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.logDirPath, { recursive: true });
    }

    const worker = new Worker(workerPath, {
      workerData: {
        request: {
          runId: run.id,
          worktreePath: run.worktreePath,
          workspaceVcs: run.workspaceVcs,
          mode: run.mode,
          yoloMode: options?.yoloMode === true,
          prompt: options?.promptOverride ?? run.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: run.lastProviderResponseId,
          providerSessionRuntime: this.db.getProviderSessionRuntime(run.id, "run"),
          priorMessages: this.buildPriorRunMessagesFromSteps(run.id),
          ...(options?.skillContext ? { skillContext: options.skillContext } : {}),
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          providerOptions: options?.providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          shellAllowlistExtra,
          resumeCheckpoint: this.getRunCheckpoint(run.id),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.logDirPath } } : {}),
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        },
      },
    });

    this.db.updateRunStatus(run.id, "running");
    this.updateWorktreeStatus(run, "busy");

    worker.on("message", async (message: unknown) => {
      const payload = message as
        | { type: "chunk"; chunk: { type: string; value: string; title?: string; metadata?: Record<string, unknown> } }
        | { type: "done"; result: WorkerDoneResult }
        | { type: "shell-approval-request"; requestId: string; command: string }
        | {
            type: "user-input-request";
            requestId: string;
            title?: string;
            content?: string;
            questions?: RunUserInputQuestion[];
            metadata?: Record<string, unknown>;
          }
        | { type: "error"; error: string };

      if (payload.type === "shell-approval-request") {
        const step = await this.appendRunEvent(
          run.id,
          "approval-requested",
          "Shell approval requested",
          payload.command,
          {
            requestKind: "approval",
            requestStatus: "opened",
            approvalRequestId: payload.requestId,
            shellApprovalRequest: true,
            command: payload.command,
          },
        );
        this.runShellApprovalStepIds.set(this.shellApprovalStepKey(run.id, payload.requestId), step.id);
        this.emitEvent({
          runId: run.id,
          type: "approval-requested",
          title: "Shell approval requested",
          content: payload.command,
          metadata: {
            requestKind: "approval",
            requestStatus: "opened",
            approvalRequestId: payload.requestId,
            shellApprovalRequest: true,
            command: payload.command,
          },
          createdAt: new Date().toISOString(),
        });
        return;
      }

      if (payload.type === "user-input-request") {
        const questions = Array.isArray(payload.questions) ? payload.questions : [];
        const content =
          payload.content?.trim() ||
          this.formatRunUserInputQuestions(questions) ||
          "The provider requested more input before it can continue.";
        const metadata = {
          ...(payload.metadata ?? {}),
          requestKind: "user-input",
          requestStatus: "opened",
          userInputRequest: true,
          userInputRequestId: payload.requestId,
          requestId: payload.requestId,
          userInputQuestions: questions,
        };
        const step = await this.appendRunEvent(
          run.id,
          "user-input-requested",
          payload.title?.trim() || "User input requested",
          content,
          metadata,
        );
        this.runUserInputStepIds.set(this.userInputStepKey(run.id, payload.requestId), step.id);
        this.emitEvent({
          runId: run.id,
          type: "user-input-requested",
          title: payload.title?.trim() || "User input requested",
          content,
          metadata,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      if (payload.type === "chunk") {
        const eventType = runChunkEventType(payload.chunk.type);
        const usageTotals =
          typeof payload.chunk.metadata?.usageTotals === "object" && payload.chunk.metadata?.usageTotals
            ? (payload.chunk.metadata.usageTotals as Partial<RunTokenUsage>)
            : null;
        if (usageTotals) {
          const currentRun = this.db.getRun(run.id);
          const nextInputTokens = Math.max(currentRun.inputTokens, Number(usageTotals.inputTokens ?? 0));
          const nextOutputTokens = Math.max(currentRun.outputTokens, Number(usageTotals.outputTokens ?? 0));
          this.db.incrementProjectTokenUsage(
            run.projectId,
            nextInputTokens - currentRun.inputTokens,
            nextOutputTokens - currentRun.outputTokens,
          );
          this.db.updateRunStatus(run.id, currentRun.status, {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
          });
        }

        if (payload.chunk.metadata?.providerSessionRuntime) {
          this.upsertProviderSessionRuntime(
            "run",
            run.id,
            provider,
            model.modelId,
            payload.chunk.metadata.providerSessionRuntime as Omit<
              ProviderSessionRuntimeInput,
              "ownerId" | "ownerKind" | "providerType" | "harnessType"
            >,
          );
        }

        const streamId =
          typeof payload.chunk.metadata?.streamId === "string" ? payload.chunk.metadata.streamId : null;
        const shouldReplace =
          payload.chunk.metadata?.replace === true &&
          streamId &&
          (payload.chunk.type === "message" ||
            payload.chunk.type === "tool-result" ||
            payload.chunk.type === "tool-progress" ||
            payload.chunk.type === "plan-updated" ||
            payload.chunk.type === "plan-progress");
        const silent = payload.chunk.metadata?.silent === true;
        const checkpoint =
          payload.chunk.metadata?.checkpoint === true &&
          typeof payload.chunk.metadata?.resumeCheckpoint === "object" &&
          payload.chunk.metadata?.resumeCheckpoint
            ? {
                ...(payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint),
                round: Number((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).round ?? 0),
                memo:
                  typeof (payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo === "string"
                    ? ((payload.chunk.metadata.resumeCheckpoint as RunResumeCheckpoint).memo ?? "")
                    : "",
              }
            : null;

        if (checkpoint) {
          this.setRunCheckpoint(run.id, checkpoint);
        }

        if (silent) {
          this.emitEvent({
            runId: run.id,
            type: eventType,
            title: payload.chunk.title ?? this.defaultRunEventTitle(eventType),
            content: payload.chunk.value,
            metadata: payload.chunk.metadata,
            createdAt: new Date().toISOString(),
          });
          return;
        }

        if (payload.chunk.type === "tool-call" || payload.chunk.type === "tool-result") {
          resetNarrationStreams();
        }

        if (shouldReplace) {
          const existingStepId = streamingStepIds.get(streamId);
          if (existingStepId) {
            this.db.updateRunStep(existingStepId, {
              title: payload.chunk.title ?? this.defaultRunEventTitle(eventType),
              content: payload.chunk.value,
              metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
            });
          } else {
            const step = await this.appendRunEvent(
              run.id,
              eventType,
              payload.chunk.title ?? this.defaultRunEventTitle(eventType),
              payload.chunk.value,
              payload.chunk.metadata,
            );
            streamingStepIds.set(streamId, step.id);
            let streamingStepKind: "tool-result" | "tool-progress" | "assistant" | "reasoning" =
              payload.chunk.metadata?.assistantKind === "reasoning" ? "reasoning" : "assistant";
            if (payload.chunk.type === "tool-result" || payload.chunk.type === "tool-progress") {
              streamingStepKind = payload.chunk.type;
            }
            streamingStepKinds.set(streamId, streamingStepKind);
          }
        } else {
          await this.appendRunEvent(
            run.id,
            eventType,
            payload.chunk.title ?? this.defaultRunEventTitle(eventType),
            payload.chunk.value,
            payload.chunk.metadata,
          );
        }
        this.emitEvent({
          runId: run.id,
          type: eventType,
          title: payload.chunk.title ?? this.defaultRunEventTitle(eventType),
          content: payload.chunk.value,
          metadata: payload.chunk.metadata,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      if (payload.type === "done") {
        const active = this.runWorkers.get(run.id);
        const wasCancelled = active?.cancelled === true;
        const currentRun = this.db.getRun(run.id);
        const nextInputTokens = Math.max(currentRun.inputTokens, payload.result.usage.inputTokens);
        const nextOutputTokens = Math.max(currentRun.outputTokens, payload.result.usage.outputTokens);
        if (payload.result.providerSessionRuntime && !wasCancelled) {
          this.upsertProviderSessionRuntime("run", run.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        const trimmedSummary = payload.result.summary.trim();
        const latestAssistantOutput = [...this.db.getRunSteps(run.id)]
          .reverse()
          .find((step) => {
            if (step.eventType !== "output") {
              return false;
            }
            let metadata: Record<string, unknown> = {};
            try {
              metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
            } catch {
              /* ignore malformed legacy metadata */
            }
            return metadata.assistantKind !== "reasoning";
          });
        const latestAssistantOutputText = latestAssistantOutput ? normalizeAssistantOutputText(latestAssistantOutput.content) : "";
        const shouldAppendFinalSummary =
          !wasCancelled &&
          provider.providerType !== "azure-legacy" &&
          trimmedSummary &&
          trimmedSummary !== "No output returned from the provider." &&
          normalizeAssistantOutputText(trimmedSummary) !== latestAssistantOutputText;
        if (shouldAppendFinalSummary) {
          await this.appendRunEvent(run.id, "output", "Final summary", trimmedSummary, {
            assistantKind: "final-summary",
          });
          this.emitEvent({
            runId: run.id,
            type: "output",
            title: "Final summary",
            content: trimmedSummary,
            metadata: {
              assistantKind: "final-summary",
            },
            createdAt: new Date().toISOString(),
          });
        }

        this.db.incrementProjectTokenUsage(
          run.projectId,
          nextInputTokens - currentRun.inputTokens,
          nextOutputTokens - currentRun.outputTokens,
        );
        this.db.updateRunStatus(run.id, wasCancelled ? "cancelled" : "completed", {
          summary: wasCancelled ? currentRun.summary : payload.result.summary,
          errorMessage: wasCancelled ? "Run cancelled by user." : null,
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
        });
        this.clearRunCheckpoint(run.id);
        this.updateWorktreeStatus(run, "ready");
        await this.appendRunEvent(
          run.id,
          "status",
          wasCancelled ? "Run cancelled" : "Run completed",
          wasCancelled
            ? `Run cancellation finished cleanup.\nInput tokens: ${nextInputTokens}\nOutput tokens: ${nextOutputTokens}`
            : `Run completed successfully.\nInput tokens: ${nextInputTokens}\nOutput tokens: ${nextOutputTokens}`,
          {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
          },
        );
        this.emitEvent({
          runId: run.id,
          type: "status",
          title: wasCancelled ? "Run cancelled" : "Run completed",
          content: wasCancelled
            ? `Run cancellation finished cleanup.\nInput tokens: ${nextInputTokens}\nOutput tokens: ${nextOutputTokens}`
            : `Run completed successfully.\nInput tokens: ${nextInputTokens}\nOutput tokens: ${nextOutputTokens}`,
          metadata: {
            inputTokens: nextInputTokens,
            outputTokens: nextOutputTokens,
            usageTotals: payload.result.usage,
            cancelled: wasCancelled,
          },
          createdAt: new Date().toISOString(),
        });
        this.clearRunRequestStepIds(run.id);
        this.runWorkers.delete(run.id);
        await worker.terminate();
        if (!wasCancelled && run.kind === "lab-implementation") {
          try {
            await this.reviewCompletedProjectLabImplementation(this.db.getRun(run.id));
          } catch (labReviewError) {
            this.logControllerError("Project Lab implementation review failed.", labReviewError, { runId: run.id });
          }
        } else if (wasCancelled && run.kind === "lab-implementation") {
          this.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
        }
        if (run.kind === "loop-iteration") {
          this.loopRunner.handleRunTerminal(run.id);
        }
        return;
      }

      if (payload.type === "error") {
        const active = this.runWorkers.get(run.id);
        const status = active?.cancelled ? "cancelled" : "failed";
        const shouldAutoRecover =
          status === "failed" && this.shouldAutoRecoverAzureLegacyToolRoundLimit(run.id, provider.providerType, payload.error);
        this.logControllerError("Run worker reported an error payload.", payload.error, {
          runId: run.id,
          status,
        });
        this.db.updateRunStatus(run.id, status, { errorMessage: payload.error });
        this.clearRunCheckpoint(run.id);
        this.updateWorktreeStatus(run, "ready");
        await this.appendRunEvent(run.id, "error", "Run failed", payload.error);
        this.emitEvent({
          runId: run.id,
          type: "error",
          title: status === "cancelled" ? "Run cancelled" : "Run failed",
          content: payload.error,
          createdAt: new Date().toISOString(),
        });
        this.clearRunRequestStepIds(run.id);
        this.runWorkers.delete(run.id);
        await worker.terminate();
        if (run.kind === "lab-implementation") {
          if (status === "cancelled") {
            this.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
          } else {
            await this.failProjectLabImplementation(run, payload.error);
          }
        }
        if (run.kind === "loop-iteration") {
          this.loopRunner.handleRunTerminal(run.id);
        }
        if (shouldAutoRecover) {
          await this.appendRunEvent(
            run.id,
            "status",
            "Automatic follow-up queued",
            "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
            {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
          );
          this.emitEvent({
            runId: run.id,
            type: "status",
            title: "Automatic follow-up queued",
            content:
              "Azure Legacy hit the tool-round limit. BuildWarden is sending an automatic follow-up that asks the model to run a full build or test first before scanning files again.",
            metadata: {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            },
            createdAt: new Date().toISOString(),
          });
          try {
            await this.followUpRunInternal(
              run.id,
              AZURE_LEGACY_AUTO_RECOVERY_PROMPT,
              {
                mode: run.mode,
                modelId: run.modelId,
              },
              {
                autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
              },
            );
          } catch (autoRecoveryError) {
            const message =
              autoRecoveryError instanceof Error ? autoRecoveryError.message : "Could not start the automatic follow-up.";
            this.logControllerError("Automatic Azure Legacy recovery follow-up failed to start.", autoRecoveryError, {
              runId: run.id,
            });
            await this.appendRunEvent(run.id, "error", "Automatic follow-up failed", message, {
              autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
            });
            this.emitEvent({
              runId: run.id,
              type: "error",
              title: "Automatic follow-up failed",
              content: message,
              metadata: {
                autoRecoveryKind: AZURE_LEGACY_AUTO_RECOVERY_KIND,
              },
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
    });

    worker.on("error", async (error) => {
      this.logControllerError("Run worker emitted a thread error.", error, { runId: run.id });
      this.db.updateRunStatus(run.id, "failed", { errorMessage: error.message });
      this.clearRunCheckpoint(run.id);
      this.updateWorktreeStatus(run, "ready");
      await this.appendRunEvent(run.id, "error", "Worker error", error.message);
      this.runWorkers.delete(run.id);
      if (run.kind === "loop-iteration") {
        this.loopRunner.handleRunTerminal(run.id);
      }
    });

    return worker;
  }

  private async appendRunEvent(
    runId: string,
    type: RunEvent["type"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.db.appendRunStep(runId, type, title, content, JSON.stringify(metadata ?? {}));
  }

  private shellApprovalStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  private userInputStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  private clearRunRequestStepIds(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.runShellApprovalStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runShellApprovalStepIds.delete(key);
      }
    }
    for (const key of this.runUserInputStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runUserInputStepIds.delete(key);
      }
    }
  }

  private formatRunUserInputQuestions(questions: RunUserInputQuestion[]): string {
    return questions
      .map((question, index) => {
        const heading = question.header || `Question ${String(index + 1)}`;
        const options = question.options.map((option) => {
          const descriptionSuffix = option.description ? `: ${option.description}` : "";
          return `- ${option.label}${descriptionSuffix}`;
        });
        return [heading, question.question, ...options].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private formatRunUserInputAnswers(answers: RunUserInputAnswers): string {
    return Object.entries(answers)
      .map(([questionId, answer]) => `${questionId}: ${Array.isArray(answer) ? answer.join(", ") : answer}`)
      .join("\n");
  }

  private defaultRunEventTitle(type: RunEvent["type"]): string {
    switch (type) {
      case "output":
        return "Agent output";
      case "tool-call":
        return "Tool call";
      case "tool-result":
        return "Tool result";
      case "tool-progress":
        return "Tool progress";
      case "approval-requested":
        return "Approval requested";
      case "approval-resolved":
        return "Approval resolved";
      case "user-input-requested":
      case "request":
        return "User input requested";
      case "plan-updated":
      case "plan":
        return "Plan updated";
      case "plan-progress":
        return "Plan progress";
      case "diff-updated":
        return "Diff updated";
      case "error":
        return "Run error";
      default:
        return "Run update";
    }
  }

  private buildRunCommitMessage(prompt: string): string {
    const singleLinePrompt = prompt.replace(/\s+/g, " ").trim();
    const summary = singleLinePrompt.length > 60 ? `${singleLinePrompt.slice(0, 60).trim()}...` : singleLinePrompt;
    return `buildwarden: ${summary || "apply run changes"}`;
  }

  private buildRunFollowUpMemo(runId: string): string {
    const run = this.db.getRun(runId);
    const steps = this.db.getRunSteps(runId);
    const recentSteps = steps.slice(-10);
    const toolCalls = recentSteps
      .filter((step) => step.eventType === "tool-call")
      .slice(-4)
      .map((step) => {
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        return `- ${String(meta.toolName ?? step.title)}: ${step.content}`;
      });
    const recentErrors = recentSteps.filter((step) => step.eventType === "error").slice(-2).map((step) => `- ${step.content}`);
    const recentOutput = recentSteps
      .filter((step) => step.eventType === "output")
      .slice(-1)[0]
      ?.content.replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    const checkpoint = this.getRunCheckpoint(runId);

    const parts = [
      "Run memory:",
      run.goalText ? `- Run goal: ${run.goalText}` : null,
      run.summary ? `- Last run summary: ${run.summary}` : null,
      recentOutput ? `- Latest agent output: ${recentOutput}` : null,
      toolCalls.length > 0 ? ["- Recent tool activity:", ...toolCalls].join("\n") : null,
      recentErrors.length > 0 ? ["- Recent errors:", ...recentErrors].join("\n") : null,
      checkpoint?.memo ? `- Latest checkpoint: ${checkpoint.memo}` : null,
      "- Continue from the current workspace state. Avoid repeating already-attempted steps unless needed.",
    ].filter(Boolean);

    return parts.join("\n");
  }

  private shouldAutoRecoverAzureLegacyToolRoundLimit(runId: string, providerType: ProviderAccountRecord["providerType"], errorMessage: string): boolean {
    if (providerType !== "azure-legacy" || errorMessage.trim() !== AZURE_LEGACY_TOOL_ROUND_LIMIT_MESSAGE) {
      return false;
    }

    const latestUserCommand = [...this.db.getRunSteps(runId)]
      .reverse()
      .find((step) => {
        if (step.eventType !== "log") {
          return false;
        }
        try {
          const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
          return metadata.source === "user";
        } catch {
          return false;
        }
      });

    if (!latestUserCommand) {
      return true;
    }

    try {
      const metadata = JSON.parse(latestUserCommand.metadataJson || "{}") as Record<string, unknown>;
      return metadata.autoRecoveryKind !== AZURE_LEGACY_AUTO_RECOVERY_KIND;
    } catch {
      return true;
    }
  }

  private buildPriorRunMessagesFromSteps(runId: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    let previousAssistantContent: string | null = null;
    for (const step of this.db.getRunSteps(runId)) {
      const metadata = parseMetadataRecord(step.metadataJson);

      if (step.eventType === "log" && metadata.source === "user") {
        messages.push({ role: "user", content: step.content });
        continue;
      }

      if (step.eventType === "output") {
        if (metadata.assistantKind === "reasoning" || step.title === "Reasoning") {
          continue;
        }
        if (isDuplicateFinalSummaryStep(step, previousAssistantContent)) {
          continue;
        }
        messages.push({ role: "assistant", content: step.content });
        previousAssistantContent = normalizeAssistantOutputText(step.content);
      }
    }
    if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
      messages.pop();
    }
    return messages;
  }

  private buildPriorChatMessages(chatId: string): Array<Record<string, unknown>> {
    const messages = this.db
      .getChatSteps(chatId)
      .flatMap((step) => {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }

        if (step.eventType === "log" && (metadata.source === "user" || metadata.source === RUN_CHAT_CONTEXT_SOURCE)) {
          return [{ role: "user", content: step.content }];
        }

        if (step.eventType === "output") {
          if (metadata.assistantKind === "reasoning" || step.title === "Reasoning") {
            return [];
          }
          return [{ role: "assistant", content: step.content }];
        }

        return [];
      });
    if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
      messages.pop();
    }
    return messages;
  }

  private getRunCheckpoint(runId: string):
    | RunResumeCheckpoint
    | undefined {
    const raw = this.db.getSettings()[runCheckpointSettingKey(runId)];
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as RunResumeCheckpoint;
    } catch {
      this.db.deleteSetting(runCheckpointSettingKey(runId));
      return undefined;
    }
  }

  private setRunCheckpoint(runId: string, checkpoint: RunResumeCheckpoint): void {
    this.db.setSetting(runCheckpointSettingKey(runId), JSON.stringify(checkpoint));
  }

  private clearRunCheckpoint(runId: string): void {
    this.db.deleteSetting(runCheckpointSettingKey(runId));
  }

  private getRunPromptRestorePoint(runId: string):
    | {
        createdAt: string;
        commandType: "initial" | "follow-up";
        patch: string;
      }
    | undefined {
    const raw = this.db.getSettings()[runPromptRestorePointSettingKey(runId)];
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as {
        createdAt: string;
        commandType: "initial" | "follow-up";
        patch: string;
      };
    } catch {
      this.db.deleteSetting(runPromptRestorePointSettingKey(runId));
      return undefined;
    }
  }

  private setRunPromptRestorePoint(
    runId: string,
    restorePoint: {
      createdAt: string;
      commandType: "initial" | "follow-up";
      patch: string;
    },
  ): void {
    this.db.setSetting(runPromptRestorePointSettingKey(runId), JSON.stringify(restorePoint));
  }

  private clearRunPromptRestorePoint(runId: string): void {
    this.db.deleteSetting(runPromptRestorePointSettingKey(runId));
  }

  private async capturePromptRestorePoint(runId: string, commandType: "initial" | "follow-up"): Promise<void> {
    const run = this.db.getRun(runId);
    if (run.workspaceVcs !== "git") {
      this.clearRunPromptRestorePoint(runId);
      return;
    }
    const patch = await this.gitService.createPromptRestorePatch(run.worktreePath);
    this.setRunPromptRestorePoint(runId, {
      createdAt: new Date().toISOString(),
      commandType,
      patch,
    });
  }

  private async resumeInterruptedRunFromCheckpoint(run: RunRecord, origin: "startup" | "manual" = "startup"): Promise<boolean> {
    const checkpoint = this.getRunCheckpoint(run.id);
    if (!checkpoint) {
      return false;
    }

    const model = this.db.getModel(run.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const apiKey = await this.secrets.readSecret(provider.apiKeyRef);
    if (apiKey === null && !providerAllowsMissingApiKey(provider)) {
      return false;
    }

    this.db.updateRunStatus(run.id, "preparing", { errorMessage: null });
    await this.appendRunEvent(
      run.id,
      "status",
      origin === "manual" ? "Recovery confirmed" : "Run resumed from checkpoint",
      checkpoint.memo || "Restarted from the last completed tool round.",
      { resumedFromCheckpoint: true, recoveredInterruptedSession: origin === "manual", round: checkpoint.round },
    );

    const worker = this.startWorker(run, provider, model, apiKey ?? "", await this.resolveNetworkProxyRuntimeConfig(), {
      skillContext: this.buildIntegratedSkillContext(run.projectId),
    });
    this.runWorkers.set(run.id, { worker, cancelled: false });
    return true;
  }

  private buildInterruptedRunRecoveryPrompt(run: RunRecord): string {
    const memory = this.buildRunFollowUpMemo(run.id);
    return [
      "The previous BuildWarden run was interrupted because the desktop app closed while the agent was active.",
      "Continue carefully from the current workspace state and the saved provider session. Do not assume the previous process finished.",
      "First inspect what already changed or what the activity log says, avoid repeating completed work, then continue the original task.",
      "",
      `Original task:\n${run.prompt}`,
      memory ? `\nRecent run memory:\n${memory}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildRunPullRequestBody(projectName: string, prompt: string, targetBranch: string): string {
    return [
      "## Summary",
      `- Automated changes from BuildWarden for \`${projectName}\`.`,
      `- Original run prompt: ${prompt}`,
      "",
      "## Target branch",
      `- ${targetBranch}`,
      "",
      "## Test plan",
      "- [ ] Review the generated diff",
      "- [ ] Run relevant tests locally",
    ].join("\n");
  }

  private isSettingEnabled(key: string, defaultValue: boolean): boolean {
    const value = this.db.getSettings()[key];
    if (value == null) {
      return defaultValue;
    }

    return value === "true";
  }

  private emitEvent(event: RunEvent): void {
    this.events.publish("run", event);
  }

  private emitChatEvent(chatId: string, event: RunEvent): void {
    this.events.publish("chat", { ...event, chatId });
  }

  private upsertProviderSessionRuntime(
    ownerKind: "run" | "chat",
    ownerId: string,
    provider: ProviderAccountRecord,
    fallbackModelId: string,
    runtime: Omit<ProviderSessionRuntimeInput, "status" | "ownerId" | "ownerKind" | "providerType" | "harnessType"> & {
      status?: ProviderSessionRuntimeInput["status"];
    },
  ): void {
    this.db.upsertProviderSessionRuntime({
      ownerId,
      ownerKind,
      providerType: provider.providerType,
      harnessType: getHarnessTypeForProvider(provider.providerType),
      status: runtime.status ?? "ready",
      cwd: runtime.cwd,
      modelId: runtime.modelId ?? fallbackModelId,
      runtimeMode: runtime.runtimeMode,
      resumeCursor: runtime.resumeCursor ?? null,
      runtimePayload: runtime.runtimePayload ?? null,
    });
  }

  private async appendChatEvent(
    chatId: string,
    eventType: RunEvent["type"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.db.appendChatEvent(chatId, eventType, title, content, metadata);
  }

  private buildStoredAttachmentMetadata(attachments: ChatAttachmentPayload[] | undefined): StoredAttachmentMetadata {
    if (!attachments?.length) {
      return {};
    }

    return {
      attachmentNames: attachments.map((attachment) => attachment.fileName),
      attachments,
    };
  }

  async setRunListVisibility(runId: string, visibility: RunListVisibility): Promise<RunRecord> {
    if (visibility !== "default" && visibility !== "for-later") {
      throw new Error("Unsupported run visibility.");
    }
    return this.db.updateRunListVisibility(runId, visibility);
  }

  private async resolveNetworkProxyRuntimeConfig(): Promise<NetworkProxyRuntimeConfig | undefined> {
    const settings = parseNetworkProxySettings(this.db.getSettings()[APP_SETTING_KEYS.networkProxyConfig]);
    const password = await this.secrets.readSecret(NETWORK_PROXY_SECRET_KEY);
    return buildNetworkProxyRuntimeConfig(settings, password ?? undefined);
  }

  private async handleChatWorkerChunk(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    payload: ChatWorkerChunkPayload,
    streamingStepIds: Map<string, string>,
  ): Promise<void> {
    const eventType = runChunkEventType(payload.chunk.type);
    if (payload.chunk.metadata?.providerSessionRuntime) {
      this.upsertProviderSessionRuntime(
        "chat",
        chat.id,
        provider,
        model.modelId,
        payload.chunk.metadata.providerSessionRuntime as Omit<
          ProviderSessionRuntimeInput,
          "ownerId" | "ownerKind" | "providerType" | "harnessType"
        >,
      );
    }
    const streamId = payload.chunk.type === "message" && typeof payload.chunk.metadata?.streamId === "string"
      ? payload.chunk.metadata.streamId
      : null;
    const shouldReplace = payload.chunk.type === "message" && payload.chunk.metadata?.replace === true && streamId;

    if (shouldReplace) {
      const existingStepId = streamingStepIds.get(streamId);
      if (existingStepId) {
        this.db.updateChatStep(existingStepId, {
          title: payload.chunk.title ?? "Agent output",
          content: payload.chunk.value,
          metadataJson: JSON.stringify(payload.chunk.metadata ?? {}),
        });
      } else {
        const step = await this.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
        streamingStepIds.set(streamId, step.id);
      }
    } else {
      await this.appendChatEvent(chat.id, eventType, payload.chunk.title ?? "Agent output", payload.chunk.value, payload.chunk.metadata);
    }
    this.emitChatEvent(chat.id, {
      runId: chat.id,
      type: eventType,
      title: payload.chunk.title ?? "Agent output",
      content: payload.chunk.value,
      metadata: payload.chunk.metadata,
      createdAt: new Date().toISOString(),
    });
  }

  private startChatWorker(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    promptOverride?: string,
    attachments?: ChatAttachmentPayload[],
    providerOptions?: { reasoningEffort?: string; anthropicEffort?: string },
  ): Worker {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "chat-worker.js");
    const streamingStepIds = new Map<string, string>();
    const settings = this.db.getSettings();
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.logDirPath, { recursive: true });
    }
    const worker = new Worker(workerPath, {
      workerData: {
        request: {
          runId: chat.id,
          // Chats are not bound to a repo; provider harnesses still need a real `cwd` for `spawn`.
          worktreePath: homedir(),
          mode: "ask" as const,
          prompt: promptOverride ?? chat.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: chat.lastProviderResponseId,
          providerSessionRuntime: this.db.getProviderSessionRuntime(chat.id, "chat"),
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          isChat: true,
          attachments: attachments ?? [],
          priorMessages: this.buildPriorChatMessages(chat.id),
          priorChatMessages: buildPriorChatCompletionMessagesFromSteps(this.db.getChatSteps(chat.id)),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.logDirPath } } : {}),
        },
      },
    });

    this.db.updateChatStatus(chat.id, "running");

    worker.on("message", async (message: unknown) => {
      const payload = message as ChatWorkerPayload;

      if (payload.type === "chunk") {
        await this.handleChatWorkerChunk(chat, provider, model, payload, streamingStepIds);
        return;
      }

      if (payload.type === "done") {
        const currentChat = this.db.getChat(chat.id);
        const nextInputTokens = Math.max(currentChat.inputTokens, payload.result.usage.inputTokens);
        const nextOutputTokens = Math.max(currentChat.outputTokens, payload.result.usage.outputTokens);
        if (payload.result.providerSessionRuntime) {
          this.upsertProviderSessionRuntime("chat", chat.id, provider, model.modelId, payload.result.providerSessionRuntime);
        }
        this.db.updateChatStatus(chat.id, "completed", {
          lastProviderResponseId: payload.result.responseId,
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          finishedAt: new Date().toISOString(),
        });
        await this.appendChatEvent(chat.id, "status", "Chat completed", "Chat completed successfully.", {
          inputTokens: nextInputTokens,
          outputTokens: nextOutputTokens,
          usageTotals: payload.result.usage,
        });
        this.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "status",
          title: "Chat completed",
          content: "Chat completed successfully.",
          metadata: { inputTokens: nextInputTokens, outputTokens: nextOutputTokens, usageTotals: payload.result.usage },
          createdAt: new Date().toISOString(),
        });
        this.chatWorkers.delete(chat.id);
        await worker.terminate();
        return;
      }

      if (payload.type === "error") {
        const active = this.chatWorkers.get(chat.id);
        const status = active?.cancelled ? "cancelled" : "failed";
        this.logControllerError("Chat worker reported an error payload.", payload.error, {
          chatId: chat.id,
          status,
        });
        this.db.updateChatStatus(chat.id, status, {
          errorMessage: payload.error,
          finishedAt: new Date().toISOString(),
        });
        await this.appendChatEvent(chat.id, "error", "Chat failed", payload.error);
        this.emitChatEvent(chat.id, {
          runId: chat.id,
          type: "error",
          title: status === "cancelled" ? "Chat cancelled" : "Chat failed",
          content: payload.error,
          createdAt: new Date().toISOString(),
        });
        this.chatWorkers.delete(chat.id);
        await worker.terminate();
      }
    });

    worker.on("error", async (error) => {
      this.logControllerError("Chat worker emitted a thread error.", error, { chatId: chat.id });
      this.db.updateChatStatus(chat.id, "failed", { errorMessage: error.message, finishedAt: new Date().toISOString() });
      await this.appendChatEvent(chat.id, "error", "Worker error", error.message);
      this.chatWorkers.delete(chat.id);
    });

    return worker;
  }

  private updateWorktreeStatus(run: RunRecord, status: WorktreeStatus): void {
    if (run.workspaceType !== "worktree" && run.workspaceType !== "copy") {
      return;
    }

    this.db.upsertWorktree({
      id: run.id,
      projectId: run.projectId,
      runId: run.id,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      status,
    });
  }

  private wasRunPromotedToProject(runId: string): boolean {
    return this.db
      .getRunSteps(runId)
      .some((step) => {
        try {
          const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
          return metadata.promotedToProject === true;
        } catch {
          return false;
        }
      });
  }

  private async promoteRunBranchToProjectCheckout(
    run: RunRecord,
    repoPath: string,
    branchName: string,
    options?: { transferOpenChanges?: boolean; deleteReleasedBranchName?: string },
  ): Promise<void> {
    if (run.workspaceType !== "worktree") {
      await this.gitService.checkoutProjectBranch(repoPath, branchName);
      return;
    }

    const openChangesPatch =
      options?.transferOpenChanges === true ? await this.gitService.createPromptRestorePatch(run.worktreePath) : "";

    await this.gitService.releaseWorktreeBranch(run.worktreePath, branchName);
    try {
      await this.gitService.checkoutProjectBranch(repoPath, branchName);
      if (openChangesPatch.trim()) {
        await this.gitService.cloneWorkspaceChanges(run.worktreePath, repoPath);
      }
    } catch (error) {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, branchName).catch(() => {});
      throw new Error(
        [
          `BuildWarden created branch "${branchName}", but could not check it out in the project repository or transfer the open changes.`,
          "Commit, stash, or discard local changes in the project repository and try again.",
          "",
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
      );
    }

    await this.gitService.removeWorktree(repoPath, run.worktreePath, options?.deleteReleasedBranchName);
    this.db.updateRunWorkspace(run.id, "local", repoPath);
  }

  private async deleteRunResources(repoPath: string, run: RunRecord, context: "run" | "project"): Promise<void> {
    const active = this.runWorkers.get(run.id);
    const cleanupErrors: string[] = [];

    if (active) {
      try {
        active.cancelled = true;
        active.worker.postMessage({ type: "cancel" });
        await active.worker.terminate();
      } catch (error) {
        cleanupErrors.push(`worker termination failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.runWorkers.delete(run.id);
      }
    }

    if (run.workspaceType === "worktree") {
      try {
        await this.gitService.removeWorktree(repoPath, run.worktreePath, run.branchName);
      } catch (error) {
        const [worktreeRegistered, gitMetadataPresent, branchPresent] = await Promise.all([
          this.gitService.isWorktreeRegistered(repoPath, run.worktreePath).catch(() => true),
          this.gitService.hasWorktreeGitMetadata(run.worktreePath).catch(() => true),
          this.gitService.hasLocalBranch(repoPath, run.branchName).catch(() => true),
        ]);
        if (!worktreeRegistered && !gitMetadataPresent && !branchPresent) {
          const message = [
            "The run was removed from BuildWarden and Git cleanup completed, but Windows kept part of the old worktree folder locked.",
            "Close any running packaged BuildWarden app from that folder, Explorer preview, terminal, or antivirus scan, then delete the folder manually.",
          ].join(" ");
          logWarn("Run deletion left non-git filesystem residue after successful git cleanup.", {
            runId: run.id,
            branchName: run.branchName,
            worktreePath: run.worktreePath,
            error,
          });
          this.emitAppWarning({
            title: "Run deleted, folder still locked",
            message,
            detail: run.worktreePath,
          });
        } else {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (run.workspaceType === "copy") {
      try {
        await removeFolderWorkspaceCopy(run.worktreePath);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (run.workspaceVcs === "folder") {
      try {
        await deleteFolderSnapshot(this.getFolderSnapshotRoot(), run.id);
      } catch (error) {
        logWarn("Failed to delete folder run snapshot.", {
          runId: run.id,
          worktreePath: run.worktreePath,
          error,
        });
      }
    }

    if (cleanupErrors.length > 0) {
      const message = [
        `Failed to delete resources for ${context === "project" ? "project cleanup" : "run deletion"}.`,
        `Run branch: ${run.branchName}`,
        ...cleanupErrors,
      ].join("\n");

      await this.appendRunEvent(run.id, "error", "Deletion cleanup failed", message);
      this.emitEvent({
        runId: run.id,
        type: "error",
        title: "Deletion cleanup failed",
        content: message,
        createdAt: new Date().toISOString(),
      });

      throw new Error(message);
    }
  }

  private emitAppWarning(warning: AppWarning): void {
    this.events.publish("warning", warning);
  }
}
