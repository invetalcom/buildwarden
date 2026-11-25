import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeReleaseChannel, resolveClaudeCodeBinaryPath } from "@buildwarden/provider-claude-code/configuration";
import { resolveCodexCliExecutable } from "@buildwarden/provider-codex-cli/configuration";
import { getCursorAgentBinaryPath, getCursorAgentBinaryPathCandidates } from "@buildwarden/provider-cursor-agent/configuration";
import {
  APP_SETTING_KEYS,
  buildNetworkProxyUrl,
  effectiveHarnessCapabilities,
  type HarnessSessionCapabilities,
  isProviderCliUpdateProviderType,
  parseAcpCommandLine,
  parseAcpEnvironment,
  parseProjectRunDefaultsSetting,
  parseProviderCliUpdateSettings,
  parseSessionCapabilityReportsSetting,
  PROVIDER_CLI_LABELS,
  PROVIDER_CLI_UPDATE_PROVIDER_TYPES,
  PROVIDER_CONFIG_ACP_COMMAND_KEY,
  PROVIDER_CONFIG_ACP_ENV_KEY,
  type ProviderAccountInput,
  type ProviderAccountRecord,
  type ProviderAdapter,
  type ProviderCliUpdateSnapshot,
  type ProviderType,
  type SubscriptionLimitWindow,
} from "@buildwarden/shared";
import { executableFingerprint } from "../executable-fingerprint";
import { createProviderCliFileProbe, type ProviderCliTarget, ProviderCliUpdateService, spawnProviderCliProcess } from "../provider-cli-updates";
import { createProviderAdapter, loadProxyAwareFetch } from "../provider-modules";
import { AppService } from "./app-service";
import { parseProviderConfigJson, type ProviderLimitState } from "./provider-model-support";
import { firstNonEmptyLine } from "./run-step-content";

/** How long a provider's last session report keeps narrowing its capabilities. */
const SESSION_CAPABILITY_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a looked-up agent executable fingerprint is reused before the file is checked again. */
const EXECUTABLE_FINGERPRINT_TTL_MS = 30_000;

const COUNCIL_LIMIT_CHECK_TIMEOUT_MS = 4_000;

/** Knows the installed provider agents: adapters, versions, updates, limits and reported capabilities. */
export class ProviderRuntimeService extends AppService<"activeWorkers" | "providerAccounts" | "settings" | "usage"> {
  private readonly providerAdapters = new Map<ProviderAccountInput["providerType"], Promise<ProviderAdapter>>();

  getProviderAdapter(providerType: ProviderAccountInput["providerType"]): Promise<ProviderAdapter> {
    let pending = this.providerAdapters.get(providerType);
    if (!pending) {
      pending = createProviderAdapter(providerType).catch((error: unknown) => {
        this.providerAdapters.delete(providerType);
        throw error;
      });
      this.providerAdapters.set(providerType, pending);
    }
    return pending;
  }

  /** Latest session report per provider account, persisted so a restart keeps the narrowing. */
  private reportedSessionCapabilitiesCache: Map<string, HarnessSessionCapabilities> | null = null;
  /** The same reports per run, for the run's own delivery decisions. */
  readonly runSessionCapabilities = new Map<string, HarnessSessionCapabilities>();
  private readonly executableFingerprints = new Map<string, { checkedAt: number; fingerprint: string | null }>();
  providerCliUpdateServiceInstance: ProviderCliUpdateService | null = null;

  get providerCliUpdates(): ProviderCliUpdateService {
    this.providerCliUpdateServiceInstance ??= new ProviderCliUpdateService({
      readSettings: () => parseProviderCliUpdateSettings(this.db.getSettings()[APP_SETTING_KEYS.providerCliUpdates]),
      readState: () => this.db.getSettings()[APP_SETTING_KEYS.providerCliUpdateState],
      writeState: (value) => this.db.setSetting(APP_SETTING_KEYS.providerCliUpdateState, value),
      listTargets: () => this.listProviderCliTargets(),
      isProviderInUse: (providerType) =>
        (this.providerCliStartReservations.get(providerType) ?? 0) > 0 ||
        [...this.services.activeWorkers.runWorkers.values(), ...this.services.activeWorkers.chatWorkers.values()].some((active) => active.providerType === providerType),
      fetchText: async (url, signal) => {
        const proxyFetch = await loadProxyAwareFetch(await this.services.settings.resolveNetworkProxyRuntimeConfig()) ?? fetch;
        const response = await proxyFetch(url, { signal, headers: { Accept: "application/json, text/plain, */*" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
      resolveUpdateEnv: async () => {
        const proxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
        if (!proxy) return { ...process.env };
        const proxyUrl = buildNetworkProxyUrl(proxy);
        const noProxy = proxy.noProxyHosts.join(",");
        return {
          ...process.env,
          HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
          NO_PROXY: noProxy, no_proxy: noProxy,
        };
      },
      runProcess: spawnProviderCliProcess,
      realPath: (path) => realpathSync.native(path),
      probe: createProviderCliFileProbe(),
      platform: process.platform,
      homeDir: homedir(),
      env: process.env,
      now: () => new Date(),
      onChange: (snapshot) => this.events.publish("providerCliUpdates", snapshot),
      onUpdateAvailable: (status) => this.lifecycle.onProviderCliUpdateAvailable?.(status),
      onProviderUpdated: () => {
        // Slash commands and installation lookups depend on the CLI version.
        this.services.providerAccounts.composerCommandCache.clear();
        this.detectedCodexInstallation = null;
        this.detectedClaudeInstallation = null;
        this.detectedCursorInstallation = null;
      },
      warn: (message, metadata) => this.logControllerWarn(message, metadata),
    });
    return this.providerCliUpdateServiceInstance;
  }

  private listProviderCliTargets(): ProviderCliTarget[] {
    return this.db.listProviderAccounts().flatMap((provider): ProviderCliTarget[] => {
      const providerType = provider.providerType;
      if (!isProviderCliUpdateProviderType(providerType)) return [];
      const config = parseProviderConfigJson(provider.configJson);
      switch (providerType) {
        case "claude-code":
          return [{ providerType, binaryPath: resolveClaudeCodeBinaryPath(config), releaseChannel: readClaudeCodeReleaseChannel() }];
        case "codex-cli": {
          const { binaryPath, homePath } = resolveCodexCliExecutable(config);
          return [{ providerType, binaryPath, ...(homePath ? { env: { CODEX_HOME: homePath } } : {}) }];
        }
        case "cursor-agent":
          return [{ providerType, binaryPath: getCursorAgentBinaryPath(config) }];
      }
    }).sort((left, right) =>
      PROVIDER_CLI_UPDATE_PROVIDER_TYPES.indexOf(left.providerType) - PROVIDER_CLI_UPDATE_PROVIDER_TYPES.indexOf(right.providerType));
  }

  /** Run and chat starts that passed the update check but have not registered their worker yet. */
  readonly providerCliStartReservations = new Map<ProviderType, number>();

  /**
   * Refuses to start a CLI while its installer replaces it, then counts the CLI as in use
   * until the start finishes (the worker is registered by then) or fails. Without the
   * reservation an update could begin while a run is still preparing its workspace.
   */
  reserveProviderCliStart(providerType: ProviderType): Disposable {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    if (isProviderCliUpdateProviderType(providerType) && this.providerCliUpdateServiceInstance?.isUpdating(providerType)) {
      throw new Error(`${PROVIDER_CLI_LABELS[providerType]} is being updated. Try again once the update finishes.`);
    }
    this.providerCliStartReservations.set(providerType, (this.providerCliStartReservations.get(providerType) ?? 0) + 1);
    this.services.activeWorkers.handleActiveWorkersChanged();
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        const remaining = (this.providerCliStartReservations.get(providerType) ?? 1) - 1;
        if (remaining > 0) this.providerCliStartReservations.set(providerType, remaining);
        else this.providerCliStartReservations.delete(providerType);
        this.services.activeWorkers.handleActiveWorkersChanged();
      },
    };
  }

  /** Starts the opt-in background schedule; it stays idle while the setting is off. */
  startProviderCliUpdateChecks(): void {
    this.providerCliUpdates.start();
  }

  stopProviderCliUpdateChecks(): void {
    this.providerCliUpdateServiceInstance?.dispose();
  }

  async getProviderCliUpdates(): Promise<ProviderCliUpdateSnapshot> {
    return this.providerCliUpdates.getSnapshot();
  }

  async checkProviderCliUpdates(): Promise<ProviderCliUpdateSnapshot> {
    return this.providerCliUpdates.check();
  }

  async runProviderCliUpdate(providerType: ProviderType): Promise<ProviderCliUpdateSnapshot> {
    if (!isProviderCliUpdateProviderType(providerType)) {
      throw new Error("This provider has no local CLI to update.");
    }
    return this.providerCliUpdates.update(providerType);
  }

  private get reportedSessionCapabilities(): ReadonlyMap<string, HarnessSessionCapabilities> {
    this.reportedSessionCapabilitiesCache ??= new Map(Object.entries(
      parseSessionCapabilityReportsSetting(this.db.getSettings()[APP_SETTING_KEYS.reportedSessionCapabilities]),
    ));
    return this.reportedSessionCapabilitiesCache;
  }

  /**
   * The provider's last session report, while it is recent. A report can only narrow support,
   * and a provider it narrowed out may never start another session to correct it (after the agent
   * is upgraded, for example), so an old report stops counting.
   */
  sessionCapabilityReport(provider: ProviderAccountRecord): HarnessSessionCapabilities | undefined {
    const report = this.reportedSessionCapabilities.get(provider.id);
    if (!report) return undefined;
    const age = Date.now() - Date.parse(report.reportedAt);
    if (!Number.isFinite(age) || age > SESSION_CAPABILITY_REPORT_MAX_AGE_MS) return undefined;
    // A report describes the agent build that made it. Once another build is installed, it no
    // longer counts, so an upgrade that adds support is not held back by the old answer. A build
    // that cannot be identified right now (mid-upgrade, say) is not taken as another one: the
    // report stays until a known build differs from it.
    const fingerprint = report.executableFingerprint ? this.providerExecutableFingerprint(provider) : null;
    if (report.executableFingerprint && fingerprint && fingerprint !== report.executableFingerprint) {
      this.forgetSessionCapabilities(provider.id);
      return undefined;
    }
    return report;
  }

  /**
   * Identifies the installed agent a provider starts, when BuildWarden starts it from a command it
   * can find. Only ACP agents are started that way today; other providers return null.
   */
  private providerExecutableFingerprint(provider: ProviderAccountRecord): string | null {
    if (provider.providerType !== "acp") return null;
    const cached = this.executableFingerprints.get(provider.id);
    if (cached && Date.now() - cached.checkedAt < EXECUTABLE_FINGERPRINT_TTL_MS) return cached.fingerprint;
    let fingerprint: string | null = null;
    try {
      const config = parseProviderConfigJson(provider.configJson);
      const command = parseAcpCommandLine(String(config[PROVIDER_CONFIG_ACP_COMMAND_KEY] ?? ""))[0];
      const env = { ...process.env, ...parseAcpEnvironment(String(config[PROVIDER_CONFIG_ACP_ENV_KEY] ?? "")) };
      fingerprint = command ? executableFingerprint(command, env) : null;
    } catch {
      fingerprint = null;
    }
    this.executableFingerprints.set(provider.id, { checkedAt: Date.now(), fingerprint });
    return fingerprint;
  }

  forgetSessionCapabilities(providerAccountId: string): void {
    this.executableFingerprints.delete(providerAccountId);
    const reports = this.reportedSessionCapabilities as Map<string, HarnessSessionCapabilities>;
    if (!reports.delete(providerAccountId)) return;
    try {
      this.db.setSetting(APP_SETTING_KEYS.reportedSessionCapabilities, JSON.stringify(Object.fromEntries(reports)));
    } catch (error) {
      this.logControllerWarn("Could not persist session capability reports.", { error });
    }
  }

  /**
   * Merges a session report into the provider's last one and persists it. Reports from different
   * sources (the agent, BuildWarden's MCP bridge) describe different fields, so neither erases
   * the other.
   */
  rememberSessionCapabilities(provider: ProviderAccountRecord, report: HarnessSessionCapabilities): HarnessSessionCapabilities {
    const reports = this.reportedSessionCapabilities as Map<string, HarnessSessionCapabilities>;
    // The build is identified here, never taken from the report: the agent cannot vouch for itself.
    const stored: HarnessSessionCapabilities = { ...reports.get(provider.id), ...report };
    delete stored.executableFingerprint;
    const fingerprint = this.providerExecutableFingerprint(provider);
    if (fingerprint) stored.executableFingerprint = fingerprint;
    reports.set(provider.id, stored);
    try {
      this.db.setSetting(APP_SETTING_KEYS.reportedSessionCapabilities, JSON.stringify(Object.fromEntries([...reports].slice(-50))));
    } catch (error) {
      this.logControllerWarn("Could not persist session capability reports.", { error });
    }
    return stored;
  }

  /**
   * Resolve a binary on PATH without blocking the main-process event loop.
   * PATH misses on Windows (`where.exe`) can take hundreds of milliseconds,
   * and the renderer triggers these lookups right at startup.
   */
  private lookupBinaryOnPath(commands: Array<{ file: string; args: string[] }>, label: string): Promise<string | null> {
    const tryCommand = (command: { file: string; args: string[] }): Promise<string | null> =>
      new Promise((resolve) => {
        try {
          const child = spawn(command.file, command.args, { windowsHide: true, timeout: 3_000 });
          let stdout = "";
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.on("error", () => resolve(null));
          child.on("close", (code) => {
            if (code !== 0) {
              resolve(null);
              return;
            }
            resolve(firstNonEmptyLine(stdout));
          });
        } catch {
          this.logControllerWarn(`${label} detection strategy failed; continuing to next lookup.`, {
            command: command.file,
            args: command.args,
          });
          resolve(null);
        }
      });

    return commands.reduce<Promise<string | null>>(
      (previous, command) => previous.then((found) => (found ? found : tryCommand(command))),
      Promise.resolve(null),
    );
  }

  private detectedCodexInstallation: Promise<{ binaryPath: string | null }> | null = null;
  private detectedClaudeInstallation: Promise<{ binaryPath: string | null }> | null = null;
  private detectedCursorInstallation: Promise<{ binaryPath: string | null; message?: string }> | null = null;

  getDetectedCodexInstallation(): Promise<{ binaryPath: string | null }> {
    this.detectedCodexInstallation ??= (async () => {
      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["codex.cmd"] },
              { file: "where.exe", args: ["codex.exe"] },
              { file: "where.exe", args: ["codex"] },
            ]
          : [{ file: "which", args: ["codex"] }];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Codex");
      if (binaryPath === null) {
        // Do not cache misses; the user may install the CLI while the app runs.
        this.detectedCodexInstallation = null;
      }
      return { binaryPath };
    })();
    return this.detectedCodexInstallation ?? Promise.resolve({ binaryPath: null });
  }

  getDetectedClaudeInstallation(): Promise<{ binaryPath: string | null }> {
    this.detectedClaudeInstallation ??= (async () => {
      if (process.platform === "win32") {
        const userProfile = process.env.USERPROFILE;
        const nativeInstallerPath = userProfile ? join(userProfile, ".local", "bin", "claude.exe") : null;
        if (nativeInstallerPath && existsSync(nativeInstallerPath)) {
          return { binaryPath: nativeInstallerPath };
        }
      }

      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["claude.cmd"] },
              { file: "where.exe", args: ["claude.exe"] },
              { file: "where.exe", args: ["claude"] },
            ]
          : [{ file: "which", args: ["claude"] }];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Claude Code");
      if (binaryPath === null) {
        this.detectedClaudeInstallation = null;
      }
      return { binaryPath };
    })();
    return this.detectedClaudeInstallation ?? Promise.resolve({ binaryPath: null });
  }

  getDetectedCursorInstallation(): Promise<{ binaryPath: string | null; message?: string }> {
    this.detectedCursorInstallation ??= (async () => {
      const nativePath = getCursorAgentBinaryPathCandidates().find((candidate) => existsSync(candidate));
      if (nativePath) {
        return { binaryPath: nativePath };
      }

      const commands =
        process.platform === "win32"
          ? [
              { file: "where.exe", args: ["agent.cmd"] },
              { file: "where.exe", args: ["agent.exe"] },
              { file: "where.exe", args: ["agent"] },
              { file: "where.exe", args: ["cursor-agent.cmd"] },
              { file: "where.exe", args: ["cursor-agent.exe"] },
              { file: "where.exe", args: ["cursor-agent"] },
            ]
          : [
              { file: "which", args: ["agent"] },
              { file: "which", args: ["cursor-agent"] },
            ];
      const binaryPath = await this.lookupBinaryOnPath(commands, "Cursor Agent");
      if (binaryPath === null) {
        this.detectedCursorInstallation = null;
      }
      if (binaryPath) {
        return { binaryPath };
      }

      const cursorDesktopPath =
        process.platform === "win32" && process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")
          : null;
      if (cursorDesktopPath && existsSync(cursorDesktopPath)) {
        return {
          binaryPath: null,
          message:
            "Cursor desktop is installed, but the Cursor Agent CLI was not found. Install or expose `agent`/`cursor-agent` on PATH, then run `agent login` and `agent about`.",
        };
      }
      return {
        binaryPath: null,
        message: "Cursor Agent CLI was not found. Install Cursor CLI and ensure `agent about` or `cursor-agent about` works.",
      };
    })();
    return this.detectedCursorInstallation ?? Promise.resolve({ binaryPath: null });
  }

  requireProjectMcpSupported(
    projectId: string,
    provider: ProviderAccountRecord,
    projectRunDefaults = this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults],
  ): void {
    // Optional servers are skipped with a visible error by the adapter, so only required ones block a start.
    const required = (parseProjectRunDefaultsSetting(projectRunDefaults)[projectId]?.mcpServers ?? [])
      .filter((server) => server.enabled && server.required === true);
    if (required.length === 0) return;
    const support = effectiveHarnessCapabilities(provider.providerType, this.sessionCapabilityReport(provider)).projectMcp;
    if (support === "unsupported") {
      const names = required.map((server) => server.name).join(", ");
      throw new Error(`Project MCP servers are not supported by ${provider.label}, and the project requires ${names}. Select another provider, or mark the server${required.length === 1 ? "" : "s"} optional or disable ${required.length === 1 ? "it" : "them"}.`);
    }
  }

  /** The exhausted usage window of a subscription provider, or null when it can run or nothing is known. */
  async getProviderLimitState(modelId: string, refresh = false): Promise<ProviderLimitState | null> {
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    if (!["codex-cli", "claude-code", "cursor-agent"].includes(provider.providerType)) return null;
    const report = await Promise.race([
      this.services.usage.getSubscriptionLimits(refresh ? { refresh: true } : {}),
      new Promise<null>((resolveLater) => { setTimeout(() => resolveLater(null), COUNCIL_LIMIT_CHECK_TIMEOUT_MS).unref?.(); }),
    ]).catch(() => null);
    const account = report?.accounts.find((entry) => entry.id === provider.id || entry.id === provider.providerType);
    // With several windows used up, work can only resume after the last one resets. A window
    // with no known reset comes first, because nothing can say when it will be free again.
    const resetTime = (resetsAt: string | undefined) => (resetsAt ? Date.parse(resetsAt) : Number.POSITIVE_INFINITY);
    const exhausted = account?.windows
      .filter((window) => window.usedPercent >= 100)
      .reduce<SubscriptionLimitWindow | undefined>(
        (latest, window) => (!latest || resetTime(window.resetsAt) > resetTime(latest.resetsAt) ? window : latest),
        undefined,
      );
    if (!exhausted) return null;
    const reset = exhausted.resetsAt ? `, resets ${new Date(exhausted.resetsAt).toLocaleString()}` : "";
    return { reason: `${exhausted.label} usage limit reached${reset}`, resetsAt: exhausted.resetsAt ?? null };
  }
}
