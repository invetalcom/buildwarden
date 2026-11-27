import { execFile } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import {
  APP_SETTING_KEYS,
  parseRemoteAccessExposure,
  TAILSCALE_HTTPS_PORTS,
  type RemoteAccessExposure,
  type RemoteAccessStatus,
} from "@buildwarden/shared";

const DEFAULT_HTTPS_PORT = TAILSCALE_HTTPS_PORTS[0];
const SERVE_PATH = "/";
const COMMAND_TIMEOUT_MS = 15_000;
// Windows retries a refused loopback connection for about two seconds before reporting it.
const PORT_PROBE_TIMEOUT_MS = 4_000;
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

/** Whether some program accepts connections on a loopback port. */
export type LoopbackPortProbe = (port: number) => Promise<boolean>;

export interface TailscaleServeStateStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

type TailscaleNodeStatus = {
  BackendState?: unknown;
  Self?: { ID?: unknown; DNSName?: unknown; Online?: unknown } | null;
};

type TailscaleServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: unknown } | null>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> } | null>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, TailscaleServeStatus | null>;
};

type TailscaleStatus = RemoteAccessStatus["tailscale"];

/** The handler this data directory created, as recorded in its settings. */
type Ownership = { host: string; target: string; port: number; nodeId: string };

/**
 * What enabling exposure would do. `apply` runs Serve or Funnel on `port`: a free port, a handler
 * of ours that must point at a new loopback port, or a handler that already points at this server.
 */
type ExposurePlan =
  | { kind: "managed"; port: number; exposure: Exclude<RemoteAccessExposure, "local"> }
  | { kind: "shared"; port: number; exposure: Exclude<RemoteAccessExposure, "local"> }
  | { kind: "apply"; port: number; reason: "new" | "adopt" | "retarget"; note: string | null }
  | { kind: "conflict"; message: string };

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

/** Anything but a refused connection counts as in use, so a handler is never moved off a live program. */
const defaultPortProbe: LoopbackPortProbe = (port) => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  const finish = (inUse: boolean) => {
    socket.destroy();
    resolve(inUse);
  };
  socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(true));
  socket.once("connect", () => finish(true));
  socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
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

const parseHttpsPort = (value: string | undefined): number =>
  TAILSCALE_HTTPS_PORTS.find((port) => String(port) === value) ?? DEFAULT_HTTPS_PORT;
const proxyTarget = (loopbackPort: number): string => `http://127.0.0.1:${String(loopbackPort)}`;
const targetPort = (target: string): number | null => {
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
};
const hostKey = (host: string, port: number): string => `${host}:${String(port)}`;
const authority = (host: string, port: number): string => port === DEFAULT_HTTPS_PORT ? host : hostKey(host, port);
const endpointFor = (host: string, port: number): string => `https://${authority(host, port)}/`;

const rootProxyForHost = (status: TailscaleServeStatus | null, dnsName: string, port: number): string | null => {
  const expectedHostPort = hostKey(dnsName, port);
  const web = status?.Web;
  if (!web) return null;
  const entry = Object.entries(web).find(([hostPort]) => hostPort.toLowerCase() === expectedHostPort);
  const proxy = entry?.[1]?.Handlers?.[SERVE_PATH]?.Proxy;
  return typeof proxy === "string" ? proxy.replace(/\/$/, "") : null;
};

const isPublic = (config: TailscaleServeStatus, host: string, port: number): boolean => config.AllowFunnel?.[hostKey(host, port)] === true;
const usedInForeground = (config: TailscaleServeStatus, port: number): boolean =>
  Object.values(config.Foreground ?? {}).some((entry) => entry != null && hasPort(entry, port));
const hasPort = (config: TailscaleServeStatus, port: number): boolean => Boolean(config.TCP?.[String(port)])
  || Object.keys(config.Web ?? {}).some((key) => key.endsWith(`:${String(port)}`))
  || Object.entries(config.AllowFunnel ?? {}).some(([key, value]) => key.endsWith(`:${String(port)}`) && value)
  || usedInForeground(config, port);
// Serve/Funnel change exposure for the entire port. Never expose another application's handler.
const ownsWholePort = (config: TailscaleServeStatus, host: string, port: number, target: string): boolean => {
  const suffix = `:${String(port)}`;
  return config.TCP?.[String(port)]?.HTTPS === true && rootProxyForHost(config, host, port) === target
    && Object.keys(config.Web ?? {}).filter((key) => key.endsWith(suffix)).every((key) => key === hostKey(host, port))
    && Object.keys(config.Web?.[hostKey(host, port)]?.Handlers ?? {}).every((path) => path === SERVE_PATH)
    && !usedInForeground(config, port)
    && !Object.entries(config.AllowFunnel ?? {}).some(([key, value]) => key.endsWith(suffix) && key !== hostKey(host, port) && value);
};
/** What occupies a port, for messages: `443 → http://127.0.0.1:9000`. */
const describePort = (config: TailscaleServeStatus, host: string, port: number): string => {
  if (usedInForeground(config, port)) return `${String(port)}: a foreground tailscale serve session`;
  const proxy = rootProxyForHost(config, host, port);
  if (proxy) return `${String(port)} → ${proxy}`;
  if (typeof config.TCP?.[String(port)]?.TCPForward === "string") return `${String(port)}: TCP forwarding`;
  return `${String(port)}: other handlers`;
};
const offCommand = (exposure: RemoteAccessExposure, port: number): string => `tailscale ${commandFor(exposure)} --https=${String(port)} off`;
const conflictMessage = (config: TailscaleServeStatus, host: string): string =>
  `HTTPS ports ${TAILSCALE_HTTPS_PORTS.join(", ")} on ${host} are all used by other Tailscale handlers (`
  + TAILSCALE_HTTPS_PORTS.map((port) => describePort(config, host, port)).join("; ")
  + "). BuildWarden left them unchanged. Free one with `tailscale serve --https=<port> off`, then retry.";
const commandFor = (exposure: RemoteAccessExposure): string => exposure === "internet" ? "funnel" : "serve";
const enableArgs = (target: string, exposure: RemoteAccessExposure, port: number): string[] =>
  [commandFor(exposure), "--bg", "--yes", `--https=${String(port)}`, "--set-path=/", target];
const enableCommand = (target: string, exposure: RemoteAccessExposure, port: number): string =>
  `tailscale ${enableArgs(target, exposure, port).join(" ")}`;

export class TailscaleServeService {
  private cliPath: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: TailscaleServeStateStore,
    private readonly runCommand: TailscaleCommandRunner = defaultCommandRunner,
    private readonly candidates: string[] = commandCandidates(),
    private readonly portInUse: LoopbackPortProbe = defaultPortProbe,
  ) {}

  private ownership(): Ownership | null {
    const host = normalizeDnsName(this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost));
    const target = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget);
    if (!host || !target) return null;
    return {
      host,
      target,
      port: parseHttpsPort(this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort)),
      nodeId: this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId) ?? "",
    };
  }

  /** The Host header the BuildWarden handler forwards: the MagicDNS name, with `:port` unless it is 443. */
  getTrustedProxyAuthority(): string | null {
    const owned = this.ownership();
    return owned ? authority(owned.host, owned.port) : null;
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

  async getStatus(loopbackPort: number | null): Promise<TailscaleStatus> {
    const { status } = await this.inspect(loopbackPort);
    return this.lastError ? { ...status, state: "error", verified: false, message: this.lastError } : status;
  }

  /**
   * Prefers the handler this data directory recorded. Without one it takes over a handler that
   * already forwards to this server (an earlier install on this computer left it), then the first
   * free HTTPS port. A handler of another program is never changed.
   */
  private async planExposure(config: TailscaleServeStatus, dnsName: string, nodeId: unknown, target: string): Promise<ExposurePlan> {
    const owned = this.ownership();
    let note: string | null = null;
    let skipPort: number | null = null;
    if (owned) {
      if (owned.nodeId && nodeId !== owned.nodeId) {
        return { kind: "conflict", message: `BuildWarden's Tailscale handler was set up on another Tailscale node (${owned.host}). Reconnect that node, or choose Local only there first.` };
      }
      if (owned.host !== dnsName) {
        return { kind: "conflict", message: `This host's Tailscale name changed from ${owned.host}. Choose Local only to remove the old handler, then choose again.` };
      }
      const proxy = rootProxyForHost(config, dnsName, owned.port);
      const exposure = isPublic(config, dnsName, owned.port) ? "internet" : "tailnet";
      if (proxy === target) {
        return ownsWholePort(config, dnsName, owned.port, target)
          ? { kind: "managed", port: owned.port, exposure }
          : { kind: "shared", port: owned.port, exposure };
      }
      const previousPort = targetPort(owned.target);
      if (proxy === owned.target && previousPort !== null) {
        if (!(await this.portInUse(previousPort))) return { kind: "apply", port: owned.port, reason: "retarget", note: null };
        note = `Loopback port ${String(previousPort)} now belongs to another program, so its handler on HTTPS port ${String(owned.port)} was left in place.`;
        skipPort = owned.port;
      } else if (!hasPort(config, owned.port)) {
        return { kind: "apply", port: owned.port, reason: "new", note: null };
      }
    }
    const adopted = TAILSCALE_HTTPS_PORTS.find((port) => port !== skipPort && ownsWholePort(config, dnsName, port, target));
    if (adopted !== undefined) return { kind: "apply", port: adopted, reason: "adopt", note };
    const free = TAILSCALE_HTTPS_PORTS.find((port) => port !== skipPort && !hasPort(config, port));
    if (free === undefined) return { kind: "conflict", message: conflictMessage(config, dnsName) };
    if (free !== DEFAULT_HTTPS_PORT && skipPort !== DEFAULT_HTTPS_PORT) {
      note = [note, `HTTPS port 443 is used by another handler (${describePort(config, dnsName, DEFAULT_HTTPS_PORT)}), so BuildWarden uses port ${String(free)}.`]
        .filter(Boolean).join(" ");
    }
    return { kind: "apply", port: free, reason: "new", note };
  }

  private async inspect(loopbackPort: number | null): Promise<{ status: TailscaleStatus; plan?: ExposurePlan; nodeId?: unknown }> {
    const mode = this.requestedExposure();
    const desired = mode !== "local";
    const located = await this.locate();
    if (!located) return { status: this.status(desired, "not-installed", "Install Tailscale on this host to enable private or Internet access.") };
    const node = parseJson<TailscaleNodeStatus>(located.result.stdout);
    const backendState = typeof node?.BackendState === "string" ? node.BackendState : null;
    const dnsName = normalizeDnsName(node?.Self?.DNSName);
    if (located.result.exitCode !== 0 || backendState !== "Running" || node?.Self?.Online === false || !dnsName) {
      return { status: this.status(desired, "not-running", cleanMessage(located.result.stderr) || "Tailscale is not connected to a tailnet.", { backendState, dnsName }) };
    }
    const base = { backendState, dnsName };
    if (loopbackPort == null) {
      return { status: this.status(desired, "available", "Enable the remote access server before configuring exposure.", { ...base, endpoint: endpointFor(dnsName, DEFAULT_HTTPS_PORT) }) };
    }
    let config: TailscaleServeStatus;
    try { config = await this.readConfig(located.executable); }
    catch (error) { return { status: this.status(desired, "error", String(error), base) }; }
    const target = proxyTarget(loopbackPort);
    const plan = await this.planExposure(config, dnsName, node?.Self?.ID, target);
    if (plan.kind === "conflict") return { plan, status: this.status(desired, "conflict", plan.message, base) };
    const details = { ...base, httpsPort: plan.port, endpoint: endpointFor(dnsName, plan.port),
      enableCommand: mode === "local" ? null : enableCommand(target, mode, plan.port) };
    if (plan.kind === "managed") {
      return { plan, nodeId: node?.Self?.ID, status: this.status(desired, "managed",
        (plan.exposure === "internet" ? "Public Internet endpoint; pairing is required. Visitors do not need Tailscale." : "Private endpoint; visitors must have access to this tailnet.")
        + (mode !== plan.exposure ? " The requested exposure has not been applied. Retry to apply it." : ""),
        { ...details, managed: true, verified: mode === plan.exposure, exposure: plan.exposure }) };
    }
    if (plan.kind === "shared") {
      return { plan, status: this.status(desired, "conflict",
        `Other handlers share HTTPS port ${String(plan.port)} with BuildWarden's (${describePort(config, dnsName, plan.port)}). It was left unchanged; remove them, or start over with \`${offCommand(plan.exposure, plan.port)}\`.`,
        { ...details, enableCommand: null, managed: true, exposure: plan.exposure }) };
    }
    const message = plan.reason === "adopt"
      ? `A Tailscale handler on HTTPS port ${String(plan.port)} already forwards to this BuildWarden, probably left by an earlier install. Choosing Private or Internet takes it over.`
      : plan.reason === "retarget"
        ? `BuildWarden now listens on loopback port ${String(loopbackPort)}. Retry to point its Tailscale handler there.`
        : "Tailscale is ready. Choose Private or Internet access.";
    return { plan, nodeId: node?.Self?.ID, status: this.status(desired, "available", [message, plan.note].filter(Boolean).join(" "), details) };
  }

  async enable(loopbackPort: number): Promise<TailscaleStatus> {
    this.lastError = null;
    const result = await this.applyExposure(loopbackPort);
    if (result.state === "error") this.lastError = result.message;
    return result;
  }

  private async applyExposure(loopbackPort: number): Promise<TailscaleStatus> {
    const mode = this.requestedExposure();
    if (mode === "local") return this.disable(loopbackPort);
    const { status: before, plan, nodeId } = await this.inspect(loopbackPort);
    if (before.verified && before.exposure === mode) return before;
    if (!plan || (plan.kind !== "apply" && plan.kind !== "managed") || !before.cliPath || !before.dnsName) return before;
    const target = proxyTarget(loopbackPort);
    // Persist before running: a timeout can occur after Tailscale applied the configuration.
    const identity = await this.locate();
    const node = identity ? parseJson<TailscaleNodeStatus>(identity.result.stdout) : null;
    if (!identity || identity.result.exitCode !== 0 || normalizeDnsName(node?.Self?.DNSName) !== before.dnsName || node?.Self?.ID !== nodeId) {
      return this.status(true, "error", "The Tailscale host changed while configuring exposure. Reconnect the original host and retry.");
    }
    // Replacing the record releases a handler left behind on a port another program now holds.
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId, typeof nodeId === "string" ? nodeId : "");
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, before.dnsName);
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget, target);
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort, String(plan.port));
    const result = await this.runCommand(before.cliPath, enableArgs(target, mode, plan.port));
    const after = await this.getStatus(loopbackPort);
    if (result.exitCode !== 0 || !after.verified || after.exposure !== mode || after.httpsPort !== plan.port) {
      return { ...after, state: "error", verified: false,
        message: (cleanMessage(result.stderr || result.stdout) || "The requested exposure could not be verified.")
          + (mode === "internet" ? " Complete any Tailscale HTTPS/Funnel approval, then retry." : " Retry to apply private access.") };
    }
    return after;
  }

  /** `loopbackPort` is where this server listens now, or null when it is not running. */
  async disable(loopbackPort: number | null = null): Promise<TailscaleStatus> {
    this.lastError = null;
    const result = await this.removeExposure(loopbackPort);
    if (result.state === "error") this.lastError = result.message;
    return result;
  }

  private async removeExposure(loopbackPort: number | null): Promise<TailscaleStatus> {
    const owned = this.ownership();
    const desired = this.requestedExposure() !== "local";
    if (!owned) return this.removeLeftovers(desired, loopbackPort);
    let host = owned.host;
    const { target, port } = owned;
    const details = { dnsName: host, endpoint: endpointFor(host, port), httpsPort: port, managed: true };
    const located = await this.locate();
    if (!located) return this.status(desired, "error", "Tailscale CLI is unavailable; exposure could not be removed.", details);
    const node = parseJson<TailscaleNodeStatus>(located.result.stdout);
    const currentHost = normalizeDnsName(node?.Self?.DNSName);
    const sameNode = typeof node?.Self?.ID === "string" && node.Self.ID === owned.nodeId;
    if (located.result.exitCode !== 0 || (owned.nodeId ? !sameNode : currentHost !== host) || !currentHost) {
      return this.status(desired, "error", "Reconnect Tailscale using the original account, then retry. If the host was renamed before ownership tracking was available, restore its previous name to remove exposure safely.", details);
    }
    let config: TailscaleServeStatus;
    try { config = await this.readConfig(located.executable); }
    catch (error) { return this.status(desired, "error", String(error), details); }
    if (currentHost !== host) {
      if (!hasPort(config, port)) {
        this.clearOwnership();
        return this.getStatus(null);
      }
      if (!ownsWholePort(config, currentHost, port, target)) return this.status(desired, "error", "The renamed host has different or shared proxy configuration. Restore the original name or remove the old BuildWarden handler in Tailscale, then retry.", details);
      host = currentHost;
      this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, host);
    }
    if (rootProxyForHost(config, host, port) !== target) {
      this.clearOwnership();
      return this.getStatus(null);
    }
    // The handler points at the loopback port this data directory used before. When another
    // program listens there now, the handler serves that program (often another BuildWarden).
    const previousPort = targetPort(target);
    if (previousPort !== null && previousPort !== loopbackPort && await this.portInUse(previousPort)) {
      this.clearOwnership();
      return this.status(desired, "available", `Local access only. Loopback port ${String(previousPort)} now belongs to another program, so its Tailscale handler on ${endpointFor(host, port)} was left in place.`);
    }
    const exposure = isPublic(config, host, port) ? "internet" : "tailnet";
    if (!ownsWholePort(config, host, port, target)) {
      return this.status(desired, "error", `Other handlers share HTTPS port ${String(port)} (${describePort(config, host, port)}). Remove them manually before changing BuildWarden exposure.`, { ...details, exposure });
    }
    const removed = await this.turnOff(located.executable, config, host, port);
    if (removed) return this.status(desired, "error", removed, { ...details, exposure });
    this.clearOwnership();
    return this.getStatus(null);
  }

  /**
   * Without a record, a handler that forwards exactly to this running server still exposes it:
   * an earlier install on this computer left it. Local only removes it.
   */
  private async removeLeftovers(desired: boolean, loopbackPort: number | null): Promise<TailscaleStatus> {
    const idle = this.status(desired, "available", "Local access only. No BuildWarden Tailscale handler is configured.");
    if (loopbackPort == null) return idle;
    const located = await this.locate();
    const host = located?.result.exitCode === 0 ? normalizeDnsName(parseJson<TailscaleNodeStatus>(located.result.stdout)?.Self?.DNSName) : null;
    if (!located || !host) return idle;
    let config: TailscaleServeStatus;
    try { config = await this.readConfig(located.executable); }
    catch { return idle; }
    const target = proxyTarget(loopbackPort);
    const ports = TAILSCALE_HTTPS_PORTS.filter((port) => ownsWholePort(config, host, port, target));
    for (const port of ports) {
      const failure = await this.turnOff(located.executable, config, host, port);
      if (failure) return this.status(desired, "error", `A Tailscale handler on ${endpointFor(host, port)} still forwards to this BuildWarden. ${failure}`, { dnsName: host, httpsPort: port });
    }
    return ports.length === 0 ? idle : this.status(desired, "available",
      `Local access only. Removed the Tailscale handler an earlier BuildWarden install left on ${ports.map((port) => endpointFor(host, port)).join(", ")}.`, { dnsName: host });
  }

  /** Turns one handler off and verifies it. Returns an error message, or null when it is gone. */
  private async turnOff(executable: string, config: TailscaleServeStatus, host: string, port: number): Promise<string | null> {
    const exposure = isPublic(config, host, port) ? "internet" : "tailnet";
    const result = await this.runCommand(executable, [commandFor(exposure), `--https=${String(port)}`, "--set-path=/", "off"]);
    if (result.exitCode !== 0) return cleanMessage(result.stderr || result.stdout) || "Could not remove exposure.";
    try {
      const after = await this.readConfig(executable);
      if (rootProxyForHost(after, host, port) || isPublic(after, host, port)) return "Tailscale exposure is still configured. Retry removal.";
    } catch (error) {
      return String(error);
    }
    return null;
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
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort, "");
  }

  private status(
    desired: boolean,
    state: TailscaleStatus["state"],
    message: string,
    overrides: Partial<TailscaleStatus> = {},
  ): TailscaleStatus {
    return {
      desired,
      requestedExposure: this.requestedExposure(),
      exposure: null,
      state,
      cliPath: this.cliPath,
      backendState: null,
      dnsName: null,
      endpoint: null,
      httpsPort: null,
      managed: false,
      verified: false,
      message,
      enableCommand: null,
      ...overrides,
    };
  }
}
