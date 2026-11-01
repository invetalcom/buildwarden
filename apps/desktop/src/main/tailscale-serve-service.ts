import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  APP_SETTING_KEYS,
  parseRemoteAccessExposure,
  type RemoteAccessExposure,
  type RemoteAccessStatus,
} from "@buildwarden/shared";

const SERVE_HTTPS_PORT = 443;
const SERVE_PATH = "/";
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_LENGTH = 800;

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  notFound?: boolean;
}

export type TailscaleCommandRunner = (
  executable: string,
  args: string[],
) => Promise<TailscaleCommandResult>;

export interface TailscaleServeStateStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

type TailscaleNodeStatus = {
  BackendState?: unknown;
  Self?: { ID?: unknown; DNSName?: unknown; Online?: unknown } | null;
};

type TailscaleServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean } | null>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> } | null>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, TailscaleServeStatus | null>;
};

const defaultCommandRunner: TailscaleCommandRunner = (executable, args) =>
  new Promise((resolve) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 1_048_576, timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const errorCode = error && "code" in error ? error.code : undefined;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: typeof errorCode === "number" ? errorCode : Number(Boolean(error)),
          notFound: errorCode === "ENOENT",
        });
      },
    );
  });

const commandCandidates = (): string[] => {
  const configured = process.env.TAILSCALE_CLI_PATH?.trim();
  const candidates = [
    configured,
    process.platform === "win32" && process.env.ProgramFiles
      ? join(process.env.ProgramFiles, "Tailscale", "tailscale.exe")
      : undefined,
    process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : undefined,
    process.platform === "darwin" ? "/opt/homebrew/bin/tailscale" : undefined,
    process.platform !== "win32" ? "/usr/local/bin/tailscale" : undefined,
    process.platform !== "win32" ? "/usr/bin/tailscale" : undefined,
    "tailscale",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
};

const cleanMessage = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_COMMAND_OUTPUT_LENGTH);

const parseJson = <T>(value: string): T | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
};

const normalizeDnsName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(normalized) ? normalized : null;
};

const proxyTarget = (loopbackPort: number): string => `http://127.0.0.1:${String(loopbackPort)}`;

const rootProxyForHost = (status: TailscaleServeStatus | null, dnsName: string): string | null => {
  const expectedHostPort = `${dnsName}:${String(SERVE_HTTPS_PORT)}`;
  const web = status?.Web;
  if (!web) return null;
  const entry = Object.entries(web).find(([hostPort]) => hostPort.toLowerCase() === expectedHostPort);
  const proxy = entry?.[1]?.Handlers?.[SERVE_PATH]?.Proxy;
  return typeof proxy === "string" ? proxy.replace(/\/$/, "") : null;
};

const isPublic = (config: TailscaleServeStatus, host: string): boolean => config.AllowFunnel?.[`${host}:443`] === true;
const hasPort = (config: TailscaleServeStatus): boolean => Boolean(config.TCP?.["443"])
  || Object.keys(config.Web ?? {}).some((key) => key.endsWith(":443"))
  || Object.entries(config.AllowFunnel ?? {}).some(([key, value]) => key.endsWith(":443") && value)
  || Object.values(config.Foreground ?? {}).some((entry) => entry != null && hasPort(entry));
// Serve/Funnel change exposure for the entire port. Never expose another application's handler.
const ownsWholePort = (config: TailscaleServeStatus, host: string, target: string): boolean =>
  config.TCP?.["443"]?.HTTPS === true && rootProxyForHost(config, host) === target
  && Object.keys(config.Web ?? {}).filter((key) => key.endsWith(":443")).every((key) => key === `${host}:443`)
  && Object.keys(config.Web?.[`${host}:443`]?.Handlers ?? {}).every((path) => path === "/")
  && !Object.values(config.Foreground ?? {}).some((entry) => entry != null && hasPort(entry))
  && !Object.entries(config.AllowFunnel ?? {}).some(([key, value]) => key.endsWith(":443") && key !== `${host}:443` && value);
const commandFor = (exposure: RemoteAccessExposure): string => exposure === "internet" ? "funnel" : "serve";
const enableArgs = (target: string, exposure: RemoteAccessExposure): string[] =>
  [commandFor(exposure), "--bg", "--yes", "--https=443", "--set-path=/", target];
const enableCommand = (target: string, exposure: RemoteAccessExposure): string => `tailscale ${enableArgs(target, exposure).join(" ")}`;

export class TailscaleServeService {
  private cliPath: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: TailscaleServeStateStore,
    private readonly runCommand: TailscaleCommandRunner = defaultCommandRunner,
    private readonly candidates: string[] = commandCandidates(),
  ) {}

  getManagedHost(): string | null {
    const host = normalizeDnsName(this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost));
    return this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget) ? host : null;
  }

  private requestedExposure(): RemoteAccessExposure {
    const exposure = this.store.read(APP_SETTING_KEYS.remoteAccessExposure);
    return parseRemoteAccessExposure({
      ...(exposure !== undefined ? { [APP_SETTING_KEYS.remoteAccessExposure]: exposure } : {}),
      [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleEnabled) ?? "false",
    });
  }

  private async readConfig(executable: string): Promise<TailscaleServeStatus> {
    const result = await this.runCommand(executable, ["serve", "status", "--json"]);
    if (/no serve config/i.test(result.stdout + result.stderr)) return {};
    const config = result.exitCode === 0 ? parseJson<TailscaleServeStatus>(result.stdout) : null;
    if (!config) throw new Error(cleanMessage(result.stderr || result.stdout) || "Could not inspect Tailscale configuration.");
    return config;
  }

  async getStatus(loopbackPort: number | null): Promise<RemoteAccessStatus["tailscale"]> {
    const status = await this.inspectStatus(loopbackPort);
    return this.lastError ? { ...status, state: "error", verified: false, message: this.lastError } : status;
  }

  private async inspectStatus(loopbackPort: number | null): Promise<RemoteAccessStatus["tailscale"]> {
    const mode = this.requestedExposure();
    const desired = mode !== "local";
    const located = await this.locate();
    if (!located) return this.status(desired, "not-installed", "Install Tailscale on this host to enable private or Internet access.");
    const node = parseJson<TailscaleNodeStatus>(located.result.stdout);
    const backendState = typeof node?.BackendState === "string" ? node.BackendState : null;
    const dnsName = normalizeDnsName(node?.Self?.DNSName);
    if (located.result.exitCode !== 0 || backendState !== "Running" || node?.Self?.Online === false || !dnsName) {
      return this.status(desired, "not-running", cleanMessage(located.result.stderr) || "Tailscale is not connected to a tailnet.", { backendState, dnsName });
    }
    const details = { backendState, dnsName, endpoint: "https://" + dnsName + "/",
      enableCommand: loopbackPort == null || mode === "local" ? null : enableCommand(proxyTarget(loopbackPort), mode) };
    if (loopbackPort == null) return this.status(desired, "available", "Enable the remote access server before configuring exposure.", details);
    let config: TailscaleServeStatus;
    try { config = await this.readConfig(located.executable); }
    catch (error) { return this.status(desired, "error", String(error), details); }
    const target = proxyTarget(loopbackPort);
    const matches = rootProxyForHost(config, dnsName) === target;
    const managedNodeId = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId);
    const owned = this.getManagedHost() === dnsName && this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget) === target
      && (!managedNodeId || node?.Self?.ID === managedNodeId);
    const exposure = matches ? (isPublic(config, dnsName) ? "internet" : "tailnet") : null;
    if (owned && matches && ownsWholePort(config, dnsName, target)) {
      return this.status(desired, "managed",
        (exposure === "internet" ? "Public Internet endpoint; pairing is required. Visitors do not need Tailscale." : "Private endpoint; visitors must have access to this tailnet.")
        + (mode !== exposure ? " The requested exposure has not been applied. Retry to apply it." : ""),
        { ...details, managed: true, verified: mode === exposure, exposure });
    }
    if (hasPort(config) || (this.getManagedHost() && this.getManagedHost() !== dnsName)) {
      return this.status(desired, "conflict", "HTTPS port 443 has configuration BuildWarden cannot exclusively manage. It was left unchanged.",
        { ...details, enableCommand: null, managed: owned && matches, exposure });
    }
    return this.status(desired, "available", "Tailscale is ready. Choose Private or Internet access.", details);
  }

  async enable(loopbackPort: number): Promise<RemoteAccessStatus["tailscale"]> {
    this.lastError = null;
    const result = await this.applyExposure(loopbackPort);
    if (result.state === "error") this.lastError = result.message;
    return result;
  }

  private async applyExposure(loopbackPort: number): Promise<RemoteAccessStatus["tailscale"]> {
    const mode = this.requestedExposure();
    if (mode === "local") return this.disable();
    const before = await this.getStatus(loopbackPort);
    if (before.verified && before.exposure === mode) return before;
    if ((before.state !== "available" && before.state !== "managed") || !before.cliPath || !before.dnsName) return before;
    const target = proxyTarget(loopbackPort);
    // Persist before running: a timeout can occur after Tailscale applied the configuration.
    const identity = await this.locate();
    const node = identity ? parseJson<TailscaleNodeStatus>(identity.result.stdout) : null;
    if (!identity || identity.result.exitCode !== 0 || normalizeDnsName(node?.Self?.DNSName) !== before.dnsName) {
      return this.status(true, "error", "The Tailscale host changed while configuring exposure. Reconnect the original host and retry.");
    }
    const nodeId = node?.Self?.ID;
    const managedNodeId = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId);
    if (managedNodeId && nodeId !== managedNodeId) return this.status(true, "error", "Reconnect the original Tailscale node before changing its exposure.");
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId, typeof nodeId === "string" ? nodeId : "");
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, before.dnsName);
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget, target);
    const result = await this.runCommand(before.cliPath, enableArgs(target, mode));
    const after = await this.getStatus(loopbackPort);
    if (result.exitCode !== 0 || !after.verified || after.exposure !== mode) {
      return { ...after, state: "error", verified: false,
        message: (cleanMessage(result.stderr || result.stdout) || "The requested exposure could not be verified.")
          + (mode === "internet" ? " Complete any Tailscale HTTPS/Funnel approval, then retry." : " Retry to apply private access.") };
    }
    return after;
  }

  async disable(): Promise<RemoteAccessStatus["tailscale"]> {
    this.lastError = null;
    const result = await this.removeExposure();
    if (result.state === "error") this.lastError = result.message;
    return result;
  }

  private async removeExposure(): Promise<RemoteAccessStatus["tailscale"]> {
    let host = this.getManagedHost();
    const target = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget);
    const desired = this.requestedExposure() !== "local";
    if (!host || !target) return this.status(desired, "available", "Local access only. No BuildWarden Tailscale handler is configured.");
    const details = { dnsName: host, endpoint: "https://" + host + "/", managed: true };
    const located = await this.locate();
    if (!located) return this.status(desired, "error", "Tailscale CLI is unavailable; exposure could not be removed.", details);
    const node = parseJson<TailscaleNodeStatus>(located.result.stdout);
    const currentHost = normalizeDnsName(node?.Self?.DNSName);
    const managedNodeId = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId);
    const sameNode = typeof node?.Self?.ID === "string" && node.Self.ID === managedNodeId;
    if (located.result.exitCode !== 0 || (managedNodeId ? !sameNode : currentHost !== host) || !currentHost) {
      return this.status(desired, "error", "Reconnect Tailscale using the original account, then retry. If the host was renamed before ownership tracking was available, restore its previous name to remove exposure safely.", details);
    }
    let config: TailscaleServeStatus;
    try { config = await this.readConfig(located.executable); }
    catch (error) { return this.status(desired, "error", String(error), details); }
    if (currentHost !== host) {
      if (!hasPort(config)) {
        this.clearOwnership();
        return this.getStatus(null);
      }
      if (!ownsWholePort(config, currentHost, target)) return this.status(desired, "error", "The renamed host has different or shared proxy configuration. Restore the original name or remove the old BuildWarden handler in Tailscale, then retry.", details);
      host = currentHost;
      this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, host);
    }
    if (rootProxyForHost(config, host) !== target) {
      this.clearOwnership();
      return this.getStatus(null);
    }
    const exposure = isPublic(config, host) ? "internet" : "tailnet";
    if (!ownsWholePort(config, host, target)) {
      return this.status(desired, "error", "Other handlers share HTTPS port 443. Remove them manually before changing BuildWarden exposure.", { ...details, exposure });
    }
    const result = await this.runCommand(located.executable, [commandFor(exposure), "--https=443", "--set-path=/", "off"]);
    if (result.exitCode !== 0) return this.status(desired, "error", cleanMessage(result.stderr || result.stdout) || "Could not remove exposure.", { ...details, exposure });
    try {
      const after = await this.readConfig(located.executable);
      if (rootProxyForHost(after, host) || isPublic(after, host)) throw new Error("Tailscale exposure is still configured. Retry removal.");
    } catch (error) { return this.status(desired, "error", String(error), { ...details, exposure }); }
    this.clearOwnership();
    return this.getStatus(null);
  }

  private async locate(): Promise<{ executable: string; result: TailscaleCommandResult } | null> {
    if (this.cliPath) {
      const result = await this.runCommand(this.cliPath, ["status", "--json"]);
      if (!result.notFound) return { executable: this.cliPath, result };
      this.cliPath = null;
    }
    for (const executable of this.candidates) {
      const result = await this.runCommand(executable, ["status", "--json"]);
      if (result.notFound) continue;
      this.cliPath = executable;
      return { executable, result };
    }
    return null;
  }

  private clearOwnership(): void {
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId, "");
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, "");
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget, "");
  }

  private status(
    desired: boolean,
    state: RemoteAccessStatus["tailscale"]["state"],
    message: string,
    overrides: Partial<RemoteAccessStatus["tailscale"]> = {},
  ): RemoteAccessStatus["tailscale"] {
    return {
      desired,
      requestedExposure: this.requestedExposure(),
      exposure: null,
      state,
      cliPath: this.cliPath,
      backendState: null,
      dnsName: null,
      endpoint: null,
      managed: false,
      verified: false,
      message,
      enableCommand: null,
      ...overrides,
    };
  }
}
