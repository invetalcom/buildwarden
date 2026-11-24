import {
  APP_SETTING_KEYS,
  type AttentionItem,
  type BookmarkRecord,
  type ChatBookmarkRecord,
  parseAttentionInboxSettings,
  parseRunWorkspaceLayoutPreference,
  type RunListVisibility,
  type RunNoteRecord,
  type RunRecord,
  type RunWorkspaceLayoutPreferencesByRunId,
  type UpdateRunNoteInput,
  type UpdateRunOrganizationInput,
} from "@buildwarden/shared";
import { AppService } from "./app-service";

/** Transcript indexing waits for startup to settle, then yields between small slices. */
const HISTORY_BACKFILL_START_DELAY_MS = 5_000;

const HISTORY_BACKFILL_SLICE_DELAY_MS = 250;
const HISTORY_INDEX_IDLE_DELAY_MS = 30_000;

/** Manages bookmarks, sections, notes, layouts and the attention inbox. */
export class OrganizationService extends AppService<"providerRuntime" | "runEvents" | "runForge"> {
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

  isChatBookmarked(chatId: string): Promise<boolean> {
    return Promise.resolve(this.db.isChatBookmarked(chatId));
  }

  getChatBookmarksWithSteps(): Promise<ChatBookmarkRecord[]> {
    return Promise.resolve(this.db.getChatBookmarksWithSteps());
  }

  isBookmarked(runId: string): Promise<boolean> {
    return Promise.resolve(this.db.isBookmarked(runId));
  }

  async getAttentionInbox(): Promise<AttentionItem[]> {
    const items = this.db.listAttentionInbox();
    const inbox = parseAttentionInboxSettings(this.db.getSettings()[APP_SETTING_KEYS.attentionInbox]);
    if (!inbox.enabled || !inbox.kinds.update) return items;
    const updates = this.services.providerRuntime.providerCliUpdates.attentionItems();
    if (!updates.length) return items;
    // Updates rank below live requests and failures but above routine review notices.
    const reviewIndex = items.findIndex((item) => item.kind === "review");
    const insertAt = reviewIndex < 0 ? items.length : reviewIndex;
    return [...items.slice(0, insertAt), ...updates, ...items.slice(insertAt)];
  }

  async acknowledgeAttentionItem(itemId: string): Promise<void> {
    await this.acknowledgeAttentionItems([itemId]);
  }

  async acknowledgeAttentionItems(itemIds: string[]): Promise<void> {
    const runItemIds = this.services.providerRuntime.providerCliUpdates.dismiss(itemIds);
    if (runItemIds.length) this.db.acknowledgeAttentionItems(runItemIds);
  }

  async listRunWorkspaceLayouts(): Promise<RunWorkspaceLayoutPreferencesByRunId> {
    return this.db.listRunWorkspaceLayouts();
  }

  async setRunWorkspaceLayout(runId: unknown, layout: unknown): Promise<void> {
    if (typeof runId !== "string" || !runId) throw new Error("Invalid run id.");
    if (layout === null) {
      this.db.setRunWorkspaceLayout(runId, null);
      return;
    }
    const parsed = parseRunWorkspaceLayoutPreference(layout);
    if (!parsed) throw new Error("Invalid run workspace layout.");
    this.db.setRunWorkspaceLayout(runId, parsed);
  }

  async searchRunUserInput(query: string): Promise<string[]> {
    return this.db.searchRunUserInput(query);
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

  /** Reconciles durable orchestration work after ordinary run/chat orphan recovery on startup. */
  /**
   * Indexes older transcripts for history search in small slices, off the startup path, then
   * keeps applying queued step changes at a slow pace so searches rarely have work to catch up.
   */
  startHistorySearchBackfill(): void {
    const step = () => {
      let more = false;
      try {
        more = this.db.backfillHistorySearchIndex();
      } catch (error) {
        this.logControllerWarn("Transcript search indexing stopped; search falls back to prompts and summaries for older runs.", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      setTimeout(step, more ? HISTORY_BACKFILL_SLICE_DELAY_MS : HISTORY_INDEX_IDLE_DELAY_MS).unref?.();
    };
    setTimeout(step, HISTORY_BACKFILL_START_DELAY_MS).unref?.();
  }

  async createRunSection(name: string, color?: string) { return this.services.runEvents.publishRunOrganization(this.db.createRunSection(name, color)); }

  async setRunSectionColor(sectionId: string, color: string) { return this.services.runEvents.publishRunOrganization(this.db.setRunSectionColor(sectionId, color)); }

  async renameRunSection(sectionId: string, name: string) { return this.services.runEvents.publishRunOrganization(this.db.renameRunSection(sectionId, name)); }

  async deleteRunSection(sectionId: string) { return this.services.runEvents.publishRunOrganization(this.db.deleteRunSection(sectionId)); }

  async reorderRunSections(sectionIds: string[]) { return this.services.runEvents.publishRunOrganization(this.db.reorderRunSections(sectionIds)); }

  async updateRunOrganization(runId: string, input: UpdateRunOrganizationInput) {
    return this.services.runEvents.publishRunOrganization(this.db.updateRunOrganization(runId, input));
  }

  async setRunListVisibility(runId: string, visibility: RunListVisibility): Promise<RunRecord> {
    if (visibility !== "default" && visibility !== "for-later") {
      throw new Error("Unsupported run visibility.");
    }
    const run = this.db.updateRunListVisibility(runId, visibility);
    if (visibility === "default") this.services.runForge.runForgeDiscovery?.refresh(run.projectId, true);
    return run;
  }
}
