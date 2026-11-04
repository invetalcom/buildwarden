import type { SubscriptionLimitsReport, SubscriptionProvider } from "@buildwarden/shared";
import type { BuildWardenClient } from "./buildwarden-client-core";

interface LimitsState {
  installed: readonly SubscriptionProvider[] | null;
  report: SubscriptionLimitsReport | null;
  refreshing: boolean;
  error: string | null;
}

/** One in-memory reading per host client, shared by startup, the page, and the title-bar popup. */
export class SubscriptionLimitsStore {
  private state: LimitsState = { installed: null, report: null, refreshing: false, error: null };
  private listeners = new Set<() => void>();
  private sourceKey: string | undefined;
  private generation = 0;
  private pending: Promise<void> | null = null;
  private detecting: Promise<void> | null = null;
  constructor(private readonly client: Pick<BuildWardenClient, "getSubscriptionLimits" | "getSubscriptionLimitsAvailability">) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(update: Partial<LimitsState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }

  initialize = (sourceKey: string, recheck = false): Promise<void> => {
    const changed = sourceKey !== this.sourceKey;
    if (!changed && this.detecting) return this.detecting;
    if (!changed && !recheck) return Promise.resolve();
    if (changed) {
      this.sourceKey = sourceKey; this.generation += 1; this.pending = null;
      this.update({ refreshing: false, error: null });
    }
    const generation = this.generation;
    const task = (async () => {
      try {
        const installed = await this.client.getSubscriptionLimitsAvailability();
        if (generation !== this.generation) return;
        const availabilityChanged = JSON.stringify(installed) !== JSON.stringify(this.state.installed);
        if (!availabilityChanged) { if (changed) await this.refresh(true); return; }
        // An installation change invalidates pending readings and cached reset tokens.
        this.generation += 1; this.pending = null;
        this.update({ installed, report: null, refreshing: false, error: null });
        if (installed.length) await this.refresh(true);
      } catch {
        // Detection failure must not turn a previously detected installation into a confirmed absence.
        if (generation === this.generation) this.update({ error: "Could not check provider installations." });
      }
    })();
    this.detecting = task;
    void task.finally(() => { if (this.detecting === task) this.detecting = null; });
    return task;
  };

  refresh = (force = false): Promise<void> => {
    if (this.state.installed?.length === 0) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.update({ refreshing: true, error: null });
    const task = (async () => {
      try {
        const report = await this.client.getSubscriptionLimits({ refresh: force });
        if (generation === this.generation) this.update({ report, installed: [...new Set(report.accounts.map((account) => account.providerType))], error: null });
      } catch {
        if (generation === this.generation) this.update({ error: "Could not refresh limits. Try again." });
      } finally {
        if (generation === this.generation) this.update({ refreshing: false });
      }
    })();
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = null; });
    return task;
  };

  /** Reset responses supersede a refresh that may have started before the reset. */
  replaceReport = (report: SubscriptionLimitsReport) => {
    this.generation += 1; this.pending = null;
    this.update({ report, error: null, refreshing: false });
  };
}

const stores = new WeakMap<BuildWardenClient, SubscriptionLimitsStore>();
export function subscriptionLimitsStore(client: BuildWardenClient): SubscriptionLimitsStore {
  let store = stores.get(client);
  if (!store) { store = new SubscriptionLimitsStore(client); stores.set(client, store); }
  return store;
}
