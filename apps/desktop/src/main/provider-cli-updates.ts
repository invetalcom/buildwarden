import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_CLI_LABELS,
  compareProviderCliVersions,
  isProviderCliUpdateAttentionId,
  providerCliUpdateAttentionId,
  type AttentionItem,
  type ProviderCliReleaseChannel,
  type ProviderCliUpdateProviderType,
  type ProviderCliUpdateSettings,
  type ProviderCliUpdateSnapshot,
  type ProviderCliUpdateStatus,
} from "@buildwarden/shared";
import {
  PROVIDER_CLI_DEFINITIONS,
  parseLatestProviderCliVersion,
  parseProviderCliVersion,
  resolveProviderCliCommandPath,
  resolveProviderCliInstallPlan,
  withExecutableDirOnPath,
  type ProviderCliCommand,
  type ProviderCliFileProbe,
  type ProviderCliInstallPlan,
} from "./provider-cli-install";

const FIRST_CHECK_DELAY_MS = 30_000;
const ENABLE_CHECK_DELAY_MS = 1_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 8_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1_000;
const REMEMBERED_VERSION_LIMIT = 50;

/** A configured provider account whose CLI should be checked. */
export interface ProviderCliTarget {
  providerType: ProviderCliUpdateProviderType;
  /** Configured or default executable; may be a bare command name. */
  binaryPath: string;
  /** Extra environment the CLI runs with (for example `CODEX_HOME`). */
  env?: NodeJS.ProcessEnv;
  /** npm dist-tag to compare against and install; defaults to `latest`. */
  releaseChannel?: ProviderCliReleaseChannel;
}

export interface ProviderCliProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface ProviderCliUpdateServiceDeps {
  readSettings(): ProviderCliUpdateSettings;
  readState(): string | undefined;
  writeState(value: string): void;
  listTargets(): ProviderCliTarget[];
  isProviderInUse(providerType: ProviderCliUpdateProviderType): boolean;
  /** Network access; only called while checks are enabled. */
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  /** Environment for updater processes, including the app proxy. */
  resolveUpdateEnv(): Promise<NodeJS.ProcessEnv>;
  runProcess(command: ProviderCliCommand, options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProviderCliProcessResult>;
  realPath(path: string): string;
  probe: ProviderCliFileProbe;
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  now(): Date;
  onChange(snapshot: ProviderCliUpdateSnapshot): void;
  onUpdateAvailable(status: ProviderCliUpdateStatus): void;
  onProviderUpdated(providerType: ProviderCliUpdateProviderType): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

/** Background checks may notify; manual checks show their result where the user is already looking. */
export type ProviderCliCheckSource = "background" | "manual";

interface PersistedState {
  dismissed: string[];
  /** Versions a background check announced with notifications on. */
  announced: string[];
}

interface ResolvedTarget {
  target: ProviderCliTarget;
  commandPath: string | null;
  plan: ProviderCliInstallPlan | null;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lastOutputLine = (output: string): string =>
  output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";

const remember = (values: string[], value: string): string[] =>
  [...values.filter((entry) => entry !== value), value].slice(-REMEMBERED_VERSION_LIMIT);

/**
 * Opt-in provider CLI update checks. While disabled it makes no network requests,
 * spawns no processes, and reports no statuses.
 */
export class ProviderCliUpdateService {
  private statuses = new Map<ProviderCliUpdateProviderType, ProviderCliUpdateStatus>();
  private plans = new Map<ProviderCliUpdateProviderType, ResolvedTarget>();
  private checking: Promise<ProviderCliUpdateSnapshot> | null = null;
  private checkAbort: AbortController | null = null;
  private readonly updating = new Set<ProviderCliUpdateProviderType>();
  private lastCheckedAt: string | null = null;
  private firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private wasEnabled = false;
  private lastUsage = "";
  private checkSource: ProviderCliCheckSource = "manual";

  constructor(private readonly deps: ProviderCliUpdateServiceDeps) {}

  /** Starts the background schedule; the first check waits so startup stays quiet. */
  start(): void {
    this.started = true;
    this.wasEnabled = this.settings().enabled;
    this.syncSchedule(FIRST_CHECK_DELAY_MS, false, "background");
  }

  /** Re-reads the toggle after the setting changed. */
  applySettings(): void {
    const enabled = this.settings().enabled;
    const turnedOn = enabled && !this.wasEnabled;
    this.wasEnabled = enabled;
    if (!enabled) {
      this.checkAbort?.abort();
      this.statuses.clear();
      this.plans.clear();
      this.lastCheckedAt = null;
    }
    // The check right after enabling shows its result in the open settings card, so it counts as manual.
    if (this.started) {
      this.syncSchedule(turnedOn ? ENABLE_CHECK_DELAY_MS : FIRST_CHECK_DELAY_MS, turnedOn, turnedOn ? "manual" : "background");
    }
    this.emit();
  }

  dispose(): void {
    this.started = false;
    this.clearTimers();
    this.checkAbort?.abort();
  }

  getSnapshot(): ProviderCliUpdateSnapshot {
    const settings = this.settings();
    if (!settings.enabled) {
      return { enabled: false, notify: settings.notify, checking: false, lastCheckedAt: null, providers: [] };
    }
    const state = this.readState();
    const dismissed = new Set(state.dismissed);
    const announced = new Set(state.announced);
    return {
      enabled: true,
      notify: settings.notify,
      checking: this.checking !== null,
      lastCheckedAt: this.lastCheckedAt,
      providers: [...this.statuses.values()].map((status) => ({
        ...status,
        inUse: this.deps.isProviderInUse(status.providerType),
        dismissed: status.latestVersion !== null && dismissed.has(providerCliUpdateAttentionId(status.providerType, status.latestVersion)),
        announced: status.latestVersion !== null && announced.has(providerCliUpdateAttentionId(status.providerType, status.latestVersion)),
      })),
    };
  }

  isUpdating(providerType: ProviderCliUpdateProviderType): boolean {
    return this.updating.has(providerType);
  }

  /** Publishes a fresh snapshot when a run or chat starts or stops using a checked CLI. */
  refreshUsage(): void {
    if (!this.settings().enabled || this.statuses.size === 0) return;
    const usage = [...this.statuses.keys()].map((providerType) => `${providerType}:${this.deps.isProviderInUse(providerType)}`).join(",");
    if (usage === this.lastUsage) return;
    this.lastUsage = usage;
    this.emit();
  }

  check(source: ProviderCliCheckSource = "manual"): Promise<ProviderCliUpdateSnapshot> {
    if (!this.settings().enabled) {
      return Promise.reject(new Error("Provider CLI update checks are turned off in Settings › Network."));
    }
    if (this.checking) {
      // A manual request joining a background check means the user is watching the result.
      if (source === "manual") this.checkSource = "manual";
    } else {
      this.checkSource = source;
      this.checking = this.runCheck().finally(() => {
        this.checking = null;
        this.checkAbort = null;
        this.emit();
      });
    }
    this.emit();
    return this.checking;
  }

  async update(providerType: ProviderCliUpdateProviderType): Promise<ProviderCliUpdateSnapshot> {
    if (!this.settings().enabled) {
      throw new Error("Provider CLI updates are turned off in Settings › Network.");
    }
    const label = PROVIDER_CLI_LABELS[providerType];
    // Before the state check: a running update has already moved the state to "updating".
    if (this.updating.has(providerType)) {
      throw new Error(`An update is already running for ${label}.`);
    }
    const status = this.statuses.get(providerType);
    const resolved = this.plans.get(providerType);
    if (status?.state === "checking") {
      throw new Error(`A check for ${label} is running. Try again once it finishes.`);
    }
    if (status?.state === "current") {
      throw new Error(`${label} is already up to date.`);
    }
    if (!status || status.state !== "update-available" || !resolved?.commandPath || !resolved.plan) {
      throw new Error(`Check for updates before updating ${label}.`);
    }
    if (this.deps.isProviderInUse(providerType)) {
      throw new Error(`${label} is in use by an active run or chat. Update it once they finish.`);
    }
    // Re-read ownership right before running: the install may have moved since the check.
    const current = this.resolveTarget(resolved.target);
    if (!current.plan || current.plan.lockKey !== resolved.plan.lockKey) {
      throw new Error(`The ${label} installation changed since the last check. Check again before updating.`);
    }
    if (!current.plan.command) {
      throw new Error(current.plan.manualReason ?? `${label} must be updated manually.`);
    }

    this.updating.add(providerType);
    this.setStatus({ ...status, state: "updating", message: `Running ${current.plan.displayCommand ?? "the updater"}…` });
    try {
      const command = this.resolveExecutable(current.plan.command);
      const baseEnv = { ...(await this.deps.resolveUpdateEnv()), ...resolved.target.env };
      const result = await this.deps.runProcess(command, {
        env: withExecutableDirOnPath(baseEnv, command.file, this.deps.platform),
        timeoutMs: UPDATE_TIMEOUT_MS,
      });
      if (result.timedOut) throw new Error("The updater did not finish within 10 minutes.");
      if (result.code !== 0) {
        throw new Error(lastOutputLine(result.output) || `The updater exited with code ${String(result.code)}.`);
      }
      const installedVersion = await this.probeVersion(current);
      const latestVersion = status.latestVersion;
      const updated = installedVersion !== null && latestVersion !== null && compareProviderCliVersions(installedVersion, latestVersion) >= 0;
      this.setStatus({
        ...status,
        installedVersion: installedVersion ?? status.installedVersion,
        state: updated ? "current" : "update-available",
        message: updated
          ? `Updated to v${installedVersion}.`
          : current.plan.method === "homebrew"
            ? `Homebrew has not published v${latestVersion ?? "?"} yet. Try again later.`
            : `The updater finished, but ${label} still reports v${installedVersion ?? "unknown"}.`,
        checkedAt: this.deps.now().toISOString(),
      });
      if (updated) this.deps.onProviderUpdated(providerType);
    } catch (error) {
      this.setStatus({ ...status, state: "update-available", message: `Update failed: ${errorMessage(error)}` });
      throw new Error(`${label} update failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      this.updating.delete(providerType);
      this.emit();
    }
    return this.getSnapshot();
  }

  attentionItems(): AttentionItem[] {
    if (!this.settings().enabled) return [];
    const dismissed = new Set(this.readState().dismissed);
    return [...this.statuses.values()].flatMap((status) => {
      if (status.state !== "update-available" || !status.latestVersion) return [];
      const id = providerCliUpdateAttentionId(status.providerType, status.latestVersion);
      if (dismissed.has(id)) return [];
      const from = status.installedVersion ? `v${status.installedVersion} → ` : "";
      return [{
        id,
        kind: "update" as const,
        projectId: null,
        projectName: null,
        runId: null,
        title: `${status.label} ${from}v${status.latestVersion}`,
        detail: status.canAutoUpdate
          ? "A newer CLI version is available. Update it here or in Settings › Network."
          : `${status.manualReason ?? "Update it manually."}${status.updateCommand ? ` ${status.updateCommand}` : ""}`,
        createdAt: status.checkedAt ?? this.deps.now().toISOString(),
        dismissible: true,
        providerUpdate: {
          providerType: status.providerType,
          latestVersion: status.latestVersion,
          canAutoUpdate: status.canAutoUpdate,
          inUse: this.deps.isProviderInUse(status.providerType),
        },
      }];
    });
  }

  /** Hides update notices; returns the IDs that did not belong to this service. */
  dismiss(ids: readonly string[]): string[] {
    const own = ids.filter(isProviderCliUpdateAttentionId);
    if (own.length) {
      const state = this.readState();
      this.writeState({ ...state, dismissed: own.reduce(remember, state.dismissed) });
      this.emit();
    }
    return ids.filter((id) => !isProviderCliUpdateAttentionId(id));
  }

  private async runCheck(): Promise<ProviderCliUpdateSnapshot> {
    const abort = new AbortController();
    this.checkAbort = abort;
    const targets = new Map<ProviderCliUpdateProviderType, ProviderCliTarget>();
    for (const target of this.deps.listTargets()) {
      if (!targets.has(target.providerType)) targets.set(target.providerType, target);
    }
    for (const providerType of [...this.statuses.keys()]) {
      if (!targets.has(providerType)) {
        this.statuses.delete(providerType);
        this.plans.delete(providerType);
      }
    }

    await Promise.all([...targets.values()].map(async (target) => {
      const previous = this.statuses.get(target.providerType);
      if (this.updating.has(target.providerType)) return;
      this.setStatus(previous ? { ...previous, state: "checking" } : this.emptyStatus(target.providerType, "checking"), false);
      const status = await this.checkTarget(target, abort.signal);
      if (abort.signal.aborted || !this.settings().enabled) return;
      this.setStatus(status, false);
    }));

    if (abort.signal.aborted || !this.settings().enabled) return this.getSnapshot();
    this.lastCheckedAt = this.deps.now().toISOString();
    this.announceNewVersions(this.checkSource);
    return this.getSnapshot();
  }

  private async checkTarget(target: ProviderCliTarget, signal: AbortSignal): Promise<ProviderCliUpdateStatus> {
    const checkedAt = this.deps.now().toISOString();
    const base = this.emptyStatus(target.providerType, "unknown");
    const resolved = this.resolveTarget(target);
    this.plans.set(target.providerType, resolved);
    if (!resolved.commandPath || !resolved.plan) {
      return { ...base, binaryPath: target.binaryPath, state: "not-installed", message: `${target.binaryPath} was not found.`, checkedAt };
    }
    const plan = resolved.plan;
    const withPlan: ProviderCliUpdateStatus = {
      ...base,
      binaryPath: resolved.commandPath,
      releaseChannel: target.releaseChannel ?? "latest",
      installMethod: plan.method,
      updateCommand: plan.displayCommand,
      canAutoUpdate: plan.command !== null,
      manualReason: plan.manualReason,
      checkedAt,
    };
    const [installed, latest] = await Promise.allSettled([this.probeVersion(resolved), this.fetchLatestVersion(target, signal)]);
    const installedVersion = installed.status === "fulfilled" ? installed.value : null;
    const latestVersion = latest.status === "fulfilled" ? latest.value : null;
    if (installed.status === "rejected" || latest.status === "rejected") {
      const failure = installed.status === "rejected" ? installed.reason : latest.status === "rejected" ? latest.reason : null;
      return { ...withPlan, installedVersion, latestVersion, state: "error", message: errorMessage(failure) };
    }
    if (!installedVersion || !latestVersion) {
      return {
        ...withPlan, installedVersion, latestVersion, state: "unknown",
        message: installedVersion ? "Could not read the latest published version." : "Could not read the installed version.",
      };
    }
    const behind = compareProviderCliVersions(installedVersion, latestVersion) < 0;
    return { ...withPlan, installedVersion, latestVersion, state: behind ? "update-available" : "current", message: null };
  }

  private resolveTarget(target: ProviderCliTarget): ResolvedTarget {
    const commandPath = resolveProviderCliCommandPath(target.binaryPath, {
      platform: this.deps.platform,
      env: this.deps.env,
      homeDir: this.deps.homeDir,
      exists: this.deps.probe.exists,
    });
    if (!commandPath) return { target, commandPath: null, plan: null };
    let realPath = commandPath;
    try {
      realPath = this.deps.realPath(commandPath);
    } catch (error) {
      this.deps.warn("Could not resolve the provider CLI real path; using the command path.", { commandPath, error });
    }
    const plan = resolveProviderCliInstallPlan({
      providerType: target.providerType,
      releaseChannel: target.releaseChannel,
      commandPath,
      realPath,
      platform: this.deps.platform,
      homeDir: this.deps.homeDir,
      env: this.deps.env,
      probe: this.deps.probe,
    });
    return { target, commandPath, plan };
  }

  /** Bare package-manager names (`npm`, `pnpm`) are resolved like a shell would. */
  private resolveExecutable(command: ProviderCliCommand): ProviderCliCommand {
    if (/[\\/]/.test(command.file)) return command;
    const file = resolveProviderCliCommandPath(command.file, {
      platform: this.deps.platform,
      env: this.deps.env,
      homeDir: this.deps.homeDir,
      exists: this.deps.probe.exists,
    });
    if (!file) throw new Error(`${command.file} was not found on PATH.`);
    return { ...command, file };
  }

  private async probeVersion(resolved: ResolvedTarget): Promise<string | null> {
    if (!resolved.commandPath) return null;
    // Desktop launches on macOS and Linux get a minimal PATH; npm-style CLIs (`#!/usr/bin/env node`)
    // need the Node that sits beside them, exactly as the updater does.
    const env = withExecutableDirOnPath({ ...this.deps.env, ...resolved.target.env }, resolved.commandPath, this.deps.platform);
    const result = await this.deps.runProcess({ file: resolved.commandPath, args: ["--version"] }, { env, timeoutMs: VERSION_PROBE_TIMEOUT_MS });
    if (result.timedOut) throw new Error("The version check timed out.");
    if (result.code !== 0) throw new Error(lastOutputLine(result.output) || `--version exited with code ${String(result.code)}.`);
    return parseProviderCliVersion(resolved.target.providerType, result.output);
  }

  private async fetchLatestVersion(target: ProviderCliTarget, signal: AbortSignal): Promise<string | null> {
    const { providerType } = target;
    const timeout = AbortSignal.timeout(LATEST_VERSION_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const body = await this.deps.fetchText(PROVIDER_CLI_DEFINITIONS[providerType].latestVersionUrl(target.releaseChannel ?? "latest"), combined);
      return parseLatestProviderCliVersion(providerType, body);
    } catch (error) {
      if (timeout.aborted) throw new Error("The release feed did not respond in time.", { cause: error });
      throw new Error(`Could not reach the release feed: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Each version is announced once, by the first background check that finds it while
   * notifications are on. Manual checks never announce or mark anything, so a version
   * first seen through "Check now" is still announced by the next background check.
   */
  private announceNewVersions(source: ProviderCliCheckSource): void {
    if (source !== "background" || !this.settings().notify) return;
    const state = this.readState();
    const dismissed = new Set(state.dismissed);
    let announced = state.announced;
    for (const status of this.statuses.values()) {
      if (status.state !== "update-available" || !status.latestVersion) continue;
      const id = providerCliUpdateAttentionId(status.providerType, status.latestVersion);
      if (announced.includes(id) || dismissed.has(id)) continue;
      announced = remember(announced, id);
      try {
        this.deps.onUpdateAvailable(status);
      } catch (error) {
        this.deps.warn("Could not show the provider CLI update notification.", { providerType: status.providerType, error });
      }
    }
    if (announced !== state.announced) this.writeState({ ...state, announced });
  }

  private syncSchedule(firstDelayMs: number, restartFirstCheck: boolean, firstCheckSource: ProviderCliCheckSource): void {
    if (!this.settings().enabled) {
      this.clearTimers();
      return;
    }
    if (restartFirstCheck && this.firstCheckTimer) {
      clearTimeout(this.firstCheckTimer);
      this.firstCheckTimer = null;
    }
    if (!this.firstCheckTimer && (restartFirstCheck || !this.intervalTimer)) {
      this.firstCheckTimer = setTimeout(() => {
        this.firstCheckTimer = null;
        void this.scheduledCheck(firstCheckSource);
      }, firstDelayMs);
    }
    this.intervalTimer ??= setInterval(() => void this.scheduledCheck("background"), CHECK_INTERVAL_MS);
  }

  private async scheduledCheck(source: ProviderCliCheckSource): Promise<void> {
    if (!this.settings().enabled) return;
    try {
      await this.check(source);
    } catch (error) {
      this.deps.warn("Background provider CLI update check failed.", { error });
    }
  }

  private clearTimers(): void {
    if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstCheckTimer = null;
    this.intervalTimer = null;
  }

  private emptyStatus(providerType: ProviderCliUpdateProviderType, state: ProviderCliUpdateStatus["state"]): ProviderCliUpdateStatus {
    return {
      providerType,
      label: PROVIDER_CLI_LABELS[providerType],
      binaryPath: null,
      installedVersion: null,
      latestVersion: null,
      releaseChannel: "latest",
      state,
      installMethod: "unknown",
      updateCommand: null,
      canAutoUpdate: false,
      manualReason: null,
      inUse: false,
      dismissed: false,
      announced: false,
      message: null,
      checkedAt: null,
    };
  }

  private setStatus(status: ProviderCliUpdateStatus, emit = true): void {
    this.statuses.set(status.providerType, status);
    if (emit) this.emit();
  }

  private emit(): void {
    try {
      this.deps.onChange(this.getSnapshot());
    } catch (error) {
      this.deps.warn("A provider CLI update listener failed.", { error });
    }
  }

  private settings(): ProviderCliUpdateSettings {
    return this.deps.readSettings();
  }

  private readState(): PersistedState {
    try {
      const parsed = JSON.parse(this.deps.readState() ?? "{}") as Partial<PersistedState>;
      const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
      // Older builds stored a `notified` list; it is ignored so pending versions still get announced.
      return { dismissed: strings(parsed.dismissed), announced: strings(parsed.announced) };
    } catch {
      return { dismissed: [], announced: [] };
    }
  }

  private writeState(state: PersistedState): void {
    this.deps.writeState(JSON.stringify(state));
  }
}

const MAX_PROCESS_OUTPUT_CHARS = 64 * 1_024;
const PROCESS_CLOSE_GRACE_MS = 5_000;

/** Windows command shims need cmd.exe; arguments are quoted and shell metacharacters rejected. */
export const resolveProviderCliProcessLaunch = (
  command: ProviderCliCommand,
  platform: NodeJS.Platform,
  comSpec = "cmd.exe",
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } => {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command.file)) {
    return { file: command.file, args: command.args };
  }
  const quote = (value: string): string => {
    if (/[\r\n"&|<>^%!]/.test(value)) {
      throw new Error("Provider CLI update arguments cannot contain Windows shell metacharacters.");
    }
    return `"${value}"`;
  };
  return {
    file: comSpec,
    args: ["/d", "/c", ["call", quote(command.file), ...command.args.map(quote)].join(" ")],
    windowsVerbatimArguments: true,
  };
};

export const spawnProviderCliProcess = (
  command: ProviderCliCommand,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProviderCliProcessResult> =>
  new Promise((resolve, reject) => {
    let launch: ReturnType<typeof resolveProviderCliProcessLaunch>;
    try {
      launch = resolveProviderCliProcessLaunch(command, process.platform, process.env.ComSpec || "cmd.exe");
    } catch (error) {
      reject(error);
      return;
    }
    const posix = process.platform !== "win32";
    const child = spawn(launch.file, launch.args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX, so a timeout can also end the helpers package managers start.
      ...(posix ? { detached: true } : {}),
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      settle();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Package managers spawn helpers; end the whole tree.
      if (!posix && child.pid !== undefined) {
        spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
      }
      child.kill();
      // A helper that escaped the tree can keep the pipes, and so `close`, open; stop waiting for it.
      forceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(() => resolve({ code: null, output, timedOut }));
      }, PROCESS_CLOSE_GRACE_MS);
    }, options.timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      finish(() => reject(new Error(`Could not start ${command.file} (${error.message}).`, { cause: error })));
    });
    child.on("close", (code) => {
      finish(() => resolve({ code, output, timedOut }));
    });
  });

/** Real filesystem checks. Windows `access(W_OK)` ignores ACLs, so writability is tested with a temp file. */
export const createProviderCliFileProbe = (platform: NodeJS.Platform = process.platform): ProviderCliFileProbe => ({
  exists: (path) => existsSync(path),
  isWritable: (dir) => {
    try {
      if (!statSync(dir).isDirectory()) return false;
      if (platform !== "win32") {
        accessSync(dir, constants.W_OK);
        return true;
      }
      const probePath = join(dir, `.buildwarden-write-check-${process.pid}-${randomUUID()}`);
      closeSync(openSync(probePath, "wx"));
      unlinkSync(probePath);
      return true;
    } catch {
      return false;
    }
  },
});
