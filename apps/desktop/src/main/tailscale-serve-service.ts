import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  APP_SETTING_KEYS,
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
  Self?: { DNSName?: unknown; Online?: unknown } | null;
};

type TailscaleServeStatus = {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> } | null>;
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
          exitCode: typeof errorCode === "number" ? errorCode : error ? 1 : 0,
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

const enableCommand = (target: string): string =>
  `tailscale serve --bg --yes --https=${String(SERVE_HTTPS_PORT)} --set-path=${SERVE_PATH} ${target}`;

export class TailscaleServeService {
  private cliPath: string | null = null;

  constructor(
    private readonly store: TailscaleServeStateStore,
    private readonly runCommand: TailscaleCommandRunner = defaultCommandRunner,
    private readonly candidates: string[] = commandCandidates(),
  ) {}

  getManagedHost(): string | null {
    const host = normalizeDnsName(this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost));
    return this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget) ? host : null;
  }

  async getStatus(loopbackPort: number | null): Promise<RemoteAccessStatus["tailscale"]> {
    const desired = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleEnabled) === "true";
    const located = await this.locate();
    if (!located) {
      return this.status(desired, "not-installed", "Tailscale CLI was not found. Install Tailscale to expose BuildWarden to your tailnet.");
    }

    const nodeStatus = parseJson<TailscaleNodeStatus>(located.result.stdout);
    const backendState = typeof nodeStatus?.BackendState === "string" ? nodeStatus.BackendState : null;
    const dnsName = normalizeDnsName(nodeStatus?.Self?.DNSName);
    if (located.result.exitCode !== 0 || backendState !== "Running" || nodeStatus?.Self?.Online === false || !dnsName) {
      const detail = cleanMessage(located.result.stderr || located.result.stdout);
      return this.status(
        desired,
        "not-running",
        detail || "Tailscale is installed but is not connected to a tailnet.",
        { backendState, dnsName },
      );
    }

    if (loopbackPort == null) {
      return this.status(desired, "available", "Enable the BuildWarden remote server before configuring Tailscale Serve.", {
        backendState,
        dnsName,
        endpoint: `https://${dnsName}/`,
      });
    }

    const target = proxyTarget(loopbackPort);
    const serveResult = await this.runCommand(located.executable, ["serve", "status", "--json"]);
    const noConfig = /no serve config/i.test(`${serveResult.stdout} ${serveResult.stderr}`);
    const serveStatus = serveResult.exitCode === 0 ? parseJson<TailscaleServeStatus>(serveResult.stdout) : noConfig ? {} : null;
    if (serveStatus == null) {
      return this.status(desired, "error", cleanMessage(serveResult.stderr || serveResult.stdout) || "Could not inspect Tailscale Serve.", {
        backendState,
        dnsName,
        endpoint: `https://${dnsName}/`,
        enableCommand: enableCommand(target),
      });
    }

    const existingTarget = rootProxyForHost(serveStatus, dnsName);
    const managedHost = this.getManagedHost();
    const managedTarget = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget) ?? null;
    const verified = managedHost === dnsName && managedTarget === target && existingTarget === target;
    if (verified) {
      return this.status(desired, "managed", "BuildWarden is available through this tailnet HTTPS endpoint.", {
        backendState,
        dnsName,
        endpoint: `https://${dnsName}/`,
        managed: true,
        verified: true,
        enableCommand: enableCommand(target),
      });
    }
    if (existingTarget) {
      return this.status(desired, "conflict", "Tailscale Serve already has a root HTTPS handler. BuildWarden left it unchanged.", {
        backendState,
        dnsName,
        endpoint: `https://${dnsName}/`,
        enableCommand: enableCommand(target),
      });
    }
    return this.status(desired, "available", "Tailscale is ready. Enable exposure to create a BuildWarden-owned Serve handler.", {
      backendState,
      dnsName,
      endpoint: `https://${dnsName}/`,
      enableCommand: enableCommand(target),
    });
  }

  async enable(loopbackPort: number): Promise<RemoteAccessStatus["tailscale"]> {
    const before = await this.getStatus(loopbackPort);
    if (before.state === "managed") return before;
    if (before.state !== "available" || !before.cliPath || !before.dnsName) return before;
    const target = proxyTarget(loopbackPort);
    const result = await this.runCommand(before.cliPath, [
      "serve",
      "--bg",
      "--yes",
      `--https=${String(SERVE_HTTPS_PORT)}`,
      `--set-path=${SERVE_PATH}`,
      target,
    ]);
    if (result.exitCode !== 0) {
      return this.status(true, "error", cleanMessage(result.stderr || result.stdout) || "Tailscale Serve could not be enabled.", {
        backendState: before.backendState,
        dnsName: before.dnsName,
        endpoint: before.endpoint,
        enableCommand: enableCommand(target),
      });
    }
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost, before.dnsName);
    this.store.write(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget, target);
    const verified = await this.getStatus(loopbackPort);
    if (verified.state !== "managed") {
      this.clearOwnership();
      return { ...verified, state: "error", message: "Tailscale accepted the command, but the BuildWarden handler could not be verified." };
    }
    return verified;
  }

  async disable(): Promise<RemoteAccessStatus["tailscale"]> {
    const managedHost = this.getManagedHost();
    const managedTarget = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget) ?? null;
    const desired = this.store.read(APP_SETTING_KEYS.remoteAccessTailscaleEnabled) === "true";
    if (!managedHost || !managedTarget) {
      return this.status(desired, "available", "BuildWarden does not own a Tailscale Serve handler.");
    }
    const located = await this.locate();
    if (!located) {
      return this.status(desired, "error", "Tailscale CLI was not found, so the managed Serve handler could not be removed.", {
        dnsName: managedHost,
        endpoint: `https://${managedHost}/`,
        managed: true,
      });
    }
    const serveResult = await this.runCommand(located.executable, ["serve", "status", "--json"]);
    const serveStatus = serveResult.exitCode === 0 ? parseJson<TailscaleServeStatus>(serveResult.stdout) : null;
    if (rootProxyForHost(serveStatus, managedHost) !== managedTarget) {
      this.clearOwnership();
      return this.getStatus(null);
    }
    const result = await this.runCommand(located.executable, [
      "serve",
      `--https=${String(SERVE_HTTPS_PORT)}`,
      `--set-path=${SERVE_PATH}`,
      "off",
    ]);
    if (result.exitCode !== 0) {
      return this.status(false, "error", cleanMessage(result.stderr || result.stdout) || "BuildWarden could not remove its Tailscale Serve handler.", {
        dnsName: managedHost,
        endpoint: `https://${managedHost}/`,
        managed: true,
      });
    }
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
