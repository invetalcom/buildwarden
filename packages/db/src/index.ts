import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type QueryExecResult, type SqlJsStatic } from "sql.js";
import type {
  AppSettingRecord,
  AppSnapshot,
  AutomationAction,
  AutomationEventKind,
  AutomationEventRecord,
  AutomationGuardrails,
  AutomationInput,
  AutomationRecord,
  AutomationRunDetail,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerEvent,
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
  ProjectInput,
  ProjectInsightKind,
  ProjectInsightRecord,
  ProjectLabEventRecord,
  ProjectLabThreadDetail,
  ProjectLabThreadKind,
  ProjectLabMode,
  ProjectLabOrigin,
  ProjectLabThreadRecord,
  ProjectLabThreadStatus,
  ProjectTaskInput,
  ProjectTaskRecord,
  ProjectRecord,
  ProjectSnapshot,
  ProviderAccountRecord,
  ProviderSessionRuntimeInput,
  ProviderSessionRuntimeRecord,
  RunDetail,
  RunListVisibility,
  RunInput,
  RunNoteRecord,
  RunNoteStatus,
  UpdateProjectTaskInput,
  UpdateRunNoteInput,
  RunRecord,
  RunStatus,
  RunStepRecord,
  WorktreeRecord,
} from "@buildwarden/shared";
import {
  computeNextAutomationRunAt,
  normalizeAutomationAction,
  normalizeAutomationGuardrails,
  normalizeAutomationTrigger,
} from "@buildwarden/shared";

const require = createRequire(import.meta.url);

const DEFAULT_DB_NAME = "buildwarden.sqlite";
const SQLITE_VARIABLE_BATCH_SIZE = 900;

const nowIso = () => new Date().toISOString();
const createId = () => crypto.randomUUID();
const chunkValues = <T>(values: readonly T[], size = SQLITE_VARIABLE_BATCH_SIZE): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

export class BuildWardenDatabase {
  private sql: SqlJsStatic | null = null;
  private db: Database | null = null;
  /** Coalesces disk writes during streaming so the main process can still handle IPC (e.g. switching runs). */
  private persistFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic write id; an in-flight async write only renames into place while it is still the newest. */
  private persistGeneration = 0;
  private persistInFlightPromise: Promise<void> | null = null;
  private persistDirty = false;
  private static readonly PERSIST_DEBOUNCE_MS = 400;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    let wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    // In packaged Electron apps, .wasm files are unpacked to app.asar.unpacked
    if (!existsSync(wasmPath) && wasmPath.includes(".asar")) {
      wasmPath = wasmPath.replace(".asar", ".asar.unpacked");
    }
    this.sql = await initSqlJs({
      locateFile: () => wasmPath,
    });

    if (existsSync(this.filePath)) {
      const bytes = readFileSync(this.filePath);
      this.db = new this.sql.Database(bytes);
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.db = new this.sql.Database();
    }

    this.createInitialSchema();
    this.applySchemaMigrations();
    this.persist();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async close(): Promise<void> {
    this.persist();
    while (this.persistInFlightPromise) {
      await this.persistInFlightPromise;
    }
    this.db?.close();
    this.db = null;
  }

  /**
   * Synchronous best-effort write for process shutdown, where async work can
   * no longer be awaited. Clears any pending debounced write first.
   */
  flushToDiskSync(): void {
    if (!this.db) {
      return;
    }
    if (this.persistFlushTimer != null) {
      clearTimeout(this.persistFlushTimer);
      this.persistFlushTimer = null;
    }
    const generation = ++this.persistGeneration;
    const bytes = this.db.export();
    const tmpPath = `${this.filePath}.${generation}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmpPath, Buffer.from(bytes));
    renameSync(tmpPath, this.filePath);
  }

  /** Clears the database file and reinitializes with a fresh schema. Complete reset. */
  async resetAndReinit(): Promise<void> {
    await this.close();
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath);
    }
    await this.init();
  }

  getSnapshot(
    selectedProjectId: string | null = null,
    selectedRunId: string | null = null,
    selectedChatId: string | null = null,
  ): AppSnapshot {
    const projects = this.listProjects().map((project) => {
      const allRuns = this.listRunsForProject(project.id);
      const visibleRuns = allRuns.filter((run) => run.kind === "standard");
      const runs = visibleRuns.filter((run) => run.listVisibility !== "for-later");
      const forLaterRuns = visibleRuns.filter((run) => run.listVisibility === "for-later");
      return {
        project,
        runs,
        forLaterRuns,
        activeRuns: runs.filter((run) => ["queued", "preparing", "running"].includes(run.status)),
        recentRuns: runs.slice(0, 12),
        tasks: this.listProjectTasks(project.id),
        automations: this.listProjectAutomations(project.id),
        insights: this.listProjectInsights(project.id),
        labThreads: this.listProjectLabThreadDetails(project.id),
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
    const branchName =
      run.workspaceVcs === "folder" ? (run.workspaceType === "copy" ? "Folder copy" : "Project folder") : run.branchName;

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
    this.persist();
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
    this.persist();
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
    return this.all<ChatSummary>(
      `
      select id, prompt, status, created_at as createdAt
      from chats
      order by updated_at desc
      `,
    );
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
    this.persist();
  }

  removeChatBookmark(chatId: string): void {
    const bookmark = this.first<{ id: string }>("select id from chat_bookmarks where original_chat_id = ?", [chatId]);
    if (bookmark) this.removeChatBookmarkById(bookmark.id);
  }

  removeChatBookmarkById(bookmarkId: string): void {
    this.run("delete from chat_bookmark_steps where chat_bookmark_id = ?", [bookmarkId]);
    this.run("delete from chat_bookmarks where id = ?", [bookmarkId]);
    this.persist();
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

  createChat(providerAccountId: string, modelId: string, prompt: string): ChatRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into chats (id, provider_account_id, model_id, prompt, status, last_provider_response_id, input_tokens, output_tokens, created_at, updated_at, started_at, finished_at)
      values (?, ?, ?, ?, 'queued', null, 0, 0, ?, ?, null, null)
      `,
      [id, providerAccountId, modelId, prompt, createdAt, createdAt],
    );
    this.persist();
    return this.getChat(id);
  }

  createProjectTask(projectId: string, input: ProjectTaskInput): ProjectTaskRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into project_tasks (id, project_id, title, prompt, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
      `,
      [id, projectId, input.title, input.prompt, createdAt, createdAt],
    );
    this.persist();
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

    const updatedAt = nowIso();
    this.run(
      `
      update project_tasks
      set title = ?, prompt = ?, updated_at = ?
      where id = ?
      `,
      [nextTitle, nextPrompt, updatedAt, taskId],
    );
    this.persist();
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
    this.run("delete from project_tasks where id = ?", [taskId]);
    this.persist();
  }

  createProjectAutomation(projectId: string, input: AutomationInput): AutomationRecord {
    const id = createId();
    const createdAt = nowIso();
    const trigger = normalizeAutomationTrigger(input.trigger);
    const action = normalizeAutomationAction(input.action);
    const guardrails = normalizeAutomationGuardrails(input.guardrails);
    const nextRunAt = input.enabled === false ? null : computeNextAutomationRunAt(trigger, new Date(createdAt));
    const name = input.name.trim();
    if (!name) {
      throw new Error("Automation name cannot be empty.");
    }
    this.run(
      `
      insert into automations (
        id, project_id, name, description, enabled, trigger_json, action_json, guardrails_json,
        last_run_at, next_run_at, failure_count, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, 0, ?, ?)
      `,
      [
        id,
        projectId,
        name,
        input.description?.trim() ?? "",
        input.enabled === false ? 0 : 1,
        JSON.stringify(trigger),
        JSON.stringify(action),
        JSON.stringify(guardrails),
        nextRunAt,
        createdAt,
        createdAt,
      ],
    );
    this.persist();
    return this.getAutomation(id);
  }

  updateProjectAutomation(automationId: string, input: Partial<AutomationInput>): AutomationRecord {
    const existing = this.getAutomation(automationId);
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) {
      throw new Error("Automation name cannot be empty.");
    }
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0;
    const trigger = input.trigger ? normalizeAutomationTrigger(input.trigger) : existing.trigger;
    const action = input.action ? normalizeAutomationAction(input.action) : existing.action;
    const guardrails = input.guardrails
      ? normalizeAutomationGuardrails({ ...existing.guardrails, ...input.guardrails })
      : existing.guardrails;
    const updatedAt = nowIso();
    const nextRunAt = enabled ? computeNextAutomationRunAt(trigger, new Date(updatedAt)) : null;

    this.run(
      `
      update automations
      set name = ?, description = ?, enabled = ?, trigger_json = ?, action_json = ?, guardrails_json = ?,
          next_run_at = ?, updated_at = ?
      where id = ?
      `,
      [
        name,
        input.description === undefined ? existing.description : input.description.trim(),
        enabled,
        JSON.stringify(trigger),
        JSON.stringify(action),
        JSON.stringify(guardrails),
        nextRunAt,
        updatedAt,
        automationId,
      ],
    );
    this.persist();
    return this.getAutomation(automationId);
  }

  deleteProjectAutomation(automationId: string): void {
    const runIds = this.all<{ id: string }>("select id from automation_runs where automation_id = ?", [automationId]).map((row) => row.id);
    for (const batch of chunkValues(runIds)) {
      const placeholders = batch.map(() => "?").join(", ");
      this.run(`delete from automation_events where automation_run_id in (${placeholders})`, batch);
    }
    this.run("delete from automation_event_fingerprints where automation_id = ?", [automationId]);
    this.run("delete from automation_runs where automation_id = ?", [automationId]);
    this.run("delete from automations where id = ?", [automationId]);
    this.persist();
  }

  getAutomation(automationId: string): AutomationRecord {
    const row = this.first<{
      id: string;
      projectId: string;
      name: string;
      description: string;
      enabled: number;
      triggerJson: string;
      actionJson: string;
      guardrailsJson: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
      failureCount: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `
      select
        id,
        project_id as projectId,
        name,
        description,
        enabled,
        trigger_json as triggerJson,
        action_json as actionJson,
        guardrails_json as guardrailsJson,
        last_run_at as lastRunAt,
        next_run_at as nextRunAt,
        failure_count as failureCount,
        created_at as createdAt,
        updated_at as updatedAt
      from automations
      where id = ?
      `,
      [automationId],
    );
    if (!row) {
      throw new Error(`Automation not found: ${automationId}`);
    }
    return this.mapAutomationRow(row);
  }

  listProjectAutomations(projectId: string): AutomationRecord[] {
    return this.all<{
      id: string;
      projectId: string;
      name: string;
      description: string;
      enabled: number;
      triggerJson: string;
      actionJson: string;
      guardrailsJson: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
      failureCount: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `
      select
        id,
        project_id as projectId,
        name,
        description,
        enabled,
        trigger_json as triggerJson,
        action_json as actionJson,
        guardrails_json as guardrailsJson,
        last_run_at as lastRunAt,
        next_run_at as nextRunAt,
        failure_count as failureCount,
        created_at as createdAt,
        updated_at as updatedAt
      from automations
      where project_id = ?
      order by updated_at desc, created_at desc
      `,
      [projectId],
    ).map((row) => this.mapAutomationRow(row));
  }

  listEnabledAutomations(): AutomationRecord[] {
    return this.all<{
      id: string;
      projectId: string;
      name: string;
      description: string;
      enabled: number;
      triggerJson: string;
      actionJson: string;
      guardrailsJson: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
      failureCount: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `
      select
        id,
        project_id as projectId,
        name,
        description,
        enabled,
        trigger_json as triggerJson,
        action_json as actionJson,
        guardrails_json as guardrailsJson,
        last_run_at as lastRunAt,
        next_run_at as nextRunAt,
        failure_count as failureCount,
        created_at as createdAt,
        updated_at as updatedAt
      from automations
      where enabled = 1
      order by next_run_at is null asc, next_run_at asc, updated_at desc
      `,
    ).map((row) => this.mapAutomationRow(row));
  }

  listDueAutomations(reference = new Date()): AutomationRecord[] {
    const referenceIso = reference.toISOString();
    return this.listEnabledAutomations().filter(
      (automation) => automation.nextRunAt !== null && automation.nextRunAt <= referenceIso,
    );
  }

  touchAutomationSchedule(automationId: string, nextRunAt: string | null, lastRunAt?: string | null): void {
    const updatedAt = nowIso();
    this.run(
      `
      update automations
      set next_run_at = ?, last_run_at = coalesce(?, last_run_at), updated_at = ?
      where id = ?
      `,
      [nextRunAt, lastRunAt ?? null, updatedAt, automationId],
    );
    this.persist();
  }

  countActiveAutomationRuns(automationId: string): number {
    return this.first<{ count: number }>(
      "select count(*) as count from automation_runs where automation_id = ? and status in ('queued', 'running')",
      [automationId],
    )?.count ?? 0;
  }

  countAutomationRunsSince(automationId: string, sinceIso: string): number {
    return this.first<{ count: number }>(
      "select count(*) as count from automation_runs where automation_id = ? and created_at >= ?",
      [automationId, sinceIso],
    )?.count ?? 0;
  }

  createAutomationRun(input: {
    automationId: string;
    projectId: string;
    status?: AutomationRunStatus;
    triggerType: AutomationTrigger["type"];
    triggerEvent: AutomationTriggerEvent;
    renderedPrompt: string;
    linkedPrUrl?: string | null;
  }): AutomationRunRecord {
    const id = createId();
    const createdAt = nowIso();
    const status = input.status ?? "queued";
    this.run(
      `
      insert into automation_runs (
        id, automation_id, project_id, status, trigger_type, trigger_event_json, rendered_prompt, output_json,
        error_message, linked_run_id, linked_task_id, linked_lab_thread_ids_json, linked_pr_url,
        created_at, started_at, finished_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, null, null, null, null, '[]', ?, ?, null, null, ?)
      `,
      [
        id,
        input.automationId,
        input.projectId,
        status,
        input.triggerType,
        JSON.stringify(input.triggerEvent),
        input.renderedPrompt,
        input.linkedPrUrl ?? null,
        createdAt,
        createdAt,
      ],
    );
    this.persist();
    return this.getAutomationRun(id);
  }

  updateAutomationRun(
    automationRunId: string,
    input: Partial<{
      status: AutomationRunStatus;
      renderedPrompt: string;
      output: Record<string, unknown> | null;
      errorMessage: string | null;
      linkedRunId: string | null;
      linkedTaskId: string | null;
      linkedLabThreadIds: string[];
      linkedPrUrl: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }>,
  ): AutomationRunRecord {
    const existing = this.getAutomationRun(automationRunId);
    const updatedAt = nowIso();
    this.run(
      `
      update automation_runs
      set status = ?,
          rendered_prompt = ?,
          output_json = ?,
          error_message = ?,
          linked_run_id = ?,
          linked_task_id = ?,
          linked_lab_thread_ids_json = ?,
          linked_pr_url = ?,
          started_at = ?,
          finished_at = ?,
          updated_at = ?
      where id = ?
      `,
      [
        input.status ?? existing.status,
        input.renderedPrompt ?? existing.renderedPrompt,
        input.output === undefined ? (existing.output ? JSON.stringify(existing.output) : null) : input.output ? JSON.stringify(input.output) : null,
        input.errorMessage === undefined ? existing.errorMessage : input.errorMessage,
        input.linkedRunId === undefined ? existing.linkedRunId : input.linkedRunId,
        input.linkedTaskId === undefined ? existing.linkedTaskId : input.linkedTaskId,
        JSON.stringify(input.linkedLabThreadIds ?? existing.linkedLabThreadIds),
        input.linkedPrUrl === undefined ? existing.linkedPrUrl : input.linkedPrUrl,
        input.startedAt === undefined ? existing.startedAt : input.startedAt,
        input.finishedAt === undefined ? existing.finishedAt : input.finishedAt,
        updatedAt,
        automationRunId,
      ],
    );

    if (input.status === "failed") {
      this.run("update automations set failure_count = failure_count + 1, last_run_at = ?, updated_at = ? where id = ?", [
        input.finishedAt ?? updatedAt,
        updatedAt,
        existing.automationId,
      ]);
    } else if (input.status === "succeeded" || input.status === "skipped") {
      this.run("update automations set last_run_at = ?, updated_at = ? where id = ?", [
        input.finishedAt ?? updatedAt,
        updatedAt,
        existing.automationId,
      ]);
    }

    this.persist();
    return this.getAutomationRun(automationRunId);
  }

  getAutomationRun(automationRunId: string): AutomationRunRecord {
    const row = this.first<{
      id: string;
      automationId: string;
      projectId: string;
      status: AutomationRunStatus;
      triggerType: AutomationTrigger["type"];
      triggerEventJson: string;
      renderedPrompt: string;
      outputJson: string | null;
      errorMessage: string | null;
      linkedRunId: string | null;
      linkedTaskId: string | null;
      linkedLabThreadIdsJson: string;
      linkedPrUrl: string | null;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
      updatedAt: string;
    }>(
      `
      select
        id,
        automation_id as automationId,
        project_id as projectId,
        status,
        trigger_type as triggerType,
        trigger_event_json as triggerEventJson,
        rendered_prompt as renderedPrompt,
        output_json as outputJson,
        error_message as errorMessage,
        linked_run_id as linkedRunId,
        linked_task_id as linkedTaskId,
        linked_lab_thread_ids_json as linkedLabThreadIdsJson,
        linked_pr_url as linkedPrUrl,
        created_at as createdAt,
        started_at as startedAt,
        finished_at as finishedAt,
        updated_at as updatedAt
      from automation_runs
      where id = ?
      `,
      [automationRunId],
    );
    if (!row) {
      throw new Error(`Automation run not found: ${automationRunId}`);
    }
    return this.mapAutomationRunRow(row);
  }

  listAutomationRuns(automationId: string): AutomationRunRecord[] {
    return this.all<{
      id: string;
      automationId: string;
      projectId: string;
      status: AutomationRunStatus;
      triggerType: AutomationTrigger["type"];
      triggerEventJson: string;
      renderedPrompt: string;
      outputJson: string | null;
      errorMessage: string | null;
      linkedRunId: string | null;
      linkedTaskId: string | null;
      linkedLabThreadIdsJson: string;
      linkedPrUrl: string | null;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
      updatedAt: string;
    }>(
      `
      select
        id,
        automation_id as automationId,
        project_id as projectId,
        status,
        trigger_type as triggerType,
        trigger_event_json as triggerEventJson,
        rendered_prompt as renderedPrompt,
        output_json as outputJson,
        error_message as errorMessage,
        linked_run_id as linkedRunId,
        linked_task_id as linkedTaskId,
        linked_lab_thread_ids_json as linkedLabThreadIdsJson,
        linked_pr_url as linkedPrUrl,
        created_at as createdAt,
        started_at as startedAt,
        finished_at as finishedAt,
        updated_at as updatedAt
      from automation_runs
      where automation_id = ?
      order by created_at desc
      limit 100
      `,
      [automationId],
    ).map((row) => this.mapAutomationRunRow(row));
  }

  getAutomationRunDetail(automationRunId: string): AutomationRunDetail {
    return {
      run: this.getAutomationRun(automationRunId),
      events: this.listAutomationEvents(automationRunId),
    };
  }

  appendAutomationEvent(input: {
    automationRunId: string;
    kind: AutomationEventKind;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): AutomationEventRecord {
    const id = createId();
    const createdAt = nowIso();
    this.run(
      `
      insert into automation_events (id, automation_run_id, kind, title, content, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.automationRunId, input.kind, input.title, input.content, JSON.stringify(input.metadata ?? {}), createdAt],
    );
    this.persist();
    return {
      id,
      automationRunId: input.automationRunId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt,
    };
  }

  listAutomationEvents(automationRunId: string): AutomationEventRecord[] {
    return this.all<AutomationEventRecord>(
      `
      select
        id,
        automation_run_id as automationRunId,
        kind,
        title,
        content,
        metadata_json as metadataJson,
        created_at as createdAt
      from automation_events
      where automation_run_id = ?
      order by created_at asc
      `,
      [automationRunId],
    );
  }

  hasAutomationFingerprint(automationId: string, fingerprint: string): boolean {
    const row = this.first<{ fingerprint: string }>(
      "select fingerprint from automation_event_fingerprints where automation_id = ? and fingerprint = ?",
      [automationId, fingerprint],
    );
    return Boolean(row);
  }

  hasAnyAutomationFingerprint(automationId: string): boolean {
    const row = this.first<{ count: number }>(
      "select count(*) as count from automation_event_fingerprints where automation_id = ?",
      [automationId],
    );
    return (row?.count ?? 0) > 0;
  }

  markAutomationFingerprint(automationId: string, fingerprint: string, payload: Record<string, unknown>): void {
    const seenAt = nowIso();
    this.run(
      `
      insert into automation_event_fingerprints (automation_id, fingerprint, last_payload_json, seen_at)
      values (?, ?, ?, ?)
      on conflict(automation_id, fingerprint) do update set last_payload_json = excluded.last_payload_json, seen_at = excluded.seen_at
      `,
      [automationId, fingerprint, JSON.stringify(payload), seenAt],
    );
    this.persist();
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
      this.persist();
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
    this.persist();
    return this.getProjectInsight(input.projectId, input.kind)!;
  }

  createProjectLabThread(input: {
      projectId: string;
      kind: ProjectLabThreadKind;
      mode: ProjectLabMode;
      status: ProjectLabThreadStatus;
    origin: ProjectLabOrigin;
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
    this.persist();
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
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  getChat(id: string): ChatRecord {
    const chat = this.first<ChatRecord>(
      `
      select
        id,
        provider_account_id as providerAccountId,
        model_id as modelId,
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
    this.persist();
  }

  updateChatConfiguration(chatId: string, modelId: string): void {
    this.run("update chats set model_id = ?, updated_at = ? where id = ?", [modelId, nowIso(), chatId]);
    this.persist();
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
    this.schedulePersist();
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
    this.schedulePersist();
  }

  deleteChat(chatId: string): void {
    this.run("delete from chat_steps where chat_id = ?", [chatId]);
    this.run("delete from chats where id = ?", [chatId]);
    this.persist();
  }

  addProject(input: ProjectInput & { defaultBranch: string; resolvedName: string; kind?: ProjectRecord["kind"] }): ProjectRecord {
    const id = createId();
    const createdAt = nowIso();
    const kind = input.kind ?? "git";
    this.run(
      `
      insert into projects (id, name, repo_path, default_branch, project_kind, cumulative_input_tokens, cumulative_output_tokens, created_at, updated_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, input.resolvedName, input.repoPath, input.defaultBranch, kind, 0, 0, createdAt, createdAt, createdAt],
    );
    this.persist();
    return this.getProject(id);
  }

  listProjects(): ProjectRecord[] {
    return this.all<ProjectRecord>(
      `
      select
        id,
        name,
        repo_path as repoPath,
        default_branch as defaultBranch,
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
        default_branch as defaultBranch,
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
    this.persist();
  }

  updateProjectKind(projectId: string, kind: ProjectRecord["kind"], defaultBranch: string): ProjectRecord {
    const timestamp = nowIso();
    this.run(
      `
      update projects
      set project_kind = ?, default_branch = ?, updated_at = ?
      where id = ?
      `,
      [kind, defaultBranch, timestamp, projectId],
    );
    this.persist();
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
    this.schedulePersist();
    return this.getProject(projectId);
  }

  deleteProject(projectId: string): void {
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
    this.run("delete from runs where project_id = ?", [projectId]);
    this.run("delete from project_lab_events where thread_id in (select id from project_lab_threads where project_id = ?)", [projectId]);
    this.run("delete from project_lab_threads where project_id = ?", [projectId]);
    this.run("delete from project_tasks where project_id = ?", [projectId]);
    this.run("delete from project_insights where project_id = ?", [projectId]);
    this.run(
      "delete from automation_events where automation_run_id in (select id from automation_runs where project_id = ?)",
      [projectId],
    );
    this.run(
      "delete from automation_event_fingerprints where automation_id in (select id from automations where project_id = ?)",
      [projectId],
    );
    this.run("delete from automation_runs where project_id = ?", [projectId]);
    this.run("delete from automations where project_id = ?", [projectId]);
    this.run("delete from projects where id = ?", [projectId]);
    this.persist();
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
    this.persist();
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
    this.persist();
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
    this.persist();
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

  deleteModel(modelId: string): void {
    this.run("delete from models where id = ?", [modelId]);
    this.persist();
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
        parent_run_id, root_run_id, lineage_title, created_at, updated_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        createdAt,
        createdAt,
        null,
        null,
      ],
    );
    this.persist();
    return this.getRun(id);
  }

  private withDerivedRunStates(runs: RunRecord[]): RunRecord[] {
    if (runs.length === 0) {
      return [];
    }

    const derivedByRunId = new Map<
      string,
      {
        parts: Set<string>;
        lastUserInputAt: string;
        pendingUserInputRequest: boolean;
      }
    >();
    for (const run of runs) {
      const parts = new Set<string>();
      if (run.prompt.trim()) {
        parts.add(run.prompt.trim());
      }
      if (run.goalText?.trim()) {
        parts.add(run.goalText.trim());
      }
      derivedByRunId.set(run.id, {
        parts,
        lastUserInputAt: run.createdAt,
        pendingUserInputRequest: false,
      });
    }

    const runIds = runs.map((run) => run.id);
    for (const batch of chunkValues(runIds)) {
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

        const metadata = this.parseJsonObject(step.metadataJson);
        const isUserInputRequest = metadata?.requestKind === "user-input";
        if (step.eventType === "user-input-requested" && isUserInputRequest && metadata.requestStatus === "opened") {
          derived.pendingUserInputRequest = true;
        }

        const isUserCommand = metadata?.source === "user";
        const isSubmittedUserInput = isUserInputRequest && metadata.requestStatus === "resolved";
        if ((isUserCommand || isSubmittedUserInput) && step.content.trim()) {
          derived.parts.add(step.content.trim());
          derived.lastUserInputAt = step.createdAt;
        }
      }
    }

    return runs.map((run) => {
      const derived = derivedByRunId.get(run.id);
      return {
        ...run,
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
    this.run("delete from run_notes where run_id = ?", [runId]);
    this.run("delete from run_steps where run_id = ?", [runId]);
    this.run("delete from worktrees where run_id = ?", [runId]);
    this.run("delete from runs where id = ?", [runId]);
    this.persist();
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
    this.persist();
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
    this.persist();
    return this.getRunNote(noteId);
  }

  deleteRunNote(noteId: string): void {
    this.run("delete from run_notes where id = ?", [noteId]);
    this.persist();
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

  countRunsForModel(modelId: string): number {
    const row = this.first<{ count: number }>(
      `
      select count(*) as count
      from runs
      where model_id = ?
      `,
      [modelId],
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
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    if (terminal) {
      this.persist();
    } else {
      this.schedulePersist();
    }
    return this.getRun(runId);
  }

  updateRunConfiguration(
    runId: string,
    fields: {
      providerAccountId?: string;
      modelId?: string;
      mode?: RunRecord["mode"];
      goalText?: string | null;
    },
  ): RunRecord {
    const existing = this.getRun(runId);
    const timestamp = nowIso();

    this.run(
      `
      update runs
      set provider_account_id = ?, model_id = ?, run_mode = ?, goal_text = ?, updated_at = ?
      where id = ?
      `,
      [
        fields.providerAccountId ?? existing.providerAccountId,
        fields.modelId ?? existing.modelId,
        fields.mode ?? existing.mode,
        fields.goalText !== undefined ? fields.goalText : existing.goalText,
        timestamp,
        runId,
      ],
    );
    this.persist();
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
    this.persist();
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

    this.persist();
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
    this.persist();
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
    this.schedulePersist();
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
    this.schedulePersist();

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

    this.persist();

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
    this.persist();
  }

  deleteSetting(key: string): void {
    this.run("delete from app_settings where key = ?", [key]);
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  getRunDetail(runId: string, diff: string): RunDetail {
    return {
      run: this.getRun(runId),
      steps: this.getRunSteps(runId),
      notes: this.listRunNotes(runId),
      diff,
    };
  }

  private mapAutomationRow(row: {
    id: string;
    projectId: string;
    name: string;
    description: string;
    enabled: number;
    triggerJson: string;
    actionJson: string;
    guardrailsJson: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
    failureCount: number;
    createdAt: string;
    updatedAt: string;
  }): AutomationRecord {
    let trigger: AutomationTrigger = { type: "manual" };
    let action: AutomationAction = { type: "notify", messageTemplate: "Automation {{automation.name}} ran." };
    let guardrails: AutomationGuardrails = normalizeAutomationGuardrails();
    try {
      trigger = normalizeAutomationTrigger(JSON.parse(row.triggerJson) as AutomationTrigger);
    } catch {
      trigger = { type: "manual" };
    }
    try {
      action = normalizeAutomationAction(JSON.parse(row.actionJson) as AutomationAction);
    } catch {
      action = { type: "notify", messageTemplate: "Automation {{automation.name}} ran." };
    }
    try {
      guardrails = normalizeAutomationGuardrails(JSON.parse(row.guardrailsJson) as Partial<AutomationGuardrails>);
    } catch {
      guardrails = normalizeAutomationGuardrails();
    }
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      trigger,
      action,
      guardrails,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      failureCount: row.failureCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapAutomationRunRow(row: {
    id: string;
    automationId: string;
    projectId: string;
    status: AutomationRunStatus;
    triggerType: AutomationTrigger["type"];
    triggerEventJson: string;
    renderedPrompt: string;
    outputJson: string | null;
    errorMessage: string | null;
    linkedRunId: string | null;
    linkedTaskId: string | null;
    linkedLabThreadIdsJson: string;
    linkedPrUrl: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
  }): AutomationRunRecord {
    let triggerEvent: AutomationTriggerEvent = { type: row.triggerType, reason: "Unknown trigger" };
    let output: Record<string, unknown> | null = null;
    let linkedLabThreadIds: string[] = [];
    try {
      const parsed = JSON.parse(row.triggerEventJson) as AutomationTriggerEvent;
      triggerEvent = parsed && typeof parsed === "object" ? parsed : triggerEvent;
    } catch {
      triggerEvent = { type: row.triggerType, reason: "Unknown trigger" };
    }
    try {
      const parsed = row.outputJson ? (JSON.parse(row.outputJson) as unknown) : null;
      output = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      output = null;
    }
    try {
      const parsed = JSON.parse(row.linkedLabThreadIdsJson) as unknown;
      linkedLabThreadIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      linkedLabThreadIds = [];
    }
    return {
      id: row.id,
      automationId: row.automationId,
      projectId: row.projectId,
      status: row.status,
      triggerType: row.triggerType,
      triggerEvent,
      renderedPrompt: row.renderedPrompt,
      output,
      errorMessage: row.errorMessage,
      linkedRunId: row.linkedRunId,
      linkedTaskId: row.linkedTaskId,
      linkedLabThreadIds,
      linkedPrUrl: row.linkedPrUrl,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      updatedAt: row.updatedAt,
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

      create table if not exists automations (
        id text primary key,
        project_id text not null,
        name text not null,
        description text not null default '',
        enabled integer not null default 1,
        trigger_json text not null,
        action_json text not null,
        guardrails_json text not null default '{}',
        last_run_at text,
        next_run_at text,
        failure_count integer not null default 0,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id)
      );

      create table if not exists automation_runs (
        id text primary key,
        automation_id text not null,
        project_id text not null,
        status text not null,
        trigger_type text not null,
        trigger_event_json text not null default '{}',
        rendered_prompt text not null default '',
        output_json text,
        error_message text,
        linked_run_id text,
        linked_task_id text,
        linked_lab_thread_ids_json text not null default '[]',
        linked_pr_url text,
        created_at text not null,
        started_at text,
        finished_at text,
        updated_at text not null,
        foreign key(automation_id) references automations(id),
        foreign key(project_id) references projects(id)
      );

      create table if not exists automation_events (
        id text primary key,
        automation_run_id text not null,
        kind text not null,
        title text not null,
        content text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        foreign key(automation_run_id) references automation_runs(id)
      );

      create table if not exists automation_event_fingerprints (
        automation_id text not null,
        fingerprint text not null,
        last_payload_json text not null default '{}',
        seen_at text not null,
        primary key (automation_id, fingerprint),
        foreign key(automation_id) references automations(id)
      );

      create unique index if not exists idx_project_insights_project_kind on project_insights(project_id, kind);
      create index if not exists idx_project_lab_threads_project_id on project_lab_threads(project_id);
      create index if not exists idx_project_lab_events_thread_id on project_lab_events(thread_id);
      create index if not exists idx_automations_project_id on automations(project_id);
      create index if not exists idx_automations_next_run on automations(enabled, next_run_at);
      create index if not exists idx_automation_runs_automation_created on automation_runs(automation_id, created_at desc);
      create index if not exists idx_automation_runs_status on automation_runs(status);
      create index if not exists idx_automation_events_run_created on automation_events(automation_run_id, created_at);
      create index if not exists idx_runs_project_created_at on runs(project_id, created_at desc);
      create index if not exists idx_runs_status on runs(status);
      create index if not exists idx_runs_parent_run_id on runs(parent_run_id);
      create index if not exists idx_runs_root_run_id on runs(root_run_id);
      create index if not exists idx_run_steps_run_created_at on run_steps(run_id, created_at);
      create index if not exists idx_run_notes_run_status_updated on run_notes(run_id, status, updated_at desc);
      create index if not exists idx_chat_steps_chat_created_at on chat_steps(chat_id, created_at);
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
    `);

  }

  private applySchemaMigrations(): void {
    this.ensureColumn("projects", "project_kind", "text not null default 'git'");
    this.ensureColumn("runs", "workspace_vcs", "text not null default 'git'");
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
    statement.bind(params);
    const rows: T[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }

    statement.free();
    return rows;
  }

  private first<T>(sql: string, params: unknown[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  private run(sql: string, params: unknown[] = []): void {
    const statement = this.database.prepare(sql);
    statement.run(params);
    statement.free();
  }

  private exec(sql: string): QueryExecResult[] {
    return this.database.exec(sql);
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

  /**
   * Writes the in-memory DB to disk immediately. Clears any pending debounced write.
   * Use for app shutdown and terminal run/chat states.
   */
  private persist(): void {
    if (this.persistFlushTimer != null) {
      clearTimeout(this.persistFlushTimer);
      this.persistFlushTimer = null;
    }
    this.persistToDisk();
  }

  /**
   * Coalesced persist for high-frequency updates (streaming steps, token
   * counts). Trailing-throttle rather than sliding-debounce: a pending flush is
   * never postponed, so sustained streaming still hits disk every 400ms.
   */
  private schedulePersist(): void {
    if (!this.db) {
      return;
    }
    if (this.persistFlushTimer != null) {
      return;
    }
    this.persistFlushTimer = setTimeout(() => {
      this.persistFlushTimer = null;
      this.persistToDisk();
    }, BuildWardenDatabase.PERSIST_DEBOUNCE_MS);
  }

  /**
   * Exports the in-memory database (cheap memcpy) and writes it to disk
   * asynchronously via temp-file + rename, so the multi-megabyte file write
   * never blocks the main-process event loop. Writes never overlap; a write
   * requested while one is in flight runs once the current write finishes.
   */
  private persistToDisk(): void {
    if (!this.db) {
      return;
    }
    if (this.persistInFlightPromise) {
      this.persistDirty = true;
      return;
    }

    const generation = ++this.persistGeneration;
    const bytes = this.db.export();
    const tmpPath = `${this.filePath}.${generation}.tmp`;
    this.persistInFlightPromise = (async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(tmpPath, Buffer.from(bytes));
        if (generation === this.persistGeneration) {
          await rename(tmpPath, this.filePath);
        } else {
          // A newer write (e.g. the synchronous shutdown flush) superseded this one.
          await rm(tmpPath, { force: true });
        }
      } catch (error) {
        console.error("[buildwarden:db] Failed to persist database to disk.", error);
        await rm(tmpPath, { force: true }).catch(() => {});
      } finally {
        this.persistInFlightPromise = null;
        if (this.persistDirty) {
          this.persistDirty = false;
          this.persistToDisk();
        }
      }
    })();
  }

  private get database(): Database {
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
