import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  REMOTE_ACCESS_SCOPES,
  type NetworkProxySettingsSnapshot,
  type RemoteAccessExposure,
  type RemoteAccessScope,
  type RemoteAccessStatus,
} from "@buildwarden/shared";
import { runDoctor } from "./command-line-doctor";
import { runAutomation, runCli, runModel, runProject, runProvider, runRun, runStorage } from "./command-line-setup";
import {
  confirm,
  count,
  parseCommand,
  plain,
  readPipedSecret,
  required,
  rows,
  unknownAction,
  type Command,
  type CommandLineIo,
} from "./command-line-shared";
import { HostNotRunningError, type HostStatus } from "./control-protocol";
import { readServeOptions, SERVE_OPTIONS, UsageError } from "./launch";

export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_RUNNING = 3;

const HELP = `BuildWarden

Usage: buildwarden [command]

Without a command this opens the desktop app.

Host
  serve [--port <number>] [--run-missed]
                                     Run without a desktop; clients connect through remote access.
                                     --run-missed starts automations missed while it was off
  status [--json]                    Show the running host
  doctor                             Check the host and what it needs
  stop                               Stop the running host
  service install [serve options]    Run the host as a systemd user service
  service uninstall | print          Remove the service, or print its unit file

Remote connections
  pair [--read-only | --scopes <a,b>] [--origin <url>]
                                     Create a one-time pairing code for a browser or phone
  remote                             Show remote access and Tailscale
  remote expose <private|internet|local>
                                     Publish through Tailscale Serve, Funnel, or not at all
  remote origins [add|remove <url>]  Hosted website origins that may connect
  sessions [revoke <id>|--all]       Paired devices

Network proxy
  proxy                              Show the proxy
  proxy set <url> [--username <name>] [--password-stdin]
                                     For example: proxy set http://proxy.example:8080
  proxy on | off | clear             Use it, stop using it, or forget it and its password

Projects, providers and models
  project                            List projects
  project add <folder> | clone <url> [folder] [--name <name>]
  project token <project> [set|remove] [--stdin]
                                     GitHub or GitLab access token
  project remove <project> [--yes]   Keeps the project folder itself
  provider                           List providers
  provider detect                    Agent command-line tools the host finds
  provider add <type> [--label <name>] [--key-stdin] [--base-url <url>] [--config <json>]
                                     codex, claude, cursor: [--binary <path>] [--home|--launch-args|--endpoint <value>]
                                     acp: --command <command> [--env <KEY=VALUE>]...
                                     openai, anthropic, google, xai, openai-compatible, openrouter,
                                     azure: [--api-version <version>]
  provider check <provider>          Ask the provider again what it supports
  provider set-key <provider> [--key-stdin]
  provider remove <provider> [--yes]
  model                              List models
  model available <provider>         Models the provider offers
  model add <provider> <model>... [--name <name>] [--base-url <url>]
  model remove <model> [--yes]       Also deletes its runs and chats

Work
  run [--all] | run cancel <run>     Active or recent runs
  automation                         List automations
  automation run|enable|disable <automation>
  cli [check|on|off]                 Updates of agent command-line tools
  cli update <codex|claude|cursor>

Data
  storage | storage compact          Database size; give free space back to the disk
  storage cleanup --days <number> [--yes]
                                     Delete old runs and chats
  backup create <file> [--yes] [--password-stdin]
  backup restore <file> [--yes] [--password-stdin]

Projects, providers, models, automations and runs can be given by name, id, or the first characters of the id.
Add --user-data-dir=<folder> before the command to use another data directory.
`;

const EXPOSURES: Record<string, RemoteAccessExposure> = {
  private: "tailnet",
  tailnet: "tailnet",
  internet: "internet",
  local: "local",
};

const READ_ONLY_SCOPES: RemoteAccessScope[] = ["state:read"];

const tunnelHint = (port: number): string =>
  `From another computer: ssh -L ${String(port)}:127.0.0.1:${String(port)} <user>@<this server>, then open the link there.`;

const loopbackPort = (remote: RemoteAccessStatus): number =>
  Number(remote.loopbackUrl ? new URL(remote.loopbackUrl).port : "") || DEFAULT_REMOTE_ACCESS_PORT;

const describeExposure = (remote: RemoteAccessStatus): string => {
  const { tailscale } = remote;
  if (!tailscale.desired) return "this computer only";
  const label = tailscale.requestedExposure === "internet" ? "internet" : "private (tailnet)";
  return tailscale.verified && tailscale.endpoint ? `${label}, ${tailscale.endpoint}` : `${label}, not active: ${tailscale.message}`;
};

const describeProxy = (proxy: NetworkProxySettingsSnapshot): string => {
  if (!proxy.host) return "not set";
  const user = proxy.username ? `${proxy.username}${proxy.hasPassword ? ":***" : ""}@` : "";
  return `${proxy.protocol}://${user}${proxy.host}:${proxy.port}${proxy.enabled ? "" : " (off)"}`;
};

const parseProxyUrl = (raw: string): { protocol: "http" | "https"; host: string; port: string; username: string } => {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new UsageError(`Not a proxy URL: ${raw}`);
  }
  const protocol = url.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") throw new UsageError("The proxy must use http:// or https://.");
  // Arguments are visible to other users of the machine and stay in the shell history.
  if (url.password) throw new UsageError("Leave the password out of the URL; it is asked for, or read with --password-stdin.");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw new UsageError("A proxy URL has no path.");
  return {
    protocol,
    host: url.hostname,
    // WHATWG URLs drop the scheme's default port.
    port: url.port || (protocol === "https" ? "443" : "80"),
    username: decodeURIComponent(url.username),
  };
};

const statusText = (status: HostStatus): string => [
  `BuildWarden ${status.version} is running (pid ${String(status.pid)}, since ${new Date(status.startedAt).toLocaleString()})`,
  rows([
    ["Local address", status.remote.loopbackUrl ?? "not listening"],
    ["Reachable from", describeExposure(status.remote)],
    ["Paired devices", String(status.pairedDevices)],
    ["Projects", String(status.projects)],
    ["Active", `${count(status.activeRuns, "run")}, ${count(status.activeChats, "chat")}`],
    ["Network proxy", describeProxy(status.proxy)],
    ["Secrets", status.secretStorage],
    ["Data", status.dataDir],
    ["Logs", status.logDir ?? "none"],
  ]),
].join("\n");

const remoteText = (remote: RemoteAccessStatus): string => {
  const command = !remote.tailscale.verified && remote.tailscale.enableCommand;
  return [
    rows([
      ["Local address", remote.loopbackUrl ?? "not listening"],
      ["Reachable from", describeExposure(remote)],
      ["Tailscale", remote.tailscale.message],
    ]),
    ...(remote.tailscale.desired && command ? [`To set it up by hand: ${command}`] : []),
    ...(remote.tailscale.desired ? [] : [tunnelHint(loopbackPort(remote))]),
  ].join("\n");
};

const runPair: Command = async (args, io) => {
  const { values } = parseCommand(args, {
    "read-only": { type: "boolean" }, scopes: { type: "string" }, origin: { type: "string" },
  }, 0);
  if (values["read-only"] && values.scopes) throw new UsageError("Use either --read-only or --scopes.");
  let scopes: RemoteAccessScope[] = [...REMOTE_ACCESS_SCOPES];
  if (values["read-only"]) scopes = READ_ONLY_SCOPES;
  else if (values.scopes) scopes = values.scopes.split(",").map((scope) => scope.trim()) as RemoteAccessScope[];

  const grant = await io.request("pair", { scopes, ...(values.origin ? { clientOrigin: values.origin } : {}) });
  io.out(rows([
    ["Pairing code", grant.code],
    ["Access", grant.scopes.join(", ")],
    ["Expires", new Date(grant.expiresAt).toLocaleTimeString()],
    ...(grant.pairingUrl ? [["Link", grant.pairingUrl] as [string, string]] : []),
  ]));
  if (!grant.pairingUrl) return;
  const url = new URL(grant.pairingUrl);
  // A phone cannot open this host's loopback address, so a QR code would not help there.
  if (url.hostname === "127.0.0.1") io.out(tunnelHint(Number(url.port)));
  else if (io.interactive) io.out(await io.renderQr(grant.pairingUrl));
};

const runRemote: Command = async (args, io) => {
  const { positionals: [action = "status", first, second] } = parseCommand(args, {}, 3);
  if (action === "status") {
    io.out(remoteText((await io.request("status")).remote));
    return;
  }
  if (action === "expose") {
    const exposure = EXPOSURES[required(first, "private, internet or local")];
    if (!exposure || second) throw new UsageError("Use: remote expose <private|internet|local>");
    const remote = await io.request("remoteExpose", { exposure });
    io.out(remoteText(remote));
    // Removing the exposure can fail as well, which leaves BuildWarden's handler in place.
    const applied = exposure === "local" ? !remote.tailscale.managed : remote.tailscale.verified;
    return applied ? 0 : EXIT_FAILURE;
  }
  if (action !== "origins") return unknownAction("remote", action);
  let origins: string[];
  if (!first || first === "list") origins = await io.request("remoteOrigins", {});
  else if (first === "add") origins = await io.request("remoteOrigins", { add: required(second, "website origin") });
  else if (first === "remove") origins = await io.request("remoteOrigins", { remove: required(second, "website origin") });
  else return unknownAction("remote origins", first);
  io.out(origins.length ? origins.join("\n") : "No hosted website origins.");
};

const runSessions: Command = async (args, io) => {
  const { values, positionals: [action = "list", id] } = parseCommand(args, { all: { type: "boolean" } }, 2);
  const sessions = action === "list" || values.all ? await io.request("listSessions") : [];
  if (action === "list") {
    io.out(sessions.length
      ? sessions.map((session) => `${session.id}  ${plain(session.label)}  last used ${new Date(session.lastUsedAt).toLocaleString()}  ${session.scopes.join(", ")}`).join("\n")
      : "No paired devices.");
    return;
  }
  if (action !== "revoke") return unknownAction("sessions", action);
  const ids = values.all ? sessions.map((session) => session.id) : [required(id, "session id")];
  let revoked = 0;
  for (const sessionId of ids) if (await io.request("revokeSession", { sessionId })) revoked += 1;
  if (!values.all && revoked === 0) throw new Error("No paired device has this id.");
  io.out(`Revoked ${count(revoked, "device")}.`);
};

const setProxy = async (rawUrl: string, options: { username?: string; "password-stdin"?: boolean }, io: CommandLineIo) => {
  const proxy = parseProxyUrl(rawUrl);
  const username = options.username ?? proxy.username;
  let password = "";
  if (options["password-stdin"]) password = await readPipedSecret(io);
  else if (username && io.interactive) password = await io.promptSecret("Proxy password (empty for none): ");
  if (password && !username) throw new UsageError("A proxy password needs a username.");
  return io.request("proxySet", { ...proxy, username, ...(password ? { password } : {}) });
};

const runProxy: Command = async (args, io) => {
  const { values, positionals: [action = "show", url] } = parseCommand(args, {
    username: { type: "string" }, "password-stdin": { type: "boolean" },
  }, 2);
  if (url && action !== "set") throw new UsageError(`Unexpected argument: ${url}`);
  let proxy: NetworkProxySettingsSnapshot;
  if (action === "show") proxy = await io.request("proxyShow");
  else if (action === "set") proxy = await setProxy(required(url, "proxy URL"), values, io);
  else if (action === "on" || action === "off") proxy = await io.request("proxyEnable", { enabled: action === "on" });
  else if (action === "clear") proxy = await io.request("proxyClear");
  else return unknownAction("proxy", action);
  io.out(`Network proxy: ${describeProxy(proxy)}`);
};

const readBackupPassword = async (io: CommandLineIo, fromStdin: boolean | undefined, confirm: boolean): Promise<string> => {
  if (fromStdin) return readPipedSecret(io);
  if (!io.interactive) throw new UsageError("Pass the backup password with --password-stdin.");
  const password = await io.promptSecret("Backup password: ");
  if (confirm && await io.promptSecret("Repeat password: ") !== password) throw new Error("The passwords do not match.");
  return password;
};

const runBackup: Command = async (args, io) => {
  const { values, positionals: [action = "", file] } = parseCommand(args, {
    "password-stdin": { type: "boolean" }, yes: { type: "boolean", short: "y" },
  }, 2);
  if (action !== "create" && action !== "restore") throw new UsageError("Use: backup create <file> or backup restore <file>");
  const target = required(file, "backup file");
  const filePath = isAbsolute(target) ? target : resolve(io.cwd, target);
  if (action === "create") {
    if (existsSync(filePath)) await confirm(io, values.yes, `This replaces the existing file ${filePath}.`);
    const password = await readBackupPassword(io, values["password-stdin"], true);
    io.out(`Saved ${(await io.request("backupCreate", { filePath, password })).filePath}`);
    return;
  }
  await confirm(io, values.yes, "Restoring replaces all data of this host.");
  const password = await readBackupPassword(io, values["password-stdin"], false);
  const { createdAt } = await io.request("backupRestore", { filePath, password });
  io.out(`Restoring the backup of ${new Date(createdAt).toLocaleString()}. BuildWarden is restarting.`);
};

const runService: Command = async (args, io) => {
  const { values, positionals: [action = ""] } = parseCommand(args, SERVE_OPTIONS, 1);
  const options = readServeOptions(values);
  if (action === "print") io.out(io.service.print(options));
  else if (action === "install") io.out(await io.service.install(options));
  else if (action === "uninstall") io.out(await io.service.uninstall());
  else throw new UsageError("Use: service install, service uninstall or service print");
};

const COMMANDS: Record<string, Command> = {
  help: async (_args, io) => io.out(HELP),
  version: async (_args, io) => io.out(io.version),
  // Only reached with arguments `resolveLaunch` could not read.
  serve: async (args) => {
    readServeOptions(parseCommand(args, SERVE_OPTIONS, 0).values);
  },
  status: async (args, io) => {
    const { values } = parseCommand(args, { json: { type: "boolean" } }, 0);
    const status = await io.request("status");
    io.out(values.json ? JSON.stringify(status, null, 2) : statusText(status));
  },
  stop: async (args, io) => {
    parseCommand(args, {}, 0);
    await io.request("stop");
    io.out("BuildWarden is stopping.");
  },
  pair: runPair,
  remote: runRemote,
  sessions: runSessions,
  proxy: runProxy,
  project: runProject,
  provider: runProvider,
  model: runModel,
  run: runRun,
  automation: runAutomation,
  cli: runCli,
  storage: runStorage,
  doctor: runDoctor,
  backup: runBackup,
  service: runService,
};

/** Runs one terminal command and returns the process exit code. */
export const runCommandLine = async (args: readonly string[], io: CommandLineIo): Promise<number> => {
  const [name = "help", ...rest] = args;
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(HELP);
    return 0;
  }
  try {
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!command) throw new UsageError(`Unknown command: ${name}`);
    return (await command(rest, io)) ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      io.error(`${message}\nRun \`buildwarden help\` for the commands.`);
      return EXIT_USAGE;
    }
    io.error(message);
    return error instanceof HostNotRunningError ? EXIT_NOT_RUNNING : EXIT_FAILURE;
  }
};
