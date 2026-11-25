import { parseArgs } from "node:util";

/** Chromium switches a user may put after the command; Electron reads them, the command line does not. */
const PASS_THROUGH_SWITCHES = new Set([
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-gpu-sandbox",
  "--no-sandbox",
  "--ozone-platform",
  "--password-store",
  "--user-data-dir",
]);

export interface ServeOptions {
  port: number | null;
  /** Start automations that came due while the host was not running, instead of skipping them. */
  runMissed: boolean;
}

export type Launch =
  | { kind: "desktop" }
  | ({ kind: "serve" } & ServeOptions)
  /** A terminal command, including ones that are unknown or malformed: the command line reports those. */
  | { kind: "command"; args: string[] };

export class UsageError extends Error {}

const switchName = (arg: string): string => arg.split("=", 1)[0];
const isPassThroughSwitch = (arg: string): boolean => PASS_THROUGH_SWITCHES.has(switchName(arg));

/** The Chromium switches of this launch, to repeat them when the host is started another way. */
export const passThroughSwitches = (argv: readonly string[]): string[] => argv.slice(1).filter(isPassThroughSwitch);

const parsePort = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    throw new UsageError("--port must be a whole number between 1 and 65535.");
  }
  return port;
};

/** Options of `serve`; `service install` takes the same ones. */
export const SERVE_OPTIONS = { port: { type: "string" }, "run-missed": { type: "boolean" } } as const;

export const readServeOptions = (values: { port?: string; "run-missed"?: boolean }): ServeOptions =>
  ({ port: parsePort(values.port), runMissed: values["run-missed"] === true });

export const serveArgs = ({ port, runMissed }: ServeOptions): string[] =>
  ["serve", ...(port === null ? [] : ["--port", String(port)]), ...(runMissed ? ["--run-missed"] : [])];

/**
 * Decides what this process is: the desktop app, the headless host, or a one-off terminal command.
 * `buildwarden://` links, file paths and Chromium switches keep opening the desktop app.
 */
export const resolveLaunch = (argv: readonly string[], defaultApp: boolean): Launch => {
  const args = argv.slice(1);
  // `electron . serve`: the first argument that is not a switch is the app path, not a command.
  const firstPositional = args.findIndex((arg) => !arg.startsWith("-"));
  if (defaultApp && firstPositional >= 0) args.splice(firstPositional, 1);

  const commandIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (commandIndex < 0) {
    if (args.includes("--help") || args.includes("-h")) return { kind: "command", args: ["help"] };
    if (args.includes("--version")) return { kind: "command", args: ["version"] };
    return { kind: "desktop" };
  }
  if (!/^[a-z][a-z-]*$/.test(args[commandIndex])) return { kind: "desktop" };

  const commandArgs = args.slice(commandIndex).filter((arg) => !isPassThroughSwitch(arg));
  if (commandArgs[0] !== "serve") return { kind: "command", args: commandArgs };
  try {
    const { values } = parseArgs({ args: commandArgs.slice(1), options: SERVE_OPTIONS, strict: true, allowPositionals: false });
    return { kind: "serve", ...readServeOptions(values) };
  } catch {
    return { kind: "command", args: commandArgs };
  }
};

/**
 * Set in the headless host, so agents and run terminals inherit it. Their commands must not reach back
 * into the host, for example to pair a device. It stops mistakes; it is no barrier against the same user.
 */
export const HOST_CHILD_ENV = "BUILDWARDEN_HOST_CHILD";

/** This process's launch, the same answer in every entry point that asks. */
export const currentLaunch: Launch = resolveLaunch(process.argv, process.defaultApp === true);

export const isHeadlessHost = (): boolean => currentLaunch.kind === "serve";

/**
 * Switches the headless host needs but Chromium only honors on the real command line. Null when the
 * host can continue as it is. A chosen Ozone platform (for example x11 with Xvfb) is kept.
 */
export const headlessRestartArgs = (argv: readonly string[], platform: NodeJS.Platform): string[] | null => {
  if (platform !== "linux") return null;
  const has = (name: string) => argv.some((arg) => switchName(arg) === name);
  if (has("--ozone-platform")) return null;
  return [
    "--ozone-platform=headless",
    ...(has("--disable-gpu") ? [] : ["--disable-gpu"]),
    // A locked keyring has nobody to unlock it here, so secrets use BuildWarden's own key file.
    ...(has("--password-store") ? [] : ["--password-store=basic"]),
    ...argv.slice(1),
  ];
};
