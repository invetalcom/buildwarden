import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  commandLineHead,
  isLauncherProcessName,
  looksLikeAgentProcess,
  ownedProcessOwnerKey,
  type ManageOwnedProcessesInput,
  type OwnedProcessEndReason,
  type OwnedProcessOutput,
  type OwnedProcessOwner,
  type OwnedProcessRecord,
  type OwnedProcessesSnapshot,
} from "@buildwarden/shared";
import type { ProcessTableEntry, ProcessTableReader, ProcessTableSnapshot } from "./process-table";
import type { ProcessTerminator } from "./process-terminator";

/** What a run or chat worker reports for each process it spawned. */
export interface OwnedProcessSpawnReport {
  pid: number;
  role: "agent" | "command";
  spawnedAtMs: number;
  commandLine: string;
}

export interface OwnedProcessRegistryOptions {
  /** Created on first use, so hosts that never spawn anything never start an inspector. */
  createReader: () => ProcessTableReader;
  supported: boolean;
  terminator: ProcessTerminator;
  /** Starts a command again for "restart"; omitted where restarting is unsupported. */
  spawnCommand?: (input: { commandLine: string; argv: string[] | null; cwd: string }) => ChildProcess;
  onChange: (snapshot: OwnedProcessesSnapshot) => void;
  platform: NodeJS.Platform;
  cpuCount: number;
  now?: () => number;
  pollIntervalMs?: number;
  gracefulStopMs?: number;
  pathExists?: (path: string) => boolean;
  log?: (message: string, error: unknown) => void;
}

interface TrackedProcess {
  record: OwnedProcessRecord;
  ownerKey: string;
  startedAtMs: number;
  argv: string[] | null;
  lastCpuTimeMs: number | null;
  lastSampleAtMs: number | null;
  stopRequest: Exclude<OwnedProcessEndReason, "exited"> | null;
  output: { text: string; truncated: boolean } | null;
  child: ChildProcess | null;
}

interface PendingSpawn extends OwnedProcessSpawnReport {
  owner: OwnedProcessOwner;
  cwd: string | null;
  registeredAtMs: number;
}

/** A reported spawn that never shows up in a snapshot was too short-lived to matter. */
const PENDING_SPAWN_TTL_MS = 15_000;
const FIRST_POLL_DELAY_MS = 400;
const MAX_EXITED_PER_OWNER = 100;
const OUTPUT_LIMIT_CHARS = 256 * 1024;
/** Console hosts Windows attaches to every console program; never interesting on their own. */
const IGNORED_PROCESS_NAMES = new Set(["conhost.exe"]);
/** Launchers start the agent right away; later children are commands the agent ran. */
const LAUNCHER_CHILD_WINDOW_MS = 15_000;

const isLauncher = isLauncherProcessName;

/** How long an exited process (or a spawn never seen alive) can still be recognised as a parent. */
const RECENT_EXIT_RETENTION_MS = 10 * 60_000;
/** Bounds the subtree walked when looking for workspace evidence. */
const MAX_EVIDENCE_PROCESSES = 200;

/**
 * Spellings of a workspace path as command lines contain it: Windows (`c:/x`, after normalising
 * slashes), MSYS/Git Bash (`/c/x`), and WSL (`/mnt/c/x`). Lower-cased for comparison.
 */
export const workspacePathForms = (path: string): string[] => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (normalized.length < 4) return [];
  const drive = /^([a-z]):\/(.*)$/.exec(normalized);
  return drive ? [normalized, `/${drive[1]}/${drive[2]}`, `/mnt/${drive[1]}/${drive[2]}`] : [normalized];
};

export const commandLineMentionsPath = (commandLine: string | null, forms: string[]): boolean => {
  if (!commandLine || forms.length === 0) return false;
  const normalized = commandLine.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return forms.some((form) => normalized.includes(form));
};

/** A parent that is gone: an exited tracked process, or a reported spawn never seen alive. */
interface FormerParent {
  owner: OwnedProcessOwner;
  processId: string | null;
  role: OwnedProcessRecord["role"];
  startedAtMs: number;
  endedAtMs: number;
  cwd: string | null;
}

export class OwnedProcessRegistry {
  private reader: ProcessTableReader | null = null;
  private readonly tracked = new Map<string, TrackedProcess>();
  private readonly pending: PendingSpawn[] = [];
  /** Recently ended parents by PID; Windows keeps an orphan's parent PID pointing at them. */
  private readonly formerParents = new Map<number, FormerParent>();
  private readonly ownerCwds = new Map<string, string | null>();
  private readonly lastEmitted = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private polling: Promise<void> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly gracefulStopMs: number;
  private readonly pathExists: (path: string) => boolean;

  constructor(private readonly options: OwnedProcessRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.gracefulStopMs = options.gracefulStopMs ?? 4_000;
    this.pathExists = options.pathExists ?? existsSync;
  }

  /** Records a process a run or chat worker just spawned; it is matched on the next snapshot. */
  registerSpawn(owner: OwnedProcessOwner, report: OwnedProcessSpawnReport, cwd: string | null): void {
    if (this.disposed || !this.options.supported || !Number.isInteger(report.pid) || report.pid <= 0) return;
    this.ownerCwds.set(ownedProcessOwnerKey(owner), cwd);
    this.pending.push({ ...report, owner, cwd, registeredAtMs: this.now() });
    this.requestPoll(FIRST_POLL_DELAY_MS);
  }

  getSnapshot(owner: OwnedProcessOwner): OwnedProcessesSnapshot {
    const key = ownedProcessOwnerKey(owner);
    const processes = [...this.tracked.values()]
      .filter((tracked) => tracked.ownerKey === key)
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((tracked) => ({ ...tracked.record, ports: [...tracked.record.ports] }));
    return { owner, supported: this.options.supported, processes, updatedAt: new Date(this.now()).toISOString() };
  }

  getOutput(owner: OwnedProcessOwner, processId: string): OwnedProcessOutput {
    const tracked = this.find(owner, processId);
    return { processId, text: tracked.output?.text ?? "", truncated: tracked.output?.truncated ?? false };
  }

  async manage(input: ManageOwnedProcessesInput): Promise<OwnedProcessesSnapshot> {
    const { owner } = input;
    const key = ownedProcessOwnerKey(owner);
    if (input.action === "clear-exited") {
      for (const [id, tracked] of this.tracked) {
        if (tracked.ownerKey === key && tracked.record.status === "exited") this.tracked.delete(id);
      }
      this.emit(key, owner);
      return this.getSnapshot(owner);
    }
    if (input.action === "stop-all" || input.action === "kill-all") {
      const targets = [...this.tracked.values()].filter((tracked) =>
        tracked.ownerKey === key && tracked.record.role !== "agent" && tracked.record.status !== "exited");
      await this.terminate(targets, input.action === "kill-all");
      return this.getSnapshot(owner);
    }

    if (!("processId" in input)) throw new Error("Choose a process.");
    const tracked = this.find(owner, input.processId);
    if (tracked.record.role === "agent") {
      throw new Error(owner.kind === "run"
        ? "This process runs the agent itself. Stop the run to end it."
        : "This process runs the agent itself. Stop the chat response to end it.");
    }
    if (input.action === "restart") {
      await this.restart(tracked);
    } else {
      if (tracked.record.status === "exited") return this.getSnapshot(owner);
      await this.terminate(this.subtree(tracked), input.action === "kill");
    }
    return this.getSnapshot(owner);
  }

  /** Drops what is known about an owner (for example after it was deleted); processes keep running. */
  forgetOwner(owner: OwnedProcessOwner): void {
    const key = ownedProcessOwnerKey(owner);
    for (const [id, tracked] of this.tracked) if (tracked.ownerKey === key) this.tracked.delete(id);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (ownedProcessOwnerKey(this.pending[index]!.owner) === key) this.pending.splice(index, 1);
    }
    for (const [pid, former] of this.formerParents) if (ownedProcessOwnerKey(former.owner) === key) this.formerParents.delete(pid);
    this.ownerCwds.delete(key);
    this.lastEmitted.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.reader?.dispose();
    this.reader = null;
  }

  /** Takes a snapshot now (waiting for one in flight) and applies it. */
  async refresh(): Promise<void> {
    if (this.polling) await this.polling;
    await this.poll();
  }

  private find(owner: OwnedProcessOwner, processId: string): TrackedProcess {
    const tracked = this.tracked.get(processId);
    if (!tracked || tracked.ownerKey !== ownedProcessOwnerKey(owner)) {
      throw new Error("This process is no longer tracked.");
    }
    return tracked;
  }

  private subtree(root: TrackedProcess): TrackedProcess[] {
    const children = new Map<string, TrackedProcess[]>();
    for (const tracked of this.tracked.values()) {
      if (!tracked.record.parentProcessId || tracked.record.status === "exited") continue;
      const list = children.get(tracked.record.parentProcessId) ?? [];
      list.push(tracked);
      children.set(tracked.record.parentProcessId, list);
    }
    const result: TrackedProcess[] = [];
    const visit = (tracked: TrackedProcess) => {
      result.push(tracked);
      for (const child of children.get(tracked.record.processId) ?? []) visit(child);
    };
    visit(root);
    return result;
  }

  private needsPolling(): boolean {
    return this.pending.length > 0 || [...this.tracked.values()].some((tracked) => tracked.record.status !== "exited");
  }

  private requestPoll(delayMs: number): void {
    if (this.disposed) return;
    const dueAt = this.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => {
        if (this.needsPolling()) this.requestPoll(this.pollIntervalMs);
      });
    }, delayMs);
  }

  private poll(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        this.reader ??= this.options.createReader();
        const snapshot = await this.reader.snapshot({ ports: true });
        if (!this.disposed) this.applySnapshot(snapshot);
      } catch (error) {
        this.options.log?.("Could not inspect background processes.", error);
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  /** Visible for tests: folds one process table into the tracked state. */
  applySnapshot(snapshot: ProcessTableSnapshot): void {
    const tolerance = snapshot.startTimeToleranceMs;
    const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
    const touched = new Set<string>();

    // 1. Running processes: refresh metrics, or notice that they ended (or that their PID was reused).
    for (const tracked of [...this.tracked.values()]) {
      if (tracked.record.status === "exited") continue;
      const entry = byPid.get(tracked.record.pid);
      if (tracked.child) {
        // BuildWarden started this one; its exit event is authoritative.
        if (entry) this.updateMetrics(tracked, entry, snapshot);
        continue;
      }
      if (!entry || Math.abs(entry.startedAtMs - tracked.startedAtMs) > tolerance) {
        this.markExited(tracked, snapshot.takenAtMs, null);
      } else {
        this.updateMetrics(tracked, entry, snapshot);
      }
      touched.add(tracked.ownerKey);
    }

    // 2. Spawns that workers reported.
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const pending = this.pending[index]!;
      const entry = byPid.get(pending.pid);
      const matches = entry && entry.startedAtMs <= pending.spawnedAtMs + tolerance && entry.startedAtMs >= pending.spawnedAtMs - 10_000;
      if (entry && matches) {
        this.pending.splice(index, 1);
        if (this.findAlive(pending.pid)) continue;
        if (IGNORED_PROCESS_NAMES.has(entry.name.toLowerCase())) continue;
        // Some SDKs spawn the agent CLI themselves and cannot mark it; recognise it by its executable.
        const role = pending.role === "agent" || looksLikeAgentProcess(entry) ? "agent" : "command";
        const tracked = this.track(entry, pending.owner, role, null, pending.cwd, snapshot);
        touched.add(tracked.ownerKey);
      } else if (snapshot.takenAtMs - pending.registeredAtMs > PENDING_SPAWN_TTL_MS) {
        this.pending.splice(index, 1);
        // Never seen alive, but a short-lived shell may still have left children behind.
        this.rememberFormerParent(pending.pid, {
          owner: pending.owner, processId: null, role: pending.role, startedAtMs: pending.spawnedAtMs, endedAtMs: snapshot.takenAtMs, cwd: pending.cwd,
        });
      }
    }
    for (const [pid, former] of this.formerParents) {
      if (snapshot.takenAtMs - former.endedAtMs > RECENT_EXIT_RETENTION_MS) this.formerParents.delete(pid);
    }

    // 3. Descendants, oldest first so a whole new subtree is picked up in one pass. Once seen, a
    // process stays tracked even after its parent exits and the operating system forgets the link.
    const alive = new Map<number, TrackedProcess>();
    for (const tracked of this.tracked.values()) if (tracked.record.status !== "exited") alive.set(tracked.record.pid, tracked);
    const agentWindows = this.agentWindows(snapshot.takenAtMs);
    const childrenByPpid = new Map<number, ProcessTableEntry[]>();
    for (const entry of snapshot.processes) {
      const list = childrenByPpid.get(entry.ppid) ?? [];
      list.push(entry);
      childrenByPpid.set(entry.ppid, list);
    }
    for (const entry of [...snapshot.processes].sort((left, right) => left.startedAtMs - right.startedAtMs)) {
      if (alive.has(entry.pid) || entry.pid === entry.ppid) continue;
      if (IGNORED_PROCESS_NAMES.has(entry.name.toLowerCase())) continue;
      const parent = alive.get(entry.ppid);
      let tracked: TrackedProcess | null = null;
      if (parent) {
        // A child cannot be older than its parent; otherwise the parent PID was reused.
        if (entry.startedAtMs + tolerance < parent.startedAtMs) continue;
        const role = this.inferChildRole(parent, entry);
        tracked = this.track(entry, parent.record.owner, role, parent.record.processId, this.ownerCwds.get(parent.ownerKey) ?? null, snapshot);
      } else if (this.isOrphan(entry, byPid, tolerance)) {
        // The parent is gone. Shells that background a server and exit at once often vanish
        // between two snapshots, so the link has to be recovered another way.
        tracked = this.adoptOrphan(entry, snapshot, tolerance, agentWindows, childrenByPpid);
      }
      if (!tracked) continue;
      alive.set(entry.pid, tracked);
      touched.add(tracked.ownerKey);
    }

    for (const key of touched) this.pruneExited(key);
    for (const key of touched) {
      const owner = this.ownerFromKey(key);
      if (owner) this.emit(key, owner);
    }
  }

  private inferChildRole(parent: TrackedProcess, entry: ProcessTableEntry): OwnedProcessRecord["role"] {
    if (parent.record.role !== "agent") return "command";
    if (looksLikeAgentProcess(entry)) return "agent";
    const launcherChild = isLauncher(parent.record.name) && entry.startedAtMs - parent.startedAtMs <= LAUNCHER_CHILD_WINDOW_MS
      && ![...this.tracked.values()].some((other) => other.record.parentProcessId === parent.record.processId && other.record.role === "agent");
    return launcherChild ? "agent" : "command";
  }

  private rememberFormerParent(pid: number, former: FormerParent): void {
    this.formerParents.set(pid, former);
  }

  /** Whether the process's parent is gone: absent, or its PID now belongs to a younger process. */
  private isOrphan(entry: ProcessTableEntry, byPid: Map<number, ProcessTableEntry>, tolerance: number): boolean {
    const holder = byPid.get(entry.ppid);
    return !holder || holder.startedAtMs > entry.startedAtMs + tolerance;
  }

  /** Periods during which an owner's agent ran, with the owner's workspace path spellings. */
  private agentWindows(nowMs: number): Array<{ owner: OwnedProcessOwner; cwd: string; forms: string[]; startedAtMs: number; endedAtMs: number }> {
    const windows: Array<{ owner: OwnedProcessOwner; cwd: string | null; startedAtMs: number; endedAtMs: number }> = [];
    for (const tracked of this.tracked.values()) {
      if (tracked.record.role !== "agent" || tracked.record.status === "exited") continue;
      windows.push({ owner: tracked.record.owner, cwd: this.ownerCwds.get(tracked.ownerKey) ?? tracked.record.cwd, startedAtMs: tracked.startedAtMs, endedAtMs: nowMs });
    }
    for (const former of this.formerParents.values()) {
      if (former.role === "agent") windows.push({ owner: former.owner, cwd: former.cwd, startedAtMs: former.startedAtMs, endedAtMs: former.endedAtMs });
    }
    return windows
      .flatMap((window) => window.cwd ? [{ ...window, cwd: window.cwd, forms: workspacePathForms(window.cwd) }] : [])
      .filter((window) => window.forms.length > 0)
      // The most recent agent wins when several owners share a workspace.
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  private formerParentFor(entry: ProcessTableEntry, tolerance: number): FormerParent | null {
    const unseenSpawn = this.pending.find((pending) => pending.pid === entry.ppid);
    const candidates: FormerParent[] = [
      ...(unseenSpawn ? [{
        owner: unseenSpawn.owner, processId: null, role: unseenSpawn.role, startedAtMs: unseenSpawn.spawnedAtMs, endedAtMs: Number.POSITIVE_INFINITY, cwd: unseenSpawn.cwd,
      }] : []),
      ...(this.formerParents.has(entry.ppid) ? [this.formerParents.get(entry.ppid)!] : []),
    ];
    // The child must have been born while that parent lived.
    return candidates.find((candidate) =>
      entry.startedAtMs + tolerance >= candidate.startedAtMs && entry.startedAtMs - tolerance <= candidate.endedAtMs) ?? null;
  }

  private adoptOrphan(
    entry: ProcessTableEntry,
    snapshot: ProcessTableSnapshot,
    tolerance: number,
    agentWindows: ReturnType<OwnedProcessRegistry["agentWindows"]>,
    childrenByPpid: Map<number, ProcessTableEntry[]>,
  ): TrackedProcess | null {
    const former = this.formerParentFor(entry, tolerance);
    if (former) {
      const role = former.role === "agent" && looksLikeAgentProcess(entry) ? "agent" : "command";
      const parentId = former.processId && this.tracked.has(former.processId) ? former.processId : null;
      return this.track(entry, former.owner, role, parentId, former.cwd, snapshot);
    }
    // A parent nobody saw: claim the tree only with evidence, i.e. it started while an owner's
    // agent ran and a command line in it points into that owner's workspace.
    for (const window of agentWindows) {
      if (entry.startedAtMs + tolerance < window.startedAtMs || entry.startedAtMs - tolerance > window.endedAtMs) continue;
      if (!this.subtreeMentions(entry, window.forms, childrenByPpid)) continue;
      return this.track(entry, window.owner, "command", null, window.cwd, snapshot, "workspace");
    }
    return null;
  }

  private subtreeMentions(root: ProcessTableEntry, forms: string[], childrenByPpid: Map<number, ProcessTableEntry[]>): boolean {
    const queue = [root];
    const seen = new Set<number>();
    while (queue.length > 0 && seen.size < MAX_EVIDENCE_PROCESSES) {
      const entry = queue.shift()!;
      if (seen.has(entry.pid)) continue;
      seen.add(entry.pid);
      if (commandLineMentionsPath(entry.commandLine, forms)) return true;
      // Only real children: a child older than its parent belongs to a reused PID.
      for (const child of childrenByPpid.get(entry.pid) ?? []) {
        if (child.startedAtMs >= entry.startedAtMs) queue.push(child);
      }
    }
    return false;
  }

  private findAlive(pid: number): TrackedProcess | undefined {
    for (const tracked of this.tracked.values()) {
      if (tracked.record.pid === pid && tracked.record.status !== "exited") return tracked;
    }
    return undefined;
  }

  private track(
    entry: ProcessTableEntry,
    owner: OwnedProcessOwner,
    role: OwnedProcessRecord["role"],
    parentId: string | null,
    cwd: string | null,
    snapshot: ProcessTableSnapshot,
    attribution: OwnedProcessRecord["attribution"] = "tree",
  ): TrackedProcess {
    const argv = this.reader?.readArgv?.(entry.pid) ?? entry.argv;
    const startedAtMs = entry.startedAtMs || snapshot.takenAtMs;
    const record: OwnedProcessRecord = {
      processId: `${String(entry.pid)}-${String(startedAtMs)}`,
      pid: entry.pid,
      parentProcessId: parentId,
      owner,
      role,
      attribution,
      name: entry.name || basename(commandLineHead(entry.commandLine, 1)[0] ?? "") || `PID ${String(entry.pid)}`,
      commandLine: entry.commandLine,
      cwd,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      status: "running",
      endReason: null,
      exitCode: null,
      cpuPercent: null,
      memoryBytes: entry.memoryBytes,
      ports: [...(snapshot.ports?.get(entry.pid) ?? [])],
      restartOfProcessId: null,
      restartable: false,
      hasOutput: false,
    };
    const tracked: TrackedProcess = {
      record,
      ownerKey: ownedProcessOwnerKey(owner),
      startedAtMs,
      argv,
      lastCpuTimeMs: entry.cpuTimeMs,
      lastSampleAtMs: snapshot.takenAtMs,
      stopRequest: null,
      output: null,
      child: null,
    };
    record.restartable = this.canRestart(tracked);
    this.tracked.set(record.processId, tracked);
    return tracked;
  }

  private canRestart(tracked: TrackedProcess): boolean {
    if (!this.options.spawnCommand || tracked.record.role === "agent" || !tracked.record.commandLine || !tracked.record.cwd) return false;
    if (this.options.platform === "win32") return true;
    return this.options.platform === "linux" && Boolean(tracked.argv?.length);
  }

  private updateMetrics(tracked: TrackedProcess, entry: ProcessTableEntry, snapshot: ProcessTableSnapshot): void {
    const record = tracked.record;
    record.memoryBytes = entry.memoryBytes;
    if (entry.cpuPercent !== null) {
      record.cpuPercent = entry.cpuPercent / Math.max(1, this.options.cpuCount);
    } else if (entry.cpuTimeMs !== null && tracked.lastCpuTimeMs !== null && tracked.lastSampleAtMs !== null) {
      const elapsed = snapshot.takenAtMs - tracked.lastSampleAtMs;
      record.cpuPercent = elapsed > 0
        ? Math.max(0, Math.min(100, ((entry.cpuTimeMs - tracked.lastCpuTimeMs) / (elapsed * Math.max(1, this.options.cpuCount))) * 100))
        : record.cpuPercent;
    }
    tracked.lastCpuTimeMs = entry.cpuTimeMs;
    tracked.lastSampleAtMs = snapshot.takenAtMs;
    if (snapshot.ports) record.ports = [...(snapshot.ports.get(entry.pid) ?? [])];
    if (!record.commandLine && entry.commandLine) {
      record.commandLine = entry.commandLine;
      record.restartable = this.canRestart(tracked);
    }
  }

  private markExited(tracked: TrackedProcess, atMs: number, exitCode: number | null): void {
    const record = tracked.record;
    if (record.status === "exited") return;
    // Children it started just before exiting may only show up in the next snapshot.
    this.rememberFormerParent(record.pid, {
      owner: record.owner,
      processId: record.role === "agent" ? null : record.processId,
      role: record.role,
      startedAtMs: tracked.startedAtMs,
      endedAtMs: atMs,
      cwd: record.cwd ?? this.ownerCwds.get(tracked.ownerKey) ?? null,
    });
    // An agent that finished its turn is noise once gone; its children stay listed on their own.
    if (record.role === "agent") {
      this.tracked.delete(record.processId);
      return;
    }
    record.status = "exited";
    record.endedAt = new Date(atMs).toISOString();
    record.endReason = tracked.stopRequest ?? "exited";
    record.exitCode = exitCode;
    record.cpuPercent = null;
    record.ports = [];
  }

  private pruneExited(key: string): void {
    const exited = [...this.tracked.values()]
      .filter((tracked) => tracked.ownerKey === key && tracked.record.status === "exited")
      .sort((left, right) => Date.parse(left.record.endedAt ?? "") - Date.parse(right.record.endedAt ?? ""));
    for (const tracked of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_PER_OWNER))) this.tracked.delete(tracked.record.processId);
  }

  private async terminate(targets: TrackedProcess[], force: boolean): Promise<void> {
    if (targets.length === 0) return;
    // Re-check identities first so a reused PID is never signalled.
    await this.refresh();
    const live = targets.filter((tracked) => tracked.record.status !== "exited");
    if (live.length === 0) return;
    const owners = new Map<string, OwnedProcessOwner>();
    for (const tracked of live) {
      tracked.stopRequest = force ? "killed" : "stopped";
      tracked.record.status = "stopping";
      owners.set(tracked.ownerKey, tracked.record.owner);
    }
    for (const [key, owner] of owners) this.emit(key, owner);

    const { terminator } = this.options;
    const pids = live.map((tracked) => tracked.record.pid);
    if (!force) {
      const delivered = await terminator.requestExit(pids);
      if (delivered) await this.waitUntil(() => pids.every((pid) => !terminator.isAlive(pid)), this.gracefulStopMs);
    }
    const remaining = live.filter((tracked) => terminator.isAlive(tracked.record.pid));
    if (remaining.length > 0) {
      for (const tracked of remaining) tracked.stopRequest = "killed";
      await terminator.forceExit(remaining.map((tracked) => tracked.record.pid));
      await this.waitUntil(() => remaining.every((tracked) => !terminator.isAlive(tracked.record.pid)), 3_000);
    }
    const endedAt = this.now();
    for (const tracked of live) {
      if (!terminator.isAlive(tracked.record.pid) && !tracked.child) this.markExited(tracked, endedAt, null);
      else if (terminator.isAlive(tracked.record.pid)) tracked.record.status = "running";
    }
    for (const [key, owner] of owners) this.emit(key, owner);
    await this.refresh();
  }

  private async restart(tracked: TrackedProcess): Promise<void> {
    const { record } = tracked;
    const spawnCommand = this.options.spawnCommand;
    if (!spawnCommand || !record.restartable || !record.commandLine || !record.cwd) {
      throw new Error("BuildWarden cannot start this command again.");
    }
    if (!this.pathExists(record.cwd)) throw new Error("The workspace folder no longer exists.");
    const commandLine = record.commandLine;
    const argv = tracked.argv;
    const cwd = record.cwd;
    if (record.status !== "exited") await this.terminate(this.subtree(tracked), false);

    const child = spawnCommand({ commandLine, argv, cwd });
    if (typeof child.pid !== "number") {
      child.on("error", () => undefined);
      throw new Error("The command could not be started again.");
    }
    const startedAtMs = this.now();
    const replacement: TrackedProcess = {
      record: {
        ...record,
        processId: `${String(child.pid)}-${String(startedAtMs)}`,
        pid: child.pid,
        parentProcessId: null,
        role: "restarted",
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: null,
        status: "running",
        endReason: null,
        exitCode: null,
        cpuPercent: null,
        memoryBytes: null,
        ports: [],
        restartOfProcessId: record.processId,
        // BuildWarden started this one itself.
        attribution: "tree",
        restartable: true,
        hasOutput: true,
      },
      ownerKey: tracked.ownerKey,
      startedAtMs,
      argv,
      lastCpuTimeMs: null,
      lastSampleAtMs: null,
      stopRequest: null,
      output: { text: "", truncated: false },
      child,
    };
    const append = (chunk: Buffer | string) => {
      const output = replacement.output!;
      output.text += chunk.toString();
      if (output.text.length > OUTPUT_LIMIT_CHARS) {
        output.text = output.text.slice(output.text.length - OUTPUT_LIMIT_CHARS);
        output.truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => append(`\n${error.message}\n`));
    child.on("exit", (code) => {
      replacement.child = null;
      this.markExited(replacement, this.now(), code);
      this.emit(replacement.ownerKey, replacement.record.owner);
    });
    this.tracked.set(replacement.record.processId, replacement);
    this.emit(replacement.ownerKey, replacement.record.owner);
    this.requestPoll(FIRST_POLL_DELAY_MS);
  }

  private async waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (!condition() && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private ownerFromKey(key: string): OwnedProcessOwner | null {
    for (const tracked of this.tracked.values()) if (tracked.ownerKey === key) return tracked.record.owner;
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    return kind === "run" || kind === "chat" ? { kind, id: key.slice(separator + 1) } : null;
  }

  private emit(key: string, owner: OwnedProcessOwner): void {
    const snapshot = this.getSnapshot(owner);
    const signature = JSON.stringify(snapshot.processes);
    if (this.lastEmitted.get(key) === signature) return;
    this.lastEmitted.set(key, signature);
    this.options.onChange(snapshot);
  }
}
