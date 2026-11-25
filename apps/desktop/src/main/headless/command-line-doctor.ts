import { count, formatBytes, parseCommand, plain, type Command } from "./command-line-shared";
import { HostNotRunningError, type HostStatus } from "./control-protocol";

const LOW_DISK_BYTES = 2 * 1024 ** 3;

/** What the terminal's own process can find out, so `doctor` also helps when the host does not start. */
export interface DoctorProbes {
  /** First line of a tool's output, or null when it cannot be run. */
  toolVersion(file: string, args: string[]): Promise<string | null>;
  diskFreeBytes(): Promise<number | null>;
  /** Null when this is not a systemd system or the service is not installed. */
  serviceLingers(): Promise<boolean | null>;
}

type Check = { level: "ok" | "warn" | "fail"; name: string; detail: string };

const hostChecks = (status: HostStatus): Check[] => {
  const { tailscale, loopbackUrl } = status.remote;
  return [
    { level: "ok", name: "Host", detail: `running, version ${status.version}, pid ${String(status.pid)}` },
    loopbackUrl
      ? { level: "ok", name: "Local address", detail: loopbackUrl }
      : { level: "fail", name: "Local address", detail: "the host is not listening" },
    !tailscale.desired || tailscale.verified
      ? { level: "ok", name: "Remote access", detail: tailscale.verified ? tailscale.endpoint ?? "published" : "this computer only" }
      : { level: "warn", name: "Remote access", detail: plain(tailscale.message) },
    { level: "ok", name: "Secrets", detail: status.secretStorage },
    status.projects > 0
      ? { level: "ok", name: "Projects", detail: String(status.projects) }
      : { level: "warn", name: "Projects", detail: "none; add one with: buildwarden project add <folder>" },
  ];
};

export const runDoctor: Command = async (args, io) => {
  parseCommand(args, {}, 0);
  const checks: Check[] = [];
  let running = false;
  try {
    checks.push(...hostChecks(await io.request("status")));
    running = true;
  } catch (error) {
    checks.push({
      level: "fail", name: "Host",
      detail: error instanceof HostNotRunningError ? "not running; start it with: buildwarden serve" : String(error),
    });
  }

  const git = await io.doctor.toolVersion("git", ["--version"]);
  checks.push(git ? { level: "ok", name: "Git", detail: git } : { level: "fail", name: "Git", detail: "not installed" });

  if (running) {
    const [clis, providers, models] = [
      await io.request("detectProviders"), await io.request("listProviders"), await io.request("listModels"),
    ];
    // The host's PATH decides, not the one of this terminal.
    checks.push(...clis.map((cli): Check => {
      if (cli.path) return { level: "ok", name: cli.label, detail: cli.path };
      const used = providers.some((provider) => provider.type === cli.type);
      return { level: used ? "fail" : "ok", name: cli.label, detail: used ? "not found on the host's PATH, but a provider uses it" : "not found, not used" };
    }));
    checks.push(models.length > 0
      ? { level: "ok", name: "Models", detail: `${String(models.length)} from ${count(providers.length, "provider")}` }
      : { level: "warn", name: "Models", detail: "none; see: buildwarden provider add, buildwarden model add" });
  }

  const free = await io.doctor.diskFreeBytes();
  if (free !== null) checks.push({ level: free < LOW_DISK_BYTES ? "warn" : "ok", name: "Disk", detail: `${formatBytes(free)} free` });
  const lingers = await io.doctor.serviceLingers();
  if (lingers !== null) {
    checks.push(lingers
      ? { level: "ok", name: "Service", detail: "installed, starts at boot" }
      : { level: "warn", name: "Service", detail: "stops when you log out; run: sudo loginctl enable-linger \"$USER\"" });
  }

  const width = Math.max(...checks.map((check) => check.name.length));
  io.out(checks.map((check) => `${check.level.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`).join("\n"));
  return checks.some((check) => check.level === "fail") ? 1 : 0;
};
