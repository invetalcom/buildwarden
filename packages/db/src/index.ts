import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { REMOTE_ACCESS_SCOPES } from "@buildwarden/shared";
import type {
  AppSettingRecord,
  AppSnapshot,
  BookmarkRecord,
  BookmarkStepRecord,
  BookmarkSummary,
  ChatBookmarkRecord,
  ChatBookmarkSummary,
  ChatDetail,
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
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
  OrchestrationTeamSettings,
  OrchestrationWaveRecord,
  ProjectInput,
  ProjectInsightKind,
  ProjectInsightRecord,
  ProjectLabEventRecord,
  ProjectLabThreadDetail,
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
  ProjectRecord,
  ProjectSnapshot,
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
  RunListVisibility,
  RunInput,
  RunNoteRecord,
  RunNoteStatus,
  UpdateProjectTaskInput,
  UpdateRunNoteInput,
  RunRecord,
  RunForgeRequestDetailsResult,
  RunForgeRequestSummary,
  RunStatus,
  RunStepRecord,
  WorktreeRecord,
} from "@buildwarden/shared";

const ORCHESTRATION_DETAIL_HISTORY_LIMIT = 200;
const ORCHESTRATION_SELECT = `select id, project_id as projectId, coordinator_run_id as coordinatorRunId, status,
  team_snapshot_json as teamSnapshotJson, wake_mode as wakeMode, wake_task_ids_json as wakeTaskIdsJson,
  last_event_sequence as lastEventSequence, last_delivered_sequence as lastDeliveredSequence,
  error_message as errorMessage, created_at as createdAt, updated_at as updatedAt, finished_at as finishedAt
  from orchestrations`;
const ORCHESTRATION_TASK_SELECT = `select id, orchestration_id as orchestrationId, wave_id as waveId,
  client_task_id as clientTaskId, title, prompt, role_id as roleId, model_id as modelId, intent, status,
  child_run_id as childRunId, retry_of_task_id as retryOfTaskId, summary, error_message as errorMessage,
  attention_reason as attentionReason, adoption_status as adoptionStatus,
  input_tokens as inputTokens, output_tokens as outputTokens,
  created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
  from orchestration_tasks`;

type StoredOrchestrationRecord = Omit<OrchestrationRecord, "teamSnapshot" | "wakeTaskIds"> & {
  teamSnapshotJson: string;
  wakeTaskIdsJson: string;
};

const DEFAULT_DB_NAME = "buildwarden.sqlite";
const SQLITE_VARIABLE_BATCH_SIZE = 900;

const nowIso = () => new Date().toISOString();
const createId = () => crypto.randomUUID();

export interface RunForgeRequestCacheRecord {
  runId: string;
  projectId: string;
  branchName: string;
  headSha: string | null;
  lastProbeAt: string | null;
  negativeCacheUntil: string | null;
  summary: RunForgeRequestSummary | null;
  details: RunForgeRequestDetailsResult | null;
  etag: string | null;
  lastModified: string | null;
  errorCount: number;
  retryAfterAt: string | null;
}

export interface ModelDeletionTargets {
  runIds: string[];
  chatIds: string[];
  projectInsightIds: string[];
  projectLabThreadIds: string[];
  projectLoopIds: string[];
  orchestrationIds: string[];
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

type DerivedRunState = {
  parts: Set<string>;
  lastUserInputAt: string;
  pendingUserInputRequest: boolean;
};

const createDerivedRunState = (run: RunRecord): DerivedRunState => {
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
};

export class BuildWardenDatabase {
  private db: DatabaseSync | null = null;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    const databaseExisted = existsSync(this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    try {
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
      }
    }
  }

  transaction<T>(operation: () => T): T {
    this.exec("begin immediate");
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
      throw error;
    }
  }

  async flushDurable(): Promise<void> {
    if (this.db) this.checkpoint("full");
  }

  /** Checkpoints and truncates the WAL synchronously during process shutdown. */
  flushToDiskSync(): void {
    if (this.db) this.checkpoint("truncate");
  }

  /** Clears the database file and reinitializes with a fresh schema. Complete reset. */
  async resetAndReinit(): Promise<void> {
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
      this.listOrchestrationsWithStatuses([
        "active",
        "waiting",
        "paused",
        "attention",
        "deleting",
        "deletion-failed",
        "completed",
        "cancelled",
        "failed",
      ]).map((orchestration) => [orchestration.coordinatorRunId, orchestration.status] as const),
    );
    const activeOrchestrationStatuses = new Set<OrchestrationStatus>(["active", "waiting", "paused", "attention"]);
    const projects = this.listProjects().map((project) => {
      const allRuns = this.listRunsForProject(project.id).map((run) => {
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
        tasks: this.listProjectTasks(project.id),
        insights: this.listProjectInsights(project.id),
        labThreads: this.listProjectLabThreadDetails(project.id),
        loops: this.listProjectLoopListItems(project.id),
      } satisfies ProjectSnapshot;
    });

    return {
      projects,
      providerAccounts: this.listProviderAccounts(),
      models: this.listModels(),
      selectedProjectId,
      selectedRunId,
      selectedChatId,
      settings: this.getSettings(),
      bookmarks: this.listBookmarks(),
      chatBookmarks: this.listChatBookmarks(),
      chats: this.listChats(),
    };
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
      select id, prompt, status, created_at as createdAt, run_id as runId
      from chats
      where run_id is null
      order by updated_at desc
      `,
    );
  }

  listAllChats(): ChatRecord[] {
    return this.all<{ id: string }>("select id from chats order by updated_at desc")
      .map((row) => this.getChat(row.id));
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

  listChatsWithSteps(): ChatDetail[] {
    const summaries = this.listChats();
    return summaries.map((s) => this.getChatDetail(s.id));
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
      insert into project_tasks (id, project_id, title, prompt, status, run_id, pull_request_url, created_at, updated_at)
      values (?, ?, ?, ?, 'open', null, null, ?, ?)
      `,
      [id, projectId, input.title, input.prompt, createdAt, createdAt],
    );
    return this.getProjectTask(id);
  }

  updateProjectTask(taskId: string, input: UpdateProjectTaskInput): ProjectTaskRecord {
    const existing = this.getProjectTask(taskId);
    const nextTitle = input.title === undefined ? existing.title : input.title.trim();
    const nextPrompt = input.prompt === undefined ? existing.prompt : input.prompt.trim();
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
      set title = ?, prompt = ?, status = ?, updated_at = ?
      where id = ?
      `,
      [nextTitle, nextPrompt, nextStatus, updatedAt, taskId],
    );
    return this.getProjectTask(taskId);
  }

  getProjectTask(taskId: string): ProjectTaskRecord {
    const task = this.first<ProjectTaskRecord>(
      `
      select
        id,
        project_id as projectId,
        title,
        prompt,
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
    return task;
  }

  listProjectTasks(projectId: string): ProjectTaskRecord[] {
    return this.all<ProjectTaskRecord>(
      `
      select
        id,
        project_id as projectId,
        title,
        prompt,
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
    );
  }

  deleteProjectTask(taskId: string): void {
    this.run("update runs set project_task_id = null where project_task_id = ?", [taskId]);
    this.run("delete from project_tasks where id = ?", [taskId]);
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
      where project_id = ?
      order by updated_at desc, generated_at desc
      `,
      [projectId],
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
    const loops = this.listProjectLoops(projectId);
    if (loops.length === 0) {
      return [];
    }
    return loops.map((loop) => {
      const iterations = this.listProjectLoopIterations(loop.id);
      const runs = this.listRunsByIds(iterations.flatMap((iteration) => (iteration.runId ? [iteration.runId] : [])));
      const pendingUiReviewCount = this.all<{ id: string }>(
        "select id from project_loop_ui_reviews where loop_id = ? and status = 'pending'",
        [loop.id],
      ).length;
      return { loop, iterations, runs, pendingUiReviewCount };
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

  getChat(id: string): ChatRecord {
    const chat = this.first<ChatRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
        run_id as runId,
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
      order by created_at asc
      `,
      [chatId],
    );
  }

  getChatDetail(chatId: string): ChatDetail {
    const chat = this.getChat(chatId);
    const steps = this.getChatSteps(chatId);
    return { chat, steps };
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
    this.run("update chats set model_id = ?, updated_at = ? where id = ?", [modelId, nowIso(), chatId]);
  }

  appendChatEvent(
    chatId: string,
    eventType: ChatStepRecord["eventType"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): { id: string } {
    const id = createId();
    const metadataJson = JSON.stringify(metadata ?? {});
    this.run(
      `
      insert into chat_steps (id, chat_id, event_type, title, content, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, chatId, eventType, title, content, metadataJson, nowIso()],
    );
    return { id };
  }

  updateChatStep(stepId: string, updates: { title?: string; content?: string; metadataJson?: string }): void {
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
    if (parts.length === 0) return;
    values.push(stepId);
    this.run(`update chat_steps set ${parts.join(", ")} where id = ?`, values);
  }

  deleteChat(chatId: string): void {
    this.run("delete from chat_steps where chat_id = ?", [chatId]);
    this.run("delete from chats where id = ?", [chatId]);
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

  deleteProject(projectId: string): void {
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
    this.run("delete from worktrees where project_id = ?", [projectId]);
    this.run(
      `
      delete from chat_steps
      where chat_id in (select id from chats where run_id in (select id from runs where project_id = ?))
      `,
      [projectId],
    );
    this.run("delete from chats where run_id in (select id from runs where project_id = ?)", [projectId]);
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
      [modelId, modelId, modelId, modelId, modelId, modelId, modelId, modelId],
    );
    const idsFor = (kind: string): string[] => rows.filter((row) => row.kind === kind).map((row) => row.id);
    return {
      runIds: idsFor("run"),
      chatIds: idsFor("chat"),
      projectInsightIds: idsFor("project-insight"),
      projectLabThreadIds: idsFor("project-lab-thread"),
      projectLoopIds: idsFor("project-loop"),
      orchestrationIds: idsFor("orchestration"),
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
    },
  ): RunRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into runs (
        id, project_id, provider_account_id, model_id, harness_type, run_mode, workspace_type, prompt, status,
        workspace_vcs, goal_text, branch_name, worktree_path, summary, error_message, last_provider_response_id, input_tokens, output_tokens, list_visibility, run_kind, lab_thread_id,
        parent_run_id, root_run_id, lineage_title, project_task_id, delegation_enabled, created_at, updated_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        Number(input.delegationEnabled === true),
        createdAt,
        createdAt,
        null,
        null,
      ],
    );
    return this.getRun(id);
  }

  private withDerivedRunStates(runs: RunRecord[]): RunRecord[] {
    if (runs.length === 0) {
      return [];
    }

    const derivedByRunId = new Map<string, DerivedRunState>();
    for (const run of runs) {
      derivedByRunId.set(run.id, createDerivedRunState(run));
    }

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
    }

    return runs.map((run) => {
      const derived = derivedByRunId.get(run.id);
      return {
        ...run,
        forgeRequest: forgeByRunId.get(run.id) ?? null,
        pendingUserInputRequest: derived?.pendingUserInputRequest ?? false,
        userInputSearchText: derived ? [...derived.parts].join("\n") : "",
        lastUserInputAt: derived?.lastUserInputAt ?? run.createdAt,
      };
    });
  }

  private withDerivedRunState(run: RunRecord): RunRecord {
    return this.withDerivedRunStates([run])[0]!;
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

  deleteRun(runId: string): void {
    this.run("update project_tasks set run_id = null, updated_at = ? where run_id = ?", [nowIso(), runId]);
    this.run("delete from run_notes where run_id = ?", [runId]);
    this.run("delete from run_steps where run_id = ?", [runId]);
    this.run("delete from worktrees where run_id = ?", [runId]);
    this.run("delete from chat_steps where chat_id in (select id from chats where run_id = ?)", [runId]);
    this.run("delete from chats where run_id = ?", [runId]);
    this.run("delete from run_forge_links where run_id = ?", [runId]);
    this.run("delete from runs where id = ?", [runId]);
  }

  getRunForgeRequestCache(runId: string): RunForgeRequestCacheRecord | null {
    const row = this.first<StoredRunForgeRequestCacheRecord>(
      `select l.run_id as runId, r.project_id as projectId, l.branch_name as branchName,
        l.head_sha as headSha, l.last_probe_at as lastProbeAt, l.negative_cache_until as negativeCacheUntil,
        f.summary_json as summaryJson, f.details_json as detailsJson, f.etag,
        f.last_modified as lastModified, coalesce(f.error_count, 0) as errorCount,
        f.retry_after_at as retryAfterAt
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
         updated_at = excluded.updated_at`,
      [runId, branchName, headSha, timestamp, negativeCacheUntil, timestamp, timestamp],
    );
  }

  saveRunForgeSyncError(runId: string, message: string, retryAfterAt: string): RunForgeRequestSummary | null {
    const cache = this.getRunForgeRequestCache(runId);
    if (!cache?.summary) return null;
    const timestamp = nowIso();
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

  listRunsForProject(projectId: string): RunRecord[] {
    return this.withDerivedRunStates(this.all<RunRecord>(
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

  private listRunsByIds(runIds: string[]): RunRecord[] {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length === 0) {
      return [];
    }

    const runs: RunRecord[] = [];
    for (const batch of chunkValues(uniqueRunIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      runs.push(
        ...this.all<RunRecord>(
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

  countRunsForProviderAccount(providerAccountId: string): number {
    const row = this.first<{ count: number }>(
      `
      select count(*) as count
      from runs
      where provider_account_id = ?
      `,
      [providerAccountId],
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

    this.run(
      `
      update runs
      set provider_account_id = ?, model_id = ?, run_mode = ?, goal_text = ?, delegation_enabled = ?, updated_at = ?
      where id = ?
      `,
      [
        fields.providerAccountId ?? existing.providerAccountId,
        fields.modelId ?? existing.modelId,
        fields.mode ?? existing.mode,
        fields.goalText !== undefined ? fields.goalText : existing.goalText,
        fields.delegationEnabled === undefined ? Number(existing.delegationEnabled) : Number(fields.delegationEnabled),
        timestamp,
        runId,
      ],
    );
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
    this.run(
      `
      insert into run_steps (id, run_id, event_type, title, content, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, runId, eventType, title, content, metadataJson, createdAt],
    );
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

    this.run(
      `
      update run_steps
      set title = ?, content = ?, metadata_json = ?
      where id = ?
      `,
      [
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
      order by created_at asc
      `,
      [runId],
    );
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

  setSetting(key: string, value: string): void {
    const timestamp = nowIso();
    this.run(
      `
      insert into app_settings (key, value, updated_at)
      values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      [key, value, timestamp],
    );
  }

  deleteSetting(key: string): void {
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
    const existing = this.getProviderSessionRuntime(input.ownerId, input.ownerKind);
    const timestamp = nowIso();
    const createdAt = existing?.createdAt ?? timestamp;
    const resumeCursorJson = input.resumeCursor == null ? null : JSON.stringify(input.resumeCursor);
    const runtimePayloadJson = input.runtimePayload == null ? null : JSON.stringify(input.runtimePayload);

    this.run(
      `
      insert into provider_session_runtime (
        owner_id,
        owner_kind,
        provider_type,
        harness_type,
        status,
        cwd,
        model_id,
        runtime_mode,
        resume_cursor_json,
        runtime_payload_json,
        last_seen_at,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(owner_id, owner_kind) do update set
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
        input.providerType,
        input.harnessType,
        input.status,
        input.cwd,
        input.modelId ?? null,
        input.runtimeMode,
        resumeCursorJson,
        runtimePayloadJson,
        timestamp,
        createdAt,
        timestamp,
      ],
    );
    return this.getProviderSessionRuntime(input.ownerId, input.ownerKind)!;
  }

  getProviderSessionRuntime(
    ownerId: string,
    ownerKind: ProviderSessionRuntimeRecord["ownerKind"],
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
      from provider_session_runtime
      where owner_id = ? and owner_kind = ?
      `,
      [ownerId, ownerKind],
    );
    if (!row) {
      return null;
    }
    return {
      ...row,
      resumeCursor: this.parseJsonObject(row.resumeCursorJson),
      runtimePayload: this.parseJsonObject(row.runtimePayloadJson),
    };
  }

  deleteProviderSessionRuntime(ownerId: string, ownerKind: ProviderSessionRuntimeRecord["ownerKind"]): void {
    this.run("delete from provider_session_runtime where owner_id = ? and owner_kind = ?", [ownerId, ownerKind]);
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
        last_event_sequence, last_delivered_sequence, error_message, created_at, updated_at, finished_at
      ) values (?, ?, ?, 'active', ?, null, '[]', 0, 0, null, ?, ?, null)`,
      [id, input.projectId, input.coordinatorRunId, JSON.stringify(input.teamSnapshot), timestamp, timestamp],
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
      `update orchestrations set status = ?, team_snapshot_json = ?, wake_mode = ?, wake_task_ids_json = ?,
       last_delivered_sequence = ?, error_message = ?, updated_at = ?, finished_at = ? where id = ?`,
      [
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
    childRunId?: string | null;
    retryOfTaskId?: string | null;
  }): OrchestrationTaskRecord {
    const id = createId();
    const timestamp = nowIso();
    this.run(
      `insert into orchestration_tasks (
        id, orchestration_id, wave_id, client_task_id, title, prompt, role_id, model_id, intent, status,
        child_run_id, retry_of_task_id, summary, error_message, attention_reason, adoption_status,
        input_tokens, output_tokens, created_at, updated_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, null, null, 'none', 0, 0, ?, ?, null, null)`,
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
        input.childRunId ?? null,
        input.retryOfTaskId ?? null,
        timestamp,
        timestamp,
      ],
    );
    return this.getOrchestrationTask(id);
  }

  getOrchestrationTask(id: string): OrchestrationTaskRecord {
    const task = this.first<OrchestrationTaskRecord>(
      `${ORCHESTRATION_TASK_SELECT} where id = ?`,
      [id],
    );
    if (!task) throw new Error(`Orchestration task not found: ${id}`);
    return task;
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
      | "inputTokens"
      | "outputTokens"
      | "startedAt"
      | "finishedAt"
    >>,
  ): OrchestrationTaskRecord {
    const existing = this.getOrchestrationTask(id);
    this.run(
      `update orchestration_tasks set status = ?, child_run_id = ?, summary = ?, error_message = ?,
       attention_reason = ?, adoption_status = ?, input_tokens = ?, output_tokens = ?, updated_at = ?,
       started_at = ?, finished_at = ? where id = ?`,
      [
        fields.status ?? existing.status,
        fields.childRunId !== undefined ? fields.childRunId : existing.childRunId,
        fields.summary !== undefined ? fields.summary : existing.summary,
        fields.errorMessage !== undefined ? fields.errorMessage : existing.errorMessage,
        fields.attentionReason !== undefined ? fields.attentionReason : existing.attentionReason,
        fields.adoptionStatus ?? existing.adoptionStatus,
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
    };
  }

  getOrchestrationOperation(orchestrationId: string, requestId: string): {
    id: string;
    toolName: string;
    requestHash: string;
    status: string;
    responseJson: string | null;
    errorMessage: string | null;
  } | null {
    return this.first(
      `select id, tool_name as toolName, request_hash as requestHash, status, response_json as responseJson,
       error_message as errorMessage from orchestration_operations where orchestration_id = ? and request_id = ?`,
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
  ): void {
    this.run(
      `update orchestration_operations set status = ?, response_json = ?, error_message = ?, updated_at = ?
       where orchestration_id = ? and request_id = ?`,
      [status, JSON.stringify(response ?? null), errorMessage ?? null, nowIso(), orchestrationId, requestId],
    );
  }

  deleteRunningOrchestrationOperations(): void {
    this.run("delete from orchestration_operations where status = 'running'");
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
      orchestration: this.getOrchestrationDetailByCoordinatorRunId(runId),
    };
  }

  private createInitialSchema(): void {
    this.exec(`
      create table if not exists projects (
        id text primary key,
        name text not null,
        repo_path text not null unique,
        default_branch text not null,
        project_kind text not null default 'git',
        cumulative_input_tokens integer not null default 0,
        cumulative_output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        last_opened_at text
      );

      create table if not exists provider_accounts (
        id text primary key,
        provider_type text not null,
        label text not null,
        api_base_url text,
        api_key_ref text not null,
        config_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists models (
        id text primary key,
        provider_account_id text not null,
        model_id text not null,
        display_name text not null,
        base_url_override text,
        config_json text not null default '{}',
        capabilities_json text not null default '{}',
        enabled integer not null default 1,
        created_at text not null,
        updated_at text not null,
        foreign key(provider_account_id) references provider_accounts(id)
      );

      create table if not exists runs (
        id text primary key,
        project_id text not null,
        provider_account_id text not null,
        model_id text not null,
        harness_type text not null,
        run_mode text not null default 'code',
        workspace_type text not null default 'worktree',
        workspace_vcs text not null default 'git',
        prompt text not null,
        goal_text text,
        status text not null,
        branch_name text not null,
        worktree_path text not null,
        summary text,
        error_message text,
        last_provider_response_id text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        list_visibility text not null default 'default',
        run_kind text not null default 'standard',
        lab_thread_id text,
        parent_run_id text,
        root_run_id text,
        lineage_title text,
        project_task_id text,
        delegation_enabled integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(project_id) references projects(id),
        foreign key(provider_account_id) references provider_accounts(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists run_steps (
        id text primary key,
        run_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(run_id) references runs(id)
      );

      create table if not exists run_notes (
        id text primary key,
        run_id text not null,
        content text not null,
        status text not null default 'open',
        created_at text not null,
        updated_at text not null,
        closed_at text,
        foreign key(run_id) references runs(id)
      );

      create table if not exists forge_requests (
        id text primary key,
        project_id text not null,
        provider text not null,
        request_number integer not null,
        summary_json text not null,
        details_json text,
        checks_json text not null default '[]',
        etag text,
        last_modified text,
        last_synced_at text not null,
        error_count integer not null default 0,
        sync_error text,
        retry_after_at text,
        created_at text not null,
        updated_at text not null,
        unique(project_id, provider, request_number),
        foreign key(project_id) references projects(id)
      );

      create table if not exists run_forge_links (
        run_id text primary key,
        forge_request_id text,
        branch_name text not null,
        head_sha text,
        last_probe_at text,
        negative_cache_until text,
        created_at text not null,
        updated_at text not null,
        foreign key(run_id) references runs(id),
        foreign key(forge_request_id) references forge_requests(id)
      );

      create table if not exists worktrees (
        id text primary key,
        project_id text not null,
        run_id text not null,
        branch_name text not null,
        worktree_path text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(run_id) references runs(id)
      );

      create table if not exists app_settings (
        key text primary key,
        value text not null,
        updated_at text not null
      );

      create table if not exists bookmarks (
        id text primary key,
        original_run_id text not null,
        project_id text,
        project_name text not null,
        prompt text not null,
        status text not null,
        branch_name text not null,
        model_id text,
        run_created_at text not null,
        bookmarked_at text not null
      );

      create table if not exists bookmark_steps (
        id text primary key,
        bookmark_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key (bookmark_id) references bookmarks(id)
      );

      create table if not exists chats (
        id text primary key,
        provider_account_id text not null,
        model_id text not null,
        run_id text,
        prompt text not null,
        status text not null,
        last_provider_response_id text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(provider_account_id) references provider_accounts(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists chat_steps (
        id text primary key,
        chat_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(chat_id) references chats(id)
      );

      create table if not exists chat_bookmarks (
        id text primary key,
        original_chat_id text not null,
        prompt text not null,
        status text not null,
        model_id text,
        chat_created_at text not null,
        bookmarked_at text not null
      );

      create table if not exists chat_bookmark_steps (
        id text primary key,
        chat_bookmark_id text not null,
        event_type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(chat_bookmark_id) references chat_bookmarks(id)
      );

      create table if not exists project_tasks (
        id text primary key,
        project_id text not null,
        title text not null,
        prompt text not null,
        status text not null default 'open',
        run_id text,
        pull_request_url text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id)
      );

      create table if not exists project_insights (
        id text primary key,
        project_id text not null,
        kind text not null,
        title text not null,
        summary text not null,
        data_json text not null default '{}',
        model_id text,
        generated_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(model_id) references models(id)
      );

      create table if not exists project_lab_threads (
        id text primary key,
        project_id text not null,
        kind text not null,
        lab_mode text not null default 'new-feature',
        status text not null,
        origin text not null,
        title text not null,
        summary text not null,
        outcome text,
        seed_prompt text,
        implementation_prompt text,
        implementation_run_id text,
        implementation_model_id text,
        review_model_id text,
        base_branch text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(implementation_run_id) references runs(id),
        foreign key(implementation_model_id) references models(id),
        foreign key(review_model_id) references models(id)
      );

      create table if not exists project_lab_events (
        id text primary key,
        thread_id text not null,
        role text not null,
        label text not null,
        content text not null,
        created_at text not null,
        foreign key(thread_id) references project_lab_threads(id)
      );

      create table if not exists project_loops (
        id text primary key,
        project_id text not null,
        name text not null,
        prompt text not null,
        runner_model_id text not null,
        review_model_id text,
        merge_policy text not null default 'wait-for-approval',
        ui_change_policy text not null default 'auto',
        pr_review_policy text not null default 'none',
        ui_review_instructions text,
        base_branch text not null,
        status text not null,
        plan_summary text,
        error_message text,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        foreign key(project_id) references projects(id)
      );

      create table if not exists project_loop_iterations (
        id text primary key,
        loop_id text not null,
        iteration_index integer not null,
        title text not null,
        objective text not null,
        status text not null default 'pending',
        run_id text,
        branch_name text,
        pr_url text,
        pr_number integer,
        target_branch text,
        error_message text,
        ai_review_posted integer not null default 0,
        processed_comment_ids_json text not null default '[]',
        created_at text not null,
        updated_at text not null,
        foreign key(loop_id) references project_loops(id)
      );

      create table if not exists project_loop_events (
        id text primary key,
        loop_id text not null,
        iteration_id text,
        role text not null,
        label text not null,
        content text not null,
        created_at text not null,
        foreign key(loop_id) references project_loops(id)
      );

      create table if not exists project_loop_ui_reviews (
        id text primary key,
        loop_id text not null,
        iteration_id text not null,
        round integer not null default 1,
        page_name text not null,
        description text,
        image_path text not null,
        status text not null default 'pending',
        feedback text,
        created_at text not null,
        updated_at text not null,
        foreign key(loop_id) references project_loops(id),
        foreign key(iteration_id) references project_loop_iterations(id)
      );

      create index if not exists idx_project_loops_project_id on project_loops(project_id);
      create index if not exists idx_project_loops_runner_model_id on project_loops(runner_model_id);
      create index if not exists idx_project_loops_review_model_id on project_loops(review_model_id);
      create index if not exists idx_project_loop_iterations_loop_id on project_loop_iterations(loop_id, iteration_index);
      create unique index if not exists idx_project_loop_iterations_loop_index_unique on project_loop_iterations(loop_id, iteration_index);
      create index if not exists idx_project_loop_events_loop_id on project_loop_events(loop_id, created_at);
      create index if not exists idx_project_loop_ui_reviews_loop_id on project_loop_ui_reviews(loop_id, created_at);

      create unique index if not exists idx_project_insights_project_kind on project_insights(project_id, kind);
      create index if not exists idx_project_lab_threads_project_id on project_lab_threads(project_id);
      create index if not exists idx_project_lab_threads_implementation_model_id on project_lab_threads(implementation_model_id);
      create index if not exists idx_project_lab_threads_review_model_id on project_lab_threads(review_model_id);
      create index if not exists idx_project_lab_events_thread_id on project_lab_events(thread_id);
      create index if not exists idx_runs_project_created_at on runs(project_id, created_at desc);
      create index if not exists idx_runs_model_id on runs(model_id);
      create index if not exists idx_runs_status on runs(status);
      create index if not exists idx_runs_parent_run_id on runs(parent_run_id);
      create index if not exists idx_runs_root_run_id on runs(root_run_id);
      create index if not exists idx_run_steps_run_created_at on run_steps(run_id, created_at);
      create index if not exists idx_run_notes_run_status_updated on run_notes(run_id, status, updated_at desc);
      create index if not exists idx_chat_steps_chat_created_at on chat_steps(chat_id, created_at);
      create index if not exists idx_chats_model_id on chats(model_id);
      create index if not exists idx_project_insights_model_id on project_insights(model_id);
      create index if not exists idx_worktrees_run_id on worktrees(run_id);
      create index if not exists idx_bookmarks_original_run_id on bookmarks(original_run_id);
      create index if not exists idx_chat_bookmarks_original_chat_id on chat_bookmarks(original_chat_id);

      create table if not exists provider_session_runtime (
        owner_id text not null,
        owner_kind text not null,
        provider_type text not null,
        harness_type text not null,
        status text not null,
        cwd text not null,
        model_id text,
        runtime_mode text not null,
        resume_cursor_json text,
        runtime_payload_json text,
        last_seen_at text not null,
        created_at text not null,
        updated_at text not null,
        primary key (owner_id, owner_kind)
      );
      create index if not exists idx_provider_session_runtime_last_seen on provider_session_runtime(last_seen_at);

      create table if not exists remote_pairing_grants (
        id text primary key,
        token_hash text not null unique,
        scopes_json text not null,
        expires_at text not null,
        used_at text,
        created_at text not null,
        client_origin text
      );

      create table if not exists remote_access_sessions (
        id text primary key,
        token_hash text not null unique,
        label text not null,
        scopes_json text not null,
        created_at text not null,
        expires_at text not null,
        last_used_at text not null,
        revoked_at text,
        client_origin text
      );

      create table if not exists remote_security_audit (
        id text primary key,
        event text not null,
        outcome text not null,
        session_id text,
        pairing_grant_id text,
        remote_address text,
        details_json text,
        created_at text not null
      );

      create table if not exists remote_command_idempotency (
        session_id text not null,
        idempotency_key text not null,
        method text not null,
        request_hash text not null,
        response_json text,
        created_at text not null,
        completed_at text,
        primary key (session_id, idempotency_key)
      );

      create index if not exists idx_remote_pairing_grants_expiry on remote_pairing_grants(expires_at);
      create index if not exists idx_remote_access_sessions_token on remote_access_sessions(token_hash);
      create index if not exists idx_remote_access_sessions_created on remote_access_sessions(created_at desc);
      create index if not exists idx_remote_security_audit_created on remote_security_audit(created_at desc);
      create index if not exists idx_remote_command_idempotency_created on remote_command_idempotency(created_at desc);

      create table if not exists orchestrations (
        id text primary key,
        project_id text not null,
        coordinator_run_id text not null unique,
        status text not null,
        team_snapshot_json text not null,
        wake_mode text,
        wake_task_ids_json text not null default '[]',
        last_event_sequence integer not null default 0,
        last_delivered_sequence integer not null default 0,
        error_message text,
        created_at text not null,
        updated_at text not null,
        finished_at text
      );

      create table if not exists orchestration_waves (
        id text primary key,
        orchestration_id text not null,
        wave_index integer not null,
        baseline_path text,
        baseline_state text not null default 'capturing',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists orchestration_tasks (
        id text primary key,
        orchestration_id text not null,
        wave_id text not null,
        client_task_id text not null,
        title text not null,
        prompt text not null,
        role_id text not null,
        model_id text not null,
        intent text not null,
        status text not null,
        child_run_id text unique,
        retry_of_task_id text,
        summary text,
        error_message text,
        attention_reason text,
        adoption_status text not null default 'none',
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text,
        unique(orchestration_id, client_task_id)
      );

      create table if not exists orchestration_events (
        id text primary key,
        orchestration_id text not null,
        task_id text,
        sequence integer not null,
        type text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        unique(orchestration_id, sequence)
      );

      create table if not exists orchestration_task_messages (
        id text primary key,
        orchestration_id text not null,
        task_id text not null,
        source text not null,
        content text not null,
        status text not null default 'queued',
        created_at text not null,
        delivered_at text
      );

      create table if not exists orchestration_operations (
        id text primary key,
        orchestration_id text not null,
        request_id text not null,
        tool_name text not null,
        request_hash text not null,
        status text not null,
        response_json text,
        error_message text,
        created_at text not null,
        updated_at text not null,
        unique(orchestration_id, request_id)
      );

      create table if not exists orchestration_cleanup_jobs (
        id text primary key,
        coordinator_run_id text not null,
        orchestration_id text,
        manifest_json text not null,
        status text not null,
        error_message text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists orchestration_adoptions (
        id text primary key,
        orchestration_id text not null,
        task_id text not null,
        status text not null,
        manifest_json text not null default '{}',
        backup_path text,
        error_message text,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_orchestrations_project on orchestrations(project_id, updated_at desc);
      create index if not exists idx_orchestrations_status on orchestrations(status);
      create unique index if not exists idx_orchestration_waves_number on orchestration_waves(orchestration_id, wave_index);
      create index if not exists idx_orchestration_tasks_status on orchestration_tasks(orchestration_id, status);
      create index if not exists idx_orchestration_tasks_child_run on orchestration_tasks(child_run_id);
      create index if not exists idx_orchestration_tasks_model_id on orchestration_tasks(model_id);
      create index if not exists idx_orchestration_events_sequence on orchestration_events(orchestration_id, sequence);
      create index if not exists idx_orchestration_messages_status on orchestration_task_messages(task_id, status);
      create index if not exists idx_orchestration_cleanup_status on orchestration_cleanup_jobs(status, updated_at);
      create index if not exists idx_forge_requests_project on forge_requests(project_id, updated_at desc);
      create index if not exists idx_run_forge_links_request on run_forge_links(forge_request_id);
    `);

  }

  private applySchemaMigrations(): void {
    this.ensureColumn("projects", "project_kind", "text not null default 'git'");
    this.ensureColumn("runs", "workspace_vcs", "text not null default 'git'");
    this.ensureColumn("project_loops", "pr_review_policy", "text not null default 'none'");
    this.ensureColumn("project_loop_iterations", "ai_review_posted", "integer not null default 0");
    this.ensureColumn("chats", "run_id", "text");
    this.ensureColumn("runs", "project_task_id", "text");
    this.ensureColumn("runs", "delegation_enabled", "integer not null default 0");
    this.ensureColumn("project_tasks", "status", "text not null default 'open'");
    this.ensureColumn("project_tasks", "run_id", "text");
    this.ensureColumn("project_tasks", "pull_request_url", "text");
    this.ensureColumn("remote_pairing_grants", "client_origin", "text");
    this.ensureColumn("remote_access_sessions", "client_origin", "text");
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

  private run(sql: string, params: unknown[] = []): void {
    const statement = this.database.prepare(sql);
    statement.run(...(params as SQLInputValue[]));
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
