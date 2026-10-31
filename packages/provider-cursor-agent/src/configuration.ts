import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY } from "@buildwarden/shared";

export const getDefaultCursorAgentBinaryPath = (): string => {
  return getCursorAgentBinaryPathCandidates().find((candidate) => existsSync(candidate)) ?? "agent";
};

const candidateBaseDirs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const home = env.USERPROFILE || homedir();
  const dirs = [
    join(home, ".local", "bin"),
    env.APPDATA ? join(env.APPDATA, "npm") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : undefined,
    join(home, "scoop", "shims"),
    env.ProgramData ? join(env.ProgramData, "chocolatey", "bin") : undefined,
  ];
  return Array.from(new Set(dirs.filter((dir): dir is string => Boolean(dir))));
};

export const getCursorAgentBinaryPathCandidates = (env: NodeJS.ProcessEnv = process.env): string[] => {
  if (process.platform !== "win32") {
    return [join(homedir(), ".local", "bin", "agent"), join(homedir(), ".local", "bin", "cursor-agent")];
  }
  return candidateBaseDirs(env).flatMap((dir) => [
    join(dir, "agent.exe"),
    join(dir, "agent.cmd"),
    join(dir, "cursor-agent.exe"),
    join(dir, "cursor-agent.cmd"),
  ]);
};

export const getCursorAgentBinaryPath = (config?: Record<string, unknown>): string => {
  const configured = config?.[PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY];
  return typeof configured === "string" && configured.trim() ? configured.trim() : getDefaultCursorAgentBinaryPath();
};
