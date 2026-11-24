import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { SECRET_KEY_FILE_ENV } from "../secret-key-file";
import { createHostControlClient } from "./control-client";
import { controlSocketPath, type HostControlRequest } from "./control-protocol";
import { runCommandLine } from "./command-line";
import type { DoctorProbes } from "./command-line-doctor";
import type { CommandLineIo } from "./command-line-shared";
import { HOST_CHILD_ENV, passThroughSwitches, serveArgs, type ServeOptions } from "./launch";
import { promptLine } from "./prompt-line";
import { runningHostPid, waitForService } from "./service-start";
import { buildSystemdUnit, SYSTEMD_UNIT_NAME, systemdUserUnitPath } from "./systemd-unit";

const execFileAsync = promisify(execFile);

/** Reads a line in raw mode, so neither the terminal nor readline echoes it. */
const promptSecret = (label: string): Promise<string> => new Promise((resolve, reject) => {
  const { stdin } = process;
  process.stderr.write(label);
  let value = "";
  const finish = (settle: () => void) => {
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
    settle();
  };
  const onData = (chunk: string) => {
    for (const character of chunk) {
      if (character === "\r" || character === "\n" || character === "\u0004") return finish(() => resolve(value));
      if (character === "\u0003") return finish(() => reject(new Error("Cancelled.")));
      if (character === "\u007f" || character === "\b") value = [...value].slice(0, -1).join("");
      else if (character >= " ") value += character;
    }
  };
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", onData);
  stdin.resume();
});

const readStdin = async (): Promise<string> => {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const requireSystemd = (): void => {
  if (process.platform !== "linux") throw new Error("The service needs systemd on Linux. Use `buildwarden serve` with your own service manager.");
};

const systemctl = async (...args: string[]): Promise<void> => {
  try {
    await execFileAsync("systemctl", ["--user", ...args]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`systemctl --user ${args.join(" ")} failed: ${stderr || String(error)}`, { cause: error });
  }
};

const serviceUnit = (options: ServeOptions): string => {
  requireSystemd();
  // An AppImage runs from a temporary mount; the service must start the file itself.
  const executable = process.env.APPIMAGE || process.execPath;
  const appPath = process.defaultApp ? [resolvePath(process.argv.slice(1).find((arg) => !arg.startsWith("-")) ?? ".")] : [];
  const secretKeyFile = process.env[SECRET_KEY_FILE_ENV]?.trim();
  return buildSystemdUnit({
    command: [
      executable,
      ...passThroughSwitches(process.argv),
      ...appPath,
      ...serveArgs(options),
    ],
    environment: {
      // Provider CLIs are often only on the login shell's PATH.
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      // Without its key the service could not read the secrets. Its working directory is another one.
      ...(secretKeyFile ? { [SECRET_KEY_FILE_ENV]: resolvePath(secretKeyFile) } : {}),
    },
  });
};

const createService = (request: HostControlRequest): CommandLineIo["service"] => ({
  print: serviceUnit,
  install: async (options) => {
    const unit = serviceUnit(options);
    const previousPid = await runningHostPid(request);
    const path = systemdUserUnitPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit, "utf8");
    await systemctl("daemon-reload");
    await systemctl("enable", SYSTEMD_UNIT_NAME);
    await systemctl("restart", SYSTEMD_UNIT_NAME);
    if (!await waitForService(request, previousPid)) {
      throw new Error(`Installed ${path}, but the host did not start. See: journalctl --user -u ${SYSTEMD_UNIT_NAME}`);
    }
    return [
      `Installed and started ${path}`,
      `To keep it running after you log out: sudo loginctl enable-linger ${userInfo().username}`,
      `Logs: journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`,
    ].join("\n");
  },
  uninstall: async () => {
    requireSystemd();
    await systemctl("disable", "--now", SYSTEMD_UNIT_NAME);
    rmSync(systemdUserUnitPath(), { force: true });
    await systemctl("daemon-reload");
    return "Removed the BuildWarden service. Its data was kept.";
  },
});

const gitClone = (url: string, folder: string): Promise<void> => new Promise((resolve, reject) => {
  // `--` keeps a URL that starts with a dash from being read as an option.
  const git = spawn("git", ["clone", "--", url, folder], { stdio: "inherit" });
  git.once("error", (error) => reject(new Error(`Could not run git: ${error.message}`)));
  git.once("exit", (code) => code === 0 ? resolve() : reject(new Error("The repository could not be cloned.")));
});

const createDoctorProbes = (dataDir: string): DoctorProbes => ({
  toolVersion: async (file, args) => {
    try {
      return (await execFileAsync(file, args, { timeout: 10_000 })).stdout.split("\n", 1)[0].trim();
    } catch {
      return null;
    }
  },
  diskFreeBytes: async () => {
    try {
      const disk = await statfs(existsSync(dataDir) ? dataDir : dirname(dataDir));
      return disk.bavail * disk.bsize;
    } catch {
      return null;
    }
  },
  serviceLingers: async () => {
    if (process.platform !== "linux" || !existsSync(systemdUserUnitPath())) return null;
    try {
      const { stdout } = await execFileAsync("loginctl", ["show-user", userInfo().username, "--property=Linger"]);
      return stdout.trim() === "Linger=yes";
    } catch {
      return null;
    }
  },
});

/** Commands that cannot change anything, so agents may use them too. */
const COMMANDS_FOR_HOST_CHILDREN = new Set(["help", "version"]);

const write = (stream: NodeJS.WriteStream, text: string): void => {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
};

/** Runs a command in this process. Electron has not opened a window or the database at this point. */
export const runCommandLineProcess = async (args: readonly string[], options: { dataDir: string; version: string }): Promise<number> => {
  if (process.platform === "win32") {
    write(process.stderr, "BuildWarden's terminal commands are available on Linux and macOS.");
    return 1;
  }
  if (process.env[HOST_CHILD_ENV] && !COMMANDS_FOR_HOST_CHILDREN.has(args[0])) {
    write(process.stderr, "Agents and run terminals cannot control their BuildWarden host. Use a terminal on the server instead.");
    return 1;
  }
  const request = createHostControlClient(controlSocketPath(options.dataDir));
  const code = await runCommandLine(args, {
    out: (text) => write(process.stdout, text),
    error: (text) => write(process.stderr, text),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    cwd: process.cwd(),
    version: options.version,
    request,
    promptSecret,
    promptLine: (label) => promptLine(label),
    readStdin,
    renderQr: async (text) => {
      const { default: qrcode } = await import("qrcode");
      return qrcode.toString(text, { type: "utf8", margin: 1 });
    },
    gitClone,
    doctor: createDoctorProbes(options.dataDir),
    service: createService(request),
  });
  // Output to a pipe is asynchronous; exiting now could cut it off.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))));
  return code;
};
