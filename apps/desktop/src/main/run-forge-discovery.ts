import type { RunForgeReadProvider } from "./pr-review/pr-review-types";

export function guardRunForgeReads(provider: RunForgeReadProvider, enabled: () => boolean): RunForgeReadProvider {
  const check = () => { if (!enabled()) throw new Error("Automatic PR/MR checks are disabled."); };
  return {
    getSourceRepository: (url) => { check(); return provider.getSourceRepository(url); },
    listRequests: (input) => { check(); return provider.listRequests(input); },
    getRequestSummary: (input) => { check(); return provider.getRequestSummary(input); },
    getRequestStatus: (input) => { check(); return provider.getRequestStatus(input); },
    getRequestDetails: (input) => { check(); return provider.getRequestDetails(input); },
  };
}

/** Share remote reads across runs on the same branch/request for one sweep. */
export function cacheRunForgeReads(provider: RunForgeReadProvider): RunForgeReadProvider {
  const sources = new Map<string, Promise<string | null>>();
  const statuses = new Map<string, ReturnType<RunForgeReadProvider["getRequestStatus"]>>();
  const details = new Map<string, ReturnType<RunForgeReadProvider["getRequestDetails"]>>();
  const summaries = new Map<string, ReturnType<RunForgeReadProvider["getRequestSummary"]>>();
  return {
    listRequests: (input) => provider.listRequests(input),
    getRequestSummary: (input) => {
      const result = summaries.get(input.prUrl) ?? provider.getRequestSummary(input);
      summaries.set(input.prUrl, result);
      return result;
    },
    getSourceRepository: (url) => {
      const result = sources.get(url) ?? provider.getSourceRepository(url);
      sources.set(url, result);
      return result;
    },
    getRequestStatus: (input) => {
      const result = statuses.get(input.prUrl) ?? provider.getRequestStatus(input);
      statuses.set(input.prUrl, result);
      return result;
    },
    getRequestDetails: (input) => {
      const result = details.get(input.prUrl) ?? provider.getRequestDetails(input);
      details.set(input.prUrl, result);
      return result;
    },
  };
}

/** Bounded, coalesced discovery for sidebar runs, including runs never opened this session. */
export class RunForgeDiscovery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, boolean>();
  private readonly due = new Map<string, { intervalMs: number; at: number }>();
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly dependencies: {
    projects: () => Array<{ projectId: string; intervalMs: number }>;
    shouldRun: (projectId: string) => boolean;
    refresh: (projectId: string, includeOlder: boolean) => Promise<void>;
    onError: (projectId: string, error: unknown) => void;
  }) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 5_000);
    this.timer.unref?.();
  }

  private tick(): void {
    const projects = this.dependencies.projects().filter((project) => project.intervalMs > 0);
    const enabled = new Set(projects.map((project) => project.projectId));
    for (const id of this.due.keys()) {
      if (!enabled.has(id)) { this.due.delete(id); this.pending.delete(id); }
    }
    for (const { projectId, intervalMs } of projects) {
      const due = this.due.get(projectId);
      if (!due || due.intervalMs !== intervalMs) this.refresh(projectId, true);
      else if (due.at <= Date.now() && this.dependencies.shouldRun(projectId)) this.refresh(projectId);
    }
  }

  refresh(projectId: string, includeOlder = false): void {
    if (this.stopped) return;
    const config = this.dependencies.projects().find((project) => project.projectId === projectId && project.intervalMs > 0);
    if (!config) { this.pending.delete(projectId); this.due.delete(projectId); return; }
    if (!includeOlder && !this.dependencies.shouldRun(projectId)) return;
    this.due.set(projectId, { intervalMs: config.intervalMs, at: Date.now() + config.intervalMs });
    this.pending.set(projectId, includeOlder || this.pending.get(projectId) === true);
    this.drain();
  }

  private drain(): void {
    if (this.stopped) return;
    for (const [projectId, includeOlder] of this.pending) {
      if (this.active.size >= 2) break;
      if (this.active.has(projectId)) continue;
      this.pending.delete(projectId);
      const job = Promise.resolve().then(() => {
        const enabled = this.dependencies.projects().some((project) => project.projectId === projectId && project.intervalMs > 0);
        if (enabled && (includeOlder || this.dependencies.shouldRun(projectId))) return this.dependencies.refresh(projectId, includeOlder);
      })
        .catch((error: unknown) => this.dependencies.onError(projectId, error))
        .finally(() => {
          this.active.delete(projectId);
          this.drain();
        });
      this.active.set(projectId, job);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    await Promise.allSettled(this.active.values());
  }
}
