import { posix, win32 } from "node:path";
import type { ProviderCliInstallMethod, ProviderCliUpdateProviderType } from "@buildwarden/shared";

/**
 * Pure install-ownership rules for provider CLI updates. A package manager is used
 * only when the executable's real path proves it owns the install; anything else
 * falls back to the CLI's own updater, which detects its installer itself.
 */

export interface ProviderCliDefinition {
  /** npm package that publishes the CLI; null when it is not distributed through npm. */
  npmPackage: string | null;
  /** Arguments for the CLI's built-in self-updater. */
  selfUpdateArgs: string[];
  /** Release feed that reports the newest version. */
  latestVersionUrl: string;
}

export const PROVIDER_CLI_DEFINITIONS: Record<ProviderCliUpdateProviderType, ProviderCliDefinition> = {
  "claude-code": {
    npmPackage: "@anthropic-ai/claude-code",
    selfUpdateArgs: ["update"],
    latestVersionUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
  },
  "codex-cli": {
    npmPackage: "@openai/codex",
    selfUpdateArgs: ["update"],
    latestVersionUrl: "https://registry.npmjs.org/@openai/codex/latest",
  },
  "cursor-agent": {
    npmPackage: null,
    selfUpdateArgs: ["update"],
    // Cursor publishes no version API; its installer script pins the current build.
    latestVersionUrl: "https://cursor.com/install",
  },
};

export interface ProviderCliCommand {
  file: string;
  args: string[];
}

export interface ProviderCliFileProbe {
  exists(path: string): boolean;
  isWritable(path: string): boolean;
}

export interface ProviderCliInstallInput {
  providerType: ProviderCliUpdateProviderType;
  /** Absolute executable path after PATH lookup. */
  commandPath: string;
  /** `commandPath` with symlinks followed. */
  realPath: string;
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  probe: ProviderCliFileProbe;
}

export interface ProviderCliInstallPlan {
  method: ProviderCliInstallMethod;
  /** Null when the install is manual-only. */
  command: ProviderCliCommand | null;
  displayCommand: string | null;
  manualReason: string | null;
  /** Install identity; an update is refused when it changed since the check. */
  lockKey: string;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const slashed = (value: string): string => value.replace(/\\/g, "/");
const nativePath = (value: string, platform: NodeJS.Platform): string => (platform === "win32" ? value.replace(/\//g, "\\") : value);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const quoteDisplayWord = (word: string, platform: NodeJS.Platform): string => {
  if (/^[\w./:\\@=+-]+$/.test(word)) return word;
  return platform === "win32" ? `"${word}"` : `'${word.replace(/'/g, "'\\''")}'`;
};

export const formatProviderCliCommand = (command: ProviderCliCommand, platform: NodeJS.Platform): string => {
  const executable = quoteDisplayWord(command.file, platform);
  // PowerShell, the default Windows terminal, needs `&` to run a quoted executable.
  const prefix = platform === "win32" && executable !== command.file ? "& " : "";
  return [`${prefix}${executable}`, ...command.args.map((arg) => quoteDisplayWord(arg, platform))].join(" ");
};

const firstExisting = (candidates: string[], probe: ProviderCliFileProbe): string | null =>
  candidates.find((candidate) => probe.exists(candidate)) ?? null;

const executableName = (name: string, platform: NodeJS.Platform, extension: ".exe" | ".cmd"): string =>
  platform === "win32" ? `${name}${extension}` : name;

const manualPlan = (
  method: ProviderCliInstallMethod,
  lockKey: string,
  manualReason: string,
  displayCommand: string | null,
): ProviderCliInstallPlan => ({ method, command: null, displayCommand, manualReason, lockKey });

/** Decides how the CLI at `realPath` must be updated. */
export const resolveProviderCliInstallPlan = (input: ProviderCliInstallInput): ProviderCliInstallPlan => {
  const { platform, probe } = input;
  const paths = pathFor(platform);
  const definition = PROVIDER_CLI_DEFINITIONS[input.providerType];
  const real = slashed(input.realPath);
  const command = slashed(input.commandPath);
  const commandDir = slashed(paths.dirname(input.commandPath));
  const lockKey = (method: ProviderCliInstallMethod) => `${method}:${input.realPath}`;
  const matches = (pattern: RegExp) => pattern.test(real) || pattern.test(command);

  const finish = (method: ProviderCliInstallMethod, planCommand: ProviderCliCommand, writableDir: string, sudoHint: boolean): ProviderCliInstallPlan => {
    const displayCommand = formatProviderCliCommand(planCommand, platform);
    const dir = nativePath(writableDir, platform);
    if (probe.isWritable(dir)) {
      return { method, command: planCommand, displayCommand, manualReason: null, lockKey: lockKey(method) };
    }
    if (platform === "win32") {
      return manualPlan(method, lockKey(method), `BuildWarden cannot write to ${dir}. Run the command from an Administrator terminal.`, displayCommand);
    }
    return manualPlan(
      method,
      lockKey(method),
      sudoHint
        ? `BuildWarden cannot write to ${dir}. Run the command with sudo in a terminal.`
        : `BuildWarden cannot write to ${dir}. Fix the folder permissions, then run the command in a terminal.`,
      sudoHint ? `sudo ${displayCommand}` : displayCommand,
    );
  };

  if (matches(/\/mise\/installs\//i)) {
    return manualPlan("mise", lockKey("mise"), "Managed by mise, which pins the version in its config. Update it with mise.", "mise upgrade");
  }
  if (matches(/\/microsoft\/winget\/(packages|links)\//i)) {
    return manualPlan("winget", lockKey("winget"), "Installed with winget. Update it from a terminal.", "winget upgrade");
  }

  const homebrew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\//i.exec(real);
  if (homebrew) {
    const [, prefix, kind, name] = homebrew;
    const isCask = kind.toLowerCase() === "caskroom";
    const brew = `${prefix}/bin/brew`;
    const args = ["upgrade", ...(isCask ? ["--cask"] : []), name];
    if (!probe.exists(brew)) {
      return manualPlan("homebrew", lockKey("homebrew"), "The Homebrew installation could not be verified.", formatProviderCliCommand({ file: "brew", args }, platform));
    }
    return finish("homebrew", { file: brew, args }, `${prefix}/${kind}`, false);
  }

  const npmPackage = definition.npmPackage;
  if (npmPackage) {
    const spec = `${npmPackage}@latest`;
    const globalRootIndex = real.search(/\/node_modules\//i);
    const ownsPackage = new RegExp(`/node_modules/${escapeRegExp(npmPackage)}(/|$)`, "i").test(real);
    const globalRoot = ownsPackage && globalRootIndex >= 0 ? real.slice(0, globalRootIndex) : null;
    const home = slashed(input.homeDir);

    if (matches(/\/\.volta\/|\/volta\/(bin|tools)\//i)) {
      const voltaHome = slashed(input.env.VOLTA_HOME
        || (platform === "win32" && input.env.LOCALAPPDATA ? paths.join(input.env.LOCALAPPDATA, "Volta") : paths.join(input.homeDir, ".volta")));
      const volta = firstExisting([nativePath(`${voltaHome}/bin/${executableName("volta", platform, ".exe")}`, platform)], probe) ?? "volta";
      return finish("volta", { file: volta, args: ["install", spec] }, voltaHome, false);
    }
    if (matches(/\/\.bun\/(install\/global|bin)\//i)) {
      const bun = firstExisting([nativePath(`${home}/.bun/bin/${executableName("bun", platform, ".exe")}`, platform)], probe) ?? "bun";
      return finish("bun", { file: bun, args: ["add", "--global", spec] }, globalRoot ? `${globalRoot}/node_modules` : `${home}/.bun`, false);
    }
    const pnpmHome = input.env.PNPM_HOME ? slashed(input.env.PNPM_HOME) : null;
    if (matches(/\/\.pnpm\/|\/pnpm\/global\//i) || /\/pnpm$/i.test(commandDir) || (pnpmHome !== null && commandDir.toLowerCase() === pnpmHome.toLowerCase())) {
      const pnpm = (pnpmHome && firstExisting(
        (platform === "win32" ? ["pnpm.exe", "pnpm.cmd"] : ["pnpm"]).map((name) => nativePath(`${pnpmHome}/${name}`, platform)),
        probe,
      )) || "pnpm";
      return finish("pnpm", { file: pnpm, args: ["add", "--global", spec] }, globalRoot ? `${globalRoot}/node_modules` : commandDir, false);
    }
    if (matches(/\/yarn\/global\/|\/\.config\/yarn\//i)) {
      return finish("yarn", { file: "yarn", args: ["global", "add", spec] }, globalRoot ? `${globalRoot}/node_modules` : commandDir, false);
    }

    // npm: `<prefix>/lib/node_modules/<pkg>` on POSIX, or a Windows shim beside `node_modules`.
    let prefix: string | null = null;
    if (globalRoot) {
      prefix = platform !== "win32" && /\/lib$/i.test(globalRoot) ? globalRoot.slice(0, -4) : globalRoot;
    } else if (platform === "win32" && probe.exists(nativePath(`${commandDir}/node_modules/${npmPackage}`, platform))) {
      prefix = commandDir;
    }
    if (prefix) {
      const npm = firstExisting(
        [platform === "win32" ? nativePath(`${prefix}/npm.cmd`, platform) : `${prefix}/bin/npm`],
        probe,
      ) ?? "npm";
      const modulesDir = platform === "win32" ? `${prefix}/node_modules` : `${prefix}/lib/node_modules`;
      return finish(
        "npm",
        { file: npm, args: ["install", "--global", spec, "--prefix", nativePath(prefix, platform), "--no-fund", "--no-audit"] },
        modulesDir,
        true,
      );
    }
  }

  const nativePatterns: Record<ProviderCliUpdateProviderType, RegExp> = {
    "claude-code": /\/\.local\/bin\/claude(\.exe)?$|\/\.local\/share\/claude\/|\/\.claude\/local\//i,
    "codex-cli": /\/programs\/openai\/codex\/|\/\.codex\/(bin|packages)\//i,
    "cursor-agent": /\/cursor-agent\/|\/\.local\/bin\/(agent|cursor-agent)(\.exe|\.cmd)?$/i,
  };
  const selfUpdate = { file: input.commandPath, args: definition.selfUpdateArgs };
  const method: ProviderCliInstallMethod = matches(nativePatterns[input.providerType]) ? "native" : "self-updater";
  return finish(method, selfUpdate, paths.dirname(input.realPath), true);
};

/** Extracts the version printed by `<cli> --version`. */
export const parseProviderCliVersion = (providerType: ProviderCliUpdateProviderType, output: string): string | null => {
  if (providerType === "cursor-agent") {
    return /(\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9a-f]+)?)/i.exec(output)?.[1] ?? null;
  }
  return /(\d{1,10}\.\d{1,10}\.\d{1,10}(?:-[0-9A-Za-z.]+)?)/.exec(output)?.[1] ?? null;
};

/** Reads the newest version from the release feed in {@link PROVIDER_CLI_DEFINITIONS}. */
export const parseLatestProviderCliVersion = (providerType: ProviderCliUpdateProviderType, body: string): string | null => {
  if (providerType === "cursor-agent") {
    return /downloads\.cursor\.com\/lab\/(\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+)\//i.exec(body)?.[1] ?? null;
  }
  try {
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version) ? version : null;
  } catch {
    return null;
  }
};

const pathKey = (env: NodeJS.ProcessEnv): string => Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

/**
 * Resolves a bare command like PATH lookup would, without spawning a shell. Desktop
 * launches on macOS and Linux inherit a minimal PATH, so common per-user install
 * folders are searched as well.
 */
export const resolveProviderCliCommandPath = (
  command: string,
  options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homeDir: string; exists: (path: string) => boolean },
): string | null => {
  const paths = pathFor(options.platform);
  const extensions = options.platform === "win32" && !/\.[a-z0-9]+$/i.test(command) ? [".exe", ".cmd", ".bat"] : [""];
  if (/[\\/]/.test(command)) {
    return extensions.map((extension) => `${command}${extension}`).find(options.exists) ?? null;
  }
  const extraDirs = options.platform === "win32"
    ? [paths.join(options.homeDir, ".local", "bin")]
    : ["/opt/homebrew/bin", "/usr/local/bin", ...[".local/bin", ".bun/bin", ".volta/bin", ".npm-global/bin"].map((dir) => paths.join(options.homeDir, dir))];
  const dirs = [...(options.env[pathKey(options.env)] ?? "").split(paths.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = paths.join(dir, `${command}${extension}`);
      if (options.exists(candidate)) return candidate;
    }
  }
  return null;
};

/** Prepends the executable's folder so npm-style scripts find the Node that owns them. */
export const withExecutableDirOnPath = (env: NodeJS.ProcessEnv, executable: string, platform: NodeJS.Platform): NodeJS.ProcessEnv => {
  const paths = pathFor(platform);
  if (!paths.isAbsolute(executable)) return env;
  const key = pathKey(env);
  return { ...env, [key]: [paths.dirname(executable), env[key]].filter(Boolean).join(paths.delimiter) };
};
