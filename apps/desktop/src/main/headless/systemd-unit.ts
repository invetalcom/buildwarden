import { homedir } from "node:os";
import { join } from "node:path";

/** The host exits with this status when it wants the service manager to start it again. */
export const RESTART_EXIT_CODE = 75;
/** Set by the generated unit, so the host leaves restarts to systemd instead of relaunching itself. */
export const SUPERVISED_ENV = "BUILDWARDEN_SUPERVISED";
export const SYSTEMD_UNIT_NAME = "buildwarden.service";

export const systemdUserUnitPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", SYSTEMD_UNIT_NAME);

const assertSingleLine = (value: string): string => {
  if (/[\r\n]/.test(value)) throw new Error("Paths in a systemd unit cannot contain line breaks.");
  return value;
};

const quoteUnitValue = (value: string): string =>
  `"${assertSingleLine(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** ExecStart additionally expands `$`. */
const quoteExecArgument = (value: string): string => quoteUnitValue(value).replace(/\$/g, () => "$$");

export const buildSystemdUnit = (options: { command: readonly string[]; environment: Readonly<Record<string, string>> }): string => `[Unit]
Description=BuildWarden headless host
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${options.command.map(quoteExecArgument).join(" ")}
${Object.entries(options.environment).map(([name, value]) => `Environment=${quoteUnitValue(`${name}=${value}`)}`).join("\n")}
Environment=${SUPERVISED_ENV}=1
Restart=on-failure
SuccessExitStatus=${String(RESTART_EXIT_CODE)}
RestartForceExitStatus=${String(RESTART_EXIT_CODE)}
RestartSec=10
KillMode=mixed
TimeoutStopSec=45

[Install]
WantedBy=default.target
`;
