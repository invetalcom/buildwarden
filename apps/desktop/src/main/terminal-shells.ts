import type { TerminalShell } from "@buildwarden/shared";
import { userInfo } from "node:os";

const loginShell = (): string | undefined => {
  try { return userInfo().shell ?? undefined; } catch { return undefined; }
};

export const hostDefaultTerminalShell = (shell: TerminalShell, platform = process.platform): TerminalShell =>
  terminalShells(platform).includes(shell) ? shell : "auto";

export const terminalShells = (platform = process.platform): TerminalShell[] =>
  platform === "win32" ? ["auto", "pwsh", "powershell", "cmd"] : ["auto", "bash", "zsh", "sh"];

export const terminalShellCandidates = (
  selection: TerminalShell,
  platform = process.platform,
  env = process.env,
): Array<{ file: string; args: string[] }> => {
  const root = env.SystemRoot || "C:\\Windows";
  const profiles: Record<Exclude<TerminalShell, "auto">, { file: string; args: string[] }> = {
    pwsh: { file: "pwsh.exe", args: ["-NoLogo"] },
    powershell: { file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ["-NoLogo"] },
    cmd: { file: env.ComSpec || `${root}\\System32\\cmd.exe`, args: ["/k"] },
    bash: { file: "/bin/bash", args: ["-l"] },
    zsh: { file: "/bin/zsh", args: ["-l"] },
    sh: { file: "/bin/sh", args: [] },
  };
  if (!terminalShells(platform).includes(selection)) throw new Error("This shell is not supported on the host.");
  if (selection !== "auto") return [profiles[selection]];
  const systemShell = env.SHELL || (platform === process.platform ? loginShell() : undefined);
  return platform === "win32"
    ? [profiles.cmd, profiles.pwsh, profiles.powershell]
    : [...(systemShell ? [{ file: systemShell, args: ["-l"] }] : []), profiles.bash, profiles.zsh, profiles.sh];
};

export const isMissingShell = (error: unknown): boolean =>
  error instanceof Error && /ENOENT|not found|cannot find|no such file|posix_spawnp failed/i.test(error.message);
