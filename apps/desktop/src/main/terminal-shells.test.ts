import { describe, expect, it } from "vitest";
import { isMissingShell, terminalShellCandidates } from "./terminal-shells";

describe("terminal shell selection", () => {
  it("prefers PowerShell with a command prompt fallback on Windows", () => {
    expect(terminalShellCandidates("auto", "win32", { SystemRoot: "D:\\Windows" }).map((item) => item.file)).toEqual([
      "pwsh.exe", "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "D:\\Windows\\System32\\cmd.exe",
    ]);
  });
  it("never silently falls back for an explicit profile", () => {
    expect(terminalShellCandidates("pwsh", "win32", {})).toEqual([{ file: "pwsh.exe", args: ["-NoLogo"] }]);
    expect(() => terminalShellCandidates("cmd", "linux", {})).toThrow();
    expect(isMissingShell(new Error("spawn ENOENT"))).toBe(true);
    expect(isMissingShell(new Error("EACCES permission denied"))).toBe(false);
  });
  it("uses the configured Unix shell before portable fallbacks", () => {
    expect(terminalShellCandidates("auto", "linux", { SHELL: "/custom/fish" }).map((item) => item.file))
      .toEqual(["/custom/fish", "/bin/bash", "/bin/zsh", "/bin/sh"]);
  });
});
