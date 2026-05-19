export * from "./provider-metadata";
export * from "./integrated-skills-catalog";

export type ProviderType = "ai-sdk" | "azure-legacy" | "codex-cli" | "claude-code";

export type HarnessType = "ai-sdk" | "azure-legacy" | "codex-app-server" | "claude-code";

export type RunMode = "code" | "plan" | "ask";
export type RunWorkspaceType = "worktree" | "local";
export type RunListVisibility = "default" | "for-later";
export type RunKind = "standard" | "lab-implementation";

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
  | "diff-updated"
  | "tool-progress"
  | "request"
  | "plan";

export type RunToolName = "read_file" | "write_file" | "edit_file" | "delete_file" | "list_files" | "search_repo" | "run_shell";

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
  defaultBranch: string;
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
  prompt: string;
  status: RunStatus;
  branchName: string;
  worktreePath: string;
  summary: string | null;
  errorMessage: string | null;
  lastProviderResponseId: string | null;
  inputTokens: number;
  outputTokens: number;
  listVisibility: RunListVisibility;
  kind: RunKind;
  labThreadId: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  lineageTitle: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProjectTaskRecord {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectLabThreadKind = "idea" | "rfc" | "implementation";
export type ProjectLabMode = "new-feature" | "bugfix" | "refactoring" | "rfc-only";
export type ProjectLabThreadStatus =
  | "discussing"
  | "agreed"
  | "running-implementation"
  | "implemented"
  | "parked"
  | "rejected"
  | "failed";
export type ProjectLabOrigin = "manual" | "idle" | "task";
export type ProjectLabPersonaId =
  | "moderator"
  | "architect"
  | "security-coach"
  | "clean-code"
  | "implementer";
export type ProjectLabMessageRole = "persona" | "moderator" | "system";

export interface ProjectLabPersonaConfig {
  personaId: ProjectLabPersonaId;
  label: string;
  colorToken: string;
  modelId: string | null;
  enabled: boolean;
}

export interface ProjectLabSettings {
  enabled: boolean;
  autoImplementation: boolean;
  discussionRoundCap: number;
  maxThreadsPerDay: number;
  maxConcurrentThreads: number;
  personas: ProjectLabPersonaConfig[];
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
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectLabMessageRecord {
  id: string;
  threadId: string;
  personaId: ProjectLabPersonaId | "system";
  personaLabel: string;
  role: ProjectLabMessageRole;
  bubbleColor: string;
  content: string;
  createdAt: string;
}

export interface ProjectLabThreadDetail {
  thread: ProjectLabThreadRecord;
  messages: ProjectLabMessageRecord[];
  implementationRun: RunRecord | null;
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
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
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

export const MODEL_CONFIG_OPENAI_REASONING_EFFORT_KEY = "openaiReasoningEffort";
export const MODEL_CONFIG_ANTHROPIC_EFFORT_KEY = "anthropicEffort";
export const MODEL_CONFIG_CODEX_REASONING_EFFORT_KEY = "codexReasoningEffort";

export interface ProjectInput {
  name?: string;
  repoPath: string;
}

export interface RunInput {
  projectId: string;
  providerAccountId: string;
  modelId: string;
  harnessType: HarnessType;
  mode: RunMode;
  yoloMode?: boolean;
  workspaceType: RunWorkspaceType;
  baseBranch?: string;
  prompt: string;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
  kind?: RunKind;
  labThreadId?: string | null;
}

export interface ContinueRunInput {
  sourceRunId: string;
  providerAccountId: string;
  modelId: string;
  harnessType: HarnessType;
  mode: RunMode;
  yoloMode?: boolean;
  prompt: string;
  includeWorkspaceChanges?: boolean;
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export interface RunFollowUpOptions {
  modelId?: string;
  mode?: RunMode;
  yoloMode?: boolean;
  attachments?: ChatAttachmentPayload[];
  reasoningEffort?: string;
  anthropicEffort?: string;
}

export type ShellApprovalDecision = "allow-once" | "allow-for-run" | "allow-always" | "deny";

/** Optional data when responding to a shell approval request (e.g. exact command for `allow-always`). */
export interface ShellApprovalRespondOptions {
  command?: string;
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
}

export interface RunDetail {
  run: RunRecord;
  steps: RunStepRecord[];
  diff: string;
  /** Effective workspace path for this run detail. May point at the project repo if the worktree was promoted and removed. */
  workspacePath?: string;
  /** True when this run's branch was promoted from an Easycode worktree back into the main project repository. */
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
}

/** Load a GitHub PR / GitLab MR diff via `git fetch` (no hosting HTTP API). */
export interface FetchProjectPrMrDiffInput {
  prUrl: string;
  /** Optional target branch name (e.g. `main` or `develop`). When omitted, uses `origin/HEAD` or `origin/main`. */
  baseBranch?: string;
}

export interface ProjectPrMrDiffResult {
  diff: string;
  provider: "github" | "gitlab";
  number: number;
  baseRef: string;
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
      port: typeof record.port === "string" ? record.port.trim() : typeof record.port === "number" ? String(record.port) : "",
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
  const auth =
    value.username && value.password !== undefined
      ? `${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@`
      : value.username
        ? `${encodeURIComponent(value.username)}@`
        : "";
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
  defaultBranch: string;
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

/** Persisted on user log steps so reopened chats/runs can still render the original attached files/images. */
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
  const pad = t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0;
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
export const buildPriorChatCompletionMessagesFromSteps = (steps: ChatStepRecord[]): ChatCompletionHistoryMessage[] => {
  const sorted = [...steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: ChatCompletionHistoryMessage[] = [];
  for (const step of sorted) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    if (step.eventType === "log" && meta.source === "user") {
      out.push({ role: "user", content: step.content });
      continue;
    }
    if (step.eventType === "output") {
      if (meta.assistantKind === "reasoning" || step.title === "Reasoning") {
        continue;
      }
      out.push({ role: "assistant", content: step.content });
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

export interface AppPathsInfo {
  logDirPath: string;
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
  getNetworkProxySettings(): Promise<NetworkProxySettingsSnapshot>;
  reorderProjects(projectIds: string[]): Promise<void>;
  getProjectBranches(projectId: string): Promise<string[]>;
  getProjectCurrentBranch(projectId: string): Promise<string>;
  /** Check out a local branch on the project’s main repository (fixes detached HEAD). */
  checkoutProjectBranch(projectId: string, branchName: string): Promise<void>;
  addProject(input: ProjectInput): Promise<ProjectRecord>;
  addProviderAccount(input: ProviderAccountInput): Promise<ProviderAccountRecord>;
  addModel(input: ModelInput): Promise<ModelRecord>;
  createProjectTask(projectId: string, input: { title: string; prompt: string }): Promise<ProjectTaskRecord>;
  deleteProjectTask(taskId: string): Promise<void>;
  runProjectLab(input: RunProjectLabInput): Promise<ProjectLabThreadRecord[]>;
  startProjectLabImplementation(threadId: string): Promise<ProjectLabThreadRecord>;
  deleteProjectLabThread(threadId: string): Promise<void>;
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
   * Fetches PR/MR head from `origin` and returns the unified diff (merge-base vs head). Requires matching `origin` URL.
   * @see FetchProjectPrMrDiffInput
   */
  fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult>;
  /** AI review for an already-loaded PR/MR diff (not persisted; does not post to Git). */
  analyzeProjectPrMrDiff(
    projectId: string,
    input: { prUrl: string; diff: string; modelId?: string },
  ): Promise<RunDiffReviewResult>;
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
  setRunListVisibility(runId: string, visibility: RunListVisibility): Promise<RunRecord>;
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
  cancelRunShell(runId: string, toolCallId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  refreshSnapshot(): Promise<AppSnapshot>;
  pickProjectDirectory(): Promise<string | null>;
  openPathInFileManager(path: string): Promise<OpenPathInFileManagerResult>;
  getAppPaths(): Promise<AppPathsInfo>;
  getDetectedCodexInstallation(): Promise<DetectedCodexInstallation>;
  getDetectedClaudeInstallation(): Promise<DetectedClaudeInstallation>;
  /** Open http(s) or mailto URLs outside the Electron window (system browser / mail client). */
  openExternalUrl(url: string): Promise<OpenExternalUrlResult>;
  reportRendererLog(payload: RendererLogPayload): Promise<void>;
  /** Pick an IDE executable (.exe, app bundle, etc.). */
  pickIdeExecutable(): Promise<string | null>;
  /** Open the run worktree folder in the given IDE (must be configured under {@link APP_SETTING_KEYS.idePaths}). */
  openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind): Promise<void>;
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

export const IPC_CHANNELS = {
  activateRun: "easycode:activate-run",
  addModel: "easycode:add-model",
  createProjectTask: "easycode:create-project-task",
  deleteProjectTask: "easycode:delete-project-task",
  runProjectLab: "easycode:run-project-lab",
  startProjectLabImplementation: "easycode:start-project-lab-implementation",
  deleteProjectLabThread: "easycode:delete-project-lab-thread",
  generateProjectTaskRunPrompt: "easycode:generate-project-task-run-prompt",
  generateProjectInsight: "easycode:generate-project-insight",
  addProject: "easycode:add-project",
  addProviderAccount: "easycode:add-provider-account",
  cancelRunShell: "easycode:cancel-run-shell",
  cancelRun: "easycode:cancel-run",
  commitRun: "easycode:commit-run",
  suggestCommitMessage: "easycode:suggest-commit-message",
  analyzeRunDiff: "easycode:analyze-run-diff",
  fetchProjectPrMrDiff: "easycode:fetch-project-pr-mr-diff",
  analyzeProjectPrMrDiff: "easycode:analyze-project-pr-mr-diff",
  createRunPullRequest: "easycode:create-run-pull-request",
  suggestRunPullRequestDescription: "easycode:suggest-run-pull-request-description",
  createRunLocalBranch: "easycode:create-run-local-branch",
  createRun: "easycode:create-run",
  continueRun: "easycode:continue-run",
  publishRunBranch: "easycode:publish-run-branch",
  followUpRun: "easycode:follow-up-run",
  deleteProject: "easycode:delete-project",
  deleteProviderAccount: "easycode:delete-provider-account",
  deleteRun: "easycode:delete-run",
  deleteModel: "easycode:delete-model",
  getRunDetail: "easycode:get-run-detail",
  setRunListVisibility: "easycode:set-run-list-visibility",
  getRunWorktreeDiff: "easycode:get-run-worktree-diff",
  resumeRunFromCheckpoint: "easycode:resume-run-from-checkpoint",
  recoverInterruptedRun: "easycode:recover-interrupted-run",
  undoRunToLastPrompt: "easycode:undo-run-to-last-prompt",
  getRunPublishOptions: "easycode:get-run-publish-options",
  getProjectBranches: "easycode:get-project-branches",
  getProjectCurrentBranch: "easycode:get-project-current-branch",
  checkoutProjectBranch: "easycode:checkout-project-branch",
  getSnapshot: "easycode:get-snapshot",
  getNetworkProxySettings: "easycode:get-network-proxy-settings",
  reorderProjects: "easycode:reorder-projects",
  pickProjectDirectory: "easycode:pick-project-directory",
  openPathInFileManager: "easycode:open-path-in-file-manager",
  getAppPaths: "easycode:get-app-paths",
  getDetectedCodexInstallation: "easycode:get-detected-codex-installation",
  getDetectedClaudeInstallation: "easycode:get-detected-claude-installation",
  openExternalUrl: "easycode:open-external-url",
  reportRendererLog: "easycode:report-renderer-log",
  pickIdeExecutable: "easycode:pick-ide-executable",
  openRunWorktreeInIde: "easycode:open-run-worktree-in-ide",
  releaseRun: "easycode:release-run",
  respondToShellApproval: "easycode:respond-to-shell-approval",
  refreshSnapshot: "easycode:refresh-snapshot",
  runEvent: "easycode:run-event",
  setAppSetting: "easycode:set-app-setting",
  saveNetworkProxySettings: "easycode:save-network-proxy-settings",
  addBookmark: "easycode:add-bookmark",
  removeBookmark: "easycode:remove-bookmark",
  removeBookmarkById: "easycode:remove-bookmark-by-id",
  isBookmarked: "easycode:is-bookmarked",
  getBookmarksWithSteps: "easycode:get-bookmarks-with-steps",
  addChatBookmark: "easycode:add-chat-bookmark",
  removeChatBookmark: "easycode:remove-chat-bookmark",
  removeChatBookmarkById: "easycode:remove-chat-bookmark-by-id",
  isChatBookmarked: "easycode:is-chat-bookmarked",
  getChatBookmarksWithSteps: "easycode:get-chat-bookmarks-with-steps",
  resetDatabase: "easycode:reset-database",
  createChat: "easycode:create-chat",
  getChatDetail: "easycode:get-chat-detail",
  followUpChat: "easycode:follow-up-chat",
  listChats: "easycode:list-chats",
  listChatsWithSteps: "easycode:list-chats-with-steps",
  deleteChat: "easycode:delete-chat",
  cancelChat: "easycode:cancel-chat",
  chatEvent: "easycode:chat-event",
  runTerminalStart: "easycode:run-terminal-start",
  runTerminalWrite: "easycode:run-terminal-write",
  runTerminalResize: "easycode:run-terminal-resize",
  runTerminalKill: "easycode:run-terminal-kill",
  runTerminalData: "easycode:run-terminal-data",
  runTerminalExit: "easycode:run-terminal-exit",
  openSystemTerminalAtPath: "easycode:open-system-terminal-at-path",
  appMenuCommand: "easycode:app-menu-command",
  appWarning: "easycode:app-warning",
  /** Main notifies renderer after settings changed outside the renderer (e.g. theme from the app menu). */
  appSettingsChanged: "easycode:app-settings-changed",
  showAppMenu: "easycode:show-app-menu",
} as const;

export const APP_SETTING_KEYS = {
  darkMode: "darkMode",
  /**
   * `"dark"` | `"dim"` | `"light"`. When unset, {@link parseUiTheme} falls back to legacy {@link APP_SETTING_KEYS.darkMode}.
   */
  uiTheme: "uiTheme",
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
  /** JSON string array of project ids representing the custom sidebar order. */
  projectOrder: "projectOrder",
  /** JSON string array of integrated skill ids disabled globally in Settings -> Skills. */
  integratedSkillsDisabled: "integratedSkillsDisabled",
  /** JSON object keyed by project id with string-array skill ids enabled for that project. */
  projectActiveSkills: "projectActiveSkills",
  /** JSON object keyed by project id containing Project Lab settings and persona model assignments. */
  projectLabSettings: "projectLabSettings",
  /** JSON object with app-wide outbound proxy host/port/user settings (password stored in secure storage). */
  networkProxyConfig: "networkProxyConfig",
} as const;

export const PROJECT_LAB_PERSONA_PRESETS: Record<ProjectLabPersonaId, { label: string; colorToken: string; enabledByDefault: boolean }> = {
  moderator: { label: "Moderator", colorToken: "slate", enabledByDefault: true },
  architect: { label: "Architect", colorToken: "cyan", enabledByDefault: true },
  "security-coach": { label: "Security Coach", colorToken: "rose", enabledByDefault: true },
  "clean-code": { label: "Clean Code", colorToken: "emerald", enabledByDefault: true },
  implementer: { label: "Implementer", colorToken: "violet", enabledByDefault: true },
};

export const buildDefaultProjectLabSettings = (): ProjectLabSettings => ({
  enabled: false,
  autoImplementation: false,
  discussionRoundCap: 2,
  maxThreadsPerDay: 3,
  maxConcurrentThreads: 1,
  personas: (Object.entries(PROJECT_LAB_PERSONA_PRESETS) as Array<[ProjectLabPersonaId, (typeof PROJECT_LAB_PERSONA_PRESETS)[ProjectLabPersonaId]]>).map(
    ([personaId, preset]) => ({
      personaId,
      label: preset.label,
      colorToken: preset.colorToken,
      modelId: null,
      enabled: preset.enabledByDefault,
    }),
  ),
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
      const personasById = new Map(defaults.personas.map((persona) => [persona.personaId, persona]));
      const rawPersonas = Array.isArray(record.personas) ? record.personas : [];
      const personas = defaults.personas.map((defaultPersona) => {
        const rawPersona = rawPersonas.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as { personaId?: unknown }).personaId === defaultPersona.personaId,
        ) as Record<string, unknown> | undefined;
        return {
          personaId: defaultPersona.personaId,
          label: typeof rawPersona?.label === "string" && rawPersona.label.trim() ? rawPersona.label.trim() : defaultPersona.label,
          colorToken:
            typeof rawPersona?.colorToken === "string" && rawPersona.colorToken.trim() ? rawPersona.colorToken.trim() : defaultPersona.colorToken,
          modelId: typeof rawPersona?.modelId === "string" && rawPersona.modelId.trim() ? rawPersona.modelId.trim() : null,
          enabled: typeof rawPersona?.enabled === "boolean" ? rawPersona.enabled : personasById.get(defaultPersona.personaId)?.enabled ?? true,
        } satisfies ProjectLabPersonaConfig;
      });
      result[projectId] = {
        enabled: record.enabled === true,
        autoImplementation: record.autoImplementation === true,
        discussionRoundCap: Math.min(6, Math.max(1, Number(record.discussionRoundCap ?? defaults.discussionRoundCap) || defaults.discussionRoundCap)),
        maxThreadsPerDay: Math.min(20, Math.max(1, Number(record.maxThreadsPerDay ?? defaults.maxThreadsPerDay) || defaults.maxThreadsPerDay)),
        maxConcurrentThreads: Math.min(6, Math.max(1, Number(record.maxConcurrentThreads ?? defaults.maxConcurrentThreads) || defaults.maxConcurrentThreads)),
        personas,
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
          autoImplementation: settings.autoImplementation === true,
          discussionRoundCap: Math.min(6, Math.max(1, settings.discussionRoundCap || 2)),
          maxThreadsPerDay: Math.min(20, Math.max(1, settings.maxThreadsPerDay || 3)),
          maxConcurrentThreads: Math.min(6, Math.max(1, settings.maxConcurrentThreads || 1)),
          personas: settings.personas.map((persona) => ({
            personaId: persona.personaId,
            label: persona.label.trim() || PROJECT_LAB_PERSONA_PRESETS[persona.personaId].label,
            colorToken: persona.colorToken.trim() || PROJECT_LAB_PERSONA_PRESETS[persona.personaId].colorToken,
            modelId: persona.modelId?.trim() || null,
            enabled: persona.enabled === true,
          })),
        },
      ]),
    ),
  );

/** Visual theme: deep dark, mid gray, or bright. */
export const UI_THEME_VALUES = ["dark", "dim", "light"] as const;
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

export const cycleUiTheme = (current: UiTheme): UiTheme =>
  current === "dark" ? "dim" : current === "dim" ? "light" : "dark";

/**
 * Windows frameless windows: Electron `titleBarOverlay.color` fills the minimize/maximize/close region. Use the same hex for the
 * in-page title bar (`AppTitleBar` when `syncWindowsCaptionStrip`) so the strip does not look like a separate tile.
 */
export const WINDOWS_TITLEBAR_OVERLAY_BACKGROUND: Record<UiTheme, string> = {
  dark: "#18181b",
  dim: "#3f3f46",
  light: "#cfd2d6",
};

export type RunWorkspacePanelId = "activity" | "diff" | "terminal" | "browser";

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

const RUN_WORKSPACE_PANEL_IDS: readonly RunWorkspacePanelId[] = ["activity", "diff", "terminal", "browser"];

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
        if (typeof visibleValue !== "boolean" || !tileValue || typeof tileValue !== "object" || Array.isArray(tileValue)) {
          valid = false;
          break;
        }

        const colSpan = (tileValue as Record<string, unknown>).colSpan;
        const rowSpan = (tileValue as Record<string, unknown>).rowSpan;
        if (typeof colSpan !== "number" || typeof rowSpan !== "number") {
          valid = false;
          break;
        }

        visiblePanels[panelId] = visibleValue;
        tileLayout[panelId] = {
          colSpan,
          rowSpan,
        };
      }

      const normalizedOrder = tileOrderRaw.filter(isRunWorkspacePanelId);
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
  JSON.stringify([...new Set(skillIds.map((id) => id.trim()).filter(Boolean))].sort());

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
    const normalizedSkillIds = [...new Set(skillIds.map((id) => id.trim()).filter(Boolean))].sort();
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
