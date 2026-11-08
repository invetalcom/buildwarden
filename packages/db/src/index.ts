import { CORE_SCHEMA_SQL } from "./schema-core";
import { SERVICES_SCHEMA_SQL } from "./schema-services";
import { SKILLS_SCHEMA_SQL } from "./schema-skills";
import type { SkillPackageRecord, SkillSessionSnapshot } from "@buildwarden/shared";
import { PROJECT_INSIGHT_KINDS, validateUserInputAnswers } from "@buildwarden/shared";
import { DEFAULT_RUN_SECTION_COLOR, isRunSectionColor, isRunSectionName, isUpdateRunOrganizationInput, RUN_TAG_COUNT_LIMIT, RUN_TAG_LIMIT, UNCATEGORIZED_RUN_SECTION_ID,
  type RunSectionRecord, type RunOrganizationRecord, type RunOrganizationSnapshot, type UpdateRunOrganizationInput } from "@buildwarden/shared";
import { getResponseSourceText, type ChatSearchDetail } from "@buildwarden/shared";
import type { CouncilRound, RunVerificationRecord, TokenUsageAttribution } from "@buildwarden/shared";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseTerminalShell, APP_SETTING_KEYS, ATTENTION_KIND_LABELS, parseAttentionInboxSettings, parseUsageCostTrackingEnabledSetting, parseWorkspaceSetupSettings, parseRevisionVerificationPolicy, REMOTE_ACCESS_SCOPES, type AttentionKind } from "@buildwarden/shared";
import type {
  AppSettingRecord,
  RunWorkspaceSetup,
  RunPromptRestorePoint,
  RunTurnRestorePoint,
  RunTurnRestorePointSummary,
  PendingRunRewind,
  RunRewindArchive,
  AppSnapshot,
  BookmarkRecord,
  BookmarkStepRecord,
  BookmarkSummary,
  ChatAttachmentPayload,
  ChatBookmarkRecord,
  ChatBookmarkSummary,
  AttentionItem,
  ChatDetail,
  ChatHistoryPage,
  ChatRecord,
  ChatStepRecord,
  ChatSummary,
  ModelInput,
  ModelRecord,
  OrchestrationDetail,
  OrchestrationEventRecord,
  OrchestrationRecord,
  OrchestrationStatus,
  OrchestrationTaskMessageRecord,
  OrchestrationEffectKind,
  OrchestrationEffectRecord,
  OrchestrationTaskRecord,
  OrchestrationTaskResultRecord,
  OrchestrationTaskStatus,
  OrchestrationTeamSettings,
  OrchestrationWaveRecord,
  ProjectInput,
  ProjectAutomationInput,
  ProjectAutomationListItem,
  ProjectAutomationRecord,
  ProjectAutomationSummary,
  ProjectInsightKind,
  ProjectInsightRecord,
  ProjectLabEventRecord,
  ProjectLabThreadDetail,
  ProjectLabThreadListItem,
  ProjectInsightSummary,
  ProjectLabThreadKind,
  ProjectLabMode,
  ProjectLabThreadRecord,
  ProjectLabThreadStatus,
  ProjectLoopDetail,
  ProjectLoopEventRecord,
  ProjectLoopIterationRecord,
  ProjectLoopIterationStatus,
  ProjectLoopListItem,
  ProjectLoopMergePolicy,
  ProjectLoopPrReviewPolicy,
  ProjectLoopRecord,
  ProjectLoopStatus,
  ProjectLoopUiChangePolicy,
  ProjectLoopUiReviewRecord,
  ProjectLoopUiReviewStatus,
  ProjectTaskInput,
  ProjectTaskRecord,
  ProjectTaskSummary,
  ProjectRecord,
  ProjectSnapshot,
  ProviderExecutionOptions,
  ProviderAccountRecord,
  ProviderSessionRuntimeInput,
  ProviderSessionRuntimeRecord,
  RemoteAccessAuditRecord,
  RemoteAccessPairingGrantRecord,
  RemoteAccessScope,
  RemoteAccessSession,
  RemoteAccessSessionRecord,
  RemoteCommandIdempotencyRecord,
  RunDetail,
  RunHistoryPage,
  RunListVisibility,
  RunInput,
  RunNoteRecord,
  RunNoteStatus,
  UpdateProjectTaskInput,
  UpdateProjectAutomationInput,
  UpdateRunNoteInput,
  RunRecord,
  RunListItem,
  RunListSummaryState,
  RunForgeRequestDetailsResult,
  RunForgeRequestSummary,
  RunStatus,
  RunStepRecord,
  RunStepPreview,
  UserAnchoredHistoryPageInfo,
  UserAnchoredHistoryPageRequest,
  WorktreeRecord,
  FollowUpQueueOwnerKind,
  QueuedFollowUpRecord,
  RunMode,
} from "@buildwarden/shared";

const ORCHESTRATION_DETAIL_HISTORY_LIMIT = 200;
export const INITIAL_USER_HISTORY_TURN_LIMIT = 10;
export const EARLIER_USER_HISTORY_TURN_LIMIT = 20;

type HistoryStep = RunStepRecord | ChatStepRecord;
type HistoryCursor = { createdAt: string; id: string; sequence: number };
type HistoryTable = "run_steps" | "chat_steps";

const encodeHistoryCursor = (cursor: HistoryCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeHistoryCursor = (value: string): HistoryCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (typeof parsed.createdAt === "string" && parsed.createdAt && typeof parsed.id === "string" && parsed.id &&
      typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence) && parsed.sequence > 0) {
      return { createdAt: parsed.createdAt, id: parsed.id, sequence: parsed.sequence };
    }
  } catch {
    // Normalize malformed transport input to the same public validation error.
  }
  throw new Error("Invalid history cursor.");
};
// Presentation follows the owning host's toggle; saved titles remain in SQLite when disabled.
const SESSION_TITLES_ENABLED_SQL = "coalesce((select value from app_settings where key = 'sessionTitlesEnabled'), 'true') <> 'false'";
const SESSION_TITLE_SQL = `case when ${SESSION_TITLES_ENABLED_SQL} then title else null end as title,
  (${SESSION_TITLES_ENABLED_SQL}) as titleGenerationEnabled,
  (${SESSION_TITLES_ENABLED_SQL} and title_request_id is not null) as titleGenerationPending,`;
const BOOKMARK_TITLE_SQL = `case when ${SESSION_TITLES_ENABLED_SQL} then title else null end as title,`;

const RUN_PREVIEW_FLAGS_SQL = `(length(prompt) > 500 or length(coalesce(goal_text, '')) > 500
  or length(coalesce(summary, '')) > 500 or length(coalesce(error_message, '')) > 500) as textIsPreview,
  (length(prompt) > 500) as promptIsPreview,`;

const ORCHESTRATION_SELECT = `select id, project_id as projectId, coordinator_run_id as coordinatorRunId, status,
  team_snapshot_json as teamSnapshotJson, wake_mode as wakeMode, wake_task_ids_json as wakeTaskIdsJson,
  last_event_sequence as lastEventSequence, last_delivered_sequence as lastDeliveredSequence,
  error_message as errorMessage, created_at as createdAt, updated_at as updatedAt, finished_at as finishedAt
  from orchestrations`;
const ORCHESTRATION_TASK_SELECT = `select id, orchestration_id as orchestrationId, wave_id as waveId,
  client_task_id as clientTaskId, title, prompt, role_id as roleId, model_id as modelId, intent, status, permission_mode as permissionMode,
  child_run_id as childRunId, retry_of_task_id as retryOfTaskId, summary, error_message as errorMessage,
  attention_reason as attentionReason, adoption_status as adoptionStatus, deferred_until as deferredUntil,
  input_tokens as inputTokens, output_tokens as outputTokens,
  created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
  from orchestration_tasks`;
const ORCHESTRATION_EFFECT_SELECT = `select id, orchestration_id as orchestrationId, task_id as taskId, kind, status,
  payload_json as payloadJson, attempts, error_message as errorMessage, created_at as createdAt, updated_at as updatedAt
  from orchestration_effects`;
const PROJECT_AUTOMATION_SELECT = `select id, project_id as projectId, name, prompt, attachments_json as attachmentsJson,
  cron_expression as cronExpression, time_zone as timeZone, model_id as modelId, effort,
  execution_options_json as executionOptionsJson, workspace_type as workspaceType, base_branch as baseBranch,
  only_if_previous_finished as onlyIfPreviousFinished, enabled,
  last_scheduled_at as lastScheduledAt, next_run_at as nextRunAt, last_error as lastError,
  created_at as createdAt, updated_at as updatedAt
  from project_automations`;

type StoredOrchestrationRecord = Omit<OrchestrationRecord, "teamSnapshot" | "wakeTaskIds"> & {
  teamSnapshotJson: string;
  wakeTaskIdsJson: string;
};

type StoredProjectTaskRecord = Omit<ProjectTaskRecord, "attachments"> & {
  attachmentsJson: string;
};

type StoredProjectAutomationRecord = Omit<ProjectAutomationRecord, "attachments" | "executionOptions"> & {
  attachmentsJson: string;
  executionOptionsJson: string;
};

const DEFAULT_DB_NAME = "buildwarden.sqlite";
export const BUILDWARDEN_DATABASE_SCHEMA_VERSION = 1;
/** Characters of one step that the transcript search index keeps. */
const HISTORY_SEARCH_MAX_STEP_CHARS = 20_000;
/** Step types whose text is searchable: agent output and logged prompts. */
const HISTORY_SEARCH_EVENT_TYPES = "('output', 'log')";
const SQLITE_VARIABLE_BATCH_SIZE = 900;
const LEGACY_RUN_PROMPT_RESTORE_POINT_SETTING_PREFIX = "runPromptRestorePoint:";

const nowIso = () => new Date().toISOString();

/** Host-side queue entry: the client record plus what is needed to start the follow-up. */
/**
 * Where a queued follow-up is in its delivery. `starting` and `steering` mark an attempt in
 * progress (hidden from clients); `uncertain` means steering could not be confirmed.
 */
export type QueuedFollowUpDeliveryState = "starting" | "steering" | "uncertain";

export interface QueuedFollowUpEntry {
  record: QueuedFollowUpRecord;
  ownerKind: FollowUpQueueOwnerKind;
  ownerId: string;
  deliveryState: QueuedFollowUpDeliveryState | null;
  /** Execution options without attachments (run or chat follow-up options). */
  options: Record<string, unknown>;
  attachments: ChatAttachmentPayload[];
}

interface QueuedFollowUpRow {
  id: string;
  ownerKind: FollowUpQueueOwnerKind;
  ownerId: string;
  position: number;
  prompt: string;
  optionsJson: string;
  attachmentsJson: string;
  deliveryState: string | null;
  createdAt: string;
  updatedAt: string;
}

const QUEUED_FOLLOW_UP_COLUMNS = `
  id, owner_kind as ownerKind, owner_id as ownerId, position, prompt,
  options_json as optionsJson, attachments_json as attachmentsJson, delivery_state as deliveryState,
  created_at as createdAt, updated_at as updatedAt`;

/** Entries with a delivery attempt in progress are not part of the editable queue. */
const QUEUED_FOLLOW_UP_AVAILABLE_SQL = "(delivery_state is null or delivery_state = 'uncertain')";

const parseQueuedFollowUpDeliveryState = (value: string | null): QueuedFollowUpDeliveryState | null =>
  value === "starting" || value === "steering" || value === "uncertain" ? value : null;

const base64DecodedSize = (value: string): number => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
};

const QUEUED_FOLLOW_UP_MODES = new Set<string>(["code", "plan", "ask"]);
const createId = () => crypto.randomUUID();

export interface RunForgeRequestCacheRecord {
  runId: string;
  projectId: string;
  branchName: string;
  headSha: string | null;
  lastProbeAt: string | null;
  negativeCacheUntil: string | null;
  syncError: string | null;
  summary: RunForgeRequestSummary | null;
  details: RunForgeRequestDetailsResult | null;
  etag: string | null;
  lastModified: string | null;
  errorCount: number;
  retryAfterAt: string | null;
}

/** One aggregate row of {@link BuildWardenDatabase.listTokenUsageCostRows}. */
export interface TokenUsageCostRow {
  /** Local `YYYY-MM-DD` day or `YYYY-MM-DDTHH` hour. */
  bucket: string;
  projectId: string | null;
  projectName: string | null;
  providerType: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Present on account API rows; local SQLite usage continues to use model list prices. */
  reportedCostUsd?: number | null;
  /** Recorded transcript service tier; old local events retain standard pricing. */
  speed?: "standard" | "fast" | "ultrafast";
}

export interface ModelDeletionTargets {
  runIds: string[];
  chatIds: string[];
  projectInsightIds: string[];
  projectLabThreadIds: string[];
  projectLoopIds: string[];
  orchestrationIds: string[];
  automationIds: string[];
}

type StoredRunForgeRequestCacheRecord = Omit<RunForgeRequestCacheRecord, "summary" | "details"> & {
  summaryJson: string | null;
  detailsJson: string | null;
};
const chunkValues = <T>(values: readonly T[], size = SQLITE_VARIABLE_BATCH_SIZE): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/** Snapshot task summaries carry a prompt preview; the full prompt loads with getProjectTask. */
const PROJECT_TASK_SUMMARY_PROMPT_CHARS = 2000;

type DerivedRunState = {
  parts: Set<string>;
  lastUserInputAt: string;
  pendingUserInputRequest: boolean;
};

type DerivedRunStateSource = Pick<RunRecord, "id" | "prompt" | "goalText" | "createdAt">;

const createDerivedRunState = (run: DerivedRunStateSource): DerivedRunState => {
  const parts = new Set<string>();
  if (run.prompt.trim()) parts.add(run.prompt.trim());
  if (run.goalText?.trim()) parts.add(run.goalText.trim());
  return { parts, lastUserInputAt: run.createdAt, pendingUserInputRequest: false };
};

const applyDerivedRunStep = (
  derived: DerivedRunState,
  step: { eventType: string; content: string; createdAt: string },
  metadata: Record<string, unknown> | null,
): void => {
  const isUserInputRequest = metadata?.requestKind === "user-input";
  if (step.eventType === "user-input-requested" && isUserInputRequest && metadata.requestStatus === "opened") {
    derived.pendingUserInputRequest = true;
  }
  const isSubmittedUserInput = isUserInputRequest && metadata?.requestStatus === "resolved";
  if ((metadata?.source === "user" || isSubmittedUserInput) && step.content.trim()) {
    derived.parts.add(step.content.trim());
    derived.lastUserInputAt = step.createdAt;
  }
  // A tracked request keeps its question as content and records the answers in metadata.
  const answers = isSubmittedUserInput ? metadata.userInputAnswers : null;
  if (answers && typeof answers === "object") {
    for (const value of Object.values(answers as Record<string, unknown>).flat()) {
      if (typeof value === "string" && value.trim()) derived.parts.add(value.trim());
    }
  }
};

export class BuildWardenDatabase {
  private settingsRevision = 0;
  getSettingsRevision(): number { return this.settingsRevision; }
  private historyPrefixRevision(
    table: HistoryTable,
    ownerColumn: "run_id" | "chat_id",
    ownerId: string,
    cursor: HistoryCursor,
  ): string {
    const predicate = `rowid < ?`;
    const params: SQLInputValue[] = [ownerId, cursor.sequence];
    const count = this.first<{ count: number }>(
      `select count(*) as count from ${table} where ${ownerColumn} = ? and ${predicate}`,
      params,
    )?.count ?? 0;
    const newest = this.first<HistoryCursor>(
      `select created_at as createdAt, id, rowid as sequence from ${table} where ${ownerColumn} = ? and ${predicate} order by rowid desc limit 1`,
      params,
    );
    return `${String(count)}:${newest ? encodeHistoryCursor(newest) : "empty"}`;
  }

  private getHistorySteps<TStep extends HistoryStep>(
    table: HistoryTable,
    ownerColumn: "run_id" | "chat_id",
    ownerAlias: "runId" | "chatId",
    ownerId: string,
    lowerBound?: HistoryCursor,
    upperBound?: HistoryCursor,
  ): TStep[] {
    const clauses = [`${ownerColumn} = ?`];
    const params: SQLInputValue[] = [ownerId];
    if (lowerBound) {
      clauses.push(`rowid >= ?`);
      params.push(lowerBound.sequence);
    }
    if (upperBound) {
      clauses.push(`rowid < ?`);
      params.push(upperBound.sequence);
    }
    return this.all<TStep>(
      `select id, ${ownerColumn} as ${ownerAlias}, event_type as eventType, title, content, metadata_json as metadataJson, created_at as createdAt
       from ${table} where ${clauses.join(" and ")} order by rowid asc`,
      params,
    );
  }

  private getHistoryUserAnchors(
    table: HistoryTable,
    ownerColumn: "run_id" | "chat_id",
    ownerId: string,
    limit: number,
    before?: HistoryCursor,
  ): HistoryCursor[] {
    const beforeClause = before ? `and rowid < ?` : "";
    const params: SQLInputValue[] = before
      ? [ownerId, before.sequence, limit]
      : [ownerId, limit];
    return this.all<HistoryCursor>(
      `select created_at as createdAt, id, rowid as sequence from ${table}
       where ${ownerColumn} = ? ${beforeClause}
         and event_type = 'log'
         and json_valid(metadata_json)
         and json_extract(metadata_json, '$.source') = 'user'
       order by rowid desc limit ?`,
      params,
    );
  }

  private getInitialHistoryPage<TStep extends HistoryStep>(
    table: HistoryTable,
    ownerColumn: "run_id" | "chat_id",
    ownerAlias: "runId" | "chatId",
    ownerId: string,
  ): { steps: TStep[]; page: UserAnchoredHistoryPageInfo } {
    const anchors = this.getHistoryUserAnchors(
      table,
      ownerColumn,
      ownerId,
      INITIAL_USER_HISTORY_TURN_LIMIT + 1,
    );
    const hasMore = anchors.length > INITIAL_USER_HISTORY_TURN_LIMIT;
    if (!hasMore) {
      return {
        steps: this.getHistorySteps<TStep>(table, ownerColumn, ownerAlias, ownerId),
        page: { beforeCursor: null, hasMore: false, snapshotRevision: "complete" },
      };
    }
    const boundary = anchors[INITIAL_USER_HISTORY_TURN_LIMIT - 1]!;
    return {
      steps: this.getHistorySteps<TStep>(table, ownerColumn, ownerAlias, ownerId, boundary),
      page: {
        beforeCursor: encodeHistoryCursor(boundary),
        hasMore: true,
        snapshotRevision: this.historyPrefixRevision(table, ownerColumn, ownerId, boundary),
      },
    };
  }

  private getEarlierHistoryPage<TStep extends HistoryStep>(
    table: HistoryTable,
    ownerColumn: "run_id" | "chat_id",
    ownerAlias: "runId" | "chatId",
    ownerId: string,
    request: UserAnchoredHistoryPageRequest,
  ): { steps: TStep[]; page: UserAnchoredHistoryPageInfo; stale: boolean } {
    const upperBound = decodeHistoryCursor(request.beforeCursor);
    const currentRevision = this.historyPrefixRevision(table, ownerColumn, ownerId, upperBound);
    if (currentRevision !== request.snapshotRevision) {
      return {
        steps: [],
        page: {
          beforeCursor: request.beforeCursor,
          hasMore: true,
          snapshotRevision: currentRevision,
        },
        stale: true,
      };
    }

    const anchors = this.getHistoryUserAnchors(
      table,
      ownerColumn,
      ownerId,
      EARLIER_USER_HISTORY_TURN_LIMIT + 1,
      upperBound,
    );
    const hasMore = anchors.length > EARLIER_USER_HISTORY_TURN_LIMIT;
    const boundary = hasMore ? anchors[EARLIER_USER_HISTORY_TURN_LIMIT - 1]! : undefined;
    return {
      steps: this.getHistorySteps<TStep>(table, ownerColumn, ownerAlias, ownerId, boundary, upperBound),
      page: boundary
        ? {
            beforeCursor: encodeHistoryCursor(boundary),
            hasMore: true,
            snapshotRevision: this.historyPrefixRevision(table, ownerColumn, ownerId, boundary),
          }
        : { beforeCursor: null, hasMore: false, snapshotRevision: "complete" },
      stale: false,
    };
  }

  private db: DatabaseSync | null = null;
  /**
   * Full user-input text is needed only for search and legacy summary backfills.
   * Ordinary list reads use durable run_list_summaries without loading this text.
   */
  private readonly derivedRunStateCache = new Map<string, DerivedRunState>();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    const databaseExisted = existsSync(this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    try {
      // Match JavaScript's Unicode case folding while filtering history in SQL.
      this.db.function("history_contains", { deterministic: true }, (text, query) =>
        String(text ?? "").toLowerCase().includes(String(query ?? "")) ? 1 : 0);
      this.exec("pragma busy_timeout = 5000");
      const existingJournalMode = this.first<{ journal_mode: string }>("pragma journal_mode")?.journal_mode.toLowerCase();
      if (databaseExisted && existingJournalMode !== "wal") {
        this.createPreWalBackup();
      }
      this.exec("pragma journal_mode = WAL");
      this.exec("pragma synchronous = NORMAL");
      this.exec("pragma wal_autocheckpoint = 1000");

      this.transaction(() => {
        this.createInitialSchema();
        this.applySchemaMigrations();
        this.exec(`pragma user_version = ${String(BUILDWARDEN_DATABASE_SCHEMA_VERSION)}`);
      });
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the original initialization failure.
      } finally {
        this.db = null;
      }
      throw error;
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  listSkillPackages(): SkillPackageRecord[] {
    return this.all<{ record_json: string }>("select record_json from skill_packages order by id")
      .map((row) => JSON.parse(row.record_json) as SkillPackageRecord);
  }

  saveSkillPackage(record: SkillPackageRecord): void {
    this.run("insert into skill_packages (id, record_json) values (?, ?) on conflict(id) do update set record_json = excluded.record_json",
      [record.metadata.id, JSON.stringify(record)]);
  }

  removeSkillPackage(id: string): void {
    this.run("delete from skill_packages where id = ?", [id]);
  }

  getSessionSkills(kind: "run" | "chat", id: string): SkillSessionSnapshot | null {
    const row = this.first<{ snapshot_json: string }>("select snapshot_json from skill_session_state where owner_kind = ? and owner_id = ?", [kind, id]);
    return row ? JSON.parse(row.snapshot_json) as SkillSessionSnapshot : null;
  }

  setSessionSkills(kind: "run" | "chat", id: string, snapshot: SkillSessionSnapshot): void {
    this.run("insert into skill_session_state (owner_kind, owner_id, snapshot_json) values (?, ?, ?) on conflict(owner_kind, owner_id) do update set snapshot_json = excluded.snapshot_json",
      [kind, id, JSON.stringify(snapshot)]);
  }

  async close(): Promise<void> {
    if (!this.db) return;
    const database = this.db;
    try {
      this.checkpoint("truncate");
    } finally {
      try {
        database.close();
      } finally {
        this.db = null;
        this.derivedRunStateCache.clear();
      }
    }
  }

  /** Nested calls become savepoints, so helpers that open a transaction compose atomically. */
  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `bw_sp_${String(this.transactionDepth)}`;
      this.exec(`savepoint ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = operation();
        this.exec(`release ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.exec(`rollback to ${savepoint}`);
          this.exec(`release ${savepoint}`);
        } catch {
          // Preserve the original failure.
        }
        this.derivedRunStateCache.clear();
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.exec("begin immediate");
    this.transactionDepth = 1;
    try {
      const result = operation();
      this.exec("commit");
      return result;
    } catch (error) {
      try {
        this.exec("rollback");
      } catch {
        // Preserve the original failure.
      }
      this.derivedRunStateCache.clear();
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private transactionDepth = 0;

  async flushDurable(): Promise<void> {
    if (this.db) this.checkpoint("full");
  }

  /** Creates a consistent, standalone SQLite snapshot without copying WAL sidecars. */
  createPortableSnapshot(targetPath: string): void {
    if (existsSync(targetPath)) unlinkSync(targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    const escapedTargetPath = targetPath.replaceAll("'", "''");
    this.exec(`vacuum into '${escapedTargetPath}'`);
  }

  /** Rewrites paths for artifacts that are owned by BuildWarden's data directory. */
  rebaseManagedArtifactPaths(previousDataDirectory: string, nextDataDirectory: string): void {
    const previous = previousDataDirectory.replace(/[\\/]+$/, "");
    const next = nextDataDirectory.replace(/[\\/]+$/, "");
    if (!previous || !next || previous === next) return;

    const rebaseColumn = (table: string, column: string): void => {
      const rows = this.all<{ id: string; artifactPath: string | null }>(
        `select id, ${column} as artifactPath from ${table} where ${column} is not null`,
      );
      for (const row of rows) {
        if (!row.artifactPath) continue;
        const startsWithinPrevious = row.artifactPath === previous ||
          (row.artifactPath.startsWith(previous) && /[\\/]/.test(row.artifactPath[previous.length] ?? ""));
        if (!startsWithinPrevious) continue;
        const suffixSegments = row.artifactPath
          .slice(previous.length)
          .split(/[\\/]+/)
          .filter(Boolean);
        this.run(`update ${table} set ${column} = ? where id = ?`, [join(next, ...suffixSegments), row.id]);
      }
    };

    this.transaction(() => {
      rebaseColumn("project_loop_ui_reviews", "image_path");
      rebaseColumn("orchestration_waves", "baseline_path");
      rebaseColumn("orchestration_adoptions", "backup_path");
    });
  }

  /** Checkpoints and truncates the WAL synchronously during process shutdown. */
  flushToDiskSync(): void {
    if (this.db) this.checkpoint("truncate");
  }

  /** Clears the database file and reinitializes with a fresh schema. Complete reset. */
  async resetAndReinit(): Promise<void> {
    this.settingsRevision += 1;
    await this.close();
    for (const path of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      if (existsSync(path)) unlinkSync(path);
    }
    await this.init();
  }

  getSnapshot(
    selectedProjectId: string | null = null,
    selectedRunId: string | null = null,
    selectedChatId: string | null = null,
  ): AppSnapshot {
    const orchestrationStatusByCoordinatorRunId = new Map(
      this.all<{ coordinatorRunId: string; status: OrchestrationStatus }>(
        "select coordinator_run_id as coordinatorRunId, status from orchestrations",
      ).map((row) => [row.coordinatorRunId, row.status] as const),
    );
    const activeOrchestrationStatuses = new Set<OrchestrationStatus>(["active", "waiting", "paused", "attention"]);
    const projects = this.listProjects().map((project) => {
      const allRuns = this.listRunsForProject(project.id, true).map((run) => {
        const orchestrationStatus = orchestrationStatusByCoordinatorRunId.get(run.id);
        return orchestrationStatus ? { ...run, orchestrationStatus } : run;
      });
      const visibleRuns = allRuns.filter((run) => run.kind === "standard");
      const orchestratedRuns = allRuns.filter((run) => run.kind === "orchestration-task");
      const runs = visibleRuns.filter((run) => run.listVisibility !== "for-later");
      const forLaterRuns = visibleRuns.filter((run) => run.listVisibility === "for-later");
      const activeCoordinatorIds = new Set(
        runs
          .filter((run) => run.orchestrationStatus && activeOrchestrationStatuses.has(run.orchestrationStatus))
          .map((run) => run.id),
      );
      return {
        project,
        runs,
        forLaterRuns,
        orchestratedRuns,
        activeRuns: runs.filter((run) =>
          ["queued", "preparing", "running"].includes(run.status) || activeCoordinatorIds.has(run.id),
        ),
        recentRuns: runs.slice(0, 12),
        tasks: this.listProjectTaskSummaries(project.id),
        automations: this.listProjectAutomationItems(project.id, allRuns),
        insights: this.listProjectInsightSummaries(project.id),
        labThreads: this.listProjectLabThreadSummaries(project.id, allRuns),
        loops: this.listProjectLoopListItems(project.id),
      } satisfies ProjectSnapshot;
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const settings = this.getSettings();
    return {
      projects,
      runOrganization: this.getRunOrganization(),
      providerAccounts: this.listProviderAccounts(),
      models: this.listModels(),
      selectedProjectId,
      selectedRunId,
      selectedChatId,
      settings,
      bookmarks: this.listBookmarks(),
      chatBookmarks: this.listChatBookmarks(),
      chats: this.listChats(),
      tokenUsage: {
        standaloneChats: this.getStandaloneChatTokenUsage(),
        today: this.getTokenUsageSince(todayStart.toISOString()),
        costTrackingEnabled: parseUsageCostTrackingEnabledSetting(settings[APP_SETTING_KEYS.usageCostTrackingEnabled]),
      },
    };
  }

  getRunOrganization(): RunOrganizationSnapshot {
    const sections = this.all<RunSectionRecord>("select id, name, position, color from run_sections order by position, id");
    const runs = this.all<{ runId: string; sectionId: string | null; tagsJson: string }>(
      "select run_id as runId, section_id as sectionId, tags_json as tagsJson from run_organization",
    ).map(({ tagsJson, ...record }): RunOrganizationRecord => ({ ...record, tags: JSON.parse(tagsJson) as string[] }));
    const color = this.first<{ value: string }>("select value from app_settings where key = ?", [APP_SETTING_KEYS.uncategorizedRunSectionColor])?.value;
    return { sections, runs, ...(isRunSectionColor(color) ? { uncategorizedColor: color } : {}) };
  }

  private validateRunSectionName(name: string, exceptId?: string): string {
    if (!isRunSectionName(name)) throw new Error("Use a section name of 1–80 characters other than Uncategorized.");
    const trimmed = name.trim();
    if (this.getRunOrganization().sections.some((section) => section.id !== exceptId &&
      section.name.toLowerCase() === trimmed.toLowerCase())) throw new Error("A section with this name already exists.");
    return trimmed;
  }

  private requireRunSection(sectionId: string): void {
    if (typeof sectionId !== "string" || !this.first("select id from run_sections where id = ?", [sectionId])) {
      throw new Error("Run section not found.");
    }
  }

  createRunSection(name: string, color = DEFAULT_RUN_SECTION_COLOR): RunOrganizationSnapshot {
    if (!isRunSectionColor(color)) throw new Error("Use a six-digit hex color, such as #60a5fa.");
    return this.transaction(() => {
      const trimmed = this.validateRunSectionName(name);
      if (this.getRunOrganization().sections.length >= 100) throw new Error("You can create up to 100 run sections.");
      this.run("insert into run_sections (id, name, color, position) values (?, ?, ?, (select coalesce(max(position), -1) + 1 from run_sections))", [createId(), trimmed, color.toLowerCase()]);
      return this.getRunOrganization();
    });
  }

  renameRunSection(sectionId: string, name: string): RunOrganizationSnapshot {
    return this.transaction(() => {
      this.requireRunSection(sectionId);
      const trimmed = this.validateRunSectionName(name, sectionId);
      this.run("update run_sections set name = ? where id = ?", [trimmed, sectionId]);
      return this.getRunOrganization();
    });
  }

  setRunSectionColor(sectionId: string, color: string): RunOrganizationSnapshot {
    if (!isRunSectionColor(color)) throw new Error("Use a six-digit hex color, such as #60a5fa.");
    return this.transaction(() => {
      if (sectionId === UNCATEGORIZED_RUN_SECTION_ID) {
        this.setSetting(APP_SETTING_KEYS.uncategorizedRunSectionColor, color.toLowerCase());
      } else {
        this.requireRunSection(sectionId);
        this.run("update run_sections set color = ? where id = ?", [color.toLowerCase(), sectionId]);
      }
      return this.getRunOrganization();
    });
  }

  deleteRunSection(sectionId: string): RunOrganizationSnapshot {
    return this.transaction(() => {
      this.requireRunSection(sectionId);
      this.run("update run_organization set section_id = null where section_id = ?", [sectionId]);
      this.run("delete from run_sections where id = ?", [sectionId]);
      return this.getRunOrganization();
    });
  }

  reorderRunSections(sectionIds: string[]): RunOrganizationSnapshot {
    return this.transaction(() => {
      const current = this.getRunOrganization().sections;
      if (!Array.isArray(sectionIds) || sectionIds.length !== current.length ||
        new Set(sectionIds).size !== current.length || current.some((section) => !sectionIds.includes(section.id))) {
        throw new Error("Section order must contain every custom section exactly once.");
      }
      sectionIds.forEach((id, position) => this.run("update run_sections set position = ? where id = ?", [position, id]));
      return this.getRunOrganization();
    });
  }

  updateRunOrganization(runId: string, input: UpdateRunOrganizationInput): RunOrganizationSnapshot {
    if (!isUpdateRunOrganizationInput(input)) throw new Error(`Invalid run metadata. Use up to ${RUN_TAG_COUNT_LIMIT} tags of 1–${RUN_TAG_LIMIT} characters.`);
    return this.transaction(() => {
      this.getRun(runId);
      const current = this.first<{ sectionId: string | null; tagsJson: string }>(
        "select section_id as sectionId, tags_json as tagsJson from run_organization where run_id = ?", [runId],
      );
      const requestedSection = input.sectionId === UNCATEGORIZED_RUN_SECTION_ID ? null : input.sectionId;
      const sectionId = requestedSection === undefined ? current?.sectionId ?? null : requestedSection;
      if (sectionId !== null) this.requireRunSection(sectionId);
      const tagsJson = input.tags === undefined ? current?.tagsJson ?? "[]" :
        JSON.stringify([...new Set(input.tags.map((tag) => tag.trim().toLowerCase()))]);
      this.run(`insert into run_organization (run_id, section_id, tags_json) values (?, ?, ?)
        on conflict(run_id) do update set section_id = excluded.section_id, tags_json = excluded.tags_json`, [runId, sectionId, tagsJson]);
      return this.getRunOrganization();
    });
  }

  listBookmarks(): BookmarkSummary[] {
    return this.all<BookmarkSummary>(
      `
      select id, original_run_id as originalRunId
      from bookmarks
      order by bookmarked_at desc
      `,
    );
  }

  listChatBookmarks(): ChatBookmarkSummary[] {
    return this.all<ChatBookmarkSummary>(
      `
      select id, original_chat_id as originalChatId
      from chat_bookmarks
      order by bookmarked_at desc
      `,
    );
  }

  addBookmark(runId: string): void {
    const existing = this.first<{ id: string }>("select id from bookmarks where original_run_id = ?", [runId]);
    if (existing) {
      return;
    }
    const run = this.getRun(runId);
    const project = this.getProject(run.projectId);
    const steps = this.getRunSteps(runId);
    const bookmarkId = createId();
    const bookmarkedAt = nowIso();
    let branchName = run.branchName;
    if (run.workspaceVcs === "folder") branchName = run.workspaceType === "copy" ? "Folder copy" : "Project folder";

    this.run(
      `
      insert into bookmarks (id, original_run_id, project_id, project_name, prompt, status, branch_name, run_created_at, bookmarked_at, model_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        bookmarkId,
        runId,
        run.projectId,
        project.name,
        run.prompt,
        run.status,
        branchName,
        run.createdAt,
        bookmarkedAt,
        run.modelId,
      ],
    );

    this.run("update bookmarks set title = (select title from runs where id = ?) where id = ?", [runId, bookmarkId]);

    for (const step of steps) {
      const stepId = createId();
      this.run(
        `
        insert into bookmark_steps (id, bookmark_id, event_type, title, content, metadata_json, created_at)
        values (?, ?, ?, ?, ?, ?, ?)
        `,
        [stepId, bookmarkId, step.eventType, step.title, step.content, step.metadataJson, step.createdAt],
      );
    }
  }

  removeBookmark(runId: string): void {
    const bookmark = this.first<{ id: string }>("select id from bookmarks where original_run_id = ?", [runId]);
    if (bookmark) {
      this.removeBookmarkById(bookmark.id);
    }
  }

  removeBookmarkById(bookmarkId: string): void {
    this.run("delete from bookmark_steps where bookmark_id = ?", [bookmarkId]);
    this.run("delete from bookmarks where id = ?", [bookmarkId]);
  }

  isBookmarked(runId: string): boolean {
    const row = this.first<{ id: string }>("select id from bookmarks where original_run_id = ?", [runId]);
    return Boolean(row);
  }

  getBookmarksWithSteps(): BookmarkRecord[] {
    const bookmarks = this.all<Omit<BookmarkRecord, "steps">>(
      `
      select
        id,
        original_run_id as originalRunId,
        ${BOOKMARK_TITLE_SQL}
        project_id as projectId,
        project_name as projectName,
        prompt,
        status,
        branch_name as branchName,
        model_id as modelId,
        run_created_at as runCreatedAt,
        bookmarked_at as bookmarkedAt
      from bookmarks
      order by bookmarked_at desc
      `,
    );

    return bookmarks.map((bm) => {
      const steps = this.all<BookmarkStepRecord>(
        `
        select
          id,
          bookmark_id as bookmarkId,
          event_type as eventType,
          title,
          content,
          metadata_json as metadataJson,
          created_at as createdAt
        from bookmark_steps
        where bookmark_id = ?
        order by created_at asc
        `,
        [bm.id],
      );
      const modelId = (bm as { modelId?: string | null }).modelId ?? null;
      return { ...bm, modelId, steps };
    });
  }

  listChats(): ChatSummary[] {
    // Run-scoped chats live inside the run detail view and stay out of the Chats page.
    return this.all<ChatSummary>(
      `
      select id, ${SESSION_TITLE_SQL} prompt, status, created_at as createdAt, run_id as runId
      from chats
      where run_id is null
      order by updated_at desc
      `,
    );
  }

  /**
   * Search only project-owned history and hydrate at most one page plus a continuation row.
   * Prompts and summaries match by substring. With the trigram index, transcripts (agent output
   * and logged prompts) match too; without it, or for queries shorter than a trigram, only
   * prompts and summaries are searched.
   */
  searchProjectHistory(projectId: string, query: string, offset: number) {
    const useIndex = this.historySearchIndex === "fts" && Array.from(query).length >= 3;
    // Steps written since the last indexing pass become searchable before this query runs.
    if (useIndex) this.drainHistorySearchQueue(5_000);
    const match = `"${query.replaceAll('"', '""')}"`;
    const rows = this.all<{ kind: "run" | "chat"; id: string; prompt: string; summary: string; status: string; snippet: string | null }>(
      `with entries as (
        select 0 as kindOrder, 'run' as kind, 0 as kindBit, id, prompt, coalesce(summary, '') as summary, status, created_at as sortAt
        from runs where project_id = ?
        union all
        select 1, 'chat', 1, c.id, c.prompt, '', c.status, c.updated_at
        from chats c join runs r on r.id = c.run_id where r.project_id = ?
      ),
      hits as (${useIndex
        ? "select distinct owner_id as ownerId, kind as kindBit from history_fts where history_fts match ?"
        : "select null as ownerId, null as kindBit where ? is null"})
      select kind, id, substr(prompt, 1, 500) as prompt, substr(summary, 1, 1000) as summary, status,
        ${useIndex
          ? `case when history_contains(prompt || char(10) || summary, ?) then null else (
              select snippet(history_fts, 0, '[', ']', '…', 24) from history_fts
              where history_fts match ? and owner_id = entries.id and kind = entries.kindBit limit 1) end`
          : "null"} as snippet
      from entries where ? = '' or history_contains(prompt || char(10) || summary, ?)
        or exists (select 1 from hits where hits.ownerId = entries.id and hits.kindBit = entries.kindBit)
      order by kindOrder, sortAt desc, id asc limit 21 offset ?`,
      [projectId, projectId, useIndex ? match : "", ...(useIndex ? [query, match] : []), query, query, offset],
    );
    const items = rows.slice(0, 20).map(({ snippet, ...row }) =>
      snippet ? { ...row, matchedIn: "transcript" as const, snippet } : row);
    return {
      items,
      nextOffset: rows.length > 20 ? offset + 20 : null,
      searchedTranscripts: useIndex,
      ...(this.historySearchIndex === "fts" && !this.historySearchBackfillComplete() ? { indexIncomplete: true } : {}),
    };
  }

  private historySearchIndex: "fts" | "substring" = "substring";

  /**
   * Trigram full-text index over run and chat transcripts (agent output and logged prompts).
   * Triggers only queue the ids of changed steps in a plain table; the index itself is updated
   * by `drainHistorySearchQueue` (before every search and from the background backfill). Writing
   * to the FTS table from triggers breaks statement preparation after another connection changes
   * the schema, so no trigger touches it. Entries are keyed by step id ("r:" run, "c:" chat), not
   * rowid, because VACUUM may renumber rowids of tables without an integer primary key.
   * SQLite builds without FTS5 or the trigram tokenizer keep the substring search.
   */
  private ensureHistorySearchIndex(): void {
    try {
      this.exec("create virtual table if not exists history_fts using fts5(content, owner_id unindexed, kind unindexed, tokenize = 'trigram')");
    } catch {
      this.historySearchIndex = "substring";
      return;
    }
    this.historySearchIndex = "fts";
    this.exec(`
      create table if not exists history_index_map (step_key text primary key, fts_rowid integer not null);
      create table if not exists history_index_queue (step_key text primary key);
      create table if not exists history_index_backfill (source text primary key, cursor text not null default '', done integer not null default 0);
      insert or ignore into history_index_backfill (source) values ('run_steps'), ('chat_steps');
    `);
    for (const [table, prefix] of [["run_steps", "r"], ["chat_steps", "c"]] as const) {
      const trigger = `bw_history_queue_${table}`;
      this.exec(`
        create trigger if not exists ${trigger}_insert after insert on ${table}
        when new.event_type in ${HISTORY_SEARCH_EVENT_TYPES} begin
          insert or ignore into history_index_queue (step_key) values ('${prefix}:' || new.id);
        end;
        create trigger if not exists ${trigger}_update after update of content, title, event_type on ${table} begin
          insert or ignore into history_index_queue (step_key) values ('${prefix}:' || new.id);
        end;
        create trigger if not exists ${trigger}_delete after delete on ${table} begin
          insert or ignore into history_index_queue (step_key) values ('${prefix}:' || old.id);
        end;
      `);
    }
  }

  /** Replaces the index entry for one step with its current text, or removes it. */
  private reindexHistoryStep(stepKey: string): void {
    const mapped = this.first<{ ftsRowid: number }>("select fts_rowid as ftsRowid from history_index_map where step_key = ?", [stepKey]);
    if (mapped) {
      this.run("delete from history_fts where rowid = ?", [mapped.ftsRowid]);
      this.run("delete from history_index_map where step_key = ?", [stepKey]);
    }
    const separator = stepKey.indexOf(":");
    const kind = stepKey.slice(0, separator);
    const id = stepKey.slice(separator + 1);
    const row = this.first<{ ownerId: string; text: string }>(
      kind === "r"
        ? `select run_id as ownerId, substr(title || char(10) || content, 1, ${String(HISTORY_SEARCH_MAX_STEP_CHARS)}) as text
           from run_steps where id = ? and event_type in ${HISTORY_SEARCH_EVENT_TYPES}`
        : `select chat_id as ownerId, substr(title || char(10) || content, 1, ${String(HISTORY_SEARCH_MAX_STEP_CHARS)}) as text
           from chat_steps where id = ? and event_type in ${HISTORY_SEARCH_EVENT_TYPES}`,
      [id],
    );
    if (!row) return;
    this.run("insert into history_fts (content, owner_id, kind) values (?, ?, ?)", [row.text, row.ownerId, kind === "r" ? 0 : 1]);
    const inserted = this.first<{ id: number }>("select last_insert_rowid() as id");
    this.run("insert into history_index_map (step_key, fts_rowid) values (?, ?)", [stepKey, Number(inserted?.id ?? 0)]);
  }

  /** Applies queued step changes to the index. Returns true while more remain. */
  private drainHistorySearchQueue(limit: number): boolean {
    if (this.historySearchIndex !== "fts") return false;
    const keys = this.all<{ stepKey: string }>("select step_key as stepKey from history_index_queue order by step_key limit ?", [limit + 1]);
    if (keys.length === 0) return false;
    this.transaction(() => {
      for (const { stepKey } of keys.slice(0, limit)) {
        this.reindexHistoryStep(stepKey);
        this.run("delete from history_index_queue where step_key = ?", [stepKey]);
      }
    });
    return keys.length > limit;
  }

  private historySearchBackfillComplete(): boolean {
    return (this.first<{ pending: number }>("select count(*) as pending from history_index_backfill where done = 0")?.pending ?? 0) === 0;
  }

  /**
   * Indexes up to `batchSize` older steps per source and applies queued changes. Returns true
   * while work remains, so a caller can keep going in small slices without blocking.
   */
  backfillHistorySearchIndex(batchSize = 400): boolean {
    if (this.historySearchIndex !== "fts") return false;
    let remaining = this.drainHistorySearchQueue(batchSize);
    for (const [table, prefix] of [["run_steps", "r"], ["chat_steps", "c"]] as const) {
      const state = this.first<{ cursor: string; done: number }>("select cursor, done from history_index_backfill where source = ?", [table]);
      if (!state || state.done) continue;
      const ids = this.all<{ id: string }>(
        `select id from ${table} where id > ? and event_type in ${HISTORY_SEARCH_EVENT_TYPES} order by id limit ?`,
        [state.cursor, batchSize],
      );
      this.transaction(() => {
        for (const { id } of ids) {
          const stepKey = `${prefix}:${id}`;
          if (!this.first("select 1 from history_index_map where step_key = ?", [stepKey])) this.reindexHistoryStep(stepKey);
        }
        this.run("update history_index_backfill set cursor = ?, done = ? where source = ?", [
          ids.at(-1)?.id ?? state.cursor, ids.length < batchSize ? 1 : 0, table,
        ]);
      });
      if (ids.length === batchSize) remaining = true;
    }
    return remaining;
  }

  /** Scope by ID before reading; SQLite slices the transcript without hydrating all steps in JS.
   * Offsets count Unicode characters, so continuation pages never split a surrogate pair.
   */
  readProjectHistoryPage(projectId: string, kind: "run" | "chat", id: string, offset: number) {
    const target = kind === "run"
      ? "select prompt from runs where id = ? and project_id = ?"
      : "select c.prompt from chats c join runs r on r.id = c.run_id where c.id = ? and r.project_id = ?";
    const table = kind === "run" ? "run_steps" : "chat_steps";
    const owner = kind === "run" ? "run_id" : "chat_id";
    const page = this.first<{ text: string; totalChars: number }>(
      `with target as (${target}),
      bounds as (select ? as pageStart, ? as pageEnd),
      sizes as (
        select 0 as ordinal, null as stepRowId, length(prompt) as size from target
        union all
        select row_number() over (order by created_at, rowid), rowid,
          2 + length(created_at) + 1 + length(event_type) + 2 + length(title) + 1 + length(content)
        from ${table} where ${owner} = ? and exists (select 1 from target)
      ),
      spans as (
        select ordinal, stepRowId, size,
          coalesce(sum(size) over (order by ordinal rows between unbounded preceding and 1 preceding), 0) as startAt
        from sizes
      )
      select (select coalesce(sum(size), 0) from sizes) as totalChars,
        coalesce((select group_concat(piece, '') from (
          select substr(case when ordinal = 0 then (select prompt from target) else
            char(10) || char(10) || s.created_at || ' ' || s.event_type || ': ' || s.title || char(10) || s.content end,
            max(pageStart - startAt, 0) + 1,
            min(startAt + size, pageEnd) - max(startAt, pageStart)) as piece
          from spans cross join bounds left join ${table} s on s.rowid = spans.stepRowId
          where startAt < pageEnd and startAt + size > pageStart order by ordinal
        )), '') as text
      from target`,
      [id, projectId, offset, offset + 12_000, id],
    );
    if (!page) throw new Error("History entry does not belong to this project.");
    return { ...page, nextOffset: offset + 12_000 < page.totalChars ? offset + 12_000 : null };
  }

  listAllChats(): ChatRecord[] {
    return this.all<ChatRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        run_id as runId,
        ${SESSION_TITLE_SQL}
        prompt,
        status,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from chats
      order by updated_at desc
      `,
    );
  }

  getLatestChatForRun(runId: string): ChatRecord | null {
    const row = this.first<{ id: string }>(
      "select id from chats where run_id = ? order by created_at desc limit 1",
      [runId],
    );
    return row ? this.getChat(row.id) : null;
  }

  getChatsForRun(runId: string): ChatRecord[] {
    return this.all<{ id: string }>(
      "select id from chats where run_id = ? order by created_at desc",
      [runId],
    ).map((row) => this.getChat(row.id));
  }

  listChatsWithSteps(): ChatSearchDetail[] {
    const summaries = this.listChats();
    return summaries.map((summary) => ({
      chat: this.getChat(summary.id),
      // Select the source in SQLite, before loading multi-megabyte display blobs.
      // Attachment metadata is also unnecessary for list/search clients.
      steps: this.all<ChatSearchDetail["steps"][number]>(`
        select title, event_type as eventType,
          case when json_valid(metadata_json) then
            case when json_type(metadata_json, '$.responseSourceText') = 'text'
              then json_extract(metadata_json, '$.responseSourceText') else content end
            else content end as content
        from chat_steps where chat_id = ? order by created_at, rowid
      `, [summary.id]).map((step) => ({ ...step, content: getResponseSourceText(step) })),
    }));
  }

  addChatBookmark(chatId: string): void {
    const existing = this.first<{ id: string }>("select id from chat_bookmarks where original_chat_id = ?", [chatId]);
    if (existing) return;

    const chat = this.getChat(chatId);
    const steps = this.getChatSteps(chatId);
    const bookmarkId = createId();
    const bookmarkedAt = nowIso();

    this.run(
      `
      insert into chat_bookmarks (id, original_chat_id, prompt, status, chat_created_at, bookmarked_at, model_id)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [bookmarkId, chatId, chat.prompt, chat.status, chat.createdAt, bookmarkedAt, chat.modelId],
    );

    this.run("update chat_bookmarks set title = (select title from chats where id = ?) where id = ?", [chatId, bookmarkId]);

    for (const step of steps) {
      const stepId = createId();
      this.run(
        `
        insert into chat_bookmark_steps (id, chat_bookmark_id, event_type, title, content, metadata_json, created_at)
        values (?, ?, ?, ?, ?, ?, ?)
        `,
        [stepId, bookmarkId, step.eventType, step.title, step.content, step.metadataJson, step.createdAt],
      );
    }
  }

  removeChatBookmark(chatId: string): void {
    const bookmark = this.first<{ id: string }>("select id from chat_bookmarks where original_chat_id = ?", [chatId]);
    if (bookmark) this.removeChatBookmarkById(bookmark.id);
  }

  removeChatBookmarkById(bookmarkId: string): void {
    this.run("delete from chat_bookmark_steps where chat_bookmark_id = ?", [bookmarkId]);
    this.run("delete from chat_bookmarks where id = ?", [bookmarkId]);
  }

  isChatBookmarked(chatId: string): boolean {
    const row = this.first<{ id: string }>("select id from chat_bookmarks where original_chat_id = ?", [chatId]);
    return Boolean(row);
  }

  getChatBookmarksWithSteps(): ChatBookmarkRecord[] {
    const bookmarks = this.all<Omit<ChatBookmarkRecord, "steps">>(
      `
      select
        id,
        original_chat_id as originalChatId,
        ${BOOKMARK_TITLE_SQL}
        prompt,
        status,
        model_id as modelId,
        chat_created_at as chatCreatedAt,
        bookmarked_at as bookmarkedAt
      from chat_bookmarks
      order by bookmarked_at desc
      `,
    );

    return bookmarks.map((bm) => {
      const steps = this.all<BookmarkStepRecord>(
        `
        select
          id,
          chat_bookmark_id as bookmarkId,
          event_type as eventType,
          title,
          content,
          metadata_json as metadataJson,
          created_at as createdAt
        from chat_bookmark_steps
        where chat_bookmark_id = ?
        order by created_at asc
        `,
        [bm.id],
      );
      const modelId = (bm as { modelId?: string | null }).modelId ?? null;
      return { ...bm, modelId, steps };
    });
  }

  createChat(providerAccountId: string, modelId: string, prompt: string, runId?: string | null): ChatRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into chats (id, provider_account_id, model_id, run_id, prompt, status, last_provider_response_id, input_tokens, output_tokens, created_at, updated_at, started_at, finished_at)
      values (?, ?, ?, ?, ?, 'queued', null, 0, 0, ?, ?, null, null)
      `,
      [id, providerAccountId, modelId, runId ?? null, prompt, createdAt, createdAt],
    );
    return this.getChat(id);
  }

  createProjectTask(projectId: string, input: ProjectTaskInput): ProjectTaskRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into project_tasks (id, project_id, title, prompt, attachments_json, status, run_id, pull_request_url, created_at, updated_at)
      values (?, ?, ?, ?, ?, 'open', null, null, ?, ?)
      `,
      [id, projectId, input.title, input.prompt, JSON.stringify(input.attachments ?? []), createdAt, createdAt],
    );
    return this.getProjectTask(id);
  }

  updateProjectTask(taskId: string, input: UpdateProjectTaskInput): ProjectTaskRecord {
    const existing = this.getProjectTask(taskId);
    const nextTitle = input.title === undefined ? existing.title : input.title.trim();
    const nextPrompt = input.prompt === undefined ? existing.prompt : input.prompt.trim();
    const nextAttachments = input.attachments === undefined ? existing.attachments : input.attachments;
    if (!nextTitle) {
      throw new Error("Project task title cannot be empty.");
    }
    if (!nextPrompt) {
      throw new Error("Project task prompt cannot be empty.");
    }
    const nextStatus = input.status ?? existing.status;
    if (!(["open", "in_progress", "in_review", "done"] as const).includes(nextStatus)) {
      throw new Error(`Unsupported project task status: ${String(nextStatus)}`);
    }

    const updatedAt = nowIso();
    this.run(
      `
      update project_tasks
      set title = ?, prompt = ?, attachments_json = ?, status = ?, updated_at = ?
      where id = ?
      `,
      [nextTitle, nextPrompt, JSON.stringify(nextAttachments), nextStatus, updatedAt, taskId],
    );
    return this.getProjectTask(taskId);
  }

  getProjectTask(taskId: string): ProjectTaskRecord {
    const task = this.first<StoredProjectTaskRecord>(
      `
      select
        id,
        project_id as projectId,
        title,
        prompt,
        attachments_json as attachmentsJson,
        status,
        run_id as runId,
        pull_request_url as pullRequestUrl,
        created_at as createdAt,
        updated_at as updatedAt
      from project_tasks
      where id = ?
      `,
      [taskId],
    );
    if (!task) {
      throw new Error(`Project task not found: ${taskId}`);
    }
    return this.hydrateProjectTask(task);
  }

  listProjectTasks(projectId: string): ProjectTaskRecord[] {
    return this.all<StoredProjectTaskRecord>(
      `
      select
        id,
        project_id as projectId,
        title,
        prompt,
        attachments_json as attachmentsJson,
        status,
        run_id as runId,
        pull_request_url as pullRequestUrl,
        created_at as createdAt,
        updated_at as updatedAt
      from project_tasks
      where project_id = ?
      order by updated_at desc, created_at desc
      `,
      [projectId],
    ).map((task) => this.hydrateProjectTask(task));
  }

  listProjectTaskSummaries(projectId: string): ProjectTaskSummary[] {
    return this.all<Omit<ProjectTaskSummary, "promptTruncated"> & { promptTruncated: number }>(
      `
      select
        id,
        project_id as projectId,
        title,
        substr(prompt, 1, ${PROJECT_TASK_SUMMARY_PROMPT_CHARS}) as prompt,
        length(prompt) > ${PROJECT_TASK_SUMMARY_PROMPT_CHARS} as promptTruncated,
        case when json_valid(attachments_json) then json_array_length(attachments_json) else 0 end as attachmentCount,
        status,
        run_id as runId,
        pull_request_url as pullRequestUrl,
        created_at as createdAt,
        updated_at as updatedAt
      from project_tasks
      where project_id = ?
      order by updated_at desc, created_at desc
      `,
      [projectId],
    ).map((task) => ({ ...task, promptTruncated: Boolean(task.promptTruncated) }));
  }

  deleteProjectTask(taskId: string): void {
    this.run("update runs set project_task_id = null where project_task_id = ?", [taskId]);
    this.run("delete from project_tasks where id = ?", [taskId]);
  }

  createProjectAutomation(projectId: string, input: ProjectAutomationInput, nextRunAt: string, timeZone: string): ProjectAutomationRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `insert into project_automations (
        id, project_id, name, prompt, attachments_json, cron_expression, time_zone, model_id, effort,
        execution_options_json, workspace_type, base_branch, only_if_previous_finished, enabled, last_scheduled_at, next_run_at,
        last_error, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, ?, ?)`,
      [
        id, projectId, input.name.trim(), input.prompt.trim(), JSON.stringify(input.attachments ?? []),
        input.cronExpression.trim(), timeZone, input.modelId, input.effort?.trim() || "auto",
        JSON.stringify(input.executionOptions ?? {}), input.workspaceType, input.baseBranch?.trim() || null,
        Number(input.onlyIfPreviousFinished !== false), Number(input.enabled !== false), nextRunAt, createdAt, createdAt,
      ],
    );
    return this.getProjectAutomation(id);
  }

  getProjectAutomation(automationId: string): ProjectAutomationRecord {
    const automation = this.first<StoredProjectAutomationRecord>(
      `${PROJECT_AUTOMATION_SELECT} where id = ?`,
      [automationId],
    );
    if (!automation) throw new Error(`Project automation not found: ${automationId}`);
    return this.hydrateProjectAutomation(automation);
  }

  listProjectAutomations(projectId?: string): ProjectAutomationRecord[] {
    const where = projectId ? "where project_id = ?" : "";
    return this.all<StoredProjectAutomationRecord>(
      `${PROJECT_AUTOMATION_SELECT} ${where} order by name collate nocase asc`,
      projectId ? [projectId] : [],
    ).map((automation) => this.hydrateProjectAutomation(automation));
  }

  listProjectAutomationItems(projectId: string, projectRuns: RunListItem[]): ProjectAutomationListItem[] {
    const runs = projectRuns.filter((run) => run.kind === "automation" && run.automationId);
    return this.listProjectAutomations(projectId).map((record) => {
      const { attachments, ...automation } = record;
      return {
        automation: { ...automation, attachmentCount: attachments.length } satisfies ProjectAutomationSummary,
        runs: runs.filter((run) => run.automationId === record.id),
      };
    });
  }

  updateProjectAutomation(automationId: string, input: UpdateProjectAutomationInput, nextRunAt?: string, timeZone?: string): ProjectAutomationRecord {
    const existing = this.getProjectAutomation(automationId);
    const updatedAt = nowIso();
    this.run(
      `update project_automations set name = ?, prompt = ?, attachments_json = ?, cron_expression = ?, time_zone = ?,
        model_id = ?, effort = ?, execution_options_json = ?, workspace_type = ?, base_branch = ?,
        only_if_previous_finished = ?, enabled = ?,
        next_run_at = ?, last_error = null, updated_at = ? where id = ?`,
      [
        input.name?.trim() ?? existing.name,
        input.prompt?.trim() ?? existing.prompt,
        JSON.stringify(input.attachments ?? existing.attachments),
        input.cronExpression?.trim() ?? existing.cronExpression,
        timeZone ?? existing.timeZone,
        input.modelId ?? existing.modelId,
        input.effort?.trim() ?? existing.effort,
        JSON.stringify(input.executionOptions ?? existing.executionOptions),
        input.workspaceType ?? existing.workspaceType,
        input.baseBranch === undefined ? existing.baseBranch : input.baseBranch?.trim() || null,
        Number(input.onlyIfPreviousFinished ?? Boolean(existing.onlyIfPreviousFinished)),
        Number(input.enabled ?? Boolean(existing.enabled)),
        nextRunAt ?? existing.nextRunAt,
        updatedAt,
        automationId,
      ],
    );
    return this.getProjectAutomation(automationId);
  }

  markProjectAutomationScheduled(automationId: string, scheduledAt: string, nextRunAt: string, lastError: string | null = null): void {
    this.run(
      "update project_automations set last_scheduled_at = ?, next_run_at = ?, last_error = ?, updated_at = ? where id = ?",
      [scheduledAt, nextRunAt, lastError, nowIso(), automationId],
    );
  }

  setProjectAutomationError(automationId: string, lastError: string | null): void {
    this.run("update project_automations set last_error = ?, updated_at = ? where id = ?", [lastError, nowIso(), automationId]);
  }

  deleteProjectAutomation(automationId: string): void {
    this.run("delete from project_automations where id = ?", [automationId]);
  }

  linkProjectTaskToRun(taskId: string, runId: string): ProjectTaskRecord {
    const task = this.getProjectTask(taskId);
    const run = this.getRun(runId);
    if (task.projectId !== run.projectId) {
      throw new Error("Project task and run must belong to the same project.");
    }
    this.run(
      "update project_tasks set status = 'in_progress', run_id = ?, pull_request_url = null, updated_at = ? where id = ?",
      [runId, nowIso(), taskId],
    );
    return this.getProjectTask(taskId);
  }

  markProjectTaskInReview(taskId: string, pullRequestUrl?: string | null): ProjectTaskRecord {
    this.getProjectTask(taskId);
    const updatedAt = nowIso();
    if (pullRequestUrl === undefined) {
      this.run("update project_tasks set status = 'in_review', updated_at = ? where id = ?", [updatedAt, taskId]);
    } else {
      this.run(
        "update project_tasks set status = 'in_review', pull_request_url = ?, updated_at = ? where id = ?",
        [pullRequestUrl, updatedAt, taskId],
      );
    }
    return this.getProjectTask(taskId);
  }

  getProjectInsight(projectId: string, kind: ProjectInsightKind): ProjectInsightRecord | null {
    return (
      this.first<ProjectInsightRecord>(
        `
        select
          id,
          project_id as projectId,
          kind,
          title,
          summary,
          data_json as dataJson,
          model_id as modelId,
          generated_at as generatedAt,
          updated_at as updatedAt
        from project_insights
        where project_id = ? and kind = ?
        `,
        [projectId, kind],
      ) ?? null
    );
  }

  listProjectInsights(projectId: string): ProjectInsightRecord[] {
    return this.all<ProjectInsightRecord>(
      `
      select
        id,
        project_id as projectId,
        kind,
        title,
        summary,
        data_json as dataJson,
        model_id as modelId,
        generated_at as generatedAt,
        updated_at as updatedAt
      from project_insights
      where project_id = ? and kind in (${PROJECT_INSIGHT_KINDS.map(() => "?").join(", ")})
      order by updated_at desc, generated_at desc
      `,
      [projectId, ...PROJECT_INSIGHT_KINDS],
    );
  }

  private listProjectInsightSummaries(projectId: string): ProjectInsightSummary[] {
    return this.all<ProjectInsightSummary>(
      `select id, project_id as projectId, kind, title, substr(summary, 1, 500) as summary,
       model_id as modelId, generated_at as generatedAt, updated_at as updatedAt
       from project_insights where project_id = ? and kind in (${PROJECT_INSIGHT_KINDS.map(() => "?").join(", ")})
       order by updated_at desc, generated_at desc`, [projectId, ...PROJECT_INSIGHT_KINDS],
    );
  }

  upsertProjectInsight(input: {
    projectId: string;
    kind: ProjectInsightKind;
    title: string;
    summary: string;
    dataJson: string;
    modelId?: string | null;
  }): ProjectInsightRecord {
    const existing = this.getProjectInsight(input.projectId, input.kind);
    const timestamp = nowIso();
    if (existing) {
      this.run(
        `
        update project_insights
        set title = ?, summary = ?, data_json = ?, model_id = ?, generated_at = ?, updated_at = ?
        where id = ?
        `,
        [input.title, input.summary, input.dataJson, input.modelId ?? null, timestamp, timestamp, existing.id],
      );
      return this.getProjectInsight(input.projectId, input.kind)!;
    }

    const id = createId();
    this.run(
      `
      insert into project_insights (id, project_id, kind, title, summary, data_json, model_id, generated_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.projectId, input.kind, input.title, input.summary, input.dataJson, input.modelId ?? null, timestamp, timestamp],
    );
    return this.getProjectInsight(input.projectId, input.kind)!;
  }

  createProjectLabThread(input: {
      projectId: string;
      kind: ProjectLabThreadKind;
      mode: ProjectLabMode;
      status: ProjectLabThreadStatus;
    origin: "manual" | "idle" | "task";
    title: string;
      summary: string;
      outcome?: string | null;
      seedPrompt?: string | null;
      implementationPrompt?: string | null;
      implementationRunId?: string | null;
      implementationModelId?: string | null;
      reviewModelId?: string | null;
      baseBranch?: string | null;
  }): ProjectLabThreadRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
        `
        insert into project_lab_threads (
            id, project_id, kind, lab_mode, status, origin, title, summary, outcome, seed_prompt, implementation_prompt, implementation_run_id, implementation_model_id, review_model_id, base_branch, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            id,
          input.projectId,
          input.kind,
          input.mode,
          input.status,
        input.origin,
        input.title,
          input.summary,
          input.outcome ?? null,
          input.seedPrompt ?? null,
          input.implementationPrompt ?? null,
          input.implementationRunId ?? null,
          input.implementationModelId ?? null,
          input.reviewModelId ?? null,
          input.baseBranch ?? null,
          timestamp,
          timestamp,
      ],
    );
    return this.getProjectLabThread(id);
  }

  getProjectLabThread(threadId: string): ProjectLabThreadRecord {
    const thread = this.first<ProjectLabThreadRecord>(
      `
      select
        id,
          project_id as projectId,
          kind,
          coalesce(lab_mode, 'new-feature') as mode,
          status,
        origin,
        title,
        summary,
          outcome,
          seed_prompt as seedPrompt,
          implementation_prompt as implementationPrompt,
          implementation_run_id as implementationRunId,
          implementation_model_id as implementationModelId,
          review_model_id as reviewModelId,
          base_branch as baseBranch,
          created_at as createdAt,
          updated_at as updatedAt
      from project_lab_threads
      where id = ?
      `,
      [threadId],
    );
    if (!thread) {
      throw new Error(`Project Lab thread not found: ${threadId}`);
    }
    return thread;
  }

  listProjectLabThreads(projectId: string): ProjectLabThreadRecord[] {
    return this.all<ProjectLabThreadRecord>(
      `
      select
        id,
          project_id as projectId,
          kind,
          coalesce(lab_mode, 'new-feature') as mode,
          status,
        origin,
        title,
        summary,
          outcome,
          seed_prompt as seedPrompt,
          implementation_prompt as implementationPrompt,
          implementation_run_id as implementationRunId,
          implementation_model_id as implementationModelId,
          review_model_id as reviewModelId,
          base_branch as baseBranch,
          created_at as createdAt,
          updated_at as updatedAt
      from project_lab_threads
      where project_id = ?
      order by created_at desc
      `,
      [projectId],
    );
  }

  updateProjectLabThread(
    threadId: string,
    fields: {
        kind?: ProjectLabThreadKind;
        mode?: ProjectLabMode;
        status?: ProjectLabThreadStatus;
      title?: string;
      summary?: string;
        outcome?: string | null;
        seedPrompt?: string | null;
        implementationPrompt?: string | null;
        implementationRunId?: string | null;
        implementationModelId?: string | null;
        reviewModelId?: string | null;
        baseBranch?: string | null;
      },
  ): ProjectLabThreadRecord {
    const existing = this.getProjectLabThread(threadId);
    this.run(
        `
        update project_lab_threads
          set kind = ?, lab_mode = ?, status = ?, title = ?, summary = ?, outcome = ?, seed_prompt = ?, implementation_prompt = ?, implementation_run_id = ?, implementation_model_id = ?, review_model_id = ?, base_branch = ?, updated_at = ?
          where id = ?
          `,
        [
          fields.kind ?? existing.kind,
          fields.mode ?? existing.mode,
          fields.status ?? existing.status,
        fields.title ?? existing.title,
          fields.summary ?? existing.summary,
          fields.outcome !== undefined ? fields.outcome : existing.outcome,
          fields.seedPrompt !== undefined ? fields.seedPrompt : existing.seedPrompt,
          fields.implementationPrompt !== undefined ? fields.implementationPrompt : existing.implementationPrompt,
          fields.implementationRunId !== undefined ? fields.implementationRunId : existing.implementationRunId,
          fields.implementationModelId !== undefined ? fields.implementationModelId : existing.implementationModelId,
          fields.reviewModelId !== undefined ? fields.reviewModelId : existing.reviewModelId,
          fields.baseBranch !== undefined ? fields.baseBranch : existing.baseBranch,
          nowIso(),
          threadId,
      ],
    );
    return this.getProjectLabThread(threadId);
  }

  appendProjectLabEvent(input: {
    threadId: string;
    role: ProjectLabEventRecord["role"];
    label: string;
    content: string;
  }): ProjectLabEventRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into project_lab_events (id, thread_id, role, label, content, created_at)
      values (?, ?, ?, ?, ?, ?)
      `,
      [id, input.threadId, input.role, input.label, input.content, createdAt],
    );
    return this.getProjectLabEvents(input.threadId).at(-1)!;
  }

  getProjectLabEvents(threadId: string): ProjectLabEventRecord[] {
    return this.all<ProjectLabEventRecord>(
      `
      select
        id,
        thread_id as threadId,
        role,
        label,
        content,
        created_at as createdAt
      from project_lab_events
      where thread_id = ?
      order by created_at asc
      `,
      [threadId],
    );
  }

  listProjectLabThreadDetails(projectId: string): ProjectLabThreadDetail[] {
    const threads = this.listProjectLabThreads(projectId);
    if (threads.length === 0) {
      return [];
    }

    const eventsByThreadId = new Map<string, ProjectLabEventRecord[]>();
    const threadIds = threads.map((thread) => thread.id);
    for (const batch of chunkValues(threadIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      const events = this.all<ProjectLabEventRecord>(
        `
        select
          id,
          thread_id as threadId,
          role,
          label,
          content,
          created_at as createdAt
        from project_lab_events
        where thread_id in (${placeholders})
        order by created_at asc
        `,
        batch,
      );
      for (const event of events) {
        const bucket = eventsByThreadId.get(event.threadId);
        if (bucket) {
          bucket.push(event);
        } else {
          eventsByThreadId.set(event.threadId, [event]);
        }
      }
    }

    const implementationRunIds = threads.flatMap((thread) => (thread.implementationRunId ? [thread.implementationRunId] : []));
    const implementationRunsById = new Map(this.listRunsByIds(implementationRunIds).map((run) => [run.id, run]));

    return threads.map((thread) => {
      return {
        thread,
        events: eventsByThreadId.get(thread.id) ?? [],
        implementationRun: thread.implementationRunId ? (implementationRunsById.get(thread.implementationRunId) ?? null) : null,
      };
    });
  }

  getProjectLabThreadDetail(threadId: string): ProjectLabThreadDetail {
    const thread = this.getProjectLabThread(threadId);
    return {
      thread,
      events: this.getProjectLabEvents(threadId),
      implementationRun: thread.implementationRunId ? this.listRunsByIds([thread.implementationRunId])[0] ?? null : null,
    };
  }

  private listProjectLabThreadSummaries(projectId: string, runs: RunListItem[]): ProjectLabThreadListItem[] {
    const threads = this.all<ProjectLabThreadListItem["thread"] & { eventCount: number }>(
      `select id, project_id as projectId, kind, coalesce(lab_mode, 'new-feature') as mode, status, origin,
       title, substr(summary, 1, 500) as summary, implementation_run_id as implementationRunId,
       implementation_model_id as implementationModelId, review_model_id as reviewModelId,
       base_branch as baseBranch, created_at as createdAt, updated_at as updatedAt,
       (select count(*) from project_lab_events where thread_id = project_lab_threads.id) as eventCount
       from project_lab_threads where project_id = ? order by created_at desc`, [projectId],
    );
    const runsById = new Map(runs.map((run) => [run.id, run]));
    return threads.map(({ eventCount, ...thread }) => ({
      thread, eventCount,
      implementationRun: thread.implementationRunId ? runsById.get(thread.implementationRunId) ?? null : null,
    }));
  }

  deleteProjectLabThread(threadId: string): void {
    this.run("delete from project_lab_events where thread_id = ?", [threadId]);
    this.run("delete from project_lab_threads where id = ?", [threadId]);
  }

  private static readonly PROJECT_LOOP_SELECT = `
    select
      id,
      project_id as projectId,
      name,
      prompt,
      runner_model_id as runnerModelId,
      review_model_id as reviewModelId,
      merge_policy as mergePolicy,
      ui_change_policy as uiChangePolicy,
      pr_review_policy as prReviewPolicy,
      ui_review_instructions as uiReviewInstructions,
      base_branch as baseBranch,
      status,
      plan_summary as planSummary,
      error_message as errorMessage,
      created_at as createdAt,
      updated_at as updatedAt,
      started_at as startedAt,
      finished_at as finishedAt
    from project_loops
  `;

  private static readonly PROJECT_LOOP_ITERATION_SELECT = `
    select
      id,
      loop_id as loopId,
      iteration_index as iterationIndex,
      title,
      objective,
      status,
      run_id as runId,
      branch_name as branchName,
      pr_url as prUrl,
      pr_number as prNumber,
      target_branch as targetBranch,
      error_message as errorMessage,
      ai_review_posted as aiReviewPosted,
      processed_comment_ids_json as processedCommentIdsJson,
      created_at as createdAt,
      updated_at as updatedAt
    from project_loop_iterations
  `;

  private static readonly PROJECT_LOOP_UI_REVIEW_SELECT = `
    select
      id,
      loop_id as loopId,
      iteration_id as iterationId,
      round,
      page_name as pageName,
      description,
      image_path as imagePath,
      status,
      feedback,
      created_at as createdAt,
      updated_at as updatedAt
    from project_loop_ui_reviews
  `;

  createProjectLoop(input: {
    projectId: string;
    name: string;
    prompt: string;
    runnerModelId: string;
    reviewModelId?: string | null;
    mergePolicy: ProjectLoopMergePolicy;
    uiChangePolicy: ProjectLoopUiChangePolicy;
    prReviewPolicy?: ProjectLoopPrReviewPolicy;
    uiReviewInstructions?: string | null;
    baseBranch: string;
    status: ProjectLoopStatus;
  }): ProjectLoopRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `
      insert into project_loops (
        id, project_id, name, prompt, runner_model_id, review_model_id, merge_policy, ui_change_policy, pr_review_policy,
        ui_review_instructions, base_branch, status, plan_summary, error_message, created_at, updated_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?, null)
      `,
      [
        id,
        input.projectId,
        input.name,
        input.prompt,
        input.runnerModelId,
        input.reviewModelId ?? null,
        input.mergePolicy,
        input.uiChangePolicy,
        input.prReviewPolicy ?? "none",
        input.uiReviewInstructions ?? null,
        input.baseBranch,
        input.status,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    return this.getProjectLoop(id);
  }

  getProjectLoop(loopId: string): ProjectLoopRecord {
    const loop = this.first<ProjectLoopRecord>(`${BuildWardenDatabase.PROJECT_LOOP_SELECT} where id = ?`, [loopId]);
    if (!loop) {
      throw new Error(`Project loop not found: ${loopId}`);
    }
    return loop;
  }

  listProjectLoops(projectId: string): ProjectLoopRecord[] {
    return this.all<ProjectLoopRecord>(`${BuildWardenDatabase.PROJECT_LOOP_SELECT} where project_id = ? order by created_at desc`, [
      projectId,
    ]);
  }

  listProjectLoopsWithStatuses(statuses: ProjectLoopStatus[]): ProjectLoopRecord[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.all<ProjectLoopRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_SELECT} where status in (${placeholders}) order by created_at asc`,
      statuses,
    );
  }

  updateProjectLoop(
    loopId: string,
    fields: {
      status?: ProjectLoopStatus;
      name?: string;
      planSummary?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): ProjectLoopRecord {
    const existing = this.getProjectLoop(loopId);
    this.run(
      `
      update project_loops
      set status = ?, name = ?, plan_summary = ?, error_message = ?, started_at = ?, finished_at = ?, updated_at = ?
      where id = ?
      `,
      [
        fields.status ?? existing.status,
        fields.name ?? existing.name,
        fields.planSummary !== undefined ? fields.planSummary : existing.planSummary,
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        fields.startedAt !== undefined ? fields.startedAt : existing.startedAt,
        fields.finishedAt !== undefined ? fields.finishedAt : existing.finishedAt,
        nowIso(),
        loopId,
      ],
    );
    return this.getProjectLoop(loopId);
  }

  createProjectLoopIteration(input: {
    loopId: string;
    iterationIndex: number;
    title: string;
    objective: string;
    status?: ProjectLoopIterationStatus;
    targetBranch?: string | null;
  }): ProjectLoopIterationRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `
      insert into project_loop_iterations (
        id, loop_id, iteration_index, title, objective, status, run_id, branch_name, pr_url, pr_number,
        target_branch, error_message, processed_comment_ids_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, null, null, null, null, ?, null, '[]', ?, ?)
      `,
      [
        id,
        input.loopId,
        input.iterationIndex,
        input.title,
        input.objective,
        input.status ?? "pending",
        input.targetBranch ?? null,
        timestamp,
        timestamp,
      ],
    );
    return this.getProjectLoopIteration(id);
  }

  /**
   * Inserts a whole loop plan in one SQLite transaction, so an app crash cannot
   * leave a partially committed iteration list behind. Existing iterations for
   * the loop are replaced, making plan creation idempotent.
   */
  replaceProjectLoopIterations(
    loopId: string,
    entries: Array<{ title: string; objective: string; targetBranch?: string | null }>,
  ): ProjectLoopIterationRecord[] {
    const timestamp = nowIso();
    this.transaction(() => {
      this.run("delete from project_loop_iterations where loop_id = ?", [loopId]);
      for (const [index, entry] of entries.entries()) {
        this.run(
          `
          insert into project_loop_iterations (
            id, loop_id, iteration_index, title, objective, status, run_id, branch_name, pr_url, pr_number,
            target_branch, error_message, processed_comment_ids_json, created_at, updated_at
          ) values (?, ?, ?, ?, ?, 'pending', null, null, null, null, ?, null, '[]', ?, ?)
          `,
          [createId(), loopId, index, entry.title, entry.objective, entry.targetBranch ?? null, timestamp, timestamp],
        );
      }
    });
    return this.listProjectLoopIterations(loopId);
  }

  getProjectLoopIteration(iterationId: string): ProjectLoopIterationRecord {
    const iteration = this.first<ProjectLoopIterationRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_ITERATION_SELECT} where id = ?`,
      [iterationId],
    );
    if (!iteration) {
      throw new Error(`Project loop iteration not found: ${iterationId}`);
    }
    return iteration;
  }

  getProjectLoopIterationByRunId(runId: string): ProjectLoopIterationRecord | null {
    return this.first<ProjectLoopIterationRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_ITERATION_SELECT} where run_id = ?`,
      [runId],
    );
  }

  listProjectLoopIterations(loopId: string): ProjectLoopIterationRecord[] {
    return this.all<ProjectLoopIterationRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_ITERATION_SELECT} where loop_id = ? order by iteration_index asc`,
      [loopId],
    );
  }

  updateProjectLoopIteration(
    iterationId: string,
    fields: {
      status?: ProjectLoopIterationStatus;
      title?: string;
      objective?: string;
      runId?: string | null;
      branchName?: string | null;
      prUrl?: string | null;
      prNumber?: number | null;
      targetBranch?: string | null;
      errorMessage?: string | null;
      aiReviewPosted?: boolean;
      processedCommentIdsJson?: string;
    },
  ): ProjectLoopIterationRecord {
    const existing = this.getProjectLoopIteration(iterationId);
    const aiReviewPosted = fields.aiReviewPosted === undefined ? existing.aiReviewPosted : Number(fields.aiReviewPosted);
    this.run(
      `
      update project_loop_iterations
      set status = ?, title = ?, objective = ?, run_id = ?, branch_name = ?, pr_url = ?, pr_number = ?,
          target_branch = ?, error_message = ?, ai_review_posted = ?, processed_comment_ids_json = ?, updated_at = ?
      where id = ?
      `,
      [
        fields.status ?? existing.status,
        fields.title ?? existing.title,
        fields.objective ?? existing.objective,
        fields.runId !== undefined ? fields.runId : existing.runId,
        fields.branchName !== undefined ? fields.branchName : existing.branchName,
        fields.prUrl !== undefined ? fields.prUrl : existing.prUrl,
        fields.prNumber !== undefined ? fields.prNumber : existing.prNumber,
        fields.targetBranch !== undefined ? fields.targetBranch : existing.targetBranch,
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        aiReviewPosted,
        fields.processedCommentIdsJson ?? existing.processedCommentIdsJson,
        nowIso(),
        iterationId,
      ],
    );
    return this.getProjectLoopIteration(iterationId);
  }

  appendProjectLoopEvent(input: {
    loopId: string;
    iterationId?: string | null;
    role: ProjectLoopEventRecord["role"];
    label: string;
    content: string;
  }): ProjectLoopEventRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into project_loop_events (id, loop_id, iteration_id, role, label, content, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.loopId, input.iterationId ?? null, input.role, input.label, input.content, createdAt],
    );
    return {
      id,
      loopId: input.loopId,
      iterationId: input.iterationId ?? null,
      role: input.role,
      label: input.label,
      content: input.content,
      createdAt,
    };
  }

  listProjectLoopEvents(loopId: string): ProjectLoopEventRecord[] {
    return this.all<ProjectLoopEventRecord>(
      `
      select
        id,
        loop_id as loopId,
        iteration_id as iterationId,
        role,
        label,
        content,
        created_at as createdAt
      from project_loop_events
      where loop_id = ?
      order by created_at asc
      `,
      [loopId],
    );
  }

  createProjectLoopUiReview(input: {
    loopId: string;
    iterationId: string;
    round: number;
    pageName: string;
    description?: string | null;
    imagePath: string;
    status?: ProjectLoopUiReviewStatus;
    feedback?: string | null;
  }): ProjectLoopUiReviewRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `
      insert into project_loop_ui_reviews (id, loop_id, iteration_id, round, page_name, description, image_path, status, feedback, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.loopId,
        input.iterationId,
        input.round,
        input.pageName,
        input.description ?? null,
        input.imagePath,
        input.status ?? "pending",
        input.feedback ?? null,
        timestamp,
        timestamp,
      ],
    );
    return this.getProjectLoopUiReview(id);
  }

  getProjectLoopUiReview(reviewId: string): ProjectLoopUiReviewRecord {
    const review = this.first<ProjectLoopUiReviewRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_UI_REVIEW_SELECT} where id = ?`,
      [reviewId],
    );
    if (!review) {
      throw new Error(`Project loop UI review not found: ${reviewId}`);
    }
    return review;
  }

  listProjectLoopUiReviews(loopId: string): ProjectLoopUiReviewRecord[] {
    return this.all<ProjectLoopUiReviewRecord>(
      `${BuildWardenDatabase.PROJECT_LOOP_UI_REVIEW_SELECT} where loop_id = ? order by created_at asc`,
      [loopId],
    );
  }

  updateProjectLoopUiReview(
    reviewId: string,
    fields: {
      status?: ProjectLoopUiReviewStatus;
      feedback?: string | null;
    },
  ): ProjectLoopUiReviewRecord {
    const existing = this.getProjectLoopUiReview(reviewId);
    this.run(
      `
      update project_loop_ui_reviews
      set status = ?, feedback = ?, updated_at = ?
      where id = ?
      `,
      [
        fields.status ?? existing.status,
        fields.feedback !== undefined ? fields.feedback : existing.feedback,
        nowIso(),
        reviewId,
      ],
    );
    return this.getProjectLoopUiReview(reviewId);
  }

  listProjectLoopListItems(projectId: string): ProjectLoopListItem[] {
    const loops = this.all<ProjectLoopListItem["loop"]>(
      `select id, project_id as projectId, name, status, base_branch as baseBranch,
       created_at as createdAt, updated_at as updatedAt from project_loops where project_id = ? order by created_at desc`,
      [projectId],
    );
    if (loops.length === 0) {
      return [];
    }
    const loopIds = loops.map((loop) => loop.id);
    const iterationsByLoopId = new Map<string, ProjectLoopListItem["iterations"]>();
    const pendingReviewsByLoopId = new Map<string, number>();
    const allIterations: ProjectLoopListItem["iterations"] = [];

    for (const batch of chunkValues(loopIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      const iterations = this.all<ProjectLoopListItem["iterations"][number]>(
        `select id, loop_id as loopId, iteration_index as iterationIndex, status, run_id as runId from project_loop_iterations
         where loop_id in (${placeholders})
         order by loop_id asc, iteration_index asc`,
        batch,
      );
      allIterations.push(...iterations);
      for (const iteration of iterations) {
        const bucket = iterationsByLoopId.get(iteration.loopId);
        if (bucket) bucket.push(iteration);
        else iterationsByLoopId.set(iteration.loopId, [iteration]);
      }

      const reviewCounts = this.all<{ loopId: string; count: number }>(
        `select loop_id as loopId, count(*) as count
         from project_loop_ui_reviews
         where loop_id in (${placeholders}) and status = 'pending'
         group by loop_id`,
        batch,
      );
      for (const row of reviewCounts) pendingReviewsByLoopId.set(row.loopId, Number(row.count));
    }

    const runsById = new Map(
      this.listRunsByIds(allIterations.flatMap((iteration) => (iteration.runId ? [iteration.runId] : [])), true)
        .map((run) => [run.id, run] as const),
    );
    return loops.map((loop) => {
      const iterations = iterationsByLoopId.get(loop.id) ?? [];
      const runs = iterations.flatMap((iteration) => {
        const run = iteration.runId ? runsById.get(iteration.runId) : null;
        return run ? [run] : [];
      });
      return { loop, iterations, runs, pendingUiReviewCount: pendingReviewsByLoopId.get(loop.id) ?? 0 };
    });
  }

  getProjectLoopDetail(loopId: string): ProjectLoopDetail {
    const loop = this.getProjectLoop(loopId);
    const iterations = this.listProjectLoopIterations(loopId);
    const runIds = iterations.flatMap((iteration) => (iteration.runId ? [iteration.runId] : []));
    return {
      loop,
      iterations,
      events: this.listProjectLoopEvents(loopId),
      uiReviews: this.listProjectLoopUiReviews(loopId),
      runs: this.listRunsByIds(runIds),
    };
  }

  deleteProjectLoop(loopId: string): void {
    this.run("delete from project_loop_ui_reviews where loop_id = ?", [loopId]);
    this.run("delete from project_loop_events where loop_id = ?", [loopId]);
    this.run("delete from project_loop_iterations where loop_id = ?", [loopId]);
    this.run("delete from project_loops where id = ?", [loopId]);
  }

  getSessionTitleContext(kind: "run" | "chat", id: string, initial: boolean): string {
    const table = kind === "run" ? "run_steps" : "chat_steps";
    const owner = kind === "run" ? "run_id" : "chat_id";
    const rows = this.all<{ content: string; metadataJson: string }>(
      `select substr(content, 1, 8000) as content, metadata_json as metadataJson
       from ${table} where ${owner} = ? and (event_type = 'output' or json_extract(case when json_valid(metadata_json) then metadata_json else '{}' end, '$.source') = 'user')
       order by rowid ${initial ? "asc" : "desc"} limit ${initial ? 1 : 30}`, [id]);
    if (!initial) rows.reverse();
    const context = rows.map((row) => {
      const metadata = this.parseJsonObject(row.metadataJson);
      const attachments = this.parseChatAttachmentPayloads(JSON.stringify(metadata?.attachments ?? []));
      const attachmentText = attachments.map((attachment) => {
        const text = attachment.mimeType.startsWith("text/") || /\.(txt|md|json|csv|log)$/i.test(attachment.fileName)
          ? Buffer.from(attachment.dataBase64, "base64").toString("utf8").slice(0, 8000) : "";
        return `Attachment: ${attachment.fileName}${text ? "\n" + text : ""}`;
      }).join("\n");
      return `${metadata?.source === "user" ? "USER" : "ASSISTANT"}: ${row.content}\n${attachmentText}`;
    }).join("\n\n");
    return context.length <= 12000 ? context : context.slice(0, 4000) + "\n[Middle omitted]\n" + context.slice(-8000);
  }

  clearPendingSessionTitles(): void {
    for (const table of ["runs", "chats"]) this.run(`update ${table} set title_request_id = null where title_request_id is not null`);
  }

  beginSessionTitle(kind: "run" | "chat", id: string, requestId: string): boolean {
    const table = kind === "run" ? "runs" : "chats";
    return Number(this.run(`update ${table} set title_request_id = ? where id = ? and title_request_id is null`, [requestId, id]).changes) > 0;
  }

  finishSessionTitle(kind: "run" | "chat", id: string, requestId: string, title?: string): boolean {
    const table = kind === "run" ? "runs" : "chats";
    return this.transaction(() => {
      const result = this.run(`update ${table} set title = coalesce(?, title), title_request_id = null where id = ? and title_request_id = ?`, [title ?? null, id, requestId]);
      if (!Number(result.changes)) return false;
      if (title !== undefined) this.updateBookmarkedSessionTitle(kind, id, title);
      return true;
    });
  }

  renameSessionTitle(kind: "run" | "chat", id: string, title: string): void {
    const table = kind === "run" ? "runs" : "chats";
    this.transaction(() => {
      const result = this.run(`update ${table} set title = ?, title_request_id = null where id = ?`, [title, id]);
      if (!Number(result.changes)) throw new Error("Conversation not found.");
      this.updateBookmarkedSessionTitle(kind, id, title);
    });
  }

  private updateBookmarkedSessionTitle(kind: "run" | "chat", id: string, title: string): void {
    const table = kind === "run" ? "bookmarks" : "chat_bookmarks";
    const column = kind === "run" ? "original_run_id" : "original_chat_id";
    this.run(`update ${table} set title = ? where ${column} = ?`, [title, id]);
  }

  getChat(id: string): ChatRecord {
    const chat = this.first<ChatRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        run_id as runId,
        ${SESSION_TITLE_SQL}
        prompt,
        status,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from chats
      where id = ?
      `,
      [id],
    );
    if (!chat) {
      throw new Error(`Chat not found: ${id}`);
    }
    return chat;
  }

  getChatSteps(chatId: string): ChatStepRecord[] {
    return this.all<ChatStepRecord>(
      `
      select
        id,
        chat_id as chatId,
        event_type as eventType,
        title,
        content,
        metadata_json as metadataJson,
        created_at as createdAt
      from chat_steps
      where chat_id = ?
      order by created_at asc, rowid asc
      `,
      [chatId],
    );
  }

  getChatDetail(chatId: string): ChatDetail {
    const chat = this.getChat(chatId);
    const steps = this.getChatSteps(chatId);
    return { chat, steps, queuedFollowUps: this.listQueuedFollowUps("chat", chatId) };
  }

  getInitialChatHistory(chatId: string): ChatHistoryPage {
    this.getChat(chatId);
    return {
      ...this.getInitialHistoryPage<ChatStepRecord>("chat_steps", "chat_id", "chatId", chatId),
      stale: false,
    };
  }

  getEarlierChatHistory(chatId: string, request: UserAnchoredHistoryPageRequest): ChatHistoryPage {
    this.getChat(chatId);
    return this.getEarlierHistoryPage<ChatStepRecord>("chat_steps", "chat_id", "chatId", chatId, request);
  }

  updateChatStatus(
    chatId: string,
    status: RunStatus,
    opts?: {
      lastProviderResponseId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      summary?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): void {
    this.getChat(chatId); // validate exists
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const values: unknown[] = [status, nowIso()];
    if (opts?.lastProviderResponseId !== undefined) {
      updates.push("last_provider_response_id = ?");
      values.push(opts.lastProviderResponseId);
    }
    if (opts?.inputTokens !== undefined) {
      updates.push("input_tokens = ?");
      values.push(opts.inputTokens);
    }
    if (opts?.outputTokens !== undefined) {
      updates.push("output_tokens = ?");
      values.push(opts.outputTokens);
    }
    if (opts?.startedAt !== undefined) {
      updates.push("started_at = ?");
      values.push(opts.startedAt);
    }
    if (opts?.finishedAt !== undefined) {
      updates.push("finished_at = ?");
      values.push(opts.finishedAt);
    }
    values.push(chatId);
    this.run(`update chats set ${updates.join(", ")} where id = ?`, values);
  }

  updateChatConfiguration(chatId: string, modelId: string): void {
    // Keep the chat account in step with its model and drop a response/session id that
    // belongs to a different account.
    this.run(
      `
      update chats
      set model_id = ?1,
        provider_account_id = coalesce((select provider_account_id from models where id = ?1), provider_account_id),
        last_provider_response_id = case
          when (select provider_account_id from models where id = ?1) is provider_account_id then last_provider_response_id
          else null
        end,
        updated_at = ?2
      where id = ?3
      `,
      [modelId, nowIso(), chatId],
    );
  }

  appendChatEvent(
    chatId: string,
    eventType: ChatStepRecord["eventType"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): ChatStepRecord {
    const id = createId();
    const metadataJson = JSON.stringify(metadata ?? {});
    const createdAt = nowIso();
    this.run(
      `
      insert into chat_steps (id, chat_id, event_type, title, content, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, chatId, eventType, title, content, metadataJson, createdAt],
    );
    return { id, chatId, eventType, title, content, metadataJson, createdAt };
  }

  updateChatStep(stepId: string, updates: { title?: string; content?: string; metadataJson?: string }): ChatStepRecord {
    const parts: string[] = [];
    const values: unknown[] = [];
    if (updates.title !== undefined) {
      parts.push("title = ?");
      values.push(updates.title);
    }
    if (updates.content !== undefined) {
      parts.push("content = ?");
      values.push(updates.content);
    }
    if (updates.metadataJson !== undefined) {
      parts.push("metadata_json = ?");
      values.push(updates.metadataJson);
    }
    if (parts.length > 0) {
      values.push(stepId);
      this.run(`update chat_steps set ${parts.join(", ")} where id = ?`, values);
    }
    const step = this.first<ChatStepRecord>(
      `select id, chat_id as chatId, event_type as eventType, title, content,
        metadata_json as metadataJson, created_at as createdAt from chat_steps where id = ?`,
      [stepId],
    );
    if (!step) throw new Error(`Chat step not found: ${stepId}`);
    return step;
  }

  deleteChat(chatId: string): void {
    this.run("delete from queued_follow_ups where owner_kind = 'chat' and owner_id = ?", [chatId]);
    this.run("delete from chat_steps where chat_id = ?", [chatId]);
    this.run("delete from chats where id = ?", [chatId]);
  }

  resolveChatUserInput(chatId: string, requestId: string, answers: import("@buildwarden/shared").RunUserInputAnswers): ChatStepRecord {
    const step = this.getChatSteps(chatId).find((candidate) => {
      if (candidate.eventType !== "user-input-requested") return false;
      const metadata = JSON.parse(candidate.metadataJson || "{}") as Record<string, unknown>;
      return metadata.userInputRequestId === requestId && metadata.requestStatus === "opened";
    });
    if (!step) throw new Error("This question is no longer waiting for an answer.");
    const metadata = JSON.parse(step.metadataJson) as { userInputQuestions: import("@buildwarden/shared").RunUserInputQuestion[] };
    validateUserInputAnswers(metadata.userInputQuestions, answers);
    return this.updateChatStep(step.id, {
      title: "User input submitted",
      metadataJson: JSON.stringify({ ...JSON.parse(step.metadataJson), requestStatus: "resolved", userInputAnswers: answers }),
    });
  }

  closeChatUserInputRequests(chatId: string): void {
    for (const step of this.getChatSteps(chatId)) {
      if (step.eventType !== "user-input-requested") continue;
      const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
      if (metadata.requestStatus === "opened") this.updateChatStep(step.id, {
        metadataJson: JSON.stringify({ ...metadata, requestStatus: "cancelled" }),
      });
    }
  }

  addProject(input: ProjectInput & { baseBranch: string; resolvedName: string; kind?: ProjectRecord["kind"] }): ProjectRecord {
    const id = createId();
    const createdAt = nowIso();
    const kind = input.kind ?? "git";
    this.run(
      `
      insert into projects (id, name, repo_path, default_branch, project_kind, cumulative_input_tokens, cumulative_output_tokens, created_at, updated_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.resolvedName, input.repoPath, input.baseBranch, kind, 0, 0, createdAt, createdAt, createdAt],
    );
    return this.getProject(id);
  }

  listProjects(): ProjectRecord[] {
    return this.all<ProjectRecord>(
      `
      select
        id,
        name,
        repo_path as repoPath,
        default_branch as baseBranch,
        project_kind as kind,
        cumulative_input_tokens as cumulativeInputTokens,
        cumulative_output_tokens as cumulativeOutputTokens,
        created_at as createdAt,
        updated_at as updatedAt,
        last_opened_at as lastOpenedAt
      from projects
      order by coalesce(last_opened_at, updated_at) desc
      `,
    );
  }

  getProject(id: string): ProjectRecord {
    const project = this.first<ProjectRecord>(
      `
      select
        id,
        name,
        repo_path as repoPath,
        default_branch as baseBranch,
        project_kind as kind,
        cumulative_input_tokens as cumulativeInputTokens,
        cumulative_output_tokens as cumulativeOutputTokens,
        created_at as createdAt,
        updated_at as updatedAt,
        last_opened_at as lastOpenedAt
      from projects
      where id = ?
      `,
      [id],
    );

    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }

    return project;
  }

  touchProject(projectId: string): void {
    const timestamp = nowIso();
    this.run(
      "update projects set last_opened_at = ?, updated_at = ? where id = ?",
      [timestamp, timestamp, projectId],
    );
  }

  updateProjectKind(projectId: string, kind: ProjectRecord["kind"], baseBranch: string): ProjectRecord {
    const timestamp = nowIso();
    this.run(
      `
      update projects
      set project_kind = ?, default_branch = ?, updated_at = ?
      where id = ?
      `,
      [kind, baseBranch, timestamp, projectId],
    );
    return this.getProject(projectId);
  }

  updateProjectBaseBranch(projectId: string, baseBranch: string): ProjectRecord {
    const timestamp = nowIso();
    this.run(
      `
      update projects
      set default_branch = ?, updated_at = ?
      where id = ?
      `,
      [baseBranch, timestamp, projectId],
    );
    return this.getProject(projectId);
  }

  incrementProjectTokenUsage(projectId: string, inputTokensDelta: number, outputTokensDelta: number): ProjectRecord {
    if (inputTokensDelta === 0 && outputTokensDelta === 0) {
      return this.getProject(projectId);
    }

    const timestamp = nowIso();
    this.run(
      `
      update projects
      set
        cumulative_input_tokens = cumulative_input_tokens + ?,
        cumulative_output_tokens = cumulative_output_tokens + ?,
        updated_at = ?
      where id = ?
      `,
      [inputTokensDelta, outputTokensDelta, timestamp, projectId],
    );
    return this.getProject(projectId);
  }

  recordProjectTokenUsage(
    projectId: string,
    ownerKind: string,
    ownerId: string,
    inputTokensDelta: number,
    outputTokensDelta: number,
    attribution?: TokenUsageAttribution,
  ): ProjectRecord {
    if (inputTokensDelta === 0 && outputTokensDelta === 0) return this.getProject(projectId);
    return this.transaction(() => {
      const project = this.incrementProjectTokenUsage(projectId, inputTokensDelta, outputTokensDelta);
      this.insertTokenUsageEvent(projectId, ownerKind, ownerId, inputTokensDelta, outputTokensDelta, attribution);
      return project;
    });
  }

  recordChatTokenUsage(
    chatId: string,
    projectId: string | null,
    inputTokensDelta: number,
    outputTokensDelta: number,
    attribution?: TokenUsageAttribution,
  ): ChatRecord {
    if (inputTokensDelta === 0 && outputTokensDelta === 0) return this.getChat(chatId);
    return this.transaction(() => {
      this.run(
        `update chats
         set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
         where id = ?`,
        [inputTokensDelta, outputTokensDelta, nowIso(), chatId],
      );
      if (projectId) {
        this.incrementProjectTokenUsage(projectId, inputTokensDelta, outputTokensDelta);
      } else {
        this.run(
          `update app_token_usage
           set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
           where scope = 'standalone-chats'`,
          [inputTokensDelta, outputTokensDelta],
        );
      }
      this.insertTokenUsageEvent(projectId, "chat", chatId, inputTokensDelta, outputTokensDelta, attribution);
      return this.getChat(chatId);
    });
  }

  recordRunTokenUsage(
    runId: string,
    inputTokensDelta: number,
    outputTokensDelta: number,
    attribution?: TokenUsageAttribution,
  ): RunRecord {
    const existing = this.getRun(runId);
    if (inputTokensDelta === 0 && outputTokensDelta === 0) return existing;
    return this.transaction(() => {
      this.run(
        `update runs
         set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
         where id = ?`,
        [inputTokensDelta, outputTokensDelta, nowIso(), runId],
      );
      this.incrementProjectTokenUsage(existing.projectId, inputTokensDelta, outputTokensDelta);
      this.insertTokenUsageEvent(existing.projectId, "run", runId, inputTokensDelta, outputTokensDelta, attribution);
      return this.getRun(runId);
    });
  }

  getStandaloneChatTokenUsage(): { inputTokens: number; outputTokens: number } {
    return this.first<{ inputTokens: number; outputTokens: number }>(
      `select input_tokens as inputTokens, output_tokens as outputTokens
       from app_token_usage where scope = 'standalone-chats'`,
    ) ?? { inputTokens: 0, outputTokens: 0 };
  }

  getTokenUsageSince(since: string): { inputTokens: number; outputTokens: number } {
    return this.first<{ inputTokens: number; outputTokens: number }>(
      `select coalesce(sum(input_tokens), 0) as inputTokens,
              coalesce(sum(output_tokens), 0) as outputTokens
       from token_usage_events where created_at >= ?`,
      [since],
    ) ?? { inputTokens: 0, outputTokens: 0 };
  }

  /**
   * Usage grouped by local time bucket, project, provider, and model. Buckets are `YYYY-MM-DDTHH`
   * hours, `YYYY-MM-DD` days, weeks keyed by their Monday, or `YYYY-MM` months. Events in
   * `exclude` (`from` inclusive, `to` exclusive) are skipped, which lets a comparison window end
   * at the same time of day as the current one. Events recorded before attribution existed have a
   * null `modelId`.
   */
  listTokenUsageCostRows(
    since: string | null,
    bucketSize: "hour" | "day" | "week" | "month" = "day",
    exclude?: { from: string; to: string },
  ): TokenUsageCostRow[] {
    const bucket = {
      hour: "strftime('%Y-%m-%dT%H', e.created_at, 'localtime')",
      day: "date(e.created_at, 'localtime')",
      week: "date(e.created_at, 'localtime', '-6 days', 'weekday 1')",
      month: "strftime('%Y-%m', e.created_at, 'localtime')",
    }[bucketSize];
    return this.all<TokenUsageCostRow>(
      `select ${bucket} as bucket,
              e.project_id as projectId,
              p.name as projectName,
              e.provider_type as providerType,
              e.model_id as modelId,
              coalesce(sum(e.input_tokens), 0) as inputTokens,
              coalesce(sum(e.output_tokens), 0) as outputTokens,
              coalesce(sum(e.cache_read_tokens), 0) as cacheReadTokens,
              coalesce(sum(e.cache_write_tokens), 0) as cacheWriteTokens,
              coalesce(sum(e.reasoning_tokens), 0) as reasoningTokens
       from token_usage_events e
       left join projects p on p.id = e.project_id
       where (? is null or e.created_at >= ?)
         and not (? is not null and e.created_at >= ? and e.created_at < ?)
       group by bucket, e.project_id, e.provider_type, e.model_id
       order by bucket`,
      [since, since, exclude?.from ?? null, exclude?.from ?? null, exclude?.to ?? null],
    );
  }

  /** Timestamp of the first recorded usage event, or `null` when there is none. */
  getEarliestTokenUsageAt(): string | null {
    return this.first<{ createdAt: string | null }>("select min(created_at) as createdAt from token_usage_events")?.createdAt ?? null;
  }

  /**
   * Attributed models and projects ordered by all-time processed tokens, so charts can give each
   * one a color that stays the same whatever period is shown.
   */
  getTokenUsageRanks(): { models: Array<{ providerType: string; modelId: string }>; projectIds: Array<string | null> } {
    const models = this.all<{ providerType: string | null; modelId: string }>(
      `select provider_type as providerType, model_id as modelId
       from token_usage_events where model_id is not null
       group by provider_type, model_id
       order by sum(input_tokens + output_tokens) desc, model_id`,
    ).map((row) => ({ providerType: row.providerType ?? "unknown", modelId: row.modelId }));
    const projectIds = this.all<{ projectId: string | null }>(
      `select project_id as projectId from token_usage_events
       group by project_id
       order by sum(input_tokens + output_tokens) desc, project_id`,
    ).map((row) => row.projectId);
    return { models, projectIds };
  }

  private insertTokenUsageEvent(
    projectId: string | null,
    ownerKind: string,
    ownerId: string,
    inputTokens: number,
    outputTokens: number,
    attribution?: TokenUsageAttribution,
  ): void {
    const nonNegative = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? value ?? 0 : 0);
    this.run(
      `insert into token_usage_events
       (id, project_id, owner_kind, owner_id, input_tokens, output_tokens, provider_type, model_id,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId(),
        projectId,
        ownerKind,
        ownerId,
        inputTokens,
        outputTokens,
        attribution?.providerType ?? null,
        attribution?.modelId ?? null,
        nonNegative(attribution?.cacheReadTokens),
        nonNegative(attribution?.cacheWriteTokens),
        nonNegative(attribution?.reasoningTokens),
        nowIso(),
      ],
    );
  }

  deleteProject(projectId: string): void {
    const runIds = this.all<{ id: string }>("select id from runs where project_id = ?", [projectId]).map(({ id }) => id);
    for (const runId of runIds) {
      this.derivedRunStateCache.delete(runId);
    }

    this.run("delete from project_automations where project_id = ?", [projectId]);
    this.run("delete from run_forge_links where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from forge_requests where project_id = ?", [projectId]);
    this.run(
      `
      delete from run_notes
      where run_id in (select id from runs where project_id = ?)
      `,
      [projectId],
    );
    this.run(
      `
      delete from run_steps
      where run_id in (select id from runs where project_id = ?)
      `,
      [projectId],
    );
    this.run("delete from attention_acknowledgements where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from worktrees where project_id = ?", [projectId]);
    this.run(
      `
      delete from chat_steps
      where chat_id in (select id from chats where run_id in (select id from runs where project_id = ?))
      `,
      [projectId],
    );
    this.run("delete from run_verifications where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from run_restore_points where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from run_council_rounds where project_id = ?", [projectId]);
    this.run("delete from run_review_baselines where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from queued_follow_ups where owner_kind = 'chat' and owner_id in (select id from chats where run_id in (select id from runs where project_id = ?))", [projectId]);
    this.run("delete from queued_follow_ups where owner_kind = 'run' and owner_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from chats where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from run_workspace_setup where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from run_organization where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("delete from runs where project_id = ?", [projectId]);
    this.run("delete from project_lab_events where thread_id in (select id from project_lab_threads where project_id = ?)", [projectId]);
    this.run("delete from project_lab_threads where project_id = ?", [projectId]);
    // Defense in depth: the app controller deletes loops (with their runs and stored
    // screenshots) before calling this, but the DB-level cascade keeps the tables
    // consistent for any other caller.
    this.run("delete from project_loop_ui_reviews where loop_id in (select id from project_loops where project_id = ?)", [projectId]);
    this.run("delete from project_loop_events where loop_id in (select id from project_loops where project_id = ?)", [projectId]);
    this.run("delete from project_loop_iterations where loop_id in (select id from project_loops where project_id = ?)", [projectId]);
    this.run("delete from project_loops where project_id = ?", [projectId]);
    this.run("delete from project_tasks where project_id = ?", [projectId]);
    this.run("delete from project_insights where project_id = ?", [projectId]);
    this.run("delete from projects where id = ?", [projectId]);
  }

  addProviderAccount(input: {
    providerType: string;
    label: string;
    apiBaseUrl: string | null;
    apiKeyRef: string;
    configJson: string;
  }): ProviderAccountRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into provider_accounts (id, provider_type, label, api_base_url, api_key_ref, config_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.providerType, input.label, input.apiBaseUrl, input.apiKeyRef, input.configJson, createdAt, createdAt],
    );
    return this.getProviderAccount(id);
  }

  listProviderAccounts(): ProviderAccountRecord[] {
    return this.all<ProviderAccountRecord>(
      `
      select
        id,
        provider_type as providerType,
        label,
        api_base_url as apiBaseUrl,
        api_key_ref as apiKeyRef,
        config_json as configJson,
        created_at as createdAt,
        updated_at as updatedAt
      from provider_accounts
      order by updated_at desc
      `,
    );
  }

  deleteProviderAccount(providerAccountId: string): void {
    this.run("delete from models where provider_account_id = ?", [providerAccountId]);
    this.run("delete from provider_accounts where id = ?", [providerAccountId]);
  }

  getProviderAccount(id: string): ProviderAccountRecord {
    const provider = this.first<ProviderAccountRecord>(
      `
      select
        id,
        provider_type as providerType,
        label,
        api_base_url as apiBaseUrl,
        api_key_ref as apiKeyRef,
        config_json as configJson,
        created_at as createdAt,
        updated_at as updatedAt
      from provider_accounts
      where id = ?
      `,
      [id],
    );

    if (!provider) {
      throw new Error(`Provider account not found: ${id}`);
    }

    return provider;
  }

  addModel(input: ModelInput): ModelRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into models (
        id, provider_account_id, model_id, display_name, base_url_override, config_json,
        capabilities_json, enabled, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.providerAccountId,
        input.modelId,
        input.displayName,
        input.baseUrlOverride ?? null,
        JSON.stringify(input.config ?? {}),
        // Keep capability provenance alongside the flags; legacy rows may omit it.
        JSON.stringify(input.capabilities ?? {}),
        input.enabled === false ? 0 : 1,
        createdAt,
        createdAt,
      ],
    );
    return this.getModel(id);
  }

  listModels(): ModelRecord[] {
    return this.all<ModelRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        display_name as displayName,
        base_url_override as baseUrlOverride,
        config_json as configJson,
        capabilities_json as capabilitiesJson,
        enabled,
        created_at as createdAt,
        updated_at as updatedAt
      from models
      order by updated_at desc
      `,
    );
  }

  getModelDeletionTargets(modelId: string): ModelDeletionTargets {
    const rows = this.all<{ kind: string; id: string }>(
      `
      with recursive related(kind, id) as (
        select 'run', id from runs where model_id = ?
        union
        select 'project-lab-thread', id
        from project_lab_threads
        where implementation_model_id = ? or review_model_id = ?
        union
        select 'project-loop', id
        from project_loops
        where runner_model_id = ? or review_model_id = ?
        union
        select 'orchestration', orchestration_id
        from orchestration_tasks
        where model_id = ?
        union
        select 'automation', id
        from project_automations
        where model_id = ?
        union
        select 'run', run.id
        from related
        join runs run on related.kind = 'automation' and run.automation_id = related.id
        union
        select 'run', thread.implementation_run_id
        from related
        join project_lab_threads thread
          on related.kind = 'project-lab-thread' and thread.id = related.id
        where thread.implementation_run_id is not null
        union
        select 'project-lab-thread', thread.id
        from related
        join project_lab_threads thread
          on related.kind = 'run' and thread.implementation_run_id = related.id
        union
        select 'run', iteration.run_id
        from related
        join project_loop_iterations iteration
          on related.kind = 'project-loop' and iteration.loop_id = related.id
        where iteration.run_id is not null
        union
        select 'project-loop', iteration.loop_id
        from related
        join project_loop_iterations iteration
          on related.kind = 'run' and iteration.run_id = related.id
        union
        select 'run', orchestration.coordinator_run_id
        from related
        join orchestrations orchestration
          on related.kind = 'orchestration' and orchestration.id = related.id
        union
        select 'run', task.child_run_id
        from related
        join orchestration_tasks task
          on related.kind = 'orchestration' and task.orchestration_id = related.id
        where task.child_run_id is not null
        union
        select 'orchestration', orchestration.id
        from related
        join orchestrations orchestration
          on related.kind = 'run' and orchestration.coordinator_run_id = related.id
        union
        select 'orchestration', task.orchestration_id
        from related
        join orchestration_tasks task
          on related.kind = 'run' and task.child_run_id = related.id
      )
      select kind, id from related
      union
      select 'chat', chat.id
      from chats chat
      where chat.model_id = ?
        or exists (
          select 1 from related
          where related.kind = 'run' and related.id = chat.run_id
        )
      union
      select 'project-insight', id
      from project_insights
      where model_id = ?
      order by kind, id
      `,
      [modelId, modelId, modelId, modelId, modelId, modelId, modelId, modelId, modelId],
    );
    const idsFor = (kind: string): string[] => rows.filter((row) => row.kind === kind).map((row) => row.id);
    return {
      runIds: idsFor("run"),
      chatIds: idsFor("chat"),
      projectInsightIds: idsFor("project-insight"),
      projectLabThreadIds: idsFor("project-lab-thread"),
      projectLoopIds: idsFor("project-loop"),
      orchestrationIds: idsFor("orchestration"),
      automationIds: idsFor("automation"),
    };
  }

  deleteProjectInsights(projectInsightIds: string[]): void {
    this.transaction(() => {
      for (const batch of chunkValues([...new Set(projectInsightIds)])) {
        if (batch.length === 0) continue;
        const placeholders = batch.map(() => "?").join(", ");
        this.run(`delete from project_insights where id in (${placeholders})`, batch);
      }
    });
  }

  deleteModel(modelId: string): void {
    this.run("delete from models where id = ?", [modelId]);
  }

  getModel(id: string): ModelRecord {
    const model = this.first<ModelRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        display_name as displayName,
        base_url_override as baseUrlOverride,
        config_json as configJson,
        capabilities_json as capabilitiesJson,
        enabled,
        created_at as createdAt,
        updated_at as updatedAt
      from models
      where id = ?
      `,
      [id],
    );

    if (!model) {
      throw new Error(`Model not found: ${id}`);
    }

    return model;
  }

  createRun(
    input: RunInput & {
      branchName: string;
      worktreePath: string;
      parentRunId?: string | null;
      rootRunId?: string | null;
      lineageTitle?: string | null;
      workspaceSetupProfile?: RunWorkspaceSetup["profile"] | null;
      /** Atomically attach a newly created child to its persisted task intent. */
      orchestrationTaskId?: string;
    },
  ): RunRecord {
    const id = createId();
    const createdAt = nowIso();
    return this.transaction(() => {
      this.run(
        `
        insert into runs (
          id, project_id, provider_account_id, model_id, harness_type, run_mode, workspace_type, prompt, status,
          workspace_vcs, goal_text, branch_name, worktree_path, summary, error_message, last_provider_response_id, input_tokens, output_tokens, list_visibility, run_kind, lab_thread_id,
          parent_run_id, root_run_id, lineage_title, project_task_id, automation_id, delegation_enabled, created_at, updated_at, started_at, finished_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          input.projectId,
          input.providerAccountId,
          input.modelId,
          input.harnessType,
          input.mode,
          input.workspaceType,
          input.prompt,
          "queued",
          input.workspaceVcs ?? "git",
          input.goalText ?? null,
          input.branchName,
          input.worktreePath,
          null,
          null,
          null,
          0,
          0,
          "default",
          input.kind ?? "standard",
          input.labThreadId ?? null,
          input.parentRunId ?? null,
          input.rootRunId ?? null,
          input.lineageTitle ?? null,
          input.projectTaskId ?? null,
          input.automationId ?? null,
          Number(input.delegationEnabled === true),
          createdAt,
          createdAt,
          null,
          null,
        ],
      );
      if (input.workspaceType !== "local") {
        const setup = parseWorkspaceSetupSettings(this.getSettings()[APP_SETTING_KEYS.workspaceSetupProfiles])[input.projectId];
        const profile = input.workspaceSetupProfile === undefined
          ? setup?.profiles.find((entry) => entry.id === setup.activeProfileId)
          : input.workspaceSetupProfile;
        if (profile) this.saveRunWorkspaceSetup(id, { profile, status: "pending" });
      }
      if (input.orchestrationTaskId) {
        const task = this.getOrchestrationTask(input.orchestrationTaskId);
        const orchestration = this.getOrchestration(task.orchestrationId);
        if (task.childRunId || orchestration.projectId !== input.projectId || orchestration.coordinatorRunId !== input.parentRunId) {
          throw new Error("The child does not match its orchestration task intent.");
        }
        this.updateOrchestrationTask(task.id, { childRunId: id, status: "queued" });
      }
      return this.getRun(id);
    });
  }

  private loadDerivedRunStates(runs: DerivedRunStateSource[]): Map<string, DerivedRunState> {
    const derivedByRunId = new Map<string, DerivedRunState>();
    const uncachedRunIds: string[] = [];
    for (const run of runs) {
      const cached = this.derivedRunStateCache.get(run.id);
      if (cached) derivedByRunId.set(run.id, cached);
      else {
        const derived = createDerivedRunState(run);
        derivedByRunId.set(run.id, derived);
        uncachedRunIds.push(run.id);
      }
    }

    for (const batch of chunkValues(uncachedRunIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      const steps = this.all<{
        runId: string;
        eventType: string;
        content: string;
        metadataJson: string;
        createdAt: string;
      }>(
        `
        select
          run_id as runId,
          event_type as eventType,
          content,
          metadata_json as metadataJson,
          created_at as createdAt
        from run_steps
        where run_id in (${placeholders}) and event_type in ('log', 'user-input-requested')
        order by run_id asc, created_at asc
        `,
        batch,
      );

      for (const step of steps) {
        const derived = derivedByRunId.get(step.runId);
        if (!derived) {
          continue;
        }

        applyDerivedRunStep(derived, step, this.parseJsonObject(step.metadataJson));
      }
      for (const runId of batch) {
        const derived = derivedByRunId.get(runId);
        if (derived) this.derivedRunStateCache.set(runId, derived);
      }
    }

    return derivedByRunId;
  }

  private saveRunListSummary(runId: string, summary: RunListSummaryState): void {
    this.run(
      `insert or replace into run_list_summaries (run_id, last_user_input_at, pending_user_input_request)
       values (?, ?, ?)`,
      [runId, summary.lastUserInputAt, Number(summary.pendingUserInputRequest)],
    );
  }

  private loadRunListSummaries(runs: DerivedRunStateSource[]): Map<string, RunListSummaryState> {
    const summaries = new Map<string, RunListSummaryState>();
    for (const batch of chunkValues(runs.map((run) => run.id))) {
      const rows = this.all<{ runId: string; lastUserInputAt: string; pendingUserInputRequest: number }>(
        `select run_id as runId, last_user_input_at as lastUserInputAt,
         pending_user_input_request as pendingUserInputRequest from run_list_summaries
         where run_id in (${batch.map(() => "?").join(", ")})`,
        batch,
      );
      for (const row of rows) summaries.set(row.runId, { ...row, pendingUserInputRequest: Boolean(row.pendingUserInputRequest) });
    }
    // Older databases backfill once. Edited/deleted history invalidates only its own run.
    const missing = runs.filter((run) => !summaries.has(run.id));
    const sources = chunkValues(missing.map((run) => run.id)).flatMap((batch) => this.all<DerivedRunStateSource>(
      `select id, prompt, goal_text as goalText, created_at as createdAt from runs
       where id in (${batch.map(() => "?").join(", ")})`, batch,
    ));
    const backfill = () => {
      for (const [runId, derived] of this.loadDerivedRunStates(sources)) {
        this.saveRunListSummary(runId, derived);
        summaries.set(runId, derived);
      }
    };
    if (sources.length) {
      if (this.db?.isTransaction) backfill();
      else this.transaction(backfill);
    }
    return summaries;
  }

  private withDerivedRunStates<T extends RunListItem>(runs: T[]): T[] {
    if (runs.length === 0) {
      return [];
    }

    const derivedByRunId = this.loadRunListSummaries(runs);
    const runIds = runs.map((run) => run.id);
    const forgeByRunId = new Map<string, RunForgeRequestSummary>();
    for (const batch of chunkValues(runIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      const forgeRows = this.all<{ runId: string; summaryJson: string }>(
        `select l.run_id as runId, f.summary_json as summaryJson
         from run_forge_links l
         join forge_requests f on f.id = l.forge_request_id
         where l.run_id in (${placeholders})`,
        batch,
      );
      for (const row of forgeRows) {
        const summary = this.parseJsonValue<RunForgeRequestSummary>(row.summaryJson);
        if (summary) forgeByRunId.set(row.runId, summary);
      }
    }

    return runs.map((run) => {
      const derived = derivedByRunId.get(run.id);
      return {
        ...run,
        ...(run.textIsPreview !== undefined ? { textIsPreview: Boolean(run.textIsPreview), promptIsPreview: Boolean(run.promptIsPreview) } : {}),
        forgeRequest: forgeByRunId.get(run.id) ?? null,
        pendingUserInputRequest: derived?.pendingUserInputRequest ?? false,
        lastUserInputAt: derived?.lastUserInputAt ?? run.createdAt,
      };
    });
  }

  private withDerivedRunState(run: RunRecord): RunRecord {
    return this.withDerivedRunStates([run])[0]!;
  }

  /**
   * Ids of runs whose prompt, goal, follow-up prompts, or submitted answers
   * contain every search term. Kept out of snapshots because the combined
   * user-input text is large.
   */
  searchRunUserInput(query: string): string[] {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const runs = this.all<DerivedRunStateSource>(
      "select id, prompt, goal_text as goalText, created_at as createdAt from runs",
    );
    const derivedByRunId = this.loadDerivedRunStates(runs);
    return runs
      .filter((run) => {
        const derived = derivedByRunId.get(run.id);
        if (!derived) return false;
        const searchText = [...derived.parts].join("\n").toLocaleLowerCase();
        return terms.every((term) => searchText.includes(term));
      })
      .map((run) => run.id);
  }

  getRun(id: string): RunRecord {
    const run = this.first<RunRecord>(
      `
      select
        id,
        project_id as projectId,
        provider_account_id as providerAccountId,
        model_id as modelId,
        harness_type as harnessType,
        run_mode as mode,
        workspace_type as workspaceType,
        workspace_vcs as workspaceVcs,
        prompt,
        ${SESSION_TITLE_SQL}
        goal_text as goalText,
        status,
        branch_name as branchName,
        worktree_path as worktreePath,
        summary,
        error_message as errorMessage,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        list_visibility as listVisibility,
        run_kind as kind,
        lab_thread_id as labThreadId,
        parent_run_id as parentRunId,
        root_run_id as rootRunId,
        lineage_title as lineageTitle,
        project_task_id as projectTaskId,
        automation_id as automationId,
        delegation_enabled as delegationEnabled,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from runs
      where id = ?
      `,
      [id],
    );

    if (!run) {
      throw new Error(`Run not found: ${id}`);
    }

    return this.withDerivedRunState(run);
  }

  getRunWorkspaceSetup(runId: string, throwOnInvalidProfile = false): RunWorkspaceSetup | null {
    const row = this.first<{ profile: string; status: RunWorkspaceSetup["status"] }>("select profile_json as profile, status from run_workspace_setup where run_id = ?", [runId]);
    if (!row) return null;
    try {
      return { profile: JSON.parse(row.profile) as RunWorkspaceSetup["profile"], status: row.status };
    } catch {
      // Detail views remain readable, but execution must not silently skip required setup.
      if (throwOnInvalidProfile) throw new Error("The run's workspace setup profile is corrupted. Start a new run with a valid profile.");
      return null;
    }
  }

  saveRunWorkspaceSetup(runId: string, setup: RunWorkspaceSetup): void {
    // A run's profile is immutable; subsequent calls update only its progress status.
    this.run("insert into run_workspace_setup (run_id, profile_json, status) values (?, ?, ?) on conflict(run_id) do update set status = excluded.status", [runId, JSON.stringify(setup.profile), setup.status]);
  }

  deleteRun(runId: string): void {
    this.run("delete from run_organization where run_id = ?", [runId]);
    this.derivedRunStateCache.delete(runId);
    this.run("update project_tasks set run_id = null, updated_at = ? where run_id = ?", [nowIso(), runId]);
    this.run("delete from attention_acknowledgements where run_id = ?", [runId]);
    this.run("delete from run_notes where run_id = ?", [runId]);
    this.run("delete from queued_follow_ups where owner_kind = 'run' and owner_id = ?", [runId]);
    this.run("delete from queued_follow_ups where owner_kind = 'chat' and owner_id in (select id from chats where run_id = ?)", [runId]);
    this.run("delete from run_steps where run_id = ?", [runId]);
    this.run("delete from run_verifications where run_id = ?", [runId]);
    this.run("delete from run_council_rounds where run_id = ?", [runId]);
    this.run("delete from run_review_baselines where run_id = ?", [runId]);
    this.run("delete from run_restore_points where run_id = ?", [runId]);
    this.run("delete from worktrees where run_id = ?", [runId]);
    this.run("delete from chat_steps where chat_id in (select id from chats where run_id = ?)", [runId]);
    this.run("delete from chats where run_id = ?", [runId]);
    this.run("delete from run_forge_links where run_id = ?", [runId]);
    this.run("delete from run_workspace_setup where run_id = ?", [runId]);
    this.run("delete from runs where id = ?", [runId]);
  }

  /** Keeps the first head seen for a run. Restore points cannot hold this: they move with every prompt. */
  recordRunReviewBaseline(runId: string, headSha: string): void {
    this.run("insert into run_review_baselines (run_id, head_sha) values (?, ?) on conflict(run_id) do nothing", [runId, headSha]);
  }

  getRunReviewBaseline(runId: string): string | null {
    return this.first<{ headSha: string }>("select head_sha as headSha from run_review_baselines where run_id = ?", [runId])?.headSha ?? null;
  }

  listCouncilChildRunIds(parentRunId: string): string[] {
    return this.all<{ id: string }>("select id from runs where parent_run_id = ? and run_kind = 'council-review'", [parentRunId]).map(({ id }) => id);
  }

  saveCouncilRound(round: CouncilRound): void {
    this.run(
      `insert into run_council_rounds (id, run_id, project_id, status, created_at, round_json) values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set status = excluded.status, round_json = excluded.round_json`,
      [round.id, round.runId, round.projectId, round.status, round.createdAt, JSON.stringify(round)],
    );
  }

  getCouncilRound(roundId: string): CouncilRound {
    const row = this.first<{ roundJson: string }>("select round_json as roundJson from run_council_rounds where id = ?", [roundId]);
    if (!row) throw new Error("Validation round not found.");
    return JSON.parse(row.roundJson) as CouncilRound;
  }

  listCouncilRounds(runId: string): CouncilRound[] {
    return this.all<{ roundJson: string }>("select round_json as roundJson from run_council_rounds where run_id = ? order by created_at, id", [runId])
      .map((row) => JSON.parse(row.roundJson) as CouncilRound);
  }

  listCouncilRoundsWithStatuses(statuses: readonly CouncilRound["status"][]): CouncilRound[] {
    if (!statuses.length) return [];
    return this.all<{ roundJson: string }>(
      `select round_json as roundJson from run_council_rounds where status in (${statuses.map(() => "?").join(",")}) order by created_at, id`,
      [...statuses],
    ).map((row) => JSON.parse(row.roundJson) as CouncilRound);
  }

  getRunVerification(runId: string): RunVerificationRecord | null {
    const row = this.first<{ evidence: string }>("select evidence from run_verifications where run_id = ?", [runId]);
    return row ? this.parseJsonValue<RunVerificationRecord>(row.evidence) : null;
  }

  saveRunVerification(record: RunVerificationRecord): void {
    this.getRun(record.runId);
    this.run("insert into run_verifications (run_id, evidence) values (?, ?) on conflict(run_id) do update set evidence = excluded.evidence", [record.runId, JSON.stringify(record)]);
  }

  getRunForgeRequestCache(runId: string): RunForgeRequestCacheRecord | null {
    const row = this.first<StoredRunForgeRequestCacheRecord>(
      `select l.run_id as runId, r.project_id as projectId, l.branch_name as branchName,
        l.head_sha as headSha, l.last_probe_at as lastProbeAt, l.negative_cache_until as negativeCacheUntil,
        f.summary_json as summaryJson, f.details_json as detailsJson, f.etag,
        f.last_modified as lastModified, max(l.error_count, coalesce(f.error_count, 0)) as errorCount,
        case
          when l.retry_after_at is null then f.retry_after_at
          when f.retry_after_at is null then l.retry_after_at
          else max(l.retry_after_at, f.retry_after_at)
        end as retryAfterAt,
        coalesce(l.sync_error, f.sync_error) as syncError
       from run_forge_links l
       join runs r on r.id = l.run_id
       left join forge_requests f on f.id = l.forge_request_id
       where l.run_id = ?`,
      [runId],
    );
    if (!row) return null;
    const { summaryJson, detailsJson, ...cache } = row;
    return {
      ...cache,
      summary: this.parseJsonValue<RunForgeRequestSummary>(summaryJson),
      details: this.parseJsonValue<RunForgeRequestDetailsResult>(detailsJson),
    };
  }

  saveRunForgeRequest(
    runId: string,
    projectId: string,
    branchName: string,
    headSha: string | null,
    summary: RunForgeRequestSummary,
    details: RunForgeRequestDetailsResult | null,
    cache?: { etag?: string | null; lastModified?: string | null },
  ): void {
    const timestamp = nowIso();
    this.transaction(() => {
      const existing = this.first<{ id: string }>(
        `select id from forge_requests
         where project_id = ? and provider = ? and request_number = ?`,
        [projectId, summary.provider, summary.number],
      );
      const requestId = existing?.id ?? createId();
      this.run(
        `insert into forge_requests (
         id, project_id, provider, request_number, summary_json, details_json, checks_json,
         etag, last_modified, last_synced_at, error_count, sync_error, retry_after_at, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, coalesce(?, '[]'), ?, ?, ?, 0, null, null, ?, ?)
       on conflict(project_id, provider, request_number) do update set
         summary_json = excluded.summary_json,
         details_json = coalesce(excluded.details_json, forge_requests.details_json),
         checks_json = case
           when excluded.details_json is null then forge_requests.checks_json
           else excluded.checks_json
         end,
         etag = coalesce(excluded.etag, forge_requests.etag),
         last_modified = coalesce(excluded.last_modified, forge_requests.last_modified),
         last_synced_at = excluded.last_synced_at,
         error_count = 0,
         sync_error = null,
         retry_after_at = null,
         updated_at = excluded.updated_at`,
      [
        requestId,
        projectId,
        summary.provider,
        summary.number,
        JSON.stringify(summary),
        details ? JSON.stringify(details) : null,
        details ? JSON.stringify(details.checks) : null,
        cache?.etag ?? null,
        cache?.lastModified ?? null,
        summary.lastSyncedAt,
        timestamp,
        timestamp,
      ],
      );
      this.run(
        `insert into run_forge_links (
         run_id, forge_request_id, branch_name, head_sha, last_probe_at, negative_cache_until, created_at, updated_at
       ) values (?, ?, ?, ?, ?, null, ?, ?)
       on conflict(run_id) do update set
         forge_request_id = excluded.forge_request_id,
         branch_name = excluded.branch_name,
         head_sha = excluded.head_sha,
         last_probe_at = excluded.last_probe_at,
         negative_cache_until = null,
         error_count = 0, sync_error = null, retry_after_at = null,
         updated_at = excluded.updated_at`,
        [runId, requestId, branchName, headSha, timestamp, timestamp, timestamp],
      );
    });
  }

  saveRunForgeNegativeProbe(
    runId: string,
    branchName: string,
    headSha: string | null,
    negativeCacheUntil: string,
  ): void {
    const timestamp = nowIso();
    this.run(
      `insert into run_forge_links (
         run_id, forge_request_id, branch_name, head_sha, last_probe_at, negative_cache_until, created_at, updated_at
       ) values (?, null, ?, ?, ?, ?, ?, ?)
       on conflict(run_id) do update set
         forge_request_id = null,
         branch_name = excluded.branch_name,
         head_sha = excluded.head_sha,
         last_probe_at = excluded.last_probe_at,
         negative_cache_until = excluded.negative_cache_until,
         error_count = 0, sync_error = null, retry_after_at = null,
         updated_at = excluded.updated_at`,
      [runId, branchName, headSha, timestamp, negativeCacheUntil, timestamp, timestamp],
    );
  }

  clearProjectRunForgeRetryDelays(projectId: string): void {
    this.run("update run_forge_links set retry_after_at = null, negative_cache_until = null where run_id in (select id from runs where project_id = ?)", [projectId]);
    this.run("update forge_requests set retry_after_at = null where project_id = ?", [projectId]);
  }

  saveRunForgeSyncError(runId: string, message: string, retryAfterAt: string, probe?: { branchName: string; headSha: string | null }): RunForgeRequestSummary | null {
    const cache = this.getRunForgeRequestCache(runId);
    const timestamp = nowIso();
    if (probe || cache) {
      this.run(`insert into run_forge_links (
        run_id, branch_name, head_sha, error_count, sync_error, retry_after_at, created_at, updated_at
      ) values (?, ?, ?, 1, ?, ?, ?, ?)
      on conflict(run_id) do update set error_count = run_forge_links.error_count + 1,
        sync_error = excluded.sync_error, retry_after_at = excluded.retry_after_at, updated_at = excluded.updated_at`,
      [runId, probe?.branchName ?? cache!.branchName, probe?.headSha ?? cache?.headSha ?? null, message, retryAfterAt, timestamp, timestamp]);
    }
    if (!cache?.summary) return null;
    const staleSummary: RunForgeRequestSummary = {
      ...cache.summary,
      readiness: "unavailable",
      stale: true,
      syncError: message,
    };
    const staleDetails = cache.details ? { ...cache.details, summary: staleSummary } : null;
    this.run(
      `update forge_requests set summary_json = ?, details_json = coalesce(?, details_json),
       error_count = error_count + 1,
       sync_error = ?, retry_after_at = ?, updated_at = ?
       where id = (select forge_request_id from run_forge_links where run_id = ?)`,
      [
        JSON.stringify(staleSummary),
        staleDetails ? JSON.stringify(staleDetails) : null,
        message,
        retryAfterAt,
        timestamp,
        runId,
      ],
    );
    return staleSummary;
  }

  listRunNotes(runId: string): RunNoteRecord[] {
    return this.all<RunNoteRecord>(
      `
      select
        id,
        run_id as runId,
        content,
        status,
        created_at as createdAt,
        updated_at as updatedAt,
        closed_at as closedAt
      from run_notes
      where run_id = ?
      order by
        case status when 'open' then 0 else 1 end,
        updated_at desc
      `,
      [runId],
    );
  }

  private getRunNote(noteId: string): RunNoteRecord {
    const note = this.first<RunNoteRecord>(
      `
      select
        id,
        run_id as runId,
        content,
        status,
        created_at as createdAt,
        updated_at as updatedAt,
        closed_at as closedAt
      from run_notes
      where id = ?
      `,
      [noteId],
    );

    if (!note) {
      throw new Error(`Run note not found: ${noteId}`);
    }

    return note;
  }

  addRunNote(runId: string, content: string): RunNoteRecord {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Run note content cannot be empty.");
    }

    this.getRun(runId);
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into run_notes (id, run_id, content, status, created_at, updated_at, closed_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, runId, trimmed, "open", createdAt, createdAt, null],
    );
    return this.getRunNote(id);
  }

  updateRunNote(noteId: string, input: UpdateRunNoteInput): RunNoteRecord {
    const existing = this.getRunNote(noteId);
    const nextContent = input.content === undefined ? existing.content : input.content.trim();
    if (!nextContent) {
      throw new Error("Run note content cannot be empty.");
    }

    const nextStatus: RunNoteStatus = input.status ?? existing.status;
    if (nextStatus !== "open" && nextStatus !== "closed") {
      throw new Error(`Unsupported run note status: ${String(nextStatus)}`);
    }

    const updatedAt = nowIso();
    const closedAt = nextStatus === "closed" ? (existing.closedAt ?? updatedAt) : null;
    this.run(
      `
      update run_notes
      set content = ?, status = ?, updated_at = ?, closed_at = ?
      where id = ?
      `,
      [nextContent, nextStatus, updatedAt, closedAt, noteId],
    );
    return this.getRunNote(noteId);
  }

  deleteRunNote(noteId: string): void {
    this.run("delete from run_notes where id = ?", [noteId]);
  }

  private parseQueuedFollowUpRow(row: QueuedFollowUpRow): QueuedFollowUpEntry {
    const options = this.parseJsonObject(row.optionsJson) ?? {};
    const parsedAttachments = this.parseJsonValue<unknown>(row.attachmentsJson);
    const attachments = Array.isArray(parsedAttachments)
      ? parsedAttachments.filter((item): item is ChatAttachmentPayload =>
        Boolean(item) && typeof item === "object" &&
        typeof (item as ChatAttachmentPayload).fileName === "string" &&
        typeof (item as ChatAttachmentPayload).mimeType === "string" &&
        typeof (item as ChatAttachmentPayload).dataBase64 === "string")
      : [];
    const mode = typeof options.mode === "string" && QUEUED_FOLLOW_UP_MODES.has(options.mode) ? options.mode as RunMode : null;
    const deliveryState = parseQueuedFollowUpDeliveryState(row.deliveryState);
    return {
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      deliveryState,
      options,
      attachments,
      record: {
        id: row.id,
        runId: row.ownerKind === "run" ? row.ownerId : null,
        chatId: row.ownerKind === "chat" ? row.ownerId : null,
        position: row.position,
        prompt: row.prompt,
        modelId: typeof options.modelId === "string" ? options.modelId : null,
        mode,
        updatesGoal: Object.prototype.hasOwnProperty.call(options, "goalText"),
        attachments: attachments.map((attachment) => ({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: base64DecodedSize(attachment.dataBase64),
        })),
        deliveryUncertain: deliveryState === "uncertain",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  }

  /** Queue entries that are waiting (not mid-delivery), oldest first. */
  listQueuedFollowUpEntries(ownerKind: FollowUpQueueOwnerKind, ownerId: string): QueuedFollowUpEntry[] {
    return this.all<QueuedFollowUpRow>(
      `select ${QUEUED_FOLLOW_UP_COLUMNS} from queued_follow_ups
      where owner_kind = ? and owner_id = ? and ${QUEUED_FOLLOW_UP_AVAILABLE_SQL}
      order by position asc, created_at asc`,
      [ownerKind, ownerId],
    ).map((row) => this.parseQueuedFollowUpRow(row));
  }

  listQueuedFollowUps(ownerKind: FollowUpQueueOwnerKind, ownerId: string): QueuedFollowUpRecord[] {
    return this.listQueuedFollowUpEntries(ownerKind, ownerId).map((entry) => entry.record);
  }

  /** Entries whose delivery was in progress, e.g. when the app stopped. */
  listQueuedFollowUpEntriesInDelivery(): QueuedFollowUpEntry[] {
    return this.all<QueuedFollowUpRow>(
      `select ${QUEUED_FOLLOW_UP_COLUMNS} from queued_follow_ups where delivery_state in ('starting', 'steering')`,
    ).map((row) => this.parseQueuedFollowUpRow(row));
  }

  setQueuedFollowUpDeliveryState(id: string, state: QueuedFollowUpDeliveryState | null): void {
    this.run("update queued_follow_ups set delivery_state = ?, updated_at = ? where id = ?", [state, nowIso(), id]);
  }

  /** True when the owner's history already holds the user step a queued follow-up produced. */
  hasStepForQueuedFollowUp(ownerKind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): boolean {
    const table = ownerKind === "run" ? "run_steps" : "chat_steps";
    const ownerColumn = ownerKind === "run" ? "run_id" : "chat_id";
    return Boolean(this.first<{ found: number }>(
      `select 1 as found from ${table} where ${ownerColumn} = ? and metadata_json like ? limit 1`,
      [ownerId, `%"queuedFollowUpId":${JSON.stringify(queuedFollowUpId)}%`],
    ));
  }

  /**
   * Removes the user steps an undelivered attempt of a queued follow-up wrote, so a retry does
   * not repeat the message in the transcript or in later context handoffs. Returns the count.
   */
  deleteStepsForQueuedFollowUp(ownerKind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): number {
    const table = ownerKind === "run" ? "run_steps" : "chat_steps";
    const ownerColumn = ownerKind === "run" ? "run_id" : "chat_id";
    const params = [ownerId, `%"queuedFollowUpId":${JSON.stringify(queuedFollowUpId)}%`];
    const count = this.first<{ count: number }>(
      `select count(*) as count from ${table} where ${ownerColumn} = ? and metadata_json like ?`,
      params,
    )?.count ?? 0;
    if (count === 0) return 0;
    this.run(`delete from ${table} where ${ownerColumn} = ? and metadata_json like ?`, params);
    if (ownerKind === "run") this.derivedRunStateCache.delete(ownerId);
    return count;
  }

  getQueuedFollowUpEntry(id: string): QueuedFollowUpEntry | null {
    const row = this.first<QueuedFollowUpRow>(`select ${QUEUED_FOLLOW_UP_COLUMNS} from queued_follow_ups where id = ?`, [id]);
    return row ? this.parseQueuedFollowUpRow(row) : null;
  }

  /** Appends to the end of the queue. */
  enqueueFollowUp(input: {
    ownerKind: FollowUpQueueOwnerKind;
    ownerId: string;
    prompt: string;
    options: Record<string, unknown>;
    attachments: ChatAttachmentPayload[];
  }): QueuedFollowUpEntry {
    const bounds = this.first<{ maxPosition: number | null }>(
      "select max(position) as maxPosition from queued_follow_ups where owner_kind = ? and owner_id = ?",
      [input.ownerKind, input.ownerId],
    );
    const position = (bounds?.maxPosition ?? 0) + 1;
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into queued_follow_ups (id, owner_kind, owner_id, position, prompt, options_json, attachments_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.ownerKind, input.ownerId, position, input.prompt, JSON.stringify(input.options), JSON.stringify(input.attachments),
        timestamp, timestamp],
    );
    const entry = this.getQueuedFollowUpEntry(id);
    if (!entry) throw new Error("The queued follow-up could not be saved.");
    return entry;
  }

  updateQueuedFollowUpPrompt(id: string, prompt: string): void {
    this.run("update queued_follow_ups set prompt = ?, updated_at = ? where id = ?", [prompt, nowIso(), id]);
  }

  /** Moves an entry one place, or to the front. Returns false when it cannot move. */
  moveQueuedFollowUp(id: string, direction: "up" | "down" | "front"): boolean {
    return this.transaction(() => {
      const entry = this.getQueuedFollowUpEntry(id);
      if (!entry) return false;
      const siblings = this.listQueuedFollowUpEntries(entry.ownerKind, entry.ownerId);
      const index = siblings.findIndex((sibling) => sibling.record.id === id);
      let targetIndex = index + 1;
      if (direction === "front") targetIndex = 0;
      else if (direction === "up") targetIndex = index - 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length || targetIndex === index) return false;
      const reordered = [...siblings];
      const [moved] = reordered.splice(index, 1);
      if (!moved) return false;
      reordered.splice(targetIndex, 0, moved);
      const timestamp = nowIso();
      reordered.forEach((sibling, position) => {
        this.run("update queued_follow_ups set position = ?, updated_at = case when id = ? then ? else updated_at end where id = ?",
          [position + 1, id, timestamp, sibling.record.id]);
      });
      return true;
    });
  }

  deleteQueuedFollowUp(id: string): void {
    this.run("delete from queued_follow_ups where id = ?", [id]);
  }

  deleteQueuedFollowUpsForOwner(ownerKind: FollowUpQueueOwnerKind, ownerId: string): void {
    this.run("delete from queued_follow_ups where owner_kind = ? and owner_id = ?", [ownerKind, ownerId]);
  }

  listRunsForProject(projectId: string, summaryOnly?: false): RunRecord[];
  listRunsForProject(projectId: string, summaryOnly: true): RunListItem[];
  listRunsForProject(projectId: string, summaryOnly = false): RunListItem[] {
    return this.withDerivedRunStates(this.all<RunListItem>(
      `
      select
        ${summaryOnly ? RUN_PREVIEW_FLAGS_SQL : ""}
        id,
        project_id as projectId,
        provider_account_id as providerAccountId,
        model_id as modelId,
        harness_type as harnessType,
        run_mode as mode,
        workspace_type as workspaceType,
        workspace_vcs as workspaceVcs,
        ${summaryOnly ? "substr(prompt, 1, 500)" : "prompt"} as prompt,
        ${SESSION_TITLE_SQL}
        ${summaryOnly ? "substr(goal_text, 1, 500)" : "goal_text"} as goalText,
        status,
        branch_name as branchName,
        worktree_path as worktreePath,
        ${summaryOnly ? "substr(summary, 1, 500)" : "summary"} as summary,
        ${summaryOnly ? "substr(error_message, 1, 500)" : "error_message"} as errorMessage,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        list_visibility as listVisibility,
        run_kind as kind,
        lab_thread_id as labThreadId,
        parent_run_id as parentRunId,
        root_run_id as rootRunId,
        lineage_title as lineageTitle,
        project_task_id as projectTaskId,
        automation_id as automationId,
        delegation_enabled as delegationEnabled,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from runs
      where project_id = ?
      order by created_at desc
      `,
      [projectId],
    ));
  }

  private listRunsByIds(runIds: string[], summaryOnly?: false): RunRecord[];
  private listRunsByIds(runIds: string[], summaryOnly: true): RunListItem[];
  private listRunsByIds(runIds: string[], summaryOnly = false): RunListItem[] {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length === 0) {
      return [];
    }

    const runs: RunListItem[] = [];
    for (const batch of chunkValues(uniqueRunIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      runs.push(
        ...this.all<RunRecord>(
          `
          select
        ${summaryOnly ? RUN_PREVIEW_FLAGS_SQL : ""}
            id,
            project_id as projectId,
            provider_account_id as providerAccountId,
            model_id as modelId,
            harness_type as harnessType,
            run_mode as mode,
            workspace_type as workspaceType,
            workspace_vcs as workspaceVcs,
            ${summaryOnly ? "substr(prompt, 1, 500)" : "prompt"} as prompt,
            ${SESSION_TITLE_SQL}
            ${summaryOnly ? "substr(goal_text, 1, 500)" : "goal_text"} as goalText,
            status,
            branch_name as branchName,
            worktree_path as worktreePath,
            ${summaryOnly ? "substr(summary, 1, 500)" : "summary"} as summary,
            ${summaryOnly ? "substr(error_message, 1, 500)" : "error_message"} as errorMessage,
            last_provider_response_id as lastProviderResponseId,
            input_tokens as inputTokens,
            output_tokens as outputTokens,
            list_visibility as listVisibility,
            run_kind as kind,
            lab_thread_id as labThreadId,
            parent_run_id as parentRunId,
            root_run_id as rootRunId,
            lineage_title as lineageTitle,
            project_task_id as projectTaskId,
            automation_id as automationId,
            delegation_enabled as delegationEnabled,
            created_at as createdAt,
            updated_at as updatedAt,
            started_at as startedAt,
            finished_at as finishedAt
          from runs
          where id in (${placeholders})
          `,
          batch,
        ),
      );
    }

    return this.withDerivedRunStates(runs);
  }

  /** Used on app startup to find runs left in a non-terminal state after the process exited. */
  listRunsWithStatuses(statuses: RunStatus[]): RunRecord[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.all<RunRecord>(
      `
      select
        id,
        project_id as projectId,
        provider_account_id as providerAccountId,
        model_id as modelId,
        harness_type as harnessType,
        run_mode as mode,
        workspace_type as workspaceType,
        workspace_vcs as workspaceVcs,
        prompt,
        ${SESSION_TITLE_SQL}
        goal_text as goalText,
        status,
        branch_name as branchName,
        worktree_path as worktreePath,
        summary,
        error_message as errorMessage,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        list_visibility as listVisibility,
        run_kind as kind,
        lab_thread_id as labThreadId,
        parent_run_id as parentRunId,
        root_run_id as rootRunId,
        lineage_title as lineageTitle,
        project_task_id as projectTaskId,
        automation_id as automationId,
        delegation_enabled as delegationEnabled,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from runs
      where status in (${placeholders})
      order by created_at asc
      `,
      statuses,
    );
  }

  /** Used on app startup to find chats left in a non-terminal state after the process exited. */
  listChatsWithStatuses(statuses: RunStatus[]): ChatRecord[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.all<ChatRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        run_id as runId,
        ${SESSION_TITLE_SQL}
        prompt,
        status,
        last_provider_response_id as lastProviderResponseId,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        created_at as createdAt,
        updated_at as updatedAt,
        started_at as startedAt,
        finished_at as finishedAt
      from chats
      where status in (${placeholders})
      order by created_at asc
      `,
      statuses,
    );
  }

  countProviderAccountReferences(providerAccountId: string): number {
    const row = this.first<{ count: number }>(
      `
      select
        (select count(*) from runs where provider_account_id = ?) +
        (select count(*) from project_automations automation
          join models model on model.id = automation.model_id
          where model.provider_account_id = ?) as count
      `,
      [providerAccountId, providerAccountId],
    );

    return Number(row?.count ?? 0);
  }

  updateRunStatus(
    runId: string,
    status: RunStatus,
    fields?: {
      summary?: string | null;
      errorMessage?: string | null;
      lastProviderResponseId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): RunRecord {
    const existing = this.getRun(runId);
    const timestamp = nowIso();
    const startedAt = existing.startedAt ?? (status === "running" || status === "preparing" ? timestamp : null);
    const finishedAt =
      status === "completed" || status === "failed" || status === "cancelled" ? timestamp : existing.finishedAt;

    this.run(
      `
      update runs
      set status = ?, summary = ?, error_message = ?, last_provider_response_id = ?, input_tokens = ?, output_tokens = ?, updated_at = ?, started_at = ?, finished_at = ?
      where id = ?
      `,
      [
        status,
        fields?.summary ?? existing.summary,
        fields?.errorMessage ?? existing.errorMessage,
        fields?.lastProviderResponseId ?? existing.lastProviderResponseId,
        fields?.inputTokens ?? existing.inputTokens,
        fields?.outputTokens ?? existing.outputTokens,
        timestamp,
        startedAt,
        finishedAt,
        runId,
      ],
    );
    return this.getRun(runId);
  }

  updateRunConfiguration(
    runId: string,
    fields: {
      providerAccountId?: string;
      modelId?: string;
      mode?: RunRecord["mode"];
      goalText?: string | null;
      delegationEnabled?: boolean;
    },
  ): RunRecord {
    const existing = this.getRun(runId);
    const timestamp = nowIso();
    const nextProviderAccountId = fields.providerAccountId ?? existing.providerAccountId;

    this.run(
      `
      update runs
      set provider_account_id = ?, model_id = ?, run_mode = ?, goal_text = ?, delegation_enabled = ?, updated_at = ?,
        last_provider_response_id = ?
      where id = ?
      `,
      [
        nextProviderAccountId,
        fields.modelId ?? existing.modelId,
        fields.mode ?? existing.mode,
        fields.goalText !== undefined ? fields.goalText : existing.goalText,
        fields.delegationEnabled === undefined ? Number(existing.delegationEnabled) : Number(fields.delegationEnabled),
        timestamp,
        // A response/session id only means something to the account that produced it.
        nextProviderAccountId === existing.providerAccountId ? existing.lastProviderResponseId : null,
        runId,
      ],
    );
    this.derivedRunStateCache.delete(runId);
    return this.getRun(runId);
  }

  updateRunBranchName(runId: string, branchName: string): RunRecord {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }

    const timestamp = nowIso();
    this.run(
      `
      update runs
      set branch_name = ?, updated_at = ?
      where id = ?
      `,
      [trimmedBranchName, timestamp, runId],
    );
    this.run(
      `
      update worktrees
      set branch_name = ?, updated_at = ?
      where run_id = ?
      `,
      [trimmedBranchName, timestamp, runId],
    );
    return this.getRun(runId);
  }

  updateRunWorkspace(runId: string, workspaceType: RunRecord["workspaceType"], worktreePath: string): RunRecord {
    const trimmedPath = worktreePath.trim();
    if (!trimmedPath) {
      throw new Error("Enter a workspace path.");
    }

    const timestamp = nowIso();
    this.run(
      `
      update runs
      set workspace_type = ?, worktree_path = ?, updated_at = ?
      where id = ?
      `,
      [workspaceType, trimmedPath, timestamp, runId],
    );

    if (workspaceType === "worktree" || workspaceType === "copy") {
      this.run(
        `
        update worktrees
        set worktree_path = ?, updated_at = ?
        where run_id = ?
        `,
        [trimmedPath, timestamp, runId],
      );
    } else {
      this.run("delete from worktrees where run_id = ?", [runId]);
    }
    return this.getRun(runId);
  }

  listAttentionInbox(): AttentionItem[] {
    const settings = parseAttentionInboxSettings(this.getSettings()[APP_SETTING_KEYS.attentionInbox]);
    const enabledKinds = (Object.keys(settings.kinds) as AttentionKind[]).filter((kind) => settings.enabled && settings.kinds[kind]);
    if (!enabledKinds.length) return [];
    return this.all<Omit<AttentionItem, "dismissible"> & { dismissible: number }>(`
      with candidates as (
        select 'request:' || s.id as id,
          case when s.event_type = 'approval-requested' then 'approval' else 'input' end as kind,
          r.project_id as projectId, p.name as projectName, r.id as runId,
          substr(r.prompt, 1, 180) as title, substr(s.content, 1, 600) as detail,
          s.created_at as createdAt, 0 as dismissible
        from run_steps s join runs r on r.id = s.run_id join projects p on p.id = r.project_id
        where r.status in ('queued', 'preparing', 'running')
          and r.run_kind != 'council-review'
          and s.event_type in ('approval-requested', 'user-input-requested')
          and json_valid(s.metadata_json) and json_extract(s.metadata_json, '$.requestStatus') = 'opened'
        union all
        select 'run:' || r.id || ':' || r.status || ':' || coalesce(r.finished_at, r.updated_at),
          case when r.status = 'failed' then 'failed' else 'review' end,
          r.project_id, p.name, r.id, substr(r.prompt, 1, 180),
          substr(coalesce(r.error_message, r.summary, 'Open the run to review its result.'), 1, 600),
          coalesce(r.finished_at, r.updated_at), 1
        from runs r join projects p on p.id = r.project_id
        where r.status in ('failed', 'completed') and r.list_visibility != 'for-later' and r.run_kind != 'council-review'
        union all
        select 'council:' || c.id || ':' || c.status, case when c.status in ('failed', 'apply-failed') then 'failed' else 'review' end,
          c.project_id, p.name, c.run_id, substr(r.prompt, 1, 180),
          case c.status when 'ready' then 'Validation results are ready.' when 'failed' then 'Validation could not finish.' else 'Applying the selected findings failed.' end,
          coalesce(json_extract(c.round_json, '$.finishedAt'), c.created_at), 1
        from run_council_rounds c join runs r on r.id = c.run_id join projects p on p.id = c.project_id
        where c.status in ('ready', 'failed', 'apply-failed') and json_extract(c.round_json, '$.trigger') = 'auto'
        union all
        select 'orchestration:' || o.id || ':' || o.attention_started_at, 'blocked', r.project_id, p.name,
          r.id, substr(r.prompt, 1, 180), 'Orchestration needs attention. Open the run to resolve blocked tasks.', o.attention_started_at, 0
        from orchestrations o join runs r on r.id = o.coordinator_run_id join projects p on p.id = r.project_id
        where o.status = 'attention' and r.status != 'failed'
      )
      select c.* from candidates c left join attention_acknowledgements a on a.item_id = c.id
      where (a.item_id is null or c.dismissible = 0)
        and c.kind in (${enabledKinds.map(() => "?").join(",")})
        and not exists (
          select 1 from attention_suppression_windows w where w.kind = c.kind
            and c.createdAt >= w.started_at and (w.ended_at is null or c.createdAt < w.ended_at)
        )
      order by case c.kind when 'approval' then 0 when 'input' then 1 when 'failed' then 2 when 'blocked' then 3 else 4 end,
        c.createdAt desc, c.id
    `, enabledKinds).map((item) => ({ ...item, dismissible: Boolean(item.dismissible) }));
  }

  acknowledgeAttentionItem(itemId: string): void {
    this.acknowledgeAttentionItems([itemId]);
  }

  acknowledgeAttentionItems(itemIds: string[]): void {
    if (!itemIds.length) return;
    const requested = new Set(itemIds);
    this.transaction(() => {
      const items = this.listAttentionInbox().filter((candidate) => requested.has(candidate.id));
      if (items.some((item) => !item.dismissible)) throw new Error("Resolve live requests in the run before clearing them.");
      const timestamp = nowIso();
      for (const item of items) {
        // Missing or already acknowledged IDs are ignored; new arrivals are never included.
        this.run("insert or ignore into attention_acknowledgements (item_id, run_id, acknowledged_at) values (?, ?, ?)", [item.id, item.runId, timestamp]);
      }
    });
  }

  updateRunListVisibility(runId: string, visibility: RunListVisibility): RunRecord {
    const timestamp = nowIso();
    this.run(
      `
      update runs
      set list_visibility = ?, updated_at = ?
      where id = ?
      `,
      [visibility, timestamp, runId],
    );
    return this.getRun(runId);
  }

  appendRunStep(runId: string, eventType: string, title: string, content: string, metadataJson = "{}"): RunStepRecord {
    const id = createId();
    const createdAt = nowIso();
    const metadata = this.parseJsonObject(metadataJson);
    const affectsSummary = (eventType === "log" || eventType === "user-input-requested")
      && (metadata?.source === "user" || metadata?.requestKind === "user-input");
    const summary = affectsSummary ? this.first<{ lastUserInputAt: string; pendingUserInputRequest: number }>(
      `select last_user_input_at as lastUserInputAt, pending_user_input_request as pendingUserInputRequest
       from run_list_summaries where run_id = ?`, [runId],
    ) : null;
    this.run(
      `
      insert into run_steps (id, run_id, event_type, title, content, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, runId, eventType, title, content, metadataJson, createdAt],
    );
    const cached = this.derivedRunStateCache.get(runId);
    if (cached && affectsSummary) {
      applyDerivedRunStep(cached, { eventType, content, createdAt }, this.parseJsonObject(metadataJson));
    }
    if (summary) {
      const next: DerivedRunState = { ...summary, pendingUserInputRequest: Boolean(summary.pendingUserInputRequest), parts: new Set() };
      applyDerivedRunStep(next, { eventType, content, createdAt }, this.parseJsonObject(metadataJson));
      this.saveRunListSummary(runId, next);
    }
    return {
      id,
      runId,
      eventType: eventType as RunStepRecord["eventType"],
      title,
      content,
      metadataJson,
      createdAt,
    };
  }

  updateRunStep(
    stepId: string,
    fields: {
      eventType?: string;
      title?: string;
      content?: string;
      metadataJson?: string;
    },
  ): RunStepRecord {
    const existing = this.first<RunStepRecord>(
      `
      select
        id,
        run_id as runId,
        event_type as eventType,
        title,
        content,
        metadata_json as metadataJson,
        created_at as createdAt
      from run_steps
      where id = ?
      `,
      [stepId],
    );

    if (!existing) {
      throw new Error(`Run step not found: ${stepId}`);
    }
    // Only user/log history contributes to the run's derived list state. Text
    // replacements must not force the next run read to scan that history again.
    if ([existing.eventType, fields.eventType].some((type) => type === "log" || type === "user-input-requested")) {
      this.derivedRunStateCache.delete(existing.runId);
    }

    this.run(
      `
      update run_steps
      set event_type = ?, title = ?, content = ?, metadata_json = ?
      where id = ?
      `,
      [
        fields.eventType ?? existing.eventType,
        fields.title ?? existing.title,
        fields.content ?? existing.content,
        fields.metadataJson ?? existing.metadataJson,
        stepId,
      ],
    );

    return this.first<RunStepRecord>(
      `
      select
        id,
        run_id as runId,
        event_type as eventType,
        title,
        content,
        metadata_json as metadataJson,
        created_at as createdAt
      from run_steps
      where id = ?
      `,
      [stepId],
    )!;
  }

  getRunSteps(runId: string): RunStepRecord[] {
    return this.all<RunStepRecord>(
      `
      select
        id,
        run_id as runId,
        event_type as eventType,
        title,
        content,
        metadata_json as metadataJson,
        created_at as createdAt
      from run_steps
      where run_id = ?
      order by created_at asc, rowid asc
      `,
      [runId],
    );
  }

  /** Latest steps in chronological order, truncated in SQL so large tool output is never loaded. Skips superseded progress rows. */
  listRecentRunStepPreviews(runId: string, limit: number, maxContentChars: number): RunStepPreview[] {
    if (limit <= 0) return [];
    return this.all<RunStepPreview>(
      `
      select
        event_type as eventType,
        title,
        substr(content, 1, ?) as content,
        length(content) as contentChars,
        created_at as createdAt
      from run_steps
      where run_id = ? and event_type not in ('tool-progress', 'diff-updated')
      order by created_at desc, rowid desc
      limit ?
      `,
      [maxContentChars, runId, limit],
    ).reverse();
  }

  getRunRecoveryEventTimestamps(runId: string): { latestInterruptedAt: string; latestRecoveryAt: string } {
    const latestInterruptedAt =
      this.first<{ createdAt: string }>(
        `select created_at as createdAt from run_steps
         where run_id = ? and json_valid(metadata_json) and json_extract(metadata_json, '$.sessionInterrupted') = 1
         order by rowid desc limit 1`,
        [runId],
      )?.createdAt ?? "";
    const latestRecoveryAt = this.first<{ createdAt: string }>(
      `select created_at as createdAt from run_steps
       where run_id = ? and json_valid(metadata_json)
         and (json_extract(metadata_json, '$.recoveredInterruptedSession') = 1
           or json_extract(metadata_json, '$.resumedFromCheckpoint') = 1)
       order by rowid desc limit 1`,
      [runId],
    )?.createdAt ?? "";
    return {
      latestInterruptedAt,
      latestRecoveryAt,
    };
  }

  getInitialRunHistory(runId: string): RunHistoryPage {
    this.getRun(runId);
    return {
      ...this.getInitialHistoryPage<RunStepRecord>("run_steps", "run_id", "runId", runId),
      stale: false,
    };
  }

  getEarlierRunHistory(runId: string, request: UserAnchoredHistoryPageRequest): RunHistoryPage {
    this.getRun(runId);
    return this.getEarlierHistoryPage<RunStepRecord>("run_steps", "run_id", "runId", runId, request);
  }

  upsertWorktree(worktree: Omit<WorktreeRecord, "createdAt" | "updatedAt">): WorktreeRecord {
    const existing = this.first<WorktreeRecord>(
      `
      select
        id,
        project_id as projectId,
        run_id as runId,
        branch_name as branchName,
        worktree_path as worktreePath,
        status,
        created_at as createdAt,
        updated_at as updatedAt
      from worktrees
      where id = ?
      `,
      [worktree.id],
    );
    const timestamp = nowIso();

    if (existing) {
      this.run(
        `
        update worktrees
        set project_id = ?, run_id = ?, branch_name = ?, worktree_path = ?, status = ?, updated_at = ?
        where id = ?
        `,
        [worktree.projectId, worktree.runId, worktree.branchName, worktree.worktreePath, worktree.status, timestamp, worktree.id],
      );
    } else {
      this.run(
        `
        insert into worktrees (id, project_id, run_id, branch_name, worktree_path, status, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          worktree.id,
          worktree.projectId,
          worktree.runId,
          worktree.branchName,
          worktree.worktreePath,
          worktree.status,
          timestamp,
          timestamp,
        ],
      );
    }

    return this.first<WorktreeRecord>(
      `
      select
        id,
        project_id as projectId,
        run_id as runId,
        branch_name as branchName,
        worktree_path as worktreePath,
        status,
        created_at as createdAt,
        updated_at as updatedAt
      from worktrees
      where id = ?
      `,
      [worktree.id],
    )!;
  }

  setProjectRevisionVerificationPolicy(projectId: string, enabled: boolean): void {
    this.transaction(() => {
      this.getProject(projectId);
      const policies = parseRevisionVerificationPolicy(this.getSettings()[APP_SETTING_KEYS.revisionVerificationPolicy]);
      this.setSetting(APP_SETTING_KEYS.revisionVerificationPolicy, JSON.stringify({ ...policies, [projectId]: enabled }));
    });
  }

  getTerminalDefaultShell() {
    return parseTerminalShell(this.first<{ value: string }>("select value from app_settings where key = ?", [APP_SETTING_KEYS.terminalDefaultShell])?.value);
  }

  setSetting(key: string, value: string): void {
    if (key === APP_SETTING_KEYS.terminalDefaultShell && parseTerminalShell(value) !== value) {
      throw new Error("Invalid default terminal shell.");
    }
    if (key === APP_SETTING_KEYS.remoteAccessExposure && !["local", "tailnet", "internet"].includes(value)) {
      throw new Error("Remote access exposure must be local, tailnet, or internet.");
    }
    this.settingsRevision += 1;
    const timestamp = nowIso();
    if (key === APP_SETTING_KEYS.attentionInbox) {
      const previous = parseAttentionInboxSettings(this.getSettings()[key]);
      const next = parseAttentionInboxSettings(value);
      // Keep publication history separate from run history, including across restarts.
      this.exec("savepoint attention_preferences");
      try {
        for (const kind of Object.keys(ATTENTION_KIND_LABELS) as AttentionKind[]) {
          const wasEnabled = previous.enabled && previous.kinds[kind];
          const enabled = next.enabled && next.kinds[kind];
          if (wasEnabled && !enabled) {
            this.run("insert into attention_suppression_windows (kind, started_at) values (?, ?)", [kind, timestamp]);
          } else if (!wasEnabled && enabled) {
            this.run("update attention_suppression_windows set ended_at = ? where kind = ? and ended_at is null", [timestamp, kind]);
          }
        }
        this.run("insert into app_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at", [key, JSON.stringify(next), timestamp]);
        this.exec("release attention_preferences");
      } catch (error) {
        this.exec("rollback to attention_preferences");
        this.exec("release attention_preferences");
        throw error;
      }
      return;
    }
    this.run(
      `
      insert into app_settings (key, value, updated_at)
      values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      [key, value, timestamp],
    );
  }

  listRunTurnRestorePoints(runId: string): RunTurnRestorePointSummary[] {
    return this.all<{ pointJson: string }>("select point_json as pointJson from run_turn_restore_points where run_id = ? order by rowid", [runId])
      .map(({ pointJson }) => {
        const { id, stepId, prompt, createdAt, commandType, filesAvailable } = JSON.parse(pointJson) as RunTurnRestorePoint;
        return { id, stepId, prompt, createdAt, commandType, filesAvailable };
      });
  }

  getRunTurnRestorePoint(runId: string, pointId: string): RunTurnRestorePoint | null {
    const row = this.first<{ pointJson: string; patch: string | null }>("select point_json as pointJson, patch from run_turn_restore_points where run_id = ? and id = ?", [runId, pointId]);
    return row ? { ...JSON.parse(row.pointJson) as RunTurnRestorePoint, patch: row.patch } : null;
  }

  /**
   * Stores a prompt boundary separately from its file patch so detail loads stay lightweight.
   * Retains the latest 50 boundaries and at most 32 MiB of patches per run; boundaries whose
   * patches exceed that budget remain available for conversation-only rewind.
   */
  saveRunTurnRestorePoint(runId: string, point: RunTurnRestorePoint): void {
    this.transaction(() => {
      const { patch, ...pointMetadata } = point;
      this.run("insert into run_turn_restore_points (id, run_id, step_id, patch, point_json) values (?, ?, ?, ?, ?)", [point.id, runId, point.stepId, patch, JSON.stringify(pointMetadata)]);
      // Bound storage per run. Older conversation boundaries remain usable without files.
      this.run("delete from run_turn_restore_points where run_id = ? and id not in (select id from run_turn_restore_points where run_id = ? order by rowid desc limit 50)", [runId, runId]);
      let bytes = 0;
      for (const row of this.all<{ id: string; bytes: number }>("select id, coalesce(length(cast(patch as blob)), 0) as bytes from run_turn_restore_points where run_id = ? order by rowid desc", [runId])) {
        if (bytes + row.bytes <= 32 * 1024 * 1024) { bytes += row.bytes; continue; }
        this.run("update run_turn_restore_points set patch = null, point_json = json_set(point_json, '$.filesAvailable', json('false')) where id = ?", [row.id]);
      }
    });
  }

  getPendingRunRewind(runId: string): PendingRunRewind | null {
    const row = this.first<{ json: string }>("select operation_json as json from run_rewind_operations where run_id = ?", [runId]);
    return row ? JSON.parse(row.json) as PendingRunRewind : null;
  }

  listPendingRewindWorkspaces(): string[] {
    return this.all<{ path: string }>("select r.worktree_path as path from runs r join run_rewind_operations o on o.run_id = r.id").map((row) => row.path);
  }

  savePendingRunRewind(operation: PendingRunRewind): void {
    this.run("insert into run_rewind_operations (run_id, operation_json) values (?, ?) on conflict(run_id) do update set operation_json = excluded.operation_json",
      [operation.input.runId, JSON.stringify(operation)]);
  }

  /** Atomically journals a rewind and invalidates every account's resume cursor and checkpoint. */
  beginRunRewind(operation: PendingRunRewind): void {
    this.transaction(() => {
      if (this.getPendingRunRewind(operation.input.runId)) throw new Error("A rewind is already in progress.");
      this.savePendingRunRewind(operation);
      // Invalidate every account, including providers switched away from. No stale session can return.
      this.deleteProviderSessionRuntime(operation.input.runId, "run");
      this.run("update runs set last_provider_response_id = null where id = ?", [operation.input.runId]);
      this.deleteSetting("runCheckpoint:" + operation.input.runId);
    });
  }

  getRunRewindHistory(runId: string): RunRewindArchive[] {
    return this.all<{ json: string }>("select archive_json as json from run_rewind_archives where run_id = ? order by rowid", [runId])
      .map((row) => JSON.parse(row.json) as RunRewindArchive);
  }

  /**
   * Commits the active-history change after provider and optional file restoration finish.
   * Archives the selected prompt and later steps, retains lifetime usage, restores only a
   * verified native session, and clears the journal atomically so execution can resume.
   */
  completeRunRewind(operation: PendingRunRewind, point: RunTurnRestorePoint): void {
    this.transaction(() => {
      const runId = operation.input.runId;
      const steps = this.getRunSteps(runId);
      const boundary = steps.findIndex((step) => step.id === point.stepId);
      if (boundary < 0) throw new Error("The rewind prompt is no longer in active history.");
      const discarded = steps.slice(boundary);
      const archive: RunRewindArchive = { id: operation.id, createdAt: operation.createdAt, prompt: point.prompt, mode: operation.input.mode, steps: discarded };
      this.run("insert into run_rewind_archives (id, run_id, archive_json) values (?, ?, ?)", [operation.id, runId, JSON.stringify(archive)]);
      for (const step of discarded) {
        this.run("delete from run_turn_restore_points where run_id = ? and step_id = ?", [runId, step.id]);
        this.run("delete from run_steps where run_id = ? and id = ?", [runId, step.id]);
      }
      const previousUser = steps.slice(0, boundary).reverse().find((step) => this.parseJsonObject(step.metadataJson)?.source === "user");
      const goalText = previousUser ? this.parseJsonObject(previousUser.metadataJson)?.goalText : null;
      this.run("update runs set status = 'completed', summary = null, error_message = null, goal_text = ?, last_provider_response_id = null, updated_at = ? where id = ?",
        [typeof goalText === "string" ? goalText : null, nowIso(), runId]);
      if (operation.providerStrategy === "native" && operation.session) {
        this.upsertProviderSessionRuntime({ ...operation.session, status: "ready" });
        for (const table of ["provider_session_runtime", "provider_account_sessions"]) {
          this.run(`update ${table} set last_seen_at = ? where owner_id = ? and owner_kind = 'run'`, [operation.session.lastSeenAt, runId]);
        }
      }
      this.appendRunStep(runId, "status", "Conversation rewound",
        operation.input.mode === "conversation" ? "Later conversation turns were archived. Files were kept unchanged; inspect the current files before continuing." : "Conversation and files restored to before the selected prompt.",
        JSON.stringify({ rewindId: operation.id, rewindMode: operation.input.mode, providerStrategy: operation.providerStrategy, safetyPatchPath: operation.safetyPatchPath }));
      this.deleteRunPromptRestorePoint(runId);
      this.run("delete from queued_follow_ups where owner_kind = 'run' and owner_id = ?", [runId]);
      this.derivedRunStateCache.delete(runId);
      this.run("delete from run_list_summaries where run_id = ?", [runId]);
      this.run("delete from run_rewind_operations where run_id = ?", [runId]);
    });
  }

  getRunPromptRestorePoint(runId: string): RunPromptRestorePoint | null {
    const row = this.first<Omit<RunPromptRestorePoint, "headSha"> & { headSha: string | null }>(
      "select created_at as createdAt, command_type as commandType, patch, head_sha as headSha from run_restore_points where run_id = ?",
      [runId],
    );
    if (!row) return null;
    const { headSha, ...restorePoint } = row;
    return headSha ? { ...restorePoint, headSha } : restorePoint;
  }

  setRunPromptRestorePoint(runId: string, restorePoint: RunPromptRestorePoint): void {
    // Preserve the Git service's opaque patch encoding verbatim, including legacy text snapshots.
    this.run(
      `insert into run_restore_points (run_id, command_type, patch, head_sha, created_at) values (?, ?, ?, ?, ?)
       on conflict(run_id) do update set command_type = excluded.command_type, patch = excluded.patch,
         head_sha = excluded.head_sha, created_at = excluded.created_at`,
      [runId, restorePoint.commandType, restorePoint.patch, restorePoint.headSha ?? null, restorePoint.createdAt],
    );
  }

  deleteRunPromptRestorePoint(runId: string): void {
    this.run("delete from run_restore_points where run_id = ?", [runId]);
  }

  deleteSetting(key: string): void {
    this.settingsRevision += 1;
    if (key === APP_SETTING_KEYS.attentionInbox) this.setSetting(key, "{}");
    this.run("delete from app_settings where key = ?", [key]);
  }

  getSettings(): Record<string, string> {
    return this.all<AppSettingRecord>("select key, value, updated_at as updatedAt from app_settings").reduce<Record<string, string>>(
      (acc, entry) => {
        acc[entry.key] = entry.value;
        return acc;
      },
      {},
    );
  }

  createRemoteAccessPairingGrant(record: RemoteAccessPairingGrantRecord): void {
    this.run(
      `insert into remote_pairing_grants (id, token_hash, scopes_json, expires_at, used_at, created_at, client_origin)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.tokenHash, JSON.stringify(record.scopes), record.expiresAt, record.usedAt, record.createdAt, record.clientOrigin ?? null],
    );
  }

  consumeRemoteAccessPairingGrant(
    tokenHash: string,
    consumedAt: string,
    clientOrigin: string | null,
  ): RemoteAccessPairingGrantRecord | null {
    const row = this.first<{
      id: string;
      tokenHash: string;
      scopesJson: string;
      expiresAt: string;
      usedAt: string | null;
      createdAt: string;
      clientOrigin: string | null;
    }>(
      `select id, token_hash as tokenHash, scopes_json as scopesJson, expires_at as expiresAt,
              used_at as usedAt, created_at as createdAt, client_origin as clientOrigin
       from remote_pairing_grants
       where token_hash = ? and used_at is null and expires_at > ? and client_origin is ?`,
      [tokenHash, consumedAt, clientOrigin],
    );
    if (!row) {
      return null;
    }
    this.run("update remote_pairing_grants set used_at = ? where id = ? and used_at is null", [consumedAt, row.id]);
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      scopes: this.parseRemoteAccessScopes(row.scopesJson),
      expiresAt: row.expiresAt,
      usedAt: consumedAt,
      createdAt: row.createdAt,
      clientOrigin: row.clientOrigin,
    };
  }

  createRemoteAccessSession(record: RemoteAccessSessionRecord): void {
    this.run(
      `insert into remote_access_sessions (
         id, token_hash, label, scopes_json, created_at, expires_at, last_used_at, revoked_at, client_origin
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.tokenHash,
        record.label,
        JSON.stringify(record.scopes),
        record.createdAt,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
        record.clientOrigin,
      ],
    );
  }

  getRemoteAccessSessionByTokenHash(tokenHash: string): RemoteAccessSessionRecord | null {
    const row = this.first<{
      id: string;
      tokenHash: string;
      label: string;
      scopesJson: string;
      createdAt: string;
      expiresAt: string;
      lastUsedAt: string;
      revokedAt: string | null;
      clientOrigin: string | null;
    }>(
      `select id, token_hash as tokenHash, label, scopes_json as scopesJson, created_at as createdAt,
              expires_at as expiresAt, last_used_at as lastUsedAt, revoked_at as revokedAt, client_origin as clientOrigin
       from remote_access_sessions where token_hash = ?`,
      [tokenHash],
    );
    if (!row) {
      return null;
    }
    const { scopesJson, ...session } = row;
    return { ...session, scopes: this.parseRemoteAccessScopes(scopesJson) };
  }

  listRemoteAccessSessions(): RemoteAccessSession[] {
    return this.all<{
      id: string;
      label: string;
      scopesJson: string;
      createdAt: string;
      expiresAt: string;
      lastUsedAt: string;
      revokedAt: string | null;
      clientOrigin: string | null;
    }>(
      `select id, label, scopes_json as scopesJson, created_at as createdAt, expires_at as expiresAt,
              last_used_at as lastUsedAt, revoked_at as revokedAt, client_origin as clientOrigin
       from remote_access_sessions order by created_at desc`,
    ).map(({ scopesJson, ...row }) => ({ ...row, scopes: this.parseRemoteAccessScopes(scopesJson) }));
  }

  touchRemoteAccessSession(sessionId: string, lastUsedAt: string): void {
    this.run(
      "update remote_access_sessions set last_used_at = ? where id = ? and revoked_at is null",
      [lastUsedAt, sessionId],
    );
  }

  revokeRemoteAccessSession(sessionId: string, revokedAt: string): boolean {
    this.run(
      "update remote_access_sessions set revoked_at = ? where id = ? and revoked_at is null",
      [revokedAt, sessionId],
    );
    const changed = (this.first<{ count: number }>("select changes() as count")?.count ?? 0) > 0;
    return changed;
  }

  createRemoteCommandIdempotency(record: RemoteCommandIdempotencyRecord): boolean {
    this.run(
      `insert or ignore into remote_command_idempotency (
         session_id, idempotency_key, method, request_hash, response_json, created_at, completed_at
       ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.idempotencyKey,
        record.method,
        record.requestHash,
        record.responseJson,
        record.createdAt,
        record.completedAt,
      ],
    );
    const created = (this.first<{ count: number }>("select changes() as count")?.count ?? 0) > 0;
    return created;
  }

  getRemoteCommandIdempotency(sessionId: string, idempotencyKey: string): RemoteCommandIdempotencyRecord | null {
    return this.first<RemoteCommandIdempotencyRecord>(
      `select session_id as sessionId, idempotency_key as idempotencyKey, method, request_hash as requestHash,
              response_json as responseJson, created_at as createdAt, completed_at as completedAt
       from remote_command_idempotency where session_id = ? and idempotency_key = ?`,
      [sessionId, idempotencyKey],
    ) ?? null;
  }

  completeRemoteCommandIdempotency(
    sessionId: string,
    idempotencyKey: string,
    responseJson: string,
    completedAt: string,
  ): boolean {
    this.run(
      `update remote_command_idempotency
       set response_json = ?, completed_at = ?
       where session_id = ? and idempotency_key = ? and response_json is null`,
      [responseJson, completedAt, sessionId, idempotencyKey],
    );
    const completed = (this.first<{ count: number }>("select changes() as count")?.count ?? 0) > 0;
    return completed;
  }

  pruneRemoteAccessRecords(cutoffs: {
    expiredPairingGrantBefore: string;
    securityAuditBefore: string;
    completedCommandBefore: string;
  }): number {
    let removed = 0;
    this.run(
      "delete from remote_pairing_grants where used_at is not null or expires_at <= ?",
      [cutoffs.expiredPairingGrantBefore],
    );
    removed += this.first<{ count: number }>("select changes() as count")?.count ?? 0;
    this.run("delete from remote_security_audit where created_at < ?", [cutoffs.securityAuditBefore]);
    removed += this.first<{ count: number }>("select changes() as count")?.count ?? 0;
    this.run(
      `delete from remote_command_idempotency
       where completed_at is not null and completed_at < ?`,
      [cutoffs.completedCommandBefore],
    );
    removed += this.first<{ count: number }>("select changes() as count")?.count ?? 0;
    return removed;
  }

  addRemoteAccessAuditRecord(record: RemoteAccessAuditRecord): void {
    this.run(
      `insert into remote_security_audit (
         id, event, outcome, session_id, pairing_grant_id, remote_address, details_json, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.event,
        record.outcome,
        record.sessionId,
        record.pairingGrantId,
        record.remoteAddress,
        record.details ? JSON.stringify(record.details) : null,
        record.createdAt,
      ],
    );
  }

  listRemoteAccessAuditRecords(): RemoteAccessAuditRecord[] {
    return this.all<{
      id: string;
      event: RemoteAccessAuditRecord["event"];
      outcome: RemoteAccessAuditRecord["outcome"];
      sessionId: string | null;
      pairingGrantId: string | null;
      remoteAddress: string | null;
      detailsJson: string | null;
      createdAt: string;
    }>(
      `select id, event, outcome, session_id as sessionId, pairing_grant_id as pairingGrantId,
              remote_address as remoteAddress, details_json as detailsJson, created_at as createdAt
       from remote_security_audit order by created_at desc`,
    ).map(({ detailsJson, ...row }) => ({ ...row, details: this.parseJsonObject(detailsJson) }));
  }

  upsertProviderSessionRuntime(input: ProviderSessionRuntimeInput): ProviderSessionRuntimeRecord {
    const providerAccountId = input.providerAccountId ?? null;
    this.writeProviderSessionRow(
      "provider_session_runtime",
      input,
      providerAccountId,
      this.getProviderSessionRuntime(input.ownerId, input.ownerKind)?.createdAt,
    );
    if (providerAccountId) {
      this.writeProviderSessionRow(
        "provider_account_sessions",
        input,
        providerAccountId,
        this.getProviderAccountSessionRuntime(input.ownerId, input.ownerKind, providerAccountId)?.createdAt,
      );
    }
    return this.getProviderSessionRuntime(input.ownerId, input.ownerKind)!;
  }

  private writeProviderSessionRow(
    table: "provider_session_runtime" | "provider_account_sessions",
    input: ProviderSessionRuntimeInput,
    providerAccountId: string | null,
    existingCreatedAt: string | undefined,
  ): void {
    const timestamp = nowIso();
    const conflictTarget = table === "provider_session_runtime" ? "owner_id, owner_kind" : "owner_id, owner_kind, provider_account_id";
    this.run(
      `
      insert into ${table} (
        owner_id, owner_kind, provider_account_id, provider_type, harness_type, status, cwd, model_id,
        runtime_mode, resume_cursor_json, runtime_payload_json, last_seen_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(${conflictTarget}) do update set
        provider_account_id = excluded.provider_account_id,
        provider_type = excluded.provider_type,
        harness_type = excluded.harness_type,
        status = excluded.status,
        cwd = excluded.cwd,
        model_id = excluded.model_id,
        runtime_mode = excluded.runtime_mode,
        resume_cursor_json = excluded.resume_cursor_json,
        runtime_payload_json = excluded.runtime_payload_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      `,
      [
        input.ownerId,
        input.ownerKind,
        providerAccountId,
        input.providerType,
        input.harnessType,
        input.status,
        input.cwd,
        input.modelId ?? null,
        input.runtimeMode,
        input.resumeCursor == null ? null : JSON.stringify(input.resumeCursor),
        input.runtimePayload == null ? null : JSON.stringify(input.runtimePayload),
        timestamp,
        existingCreatedAt ?? timestamp,
        timestamp,
      ],
    );
  }

  /** All persisted native workspace bindings, including previously selected accounts. */
  listProviderSessionWorkspaces(): Array<Pick<ProviderSessionRuntimeRecord, "ownerId" | "ownerKind" | "cwd">> {
    // Include account-specific sessions: the latest account may have a different cwd.
    return this.all(`select owner_id as ownerId, owner_kind as ownerKind, cwd from provider_session_runtime
      union select owner_id as ownerId, owner_kind as ownerKind, cwd from provider_account_sessions`);
  }

  /** Most recent native session of the owner, regardless of which account created it. */
  getProviderSessionRuntime(
    ownerId: string,
    ownerKind: ProviderSessionRuntimeRecord["ownerKind"],
  ): ProviderSessionRuntimeRecord | null {
    return this.readProviderSessionRow("provider_session_runtime", "owner_id = ? and owner_kind = ?", [ownerId, ownerKind]);
  }

  /** The native session a specific provider account holds for the owner, if any. */
  getProviderAccountSessionRuntime(
    ownerId: string,
    ownerKind: ProviderSessionRuntimeRecord["ownerKind"],
    providerAccountId: string,
  ): ProviderSessionRuntimeRecord | null {
    return this.readProviderSessionRow(
      "provider_account_sessions",
      "owner_id = ? and owner_kind = ? and provider_account_id = ?",
      [ownerId, ownerKind, providerAccountId],
    );
  }

  private readProviderSessionRow(
    table: "provider_session_runtime" | "provider_account_sessions",
    where: string,
    params: string[],
  ): ProviderSessionRuntimeRecord | null {
    const row = this.first<
      Omit<ProviderSessionRuntimeRecord, "resumeCursor" | "runtimePayload"> & {
        resumeCursorJson: string | null;
        runtimePayloadJson: string | null;
      }
    >(
      `
      select
        owner_id as ownerId,
        owner_kind as ownerKind,
        provider_account_id as providerAccountId,
        provider_type as providerType,
        harness_type as harnessType,
        status,
        cwd,
        model_id as modelId,
        runtime_mode as runtimeMode,
        resume_cursor_json as resumeCursorJson,
        runtime_payload_json as runtimePayloadJson,
        last_seen_at as lastSeenAt,
        created_at as createdAt,
        updated_at as updatedAt
      from ${table}
      where ${where}
      `,
      params,
    );
    if (!row) {
      return null;
    }
    const { resumeCursorJson, runtimePayloadJson, ...record } = row;
    return {
      ...record,
      resumeCursor: this.parseJsonObject(resumeCursorJson),
      runtimePayload: this.parseJsonObject(runtimePayloadJson),
    };
  }

  deleteProviderSessionRuntime(ownerId: string, ownerKind: ProviderSessionRuntimeRecord["ownerKind"]): void {
    this.run("delete from provider_session_runtime where owner_id = ? and owner_kind = ?", [ownerId, ownerKind]);
    this.run("delete from provider_account_sessions where owner_id = ? and owner_kind = ?", [ownerId, ownerKind]);
  }

  createOrchestration(input: {
    projectId: string;
    coordinatorRunId: string;
    teamSnapshot: OrchestrationTeamSettings;
  }): OrchestrationRecord {
    const existing = this.getOrchestrationByCoordinatorRunId(input.coordinatorRunId);
    if (existing) return existing;
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestrations (
        id, project_id, coordinator_run_id, status, team_snapshot_json, wake_mode, wake_task_ids_json,
        last_event_sequence, last_delivered_sequence, error_message, created_at, updated_at, finished_at,
        coordinator_token_baseline
      ) values (?, ?, ?, 'active', ?, null, '[]', 0, 0, null, ?, ?, null,
        coalesce((select input_tokens + output_tokens from runs where id = ?), 0))`,
      [id, input.projectId, input.coordinatorRunId, JSON.stringify(input.teamSnapshot), timestamp, timestamp, input.coordinatorRunId],
    );
    return this.getOrchestration(id);
  }

  getOrchestration(id: string): OrchestrationRecord {
    const row = this.first<StoredOrchestrationRecord>(`${ORCHESTRATION_SELECT} where id = ?`, [id]);
    if (!row) throw new Error(`Orchestration not found: ${id}`);
    return this.deserializeOrchestration(row);
  }

  private deserializeOrchestration(row: StoredOrchestrationRecord): OrchestrationRecord {
    let teamSnapshot: OrchestrationTeamSettings;
    let wakeTaskIds: string[];
    try {
      teamSnapshot = JSON.parse(row.teamSnapshotJson) as OrchestrationTeamSettings;
    } catch {
      throw new Error(`Orchestration team snapshot is invalid: ${row.id}`);
    }
    try {
      const parsed = JSON.parse(row.wakeTaskIdsJson) as unknown;
      wakeTaskIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      wakeTaskIds = [];
    }
    return {
      id: row.id,
      projectId: row.projectId,
      coordinatorRunId: row.coordinatorRunId,
      status: row.status,
      teamSnapshot,
      wakeMode: row.wakeMode,
      wakeTaskIds,
      lastEventSequence: row.lastEventSequence,
      lastDeliveredSequence: row.lastDeliveredSequence,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
    };
  }

  getOrchestrationByCoordinatorRunId(coordinatorRunId: string): OrchestrationRecord | null {
    const row = this.first<StoredOrchestrationRecord>(
      `${ORCHESTRATION_SELECT} where coordinator_run_id = ?`,
      [coordinatorRunId],
    );
    return row ? this.deserializeOrchestration(row) : null;
  }

  listOrchestrationsWithStatuses(statuses: OrchestrationStatus[]): OrchestrationRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.all<StoredOrchestrationRecord>(
      `${ORCHESTRATION_SELECT} where status in (${placeholders}) order by created_at asc`,
      statuses,
    ).map((row) => this.deserializeOrchestration(row));
  }

  updateOrchestration(
    id: string,
    fields: Partial<Pick<
      OrchestrationRecord,
      "status" | "teamSnapshot" | "wakeMode" | "wakeTaskIds" | "lastDeliveredSequence" | "errorMessage" | "finishedAt"
    >>,
  ): OrchestrationRecord {
    const existing = this.getOrchestration(id);
    const timestamp = nowIso();
    this.run(
      `update orchestrations set attention_started_at = case
         when ? != 'attention' then null
         when status = 'attention' then attention_started_at
         else ? end,
       status = ?, team_snapshot_json = ?, wake_mode = ?, wake_task_ids_json = ?,
       last_delivered_sequence = ?, error_message = ?, updated_at = ?, finished_at = ? where id = ?`,
      [
        fields.status ?? existing.status,
        timestamp,
        fields.status ?? existing.status,
        JSON.stringify(fields.teamSnapshot ?? existing.teamSnapshot),
        fields.wakeMode !== undefined ? fields.wakeMode : existing.wakeMode,
        JSON.stringify(fields.wakeTaskIds ?? existing.wakeTaskIds),
        fields.lastDeliveredSequence ?? existing.lastDeliveredSequence,
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        timestamp,
        fields.finishedAt !== undefined ? fields.finishedAt : existing.finishedAt,
        id,
      ],
    );
    return this.getOrchestration(id);
  }

  createOrchestrationWave(orchestrationId: string, baselinePath?: string | null): OrchestrationWaveRecord {
    const row = this.first<{ nextIndex: number }>(
      "select coalesce(max(wave_index), -1) + 1 as nextIndex from orchestration_waves where orchestration_id = ?",
      [orchestrationId],
    );
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_waves (
        id, orchestration_id, wave_index, baseline_path, baseline_state, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [id, orchestrationId, Number(row?.nextIndex ?? 0), baselinePath ?? null, baselinePath ? "ready" : "capturing", timestamp, timestamp],
    );
    return this.getOrchestrationWave(id);
  }

  getOrchestrationWave(id: string): OrchestrationWaveRecord {
    const wave = this.first<OrchestrationWaveRecord>(
      `select id, orchestration_id as orchestrationId, wave_index as waveIndex, baseline_path as baselinePath,
       baseline_state as baselineState, created_at as createdAt, updated_at as updatedAt
       from orchestration_waves where id = ?`,
      [id],
    );
    if (!wave) throw new Error(`Orchestration wave not found: ${id}`);
    return wave;
  }

  updateOrchestrationWave(
    id: string,
    fields: Partial<Pick<OrchestrationWaveRecord, "baselinePath" | "baselineState">>,
  ): OrchestrationWaveRecord {
    const existing = this.getOrchestrationWave(id);
    this.run(
      "update orchestration_waves set baseline_path = ?, baseline_state = ?, updated_at = ? where id = ?",
      [
        fields.baselinePath !== undefined ? fields.baselinePath : existing.baselinePath,
        fields.baselineState ?? existing.baselineState,
        nowIso(),
        id,
      ],
    );
    return this.getOrchestrationWave(id);
  }

  listOrchestrationWaves(orchestrationId: string): OrchestrationWaveRecord[] {
    return this.all<OrchestrationWaveRecord>(
      `select id, orchestration_id as orchestrationId, wave_index as waveIndex, baseline_path as baselinePath,
       baseline_state as baselineState, created_at as createdAt, updated_at as updatedAt
       from orchestration_waves where orchestration_id = ? order by wave_index asc`,
      [orchestrationId],
    );
  }

  createOrchestrationTask(input: {
    orchestrationId: string;
    waveId: string;
    clientTaskId: string;
    title: string;
    prompt: string;
    roleId: string;
    modelId: string;
    intent: OrchestrationTaskRecord["intent"];
    permissionMode?: "inherit" | "supervised";
    /** Validated per-task overrides of the role's provider settings. */
    executionOptions?: ProviderExecutionOptions | null;
    childRunId?: string | null;
    retryOfTaskId?: string | null;
  }): OrchestrationTaskRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_tasks (
        id, orchestration_id, wave_id, client_task_id, title, prompt, role_id, model_id, intent, permission_mode, status,
        child_run_id, retry_of_task_id, summary, error_message, attention_reason, adoption_status,
        input_tokens, output_tokens, created_at, updated_at, started_at, finished_at, execution_options_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, null, null, 'none', 0, 0, ?, ?, null, null, ?)`,
      [
        id,
        input.orchestrationId,
        input.waveId,
        input.clientTaskId,
        input.title,
        input.prompt,
        input.roleId,
        input.modelId,
        input.intent,
        input.permissionMode ?? "inherit",
        input.childRunId ?? null,
        input.retryOfTaskId ?? null,
        timestamp,
        timestamp,
        input.executionOptions && Object.keys(input.executionOptions).length > 0 ? JSON.stringify(input.executionOptions) : null,
      ],
    );
    return this.getOrchestrationTask(id);
  }

  getOrchestrationTaskExecutionOptions(taskId: string): ProviderExecutionOptions | null {
    const row = this.first<{ value: string | null }>("select execution_options_json as value from orchestration_tasks where id = ?", [taskId]);
    return row?.value ? (this.parseJsonObject(row.value) as ProviderExecutionOptions | null) : null;
  }

  /** The newest events of one task, newest last, without loading the whole orchestration log. */
  listOrchestrationTaskEvents(taskId: string, limit: number): OrchestrationEventRecord[] {
    return this.all<{
      id: string; orchestrationId: string; taskId: string | null; sequence: number; type: string;
      title: string; content: string; metadataJson: string; createdAt: string;
    }>(
      `select * from (
         select id, orchestration_id as orchestrationId, task_id as taskId, sequence, type, title, content,
           metadata_json as metadataJson, created_at as createdAt
         from orchestration_events where task_id = ? order by sequence desc limit ?
       ) order by sequence asc`,
      [taskId, Math.max(1, Math.floor(limit))],
    ).map((row) => ({ ...row, metadata: this.parseJsonObject(row.metadataJson) ?? {} }));
  }

  /** One page of a task's messages, newest first, with the total so callers can continue. */
  listOrchestrationTaskMessagesPage(taskId: string, offset: number, limit: number): {
    messages: OrchestrationTaskMessageRecord[]; total: number;
  } {
    const total = this.first<{ total: number }>("select count(*) as total from orchestration_task_messages where task_id = ?", [taskId])?.total ?? 0;
    const messages = this.all<OrchestrationTaskMessageRecord>(
      `select id, orchestration_id as orchestrationId, task_id as taskId, source, content, status,
         created_at as createdAt, delivered_at as deliveredAt
       from orchestration_task_messages where task_id = ? order by created_at desc, rowid desc limit ? offset ?`,
      [taskId, Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset))],
    );
    return { messages, total: Number(total) };
  }

  createOrchestrationEffect(input: {
    orchestrationId: string;
    taskId?: string | null;
    kind: OrchestrationEffectKind;
    payload: Record<string, unknown>;
  }): OrchestrationEffectRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_effects (id, orchestration_id, task_id, kind, status, payload_json, attempts, error_message, created_at, updated_at)
       values (?, ?, ?, ?, 'pending', ?, 0, null, ?, ?)`,
      [id, input.orchestrationId, input.taskId ?? null, input.kind, JSON.stringify(input.payload), timestamp, timestamp],
    );
    return this.getOrchestrationEffect(id)!;
  }

  getOrchestrationEffect(id: string): OrchestrationEffectRecord | null {
    const row = this.first<Omit<OrchestrationEffectRecord, "payload"> & { payloadJson: string }>(
      `${ORCHESTRATION_EFFECT_SELECT} where id = ?`, [id]);
    return row ? this.mapOrchestrationEffect(row) : null;
  }

  listPendingOrchestrationEffects(
    filter: { orchestrationId?: string; taskId?: string; kind?: OrchestrationEffectKind } = {},
  ): OrchestrationEffectRecord[] {
    const clauses = ["status = 'pending'"];
    const params: string[] = [];
    if (filter.orchestrationId) { clauses.push("orchestration_id = ?"); params.push(filter.orchestrationId); }
    if (filter.taskId) { clauses.push("task_id = ?"); params.push(filter.taskId); }
    if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind); }
    return this.all<Omit<OrchestrationEffectRecord, "payload"> & { payloadJson: string }>(
      `${ORCHESTRATION_EFFECT_SELECT} where ${clauses.join(" and ")} order by created_at asc, rowid asc`, params,
    ).map((row) => this.mapOrchestrationEffect(row));
  }

  updateOrchestrationEffect(id: string, fields: {
    status?: OrchestrationEffectRecord["status"];
    payload?: Record<string, unknown>;
    errorMessage?: string | null;
    incrementAttempts?: boolean;
  }): OrchestrationEffectRecord {
    const existing = this.getOrchestrationEffect(id);
    if (!existing) throw new Error(`Orchestration effect not found: ${id}`);
    this.run(
      "update orchestration_effects set status = ?, payload_json = ?, error_message = ?, attempts = attempts + ?, updated_at = ? where id = ?",
      [
        fields.status ?? existing.status,
        JSON.stringify(fields.payload ?? existing.payload),
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        fields.incrementAttempts ? 1 : 0,
        nowIso(),
        id,
      ],
    );
    return this.getOrchestrationEffect(id)!;
  }

  private mapOrchestrationEffect(row: Omit<OrchestrationEffectRecord, "payload"> & { payloadJson: string }): OrchestrationEffectRecord {
    const { payloadJson, ...rest } = row;
    return { ...rest, payload: this.parseJsonObject(payloadJson) ?? {} };
  }

  listOrchestrationTaskResults(taskId: string): OrchestrationTaskResultRecord[] {
    const task = this.getOrchestrationTask(taskId);
    return this.listOrchestrationEvents(task.orchestrationId)
      .filter((event) => event.taskId === taskId && event.type === "result-published")
      .map((event, index) => ({
        id: event.id, taskId, version: index + 1, createdAt: event.createdAt,
        ...(typeof event.metadata.workspaceSnapshotPath === "string" ? { workspaceSnapshotPath: event.metadata.workspaceSnapshotPath } : {}),
        status: event.metadata.status as OrchestrationTaskRecord["status"],
        summary: typeof event.metadata.summary === "string" ? event.metadata.summary : null,
        errorMessage: typeof event.metadata.errorMessage === "string" ? event.metadata.errorMessage : null,
      }));
  }

  publishOrchestrationTaskResult(taskId: string, workspaceSnapshotPath?: string): OrchestrationTaskResultRecord {
    const task = this.getOrchestrationTask(taskId);
    this.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId, taskId, type: "result-published", title: task.title,
      content: task.summary || task.errorMessage || `Task ${task.status}.`,
      metadata: { status: task.status, summary: task.summary, errorMessage: task.errorMessage, workspaceSnapshotPath },
    });
    return this.listOrchestrationTaskResults(taskId).at(-1)!;
  }

  getOrchestrationTask(id: string): OrchestrationTaskRecord {
    const task = this.first<OrchestrationTaskRecord>(
      `${ORCHESTRATION_TASK_SELECT} where id = ?`,
      [id],
    );
    if (!task) throw new Error(`Orchestration task not found: ${id}`);
    return task;
  }

  /** Latest reported state of each provider-native subagent in a run, without loading its other steps. */
  listRunSubagentStates(runId: string): Array<Record<string, unknown>> {
    const rows = this.all<{ subagentJson: string | null }>(
      `select json_extract(metadata_json, '$.subagent') as subagentJson from run_steps
       where run_id = ? and json_valid(metadata_json) and json_extract(metadata_json, '$.toolName') = 'subagent'
       order by created_at asc, rowid asc`,
      [runId],
    );
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const subagent = row.subagentJson ? this.parseJsonObject(row.subagentJson) : null;
      if (subagent && typeof subagent.id === "string") latest.set(subagent.id, subagent);
    }
    return [...latest.values()];
  }

  findOrchestrationTask(id: string): OrchestrationTaskRecord | null {
    return this.first<OrchestrationTaskRecord>(`${ORCHESTRATION_TASK_SELECT} where id = ?`, [id]);
  }

  getOrchestrationTaskByChildRunId(runId: string): OrchestrationTaskRecord | null {
    return this.first<OrchestrationTaskRecord>(
      `${ORCHESTRATION_TASK_SELECT} where child_run_id = ?`,
      [runId],
    );
  }

  getOrchestrationTaskByClientTaskId(orchestrationId: string, clientTaskId: string): OrchestrationTaskRecord | null {
    return this.first<OrchestrationTaskRecord>(
      `${ORCHESTRATION_TASK_SELECT} where orchestration_id = ? and client_task_id = ?`,
      [orchestrationId, clientTaskId],
    );
  }

  listOrchestrationTasks(orchestrationId: string): OrchestrationTaskRecord[] {
    return this.all<OrchestrationTaskRecord>(
      `${ORCHESTRATION_TASK_SELECT} where orchestration_id = ? order by created_at asc`,
      [orchestrationId],
    );
  }

  /**
   * Tokens this orchestration has used, counting every child, including running ones, and the
   * coordinator from the moment the orchestration began. A run's totals cover its whole life,
   * so a long conversation before the first delegation must not use up the budget.
   */
  getOrchestrationTotalTokens(orchestrationId: string): number {
    const row = this.first<{ total: number }>(
      `select max(0, coalesce(sum(input_tokens + output_tokens), 0) -
         (select coordinator_token_baseline from orchestrations where id = ?)) as total from runs
       where id = (select coordinator_run_id from orchestrations where id = ?)
          or id in (select child_run_id from orchestration_tasks where orchestration_id = ? and child_run_id is not null)`,
      [orchestrationId, orchestrationId, orchestrationId],
    );
    return Number(row?.total ?? 0);
  }

  updateOrchestrationTask(
    id: string,
    fields: Partial<Pick<
      OrchestrationTaskRecord,
      | "status"
      | "childRunId"
      | "summary"
      | "errorMessage"
      | "attentionReason"
      | "adoptionStatus"
      | "deferredUntil"
      | "inputTokens"
      | "outputTokens"
      | "startedAt"
      | "finishedAt"
    >>,
  ): OrchestrationTaskRecord {
    const existing = this.getOrchestrationTask(id);
    this.run(
      `update orchestration_tasks set status = ?, child_run_id = ?, summary = ?, error_message = ?,
       attention_reason = ?, adoption_status = ?, deferred_until = ?, input_tokens = ?, output_tokens = ?, updated_at = ?,
       started_at = ?, finished_at = ? where id = ?`,
      [
        fields.status ?? existing.status,
        fields.childRunId !== undefined ? fields.childRunId : existing.childRunId,
        fields.summary !== undefined ? fields.summary : existing.summary,
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        fields.attentionReason !== undefined ? fields.attentionReason : existing.attentionReason,
        fields.adoptionStatus ?? existing.adoptionStatus,
        fields.deferredUntil !== undefined ? fields.deferredUntil : existing.deferredUntil,
        fields.inputTokens ?? existing.inputTokens,
        fields.outputTokens ?? existing.outputTokens,
        nowIso(),
        fields.startedAt !== undefined ? fields.startedAt : existing.startedAt,
        fields.finishedAt !== undefined ? fields.finishedAt : existing.finishedAt,
        id,
      ],
    );
    return this.getOrchestrationTask(id);
  }

  appendOrchestrationEvent(input: {
    orchestrationId: string;
    taskId?: string | null;
    type: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): OrchestrationEventRecord {
    const orchestration = this.getOrchestration(input.orchestrationId);
    const sequence = orchestration.lastEventSequence + 1;
    const id = createId();
    const createdAt = nowIso();
    this.transaction(() => {
      this.run(
        `insert into orchestration_events (
          id, orchestration_id, task_id, sequence, type, title, content, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.orchestrationId,
          input.taskId ?? null,
          sequence,
          input.type,
          input.title,
          input.content,
          JSON.stringify(input.metadata ?? {}),
          createdAt,
        ],
      );
      this.run(
        "update orchestrations set last_event_sequence = ?, updated_at = ? where id = ?",
        [sequence, createdAt, input.orchestrationId],
      );
    });
    return {
      id,
      orchestrationId: input.orchestrationId,
      taskId: input.taskId ?? null,
      sequence,
      type: input.type,
      title: input.title,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt,
    };
  }

  listOrchestrationEvents(orchestrationId: string, limit?: number): OrchestrationEventRecord[] {
    const boundedLimit = Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : null;
    return this.all<{
      id: string;
      orchestrationId: string;
      taskId: string | null;
      sequence: number;
      type: string;
      title: string;
      content: string;
      metadataJson: string;
      createdAt: string;
    }>(
      boundedLimit
        ? `select id, orchestrationId, taskId, sequence, type, title, content, metadataJson, createdAt
           from (
             select id, orchestration_id as orchestrationId, task_id as taskId, sequence, type, title, content,
              metadata_json as metadataJson, created_at as createdAt
             from orchestration_events where orchestration_id = ? order by sequence desc limit ?
           ) order by sequence asc`
        : `select id, orchestration_id as orchestrationId, task_id as taskId, sequence, type, title, content,
           metadata_json as metadataJson, created_at as createdAt
           from orchestration_events where orchestration_id = ? order by sequence asc`,
      boundedLimit ? [orchestrationId, boundedLimit] : [orchestrationId],
    ).map((row) => ({
      ...row,
      metadata: this.parseJsonObject(row.metadataJson) ?? {},
    }));
  }

  createOrchestrationTaskMessage(input: {
    orchestrationId: string;
    taskId: string;
    source: OrchestrationTaskMessageRecord["source"];
    content: string;
  }): OrchestrationTaskMessageRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `insert into orchestration_task_messages (
        id, orchestration_id, task_id, source, content, status, created_at, delivered_at
      ) values (?, ?, ?, ?, ?, 'queued', ?, null)`,
      [id, input.orchestrationId, input.taskId, input.source, input.content, createdAt],
    );
    return {
      id,
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      source: input.source,
      content: input.content,
      status: "queued",
      createdAt,
      deliveredAt: null,
    };
  }

  listOrchestrationTaskMessages(orchestrationId: string, limit?: number): OrchestrationTaskMessageRecord[] {
    const boundedLimit = Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : null;
    return this.all<OrchestrationTaskMessageRecord>(
      boundedLimit
        ? `select id, orchestrationId, taskId, source, content, status, createdAt, deliveredAt
           from (
             select rowid as insertionOrder, id, orchestration_id as orchestrationId, task_id as taskId,
              source, content, status, created_at as createdAt, delivered_at as deliveredAt
             from orchestration_task_messages where orchestration_id = ? order by rowid desc limit ?
           ) order by insertionOrder asc`
        : `select id, orchestration_id as orchestrationId, task_id as taskId, source, content, status,
           created_at as createdAt, delivered_at as deliveredAt
           from orchestration_task_messages where orchestration_id = ? order by created_at asc, rowid asc`,
      boundedLimit ? [orchestrationId, boundedLimit] : [orchestrationId],
    );
  }

  updateOrchestrationTaskMessage(
    id: string,
    status: OrchestrationTaskMessageRecord["status"],
  ): void {
    this.run(
      "update orchestration_task_messages set status = ?, delivered_at = ? where id = ?",
      [status, status === "delivered" ? nowIso() : null, id],
    );
  }

  getOrchestrationAdoption(taskId: string): {
    id: string;
    orchestrationId: string;
    taskId: string;
    status: string;
    manifest: Record<string, unknown>;
    backupPath: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.first<{
      id: string;
      orchestrationId: string;
      taskId: string;
      status: string;
      manifestJson: string;
      backupPath: string | null;
      errorMessage: string | null;
      createdAt: string;
      updatedAt: string;
    }>(
      `select id, orchestration_id as orchestrationId, task_id as taskId, status,
       manifest_json as manifestJson, backup_path as backupPath, error_message as errorMessage,
       created_at as createdAt, updated_at as updatedAt
       from orchestration_adoptions where task_id = ? order by created_at desc limit 1`,
      [taskId],
    );
    return row ? { ...row, manifest: this.parseJsonObject(row.manifestJson) ?? {} } : null;
  }

  upsertOrchestrationAdoption(input: {
    orchestrationId: string;
    taskId: string;
    status: string;
    manifest?: Record<string, unknown>;
    backupPath?: string | null;
    errorMessage?: string | null;
  }): void {
    const existing = this.getOrchestrationAdoption(input.taskId);
    const timestamp = nowIso();
    if (existing) {
      this.run(
        `update orchestration_adoptions set status = ?, manifest_json = ?, backup_path = ?,
         error_message = ?, updated_at = ? where id = ?`,
        [
          input.status,
          JSON.stringify(input.manifest ?? existing.manifest),
          input.backupPath !== undefined ? input.backupPath : existing.backupPath,
          input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage,
          timestamp,
          existing.id,
        ],
      );
    } else {
      this.run(
        `insert into orchestration_adoptions (
          id, orchestration_id, task_id, status, manifest_json, backup_path, error_message, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId(),
          input.orchestrationId,
          input.taskId,
          input.status,
          JSON.stringify(input.manifest ?? {}),
          input.backupPath ?? null,
          input.errorMessage ?? null,
          timestamp,
          timestamp,
        ],
      );
    }
  }

  getOrchestrationDetailByCoordinatorRunId(coordinatorRunId: string): OrchestrationDetail | null {
    const orchestration = this.getOrchestrationByCoordinatorRunId(coordinatorRunId);
    if (!orchestration) return null;
    const tasks = this.listOrchestrationTasks(orchestration.id);
    const activeStatuses = new Set<OrchestrationTaskStatus>(["provisioning", "queued", "running", "waiting-input"]);
    return {
      orchestration,
      waves: this.listOrchestrationWaves(orchestration.id),
      tasks,
      events: this.listOrchestrationEvents(orchestration.id, ORCHESTRATION_DETAIL_HISTORY_LIMIT),
      messages: this.listOrchestrationTaskMessages(orchestration.id, ORCHESTRATION_DETAIL_HISTORY_LIMIT),
      activeTaskCount: tasks.filter((task) => activeStatuses.has(task.status)).length,
      queuedTaskCount: tasks.filter((task) => task.status === "pending" || task.status === "queued").length,
      attentionTaskCount: tasks.filter((task) =>
        task.status === "waiting-input" || task.status === "interrupted" || task.status === "blocked").length,
      totalInputTokens: tasks.reduce((sum, task) => sum + task.inputTokens, 0),
      totalOutputTokens: tasks.reduce((sum, task) => sum + task.outputTokens, 0),
      budgetTokensUsed: this.getOrchestrationTotalTokens(orchestration.id),
    };
  }

  getOrchestrationOperation(orchestrationId: string, requestId: string): {
    id: string;
    toolName: string;
    requestHash: string;
    status: string;
    responseJson: string | null;
    errorMessage: string | null;
    errorCode: string | null;
  } | null {
    return this.first(
      `select id, tool_name as toolName, request_hash as requestHash, status, response_json as responseJson,
       error_message as errorMessage, error_code as errorCode from orchestration_operations where orchestration_id = ? and request_id = ?`,
      [orchestrationId, requestId],
    );
  }

  createOrchestrationOperation(input: {
    orchestrationId: string;
    requestId: string;
    toolName: string;
    requestHash: string;
  }): void {
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_operations (
        id, orchestration_id, request_id, tool_name, request_hash, status, response_json, error_message, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'running', null, null, ?, ?)`,
      [createId(), input.orchestrationId, input.requestId, input.toolName, input.requestHash, timestamp, timestamp],
    );
  }

  completeOrchestrationOperation(
    orchestrationId: string,
    requestId: string,
    status: "completed" | "failed",
    response: unknown,
    errorMessage?: string | null,
    errorCode?: string | null,
  ): void {
    this.run(
      `update orchestration_operations set status = ?, response_json = ?, error_message = ?, error_code = ?, updated_at = ?
       where orchestration_id = ? and request_id = ?`,
      [status, JSON.stringify(response ?? null), errorMessage ?? null, errorCode ?? null, nowIso(), orchestrationId, requestId],
    );
  }

  recoverInterruptedOrchestrationOperations(): void {
    // An effect may have happened before the completion receipt was flushed. Keep its key.
    this.run("update orchestration_operations set status = 'failed', error_message = ?, error_code = 'operation_interrupted', updated_at = ? where status = 'running'",
      ["Interrupted operation: inspect the durable task/message state before issuing a new request.", nowIso()]);
  }

  recoverOrchestrationMessageDeliveries(): void {
    const pending = this.all<{ id: string; orchestrationId: string; taskId: string }>(
      "select id, orchestration_id as orchestrationId, task_id as taskId from orchestration_task_messages where status = 'delivering'",
    );
    for (const message of pending) {
      this.updateOrchestrationTaskMessage(message.id, "unconfirmed");
      this.appendOrchestrationEvent({ orchestrationId: message.orchestrationId, taskId: message.taskId,
        type: "attention", title: "Message delivery needs review",
        content: "The app stopped while delivering a message. Inspect the child's history before sending it again.",
        metadata: { messageId: message.id, outcomeUnknown: true } });
    }
  }

  createOrchestrationCleanupJob(input: {
    coordinatorRunId: string;
    orchestrationId?: string | null;
    manifest: Record<string, unknown>;
  }): string {
    const existing = this.first<{ id: string }>(
      "select id from orchestration_cleanup_jobs where coordinator_run_id = ? and status != 'completed'",
      [input.coordinatorRunId],
    );
    if (existing) return existing.id;
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_cleanup_jobs (
        id, coordinator_run_id, orchestration_id, manifest_json, status, error_message, created_at, updated_at
      ) values (?, ?, ?, ?, 'pending', null, ?, ?)`,
      [id, input.coordinatorRunId, input.orchestrationId ?? null, JSON.stringify(input.manifest), timestamp, timestamp],
    );
    return id;
  }

  listPendingOrchestrationCleanupJobs(): Array<{
    id: string;
    coordinatorRunId: string;
    orchestrationId: string | null;
    manifest: Record<string, unknown>;
    status: string;
    errorMessage: string | null;
  }> {
    return this.all<{
      id: string;
      coordinatorRunId: string;
      orchestrationId: string | null;
      manifestJson: string;
      status: string;
      errorMessage: string | null;
    }>(
      "select id, coordinator_run_id as coordinatorRunId, orchestration_id as orchestrationId, manifest_json as manifestJson, status, error_message as errorMessage from orchestration_cleanup_jobs where status != 'completed'",
    ).map((row) => ({ ...row, manifest: this.parseJsonObject(row.manifestJson) ?? {} }));
  }

  updateOrchestrationCleanupJob(id: string, status: string, errorMessage?: string | null): void {
    this.run(
      "update orchestration_cleanup_jobs set status = ?, error_message = ?, updated_at = ? where id = ?",
      [status, errorMessage ?? null, nowIso(), id],
    );
  }

  completeOrchestrationCleanupJob(id: string): void {
    this.run("delete from orchestration_cleanup_jobs where id = ?", [id]);
  }

  deleteOrchestrationData(orchestrationId: string): void {
    this.transaction(() => {
      this.run("delete from orchestration_adoptions where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_operations where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_effects where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_task_messages where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_events where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_tasks where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestration_waves where orchestration_id = ?", [orchestrationId]);
      this.run("delete from orchestrations where id = ?", [orchestrationId]);
    });
  }

  deleteBookmarksForRunIds(runIds: string[]): void {
    for (const batch of chunkValues([...new Set(runIds)])) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      this.run(
        `delete from bookmark_steps where bookmark_id in (
          select id from bookmarks where original_run_id in (${placeholders})
        )`,
        batch,
      );
      this.run(`delete from bookmarks where original_run_id in (${placeholders})`, batch);
    }
  }

  deleteChatBookmarksForRunIds(runIds: string[]): void {
    for (const batch of chunkValues([...new Set(runIds)])) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      this.run(
        `delete from chat_bookmark_steps where chat_bookmark_id in (
          select id from chat_bookmarks where original_chat_id in (
            select id from chats where run_id in (${placeholders})
          )
        )`,
        batch,
      );
      this.run(
        `delete from chat_bookmarks where original_chat_id in (
          select id from chats where run_id in (${placeholders})
        )`,
        batch,
      );
    }
  }

  getRunDetail(runId: string, diff: string): RunDetail {
    return {
      run: this.getRun(runId),
      steps: this.getRunSteps(runId),
      notes: this.listRunNotes(runId),
      diff,
      diffLoadError: null,
      orchestration: this.getOrchestrationDetailByCoordinatorRunId(runId),
    };
  }

  private createInitialSchema(): void {
    this.exec(CORE_SCHEMA_SQL + SERVICES_SCHEMA_SQL + SKILLS_SCHEMA_SQL);
  }

  private applySchemaMigrations(): void {
    // Invalidation is atomic with the history mutation, even if the process exits
    // before the derived row can be refreshed. Do not rely on foreign_keys being enabled.
    this.exec(`
      create table if not exists run_list_summaries (
        run_id text primary key,
        last_user_input_at text not null,
        pending_user_input_request integer not null
      );
      drop trigger if exists run_list_summary_insert;
      create trigger if not exists run_list_summary_insert_v2 after insert on run_steps
      when new.event_type in ('log', 'user-input-requested')
        and case when json_valid(new.metadata_json) then
          json_extract(new.metadata_json, '$.source') = 'user' or json_extract(new.metadata_json, '$.requestKind') = 'user-input'
        else 0 end begin
        delete from run_list_summaries where run_id = new.run_id;
      end;
      drop trigger if exists run_list_summary_update;
      create trigger if not exists run_list_summary_update_v2 after update on run_steps
      when (old.event_type in ('log', 'user-input-requested') and case when json_valid(old.metadata_json) then json_extract(old.metadata_json, '$.source') = 'user' or json_extract(old.metadata_json, '$.requestKind') = 'user-input' else 0 end) or (new.event_type in ('log', 'user-input-requested') and case when json_valid(new.metadata_json) then json_extract(new.metadata_json, '$.source') = 'user' or json_extract(new.metadata_json, '$.requestKind') = 'user-input' else 0 end) begin
        delete from run_list_summaries where run_id in (old.run_id, new.run_id);
      end;
      drop trigger if exists run_list_summary_delete;
      create trigger if not exists run_list_summary_delete_v2 after delete on run_steps
      when (old.event_type in ('log', 'user-input-requested') and case when json_valid(old.metadata_json) then json_extract(old.metadata_json, '$.source') = 'user' or json_extract(old.metadata_json, '$.requestKind') = 'user-input' else 0 end) begin
        delete from run_list_summaries where run_id = old.run_id;
      end;
      create trigger if not exists run_list_summary_run_delete after delete on runs begin
        delete from run_list_summaries where run_id = old.id;
      end;
    `);
    // Additive migration: existing runs need no rows and remain Uncategorized.
    this.exec(`
      create table if not exists run_sections (
        id text primary key, name text not null, position integer not null
      );
      create table if not exists run_organization (
        run_id text primary key references runs(id) on delete cascade,
        section_id text references run_sections(id) on delete set null,
        tags_json text not null default '[]'
      );
      create index if not exists idx_run_organization_section on run_organization(section_id);
    `);
    this.ensureColumn("run_sections", "color", `text not null default '${DEFAULT_RUN_SECTION_COLOR}'`);
    this.ensureColumn("queued_follow_ups", "delivery_state", "text");
    this.ensureColumn("projects", "project_kind", "text not null default 'git'");
    this.ensureColumn("runs", "workspace_vcs", "text not null default 'git'");
    this.ensureColumn("run_forge_links", "error_count", "integer not null default 0");
    this.ensureColumn("run_forge_links", "sync_error", "text");
    this.ensureColumn("run_forge_links", "retry_after_at", "text");
    this.ensureColumn("project_loops", "pr_review_policy", "text not null default 'none'");
    this.ensureColumn("project_loop_iterations", "ai_review_posted", "integer not null default 0");
    this.ensureColumn("chats", "run_id", "text");
    for (const table of ["runs", "chats", "bookmarks", "chat_bookmarks"]) this.ensureColumn(table, "title", "text");
    for (const table of ["runs", "chats"]) this.ensureColumn(table, "title_request_id", "text");
    this.ensureColumn("run_restore_points", "head_sha", "text");
    this.ensureColumn("run_turn_restore_points", "patch", "text");
    this.ensureColumn("orchestration_tasks", "deferred_until", "text");
    this.ensureColumn("orchestration_tasks", "permission_mode", "text not null default 'inherit'");
    this.ensureColumn("orchestrations", "coordinator_token_baseline", "integer not null default 0");
    this.ensureColumn("orchestration_tasks", "execution_options_json", "text");
    this.ensureColumn("orchestration_operations", "error_code", "text");
    // Outbox of side effects whose state change must survive a crash between phases.
    this.exec(`
      create table if not exists orchestration_effects (
        id text primary key,
        orchestration_id text not null,
        task_id text,
        kind text not null,
        status text not null,
        payload_json text not null default '{}',
        attempts integer not null default 0,
        error_message text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_orchestration_effects_pending on orchestration_effects(status, orchestration_id);
    `);
    this.ensureHistorySearchIndex();
    this.run(
      `insert or ignore into app_token_usage (scope, input_tokens, output_tokens)
       select 'standalone-chats', coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
       from chats where run_id is null`,
    );
    if (!this.first<{ scope: string }>("select scope from app_token_usage where scope = 'run-chat-project-backfill-v1'")) {
      this.run(
        `update projects
         set cumulative_input_tokens = cumulative_input_tokens + coalesce((
               select sum(chat.input_tokens)
               from chats chat join runs run on run.id = chat.run_id
               where run.project_id = projects.id
             ), 0),
             cumulative_output_tokens = cumulative_output_tokens + coalesce((
               select sum(chat.output_tokens)
               from chats chat join runs run on run.id = chat.run_id
               where run.project_id = projects.id
             ), 0)`,
      );
      this.run(
        `insert into app_token_usage (scope, input_tokens, output_tokens)
         values ('run-chat-project-backfill-v1', 0, 0)`,
      );
    }
    this.ensureColumn("runs", "project_task_id", "text");
    this.ensureColumn("runs", "automation_id", "text");
    this.ensureColumn("project_automations", "execution_options_json", "text not null default '{}'");
    this.ensureColumn("project_automations", "base_branch", "text");
    this.run(
      `update project_automations
       set base_branch = (select project.default_branch from projects project where project.id = project_automations.project_id)
       where base_branch is null
         and exists (
           select 1 from projects project
           where project.id = project_automations.project_id and project.project_kind = 'git'
         )`,
    );
    this.run(
      `update project_automations
       set workspace_type = case
         when exists (
           select 1 from projects project
           where project.id = project_automations.project_id and project.project_kind = 'folder'
         ) then 'copy'
         else 'worktree'
       end
       where workspace_type = 'local'`,
    );
    this.ensureColumn("runs", "delegation_enabled", "integer not null default 0");
    // Inbox metadata stays fixed for the entire attention episode, including event-only updates.
    this.ensureColumn("orchestrations", "attention_started_at", "text");
    // Older databases only have updated_at; preserve their current notice identity on upgrade.
    this.run("update orchestrations set attention_started_at = updated_at where status = 'attention' and attention_started_at is null");
    this.ensureColumn("project_tasks", "status", "text not null default 'open'");
    this.ensureColumn("project_tasks", "run_id", "text");
    this.ensureColumn("project_tasks", "pull_request_url", "text");
    this.ensureColumn("project_tasks", "attachments_json", "text not null default '[]'");
    this.ensureColumn("remote_pairing_grants", "client_origin", "text");
    this.ensureColumn("remote_access_sessions", "client_origin", "text");
    this.ensureColumn("token_usage_events", "provider_type", "text");
    this.ensureColumn("token_usage_events", "model_id", "text");
    this.ensureColumn("token_usage_events", "cache_read_tokens", "integer not null default 0");
    this.ensureColumn("token_usage_events", "cache_write_tokens", "integer not null default 0");
    this.ensureColumn("token_usage_events", "reasoning_tokens", "integer not null default 0");
    this.ensureColumn("provider_session_runtime", "provider_account_id", "text");
    this.migrateRunPromptRestorePointsFromSettings();
    this.migrateProviderSessionAccounts();
  }

  /**
   * Seed per-account sessions only from explicitly attributed rows. Legacy rows cannot prove
   * account ownership, even when the current account has the same provider type.
   */
  private migrateProviderSessionAccounts(): void {
    this.exec(`
      insert or ignore into provider_account_sessions (
        owner_id, owner_kind, provider_account_id, provider_type, harness_type, status, cwd, model_id,
        runtime_mode, resume_cursor_json, runtime_payload_json, last_seen_at, created_at, updated_at
      )
      select
        owner_id, owner_kind, provider_account_id, provider_type, harness_type, status, cwd, model_id,
        runtime_mode, resume_cursor_json, runtime_payload_json, last_seen_at, created_at, updated_at
      from provider_session_runtime
      where provider_account_id is not null;
    `);
  }

  /**
   * Restore points used to live in app_settings, which made every settings read
   * (including each app snapshot) carry full git patches.
   */
  private migrateRunPromptRestorePointsFromSettings(): void {
    const legacyRows = this.all<{ key: string; value: string }>(
      "select key, value from app_settings where key like ?",
      [`${LEGACY_RUN_PROMPT_RESTORE_POINT_SETTING_PREFIX}%`],
    );
    for (const row of legacyRows) {
      const runId = row.key.slice(LEGACY_RUN_PROMPT_RESTORE_POINT_SETTING_PREFIX.length);
      const restorePoint = this.parseRunPromptRestorePoint(row.value);
      if (runId && restorePoint && this.first<{ id: string }>("select id from runs where id = ?", [runId])) {
        this.setRunPromptRestorePoint(runId, restorePoint);
      }
      this.run("delete from app_settings where key = ?", [row.key]);
    }
  }

  private parseRunPromptRestorePoint(value: string): RunPromptRestorePoint | null {
    const parsed = this.parseJsonObject(value);
    if (!parsed || typeof parsed.patch !== "string" || typeof parsed.createdAt !== "string") return null;
    if (parsed.commandType !== "initial" && parsed.commandType !== "follow-up") return null;
    return {
      createdAt: parsed.createdAt,
      commandType: parsed.commandType,
      patch: parsed.patch,
    };
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.all<{ name: string }>(`pragma table_info(${tableName})`);
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    this.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    const statement = this.database.prepare(sql);
    return statement.all(...(params as SQLInputValue[])) as T[];
  }

  private first<T>(sql: string, params: unknown[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  private run(sql: string, params: unknown[] = []) {
    const statement = this.database.prepare(sql);
    return statement.run(...(params as SQLInputValue[]));
  }

  private exec(sql: string): void {
    this.database.exec(sql);
  }

  private parseJsonObject(value: string | null): Record<string, unknown> | null {
    if (!value) {
      return null;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private parseJsonValue<T>(value: string | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private parseChatAttachmentPayloads(value: string | null): ChatAttachmentPayload[] {
    const parsed = this.parseJsonValue<unknown>(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ChatAttachmentPayload => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
          const candidate = entry as Partial<ChatAttachmentPayload>;
          return typeof candidate.fileName === "string" && typeof candidate.mimeType === "string" &&
            typeof candidate.dataBase64 === "string";
        })
      : [];
  }

  private hydrateProjectTask(task: StoredProjectTaskRecord): ProjectTaskRecord {
    const { attachmentsJson, ...record } = task;
    const attachments = this.parseChatAttachmentPayloads(attachmentsJson);
    return { ...record, attachments };
  }

  private hydrateProjectAutomation(automation: StoredProjectAutomationRecord): ProjectAutomationRecord {
    const { attachmentsJson, executionOptionsJson, ...record } = automation;
    const attachments = this.parseChatAttachmentPayloads(attachmentsJson);
    const parsedExecutionOptions = this.parseJsonValue<unknown>(executionOptionsJson);
    const executionOptions = parsedExecutionOptions && typeof parsedExecutionOptions === "object" && !Array.isArray(parsedExecutionOptions)
      ? parsedExecutionOptions as ProviderExecutionOptions
      : {};
    return { ...record, attachments, executionOptions };
  }

  private parseRemoteAccessScopes(value: string): RemoteAccessScope[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      const supported = new Set<RemoteAccessScope>(REMOTE_ACCESS_SCOPES);
      return Array.isArray(parsed)
        ? parsed.filter((scope): scope is RemoteAccessScope => typeof scope === "string" && supported.has(scope as RemoteAccessScope))
        : [];
    } catch {
      return [];
    }
  }

  private createPreWalBackup(): void {
    const backupPath = `${this.filePath}.pre-wal-backup`;
    if (existsSync(backupPath)) return;
    const temporaryPath = `${backupPath}.tmp`;
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    copyFileSync(this.filePath, temporaryPath);
    renameSync(temporaryPath, backupPath);
  }

  private checkpoint(mode: "full" | "truncate"): void {
    this.database.exec(`pragma wal_checkpoint(${mode})`);
  }

  private get database(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database has not been initialized");
    }

    return this.db;
  }
}

export const getDefaultDatabasePath = (baseDirectory: string, fileName = DEFAULT_DB_NAME): string => {
  mkdirSync(baseDirectory, { recursive: true });
  return join(baseDirectory, fileName);
};
