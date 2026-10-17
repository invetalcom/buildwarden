import type { RunDetail } from "@buildwarden/shared";

export const RECENT_RUN_DETAIL_CACHE_SIZE = 6;

/**
 * Keeps the last few run details after their run is closed so reopening a run
 * renders its previous state immediately while the fresh detail loads.
 */
export class RecentRunDetailCache {
  private readonly entries = new Map<string, RunDetail>();

  constructor(private readonly capacity = RECENT_RUN_DETAIL_CACHE_SIZE) {}

  get(runId: string): RunDetail | undefined {
    return this.entries.get(runId);
  }

  set(runId: string, detail: RunDetail): void {
    this.entries.delete(runId);
    this.entries.set(runId, detail);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(runId: string): void {
    this.entries.delete(runId);
  }
}
